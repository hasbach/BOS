"""CSV validation, preview and atomic catalog import (R53)."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from decimal import Decimal
from typing import Any, TypedDict

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import audit
from app.core.numbers import normalise_number
from app.errors import ApiError
from app.services import catalog, skus
from app.services.catalog import MAX_VARIANTS, ascii_lower

MAX_BYTES = 2 * 1024 * 1024
MAX_ROWS = 2000
# csv.reader has a process-wide field limit. Set it once to the upload bound so
# oversized cells in valid CSVs reach column validation and report row errors.
csv.field_size_limit(MAX_BYTES)
COLUMNS = (
    "product_code",
    "name_en",
    "name_ar",
    "description_en",
    "description_ar",
    "stores",
    "option1_name",
    "option1_value",
    "option2_name",
    "option2_value",
    "sku",
    "price",
    "currency",
    "opening_quantity",
    "low_stock_level",
)
_REQUIRED = ("product_code", "price", "currency")
_PRODUCT_FIELDS = (
    "name_en",
    "name_ar",
    "description_en",
    "description_ar",
    "stores",
    "option1_name",
    "option2_name",
)
_TEXT_LIMITS = {
    "name_en": 120,
    "name_ar": 120,
    "description_en": 2000,
    "description_ar": 2000,
    "option1_name": 40,
    "option2_name": 40,
    "option1_value": 40,
    "option2_value": 40,
}


class RowError(TypedDict):
    row: int
    column: str
    code: str


@dataclass(frozen=True)
class CellRow:
    number: int
    cells: dict[str, str]

    def __getitem__(self, column: str) -> str:
        return self.cells.get(column, "")


@dataclass
class ImportVariant:
    row: int
    sku: str
    price: str
    currency: str
    opening_quantity: int
    low_stock_level: int | None
    option_values: list[str]


@dataclass
class ImportProduct:
    code: str
    name_en: str | None
    name_ar: str | None
    description_en: str | None
    description_ar: str | None
    store_ids: list[str]
    options: list[str]
    variants: list[ImportVariant] = field(default_factory=list)


def parse_csv(data: bytes) -> list[CellRow]:
    if len(data) > MAX_BYTES:
        raise ApiError(400, "file_too_large", "Choose a CSV file of 2 MB or less")
    bad_csv = ApiError(400, "file_not_csv", "Choose a nonempty UTF-8 CSV file")
    try:
        decoded = data.decode("utf-8-sig")
        if "\x00" in decoded:
            raise bad_csv
        reader = csv.reader(io.StringIO(decoded, newline=""), strict=True)
        header = [ascii_lower(cell.strip()) for cell in next(reader)]
        if not header or (len(header) == 1 and header[0] not in COLUMNS):
            raise bad_csv
        rows = []
        for number, cells in enumerate(reader, start=2):
            if cells:
                if len(cells) > len(header):
                    raise bad_csv
                rows.append(
                    CellRow(number, dict(zip(header, (c.strip() for c in cells), strict=False)))
                )
                if len(rows) > MAX_ROWS:
                    raise ApiError(400, "too_many_rows", "CSV files can have at most 2,000 rows")
    except (StopIteration, UnicodeDecodeError, csv.Error):
        raise bad_csv from None
    if not rows or len(set(header)) != len(header):
        raise bad_csv
    missing = [c for c in _REQUIRED if c not in header]
    if "name_en" not in header and "name_ar" not in header:
        missing.append("name_en or name_ar")
    if missing:
        raise ApiError(
            400, "missing_columns", "Required columns are missing", extra={"columns": missing}
        )
    unknown = [c for c in header if c not in COLUMNS]
    if unknown:
        raise ApiError(
            400, "unknown_columns", "The file has unknown columns", extra={"columns": unknown}
        )
    return rows


def _number(raw: str, *, whole: bool) -> tuple[str, str | None]:
    if raw.startswith("-"):
        try:
            normalise_number(raw[1:])
        except ValueError:
            pass
        else:
            return "0", "negative"
    try:
        return normalise_number(raw, whole=whole), None
    except ValueError:
        if whole:
            try:
                decimal = normalise_number(raw)
            except ValueError:
                pass
            else:
                if "." in decimal:
                    return "0", "not_whole"
        return "0", "invalid"


def _price(raw: str, currency: str) -> tuple[str, str | None]:
    if not raw:
        return "0", "required"
    number, error = _number(raw, whole=False)
    if error:
        return number, error
    integer, dot, fraction = number.partition(".")
    if len(fraction) > 2:
        return "0", "invalid"
    integer = integer.lstrip("0") or "0"
    if len(integer) > 11:
        return "0", "too_large"
    if currency == "LBP" and fraction.strip("0"):
        return "0", "not_whole"
    return integer + dot + fraction, None


def _quantity(raw: str, default: int | None) -> tuple[int | None, str | None]:
    if not raw:
        return default, None
    number, error = _number(raw, whole=True)
    number = number.lstrip("0") or "0"
    if error:
        return default, error
    if len(number) > 7 or int(number) > 1_000_000:
        return default, "too_large"
    return int(number), None


def _store_names(cell: str) -> set[str]:
    return {name.strip().casefold() for name in cell.split("|")} if cell else set()


def _same_product_field(column: str, old: str, new: str) -> bool:
    if column == "stores":
        return _store_names(old) == _store_names(new)
    return old == new


def _unique_suggestions(
    pending: list[tuple[ImportVariant, str, list[tuple[str, int]]]],
    taken: set[str],
    lookup: Callable[[set[str]], set[str]] | None,
) -> None:
    # Reserve every supplied SKU first, including those on later rows. Query only candidates,
    # not the entire tenant catalog. Each retry adds the occupied keys for the next round.
    while pending:
        proposals = taken.copy()
        candidates = {}
        for variant, code, options in pending:
            variant.sku = skus.suggest(code, options, proposals)
            sku_key = skus.key(variant.sku)
            proposals.add(sku_key)
            candidates[sku_key] = (variant, code, options)
        occupied = lookup(set(candidates)) if lookup else set()
        taken = proposals
        pending = [entry for key, entry in candidates.items() if key in occupied]


@dataclass
class _Group:
    first: CellRow
    product: ImportProduct
    values: list[dict[str, str]] = field(default_factory=lambda: [{}, {}])
    combinations: set[tuple[str, ...]] = field(default_factory=set)
    row_count: int = 0
    incomplete: bool = False


def validate_rows(
    rows: list[CellRow],
    stores: dict[str, str],
    catalog_skus: set[str],
    catalog_codes: set[str] | None = None,
    *,
    occupied_skus: Callable[[set[str]], set[str]] | None = None,
) -> tuple[list[ImportProduct], list[RowError]]:
    errors: list[RowError] = []
    groups: dict[str, _Group] = {}
    explicit: set[str] = set()
    pending: list[tuple[ImportVariant, str, list[tuple[str, int]]]] = []

    def report(number: int, column: str, code: str | None) -> None:
        if code:
            errors.append({"row": number, "column": column, "code": code})

    for row in rows:
        n = row.number
        try:
            code = skus.check_code(row["product_code"])
        except skus.InvalidCode as bad:
            report(n, "product_code", bad.code)
            code = ""
        code_key = skus.key(code)
        if catalog_codes and code_key in catalog_codes:
            report(n, "product_code", "product_code_in_use")
        group = groups.get(code_key) if code else None
        first = group.first if group else row
        store_names = _store_names(row["stores"])
        if store_names - stores.keys():
            report(n, "stores", "unknown_store")
        for column, limit in _TEXT_LIMITS.items():
            if len(row[column]) > limit:
                report(n, column, "too_long")
        if group:
            for column in _PRODUCT_FIELDS:
                if row[column] and not _same_product_field(column, first[column], row[column]):
                    report(n, column, "inconsistent_product")
        else:
            if not row["name_en"] and not row["name_ar"]:
                report(n, "name_en", "required")
            product = ImportProduct(
                code,
                row["name_en"] or None,
                row["name_ar"] or None,
                row["description_en"] or None,
                row["description_ar"] or None,
                [stores[name] for name in sorted(store_names & stores.keys())],
                [row[col] for col in ("option1_name", "option2_name") if row[col]],
            )
            group = _Group(first, product)
            if code:
                groups[code_key] = group
        options, positions = _row_options(row, group, report)
        sku = ""
        if row["sku"]:
            try:
                sku = skus.check_sku(row["sku"])
            except skus.InvalidCode as bad:
                report(n, "sku", bad.code)
            else:
                sku_key = skus.key(sku)
                if sku_key in explicit:
                    report(n, "sku", "duplicate_in_file")
                if sku_key in catalog_skus:
                    report(n, "sku", "sku_in_use")
                explicit.add(sku_key)
        currency = row["currency"]
        if currency not in ("USD", "LBP"):
            report(n, "currency", "invalid_currency" if currency else "required")
        price, error = _price(row["price"], currency)
        report(n, "price", error)
        opening, error = _quantity(row["opening_quantity"], 0)
        report(n, "opening_quantity", error)
        level, error = _quantity(row["low_stock_level"], None)
        report(n, "low_stock_level", error)
        variant = ImportVariant(n, sku, price, currency, opening or 0, level, options)
        group.product.variants.append(variant)
        if not row["sku"] and code:
            pending.append((variant, group.product.code, positions))

    for group in groups.values():
        left, right = group.values
        if (
            left
            and right
            and not group.incomplete
            and len(group.combinations) != len(left) * len(right)
        ):
            report(group.first.number, "option2_value", "missing_option_value")
    if not errors:
        _unique_suggestions(pending, catalog_skus | explicit, occupied_skus)
    return [group.product for group in groups.values()], sorted(errors, key=lambda e: e["row"])


def _row_options(
    row: CellRow,
    group: _Group,
    report: Callable[[int, str, str | None], None],
) -> tuple[list[str], list[tuple[str, int]]]:
    group.row_count += 1
    if group.row_count == MAX_VARIANTS + 1:
        report(row.number, "product_code", "too_many_variants")
    if (
        group.first["option1_name"]
        and group.first["option2_name"]
        and any(
            row[c] and row[c] not in group.product.options for c in ("option1_name", "option2_name")
        )
    ):
        report(row.number, "option2_name", "too_many_options")
    labels = []
    positions = []
    complete = True
    for index, known in enumerate(group.values, start=1):
        name = group.first[f"option{index}_name"]
        col = f"option{index}_value"
        value = row[col]
        if name and not value:
            report(row.number, col, "missing_option_value")
            complete = False
        elif value and not name:
            report(row.number, f"option{index}_name", "required")
            complete = False
        elif name:
            key = ascii_lower(value)
            if key not in known:
                known[key] = value
                if len(known) == 21:
                    report(row.number, col, "too_many_values")
            labels.append(known[key])
            # Only the first 20 positions can be persisted; cap work for invalid large groups.
            if len(known) <= 20:
                positions.append((known[key], list(known).index(key) + 1))
    if group.first["option2_name"] and not group.first["option1_name"]:
        report(row.number, "option1_name", "required")
        complete = False
    if complete:
        combination = tuple(ascii_lower(value) for value in labels)
        if combination in group.combinations:
            column = f"option{len(labels)}_value" if labels else "product_code"
            report(row.number, column, "duplicate_combination")
        group.combinations.add(combination)
    else:
        group.incomplete = True
    return labels, positions


def template() -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(COLUMNS)
    writer.writerow(
        (
            "SHIRT",
            "Everyday shirt",
            "قميص",
            "",
            "",
            "",
            "Size",
            "Small",
            "",
            "",
            "SHIRT-S",
            "12.00",
            "USD",
            "8",
            "",
        )
    )
    writer.writerow(
        ("SHIRT", "", "", "", "", "", "", "Large", "", "", "SHIRT-L", "12.00", "USD", "0", "")
    )
    return output.getvalue().encode("utf-8-sig")


_SKU_KEYS = text("SELECT sku_key FROM variants WHERE sku_key = ANY(:keys)")
_CODE_KEYS = text("SELECT code_key FROM products WHERE code_key = ANY(:keys)")
_BATCH_FIELDS = (
    "id, status, file_name, row_count, product_count, variant_count, opening_units, errors, "
    "expires_at, committed_at"
)


def _sku_keys(db: Session, keys: set[str]) -> set[str]:
    return set(db.execute(_SKU_KEYS, {"keys": list(keys)}).scalars()) if keys else set()


def _code_keys(db: Session, keys: set[str]) -> set[str]:
    return set(db.execute(_CODE_KEYS, {"keys": list(keys)}).scalars()) if keys else set()


def _batch_json(batch: Any) -> dict[str, Any]:
    return {
        "id": str(batch.id),
        "status": batch.status,
        "file_name": batch.file_name,
        "row_count": batch.row_count,
        "products": batch.product_count,
        "variants": batch.variant_count,
        "opening_units": batch.opening_units,
        "errors": batch.errors,
        "expires_at": catalog.iso(batch.expires_at),
        "committed_at": catalog.iso(batch.committed_at) if batch.committed_at else None,
    }


def preview(db: Session, actor: catalog.Actor, file_name: str, data: bytes) -> dict[str, Any]:
    rows = parse_csv(data)
    stores: dict[str, str] = {}
    ambiguous: set[str] = set()
    for store_id, name in db.execute(text("SELECT id, name FROM stores WHERE status = 'active'")):
        key = name.casefold()
        if key in stores:
            ambiguous.add(key)
        stores[key] = str(store_id)
    for key in ambiguous:
        del stores[key]  # never guess between ambiguous active names
    products, errors = validate_rows(
        rows,
        stores,
        _sku_keys(db, {skus.key(r["sku"]) for r in rows if r["sku"]}),
        _code_keys(db, {skus.key(r["product_code"]) for r in rows}),
        occupied_skus=lambda keys: _sku_keys(db, keys),
    )
    if errors:
        products = []  # nothing in a failed batch can be confirmed
    variants = [v for p in products for v in p.variants]
    batch = db.execute(
        text(
            "INSERT INTO import_batches (id, tenant_id, created_by_user_id, status, file_name, "
            "file_sha256, row_count, product_count, variant_count, opening_units, errors, payload) "
            "VALUES (:id, :tenant, :actor, :status, :name, :sha, :rows, :products, :variants, "
            " :units, CAST(:errors AS jsonb), CAST(:payload AS jsonb)) RETURNING " + _BATCH_FIELDS
        ),
        {
            "id": uuid.uuid4(),
            "tenant": actor.tenant_id,
            "actor": actor.user_id,
            "status": "failed" if errors else "previewed",
            "name": file_name.replace("\\", "/").rsplit("/", 1)[-1].replace("\x00", "")[:255],
            "sha": hashlib.sha256(data).digest(),
            "rows": len(rows),
            "products": len(products),
            "variants": len(variants),
            "units": sum(v.opening_quantity for v in variants),
            "errors": json.dumps(errors),
            "payload": None if errors else json.dumps([asdict(p) for p in products]),
        },
    ).one()
    return _batch_json(batch)


def get_batch(db: Session, batch_id: uuid.UUID) -> dict[str, Any] | None:
    batch = db.execute(
        text("SELECT " + _BATCH_FIELDS + " FROM import_batches WHERE id = :id"),  # noqa: S608
        {"id": batch_id},
    ).one_or_none()
    return _batch_json(batch) if batch else None


def _product_input(product: ImportProduct) -> catalog.ProductIn:
    return catalog.ProductIn(
        code=product.code,
        name_en=product.name_en,
        name_ar=product.name_ar,
        description_en=product.description_en,
        description_ar=product.description_ar,
        store_ids=[uuid.UUID(s) for s in product.store_ids],
        photo_ids=[],
        options=[
            catalog.OptionIn(
                None,
                name,
                [
                    catalog.ValueIn(None, label)
                    for label in dict.fromkeys(v.option_values[i] for v in product.variants)
                ],
            )
            for i, name in enumerate(product.options)
        ],
        variants=[
            catalog.VariantIn(
                None,
                v.option_values,
                v.sku,
                Decimal(v.price),
                v.currency,
                v.low_stock_level,
                None,
                v.opening_quantity,
            )
            for v in product.variants
        ],
    )


def _conflicts(db: Session, products: list[ImportProduct]) -> list[RowError]:
    codes = _code_keys(db, {skus.key(p.code) for p in products})
    sku_keys = _sku_keys(db, {skus.key(v.sku) for p in products for v in p.variants})
    store_ids = {uuid.UUID(s) for p in products for s in p.store_ids}
    # Keep active listings stable until the products have been written.
    active = (
        set(
            db.execute(
                text(
                    "SELECT id FROM stores WHERE id = ANY(:ids) AND status = 'active' "
                    "ORDER BY id FOR SHARE"
                ),
                {"ids": sorted(store_ids)},
            ).scalars()
        )
        if store_ids
        else set()
    )
    errors: list[RowError] = []
    for product in products:
        if any(uuid.UUID(store) not in active for store in product.store_ids):
            errors.append(
                {"row": product.variants[0].row, "column": "stores", "code": "unknown_store"}
            )
        for variant in product.variants:
            if skus.key(product.code) in codes:
                errors.append(
                    {"row": variant.row, "column": "product_code", "code": "product_code_in_use"}
                )
            if skus.key(variant.sku) in sku_keys:
                errors.append({"row": variant.row, "column": "sku", "code": "sku_in_use"})
    return sorted(errors, key=lambda err: err["row"])


def _import_conflict(errors: list[RowError]) -> ApiError:
    return ApiError(
        409, "import_conflict", "The catalog changed after preview", extra={"errors": errors}
    )


def confirm(db: Session, actor: catalog.Actor, batch_id: uuid.UUID) -> dict[str, Any] | None:
    batch = db.execute(
        text(
            f"SELECT {_BATCH_FIELDS}, payload FROM import_batches "  # noqa: S608 (static columns)
            "WHERE id = :id FOR UPDATE"
        ),
        {"id": batch_id},
    ).one_or_none()
    if batch is None:
        return None
    if batch.status == "committed":
        return _batch_json(batch)
    if batch.expires_at <= db.execute(text("SELECT clock_timestamp()")).scalar_one():
        raise ApiError(410, "import_expired", "The import preview has expired")
    if batch.status == "failed":
        raise ApiError(409, "import_has_errors", "Fix the CSV errors before confirming")
    products = [
        ImportProduct(**{**entry, "variants": [ImportVariant(**v) for v in entry["variants"]]})
        for entry in batch.payload
    ]
    # Serialize application catalog writes before rechecking the preview. The batch lock above
    # independently serializes retries of this same confirmation.
    catalog.lock_business(db, actor.tenant_id)
    if errors := _conflicts(db, products):
        raise _import_conflict(errors)
    try:
        with db.begin_nested():
            for product in products:
                catalog.create_product(db, actor, _product_input(product), import_batch_id=batch_id)
    except ApiError as exc:
        if exc.code not in ("product_code_in_use", "sku_in_use"):
            raise
        raise _import_conflict(_conflicts(db, products)) from None
    except IntegrityError as exc:
        constraint = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
        if constraint not in ("products_code_key_uq", "variants_sku_key_uq"):
            raise
        # The savepoint undid every product, so the lookup only reports competing rows.
        raise _import_conflict(_conflicts(db, products)) from None
    batch = db.execute(
        text(
            "UPDATE import_batches SET status = 'committed', payload = NULL, "  # noqa: S608
            "committed_at = clock_timestamp(), committed_by_user_id = :actor "
            "WHERE id = :id RETURNING " + _BATCH_FIELDS
        ),
        {"actor": actor.user_id, "id": batch_id},
    ).one()
    audit.record(
        db,
        tenant_id=actor.tenant_id,
        actor_type="user",
        actor_id=actor.user_id,
        event="catalog.imported",
        target_type="import_batch",
        target_id=batch_id,
        ip=actor.ip,
        data={
            "file_name": batch.file_name,
            "products": batch.product_count,
            "variants": batch.variant_count,
            "opening_units": batch.opening_units,
        },
    )
    return _batch_json(batch)
