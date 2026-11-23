"""Catalog search: matching, filters, keyset paging and counts (FR-009, FR-029, R49, R51).

* ``q`` matches the English and Arabic names, the product code and any variant's SKU with
  ``ILIKE '%q%'``; ``%``, ``_`` and ``\\`` in ``q`` are escaped, so they match themselves.
  ASCII letters match ignoring case (``lower()`` in the C locale folds only ASCII).
* Every query is limited by ``catalog.visible_products(access)`` (R52); ``status`` and
  ``no_photo`` are checked for permission by the API before this runs.
* Stock filters are product-level over active variants (R49): ``in_stock`` = some variant
  has available > 0; ``out`` = none has; ``low`` = some variant is low or out with an
  effective level above 0.
* Newest first, 20 per page, keyset cursor over ``(created_at, id)``: products added while
  someone scrolls never shift or repeat a page. The first page also carries ``counts``
  (``all``, ``in_stock``, ``low``, ``out``) for every filter except ``stock``.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.permissions import Access
from app.services.catalog import (
    is_manager,
    low_stock_default,
    visible_products,
    visible_stores_condition,
)
from app.services.settings import money

PAGE_SIZE = 20

Stock = Literal["in_stock", "low", "out"]


@dataclass(frozen=True)
class Query:
    q: str | None = None
    store_id: uuid.UUID | None = None
    stock: Stock | None = None
    status: Literal["active", "archived"] = "active"
    no_photo: bool = False
    after: tuple[datetime, uuid.UUID] | None = None


def escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


# Group the matching products together so PostgreSQL can join balances once rather than
# rescan them per product. Only active variants with a balance contribute; products
# without any such variants must still count as out of stock, but not as low.
def _with_stock(conditions: list[str], *, materialized: bool) -> str:
    materialization = "MATERIALIZED " if materialized else ""
    return (
        f"WITH product_stock AS {materialization}("  # noqa: S608
        "  SELECT p.id, p.code, p.name_en, p.name_ar, p.status, p.created_at, "
        "         count(b.inventory_item_id) AS variant_count, "
        "         COALESCE(sum(b.on_hand - b.allocated), 0) AS available_total, "
        "         COALESCE(bool_or(b.on_hand - b.allocated > 0), false) AS any_available, "
        "         COALESCE(bool_or(COALESCE(v.low_stock_level, :default_level) > 0 "
        "           AND b.on_hand - b.allocated <= COALESCE(v.low_stock_level, :default_level)), "
        "           false) AS any_low "
        "  FROM products p LEFT JOIN (variants v JOIN stock_balances b "
        "    ON b.inventory_item_id = v.inventory_item_id) "
        "    ON v.product_id = p.id AND v.status = 'active' "
        f"  WHERE {' AND '.join(conditions)} GROUP BY p.id) "
    )


_STOCK_FILTERS = {
    "in_stock": "p.any_available",
    "out": "NOT p.any_available",
    "low": "p.any_low",
}
_PAGE_ORDER = "ORDER BY p.created_at DESC, p.id DESC"


def _conditions(db: Session, access: Access, query: Query) -> tuple[list[str], dict[str, Any]]:
    visible, params = visible_products(access)
    conditions = [visible, "p.status = :status"]
    params = {**params, "status": query.status, "default_level": low_stock_default(db)}
    if query.q:
        variant_status = "" if is_manager(access) else " AND sv.status = 'active'"
        conditions.append(
            # lower(...) LIKE lower(...) can use the trigram indexes (R51); same meaning.
            "(lower(p.name_en) LIKE lower(:pattern) ESCAPE '\\' "  # noqa: S608
            "OR p.name_ar ILIKE :pattern ESCAPE '\\' "
            "OR p.code_key LIKE lower(:pattern) ESCAPE '\\' "
            "OR EXISTS (SELECT 1 FROM variants sv WHERE sv.product_id = p.id "
            f"AND sv.sku_key LIKE lower(:pattern) ESCAPE '\\'{variant_status}))"
        )
        params["pattern"] = f"%{escape_like(query.q)}%"
    if query.store_id is not None:
        conditions.append(
            "EXISTS (SELECT 1 FROM product_stores fps WHERE fps.product_id = p.id "
            "AND fps.store_id = :store_id)"
        )
        params["store_id"] = query.store_id
    if query.no_photo:
        conditions.append("NOT EXISTS (SELECT 1 FROM product_photos ph WHERE ph.product_id = p.id)")
    return conditions, params


def search(db: Session, access: Access, query: Query) -> dict[str, Any]:
    """The contract's ``ProductPage``."""
    conditions, params = _conditions(db, access, query)
    first_page = query.after is None
    if query.after is not None:
        conditions.append("(p.created_at, p.id) < (:after_at, :after_id)")
        params = {**params, "after_at": query.after[0], "after_id": query.after[1]}
    store_condition, store_params = visible_stores_condition(access)
    stock_filter = f"WHERE {_STOCK_FILTERS[query.stock]} " if query.stock is not None else ""
    page_sql = (
        "SELECT p.id, p.code, p.name_en, p.name_ar, p.status, p.created_at, "  # noqa: S608
        "  (SELECT ph.id FROM product_photos ph WHERE ph.product_id = p.id "
        "   ORDER BY ph.position LIMIT 1) AS main_photo_id, "
        "  ARRAY(SELECT ps.store_id FROM product_stores ps JOIN stores s "
        f"   ON s.id = ps.store_id WHERE ps.product_id = p.id AND {store_condition} "
        "   ORDER BY ps.store_id) AS store_ids, "
        "  p.variant_count, p.available_total, p.any_available, p.any_low "
        f"FROM product_stock p {stock_filter}{_PAGE_ORDER} LIMIT :limit"
    )
    stock_sql = _with_stock(conditions, materialized=first_page)
    if first_page:
        # Counts see the full grouped result; only the page sees the selected stock filter.
        # Start from the one counts row so an empty page still returns counts.
        statement = (
            f"{stock_sql}, stock_counts AS ("  # noqa: S608
            "SELECT count(*) AS total, "
            f"count(*) FILTER (WHERE {_STOCK_FILTERS['in_stock']}) AS in_stock, "
            f"count(*) FILTER (WHERE {_STOCK_FILTERS['low']}) AS low, "
            f"count(*) FILTER (WHERE {_STOCK_FILTERS['out']}) AS out "
            "FROM product_stock p) "
            "SELECT p.*, c.total, c.in_stock, c.low, c.out FROM stock_counts c "
            f"LEFT JOIN ({page_sql}) p ON true {_PAGE_ORDER}"
        )
    else:
        statement = stock_sql + page_sql
    rows = db.execute(
        text(statement),
        {**params, **store_params, "limit": PAGE_SIZE + 1},
    ).all()
    counts = None
    if first_page:
        row = rows[0]
        counts = {"all": row.total, "in_stock": row.in_stock, "low": row.low, "out": row.out}
        if row.id is None:
            rows = []
    more = len(rows) > PAGE_SIZE
    rows = rows[:PAGE_SIZE]
    prices = _prices(db, [row.id for row in rows])
    return {
        "items": [_summary(row, prices.get(row.id, [])) for row in rows],
        "next_cursor": (rows[-1].created_at, rows[-1].id) if more else None,
        "counts": counts,
    }


def _prices(db: Session, product_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[dict[str, str]]]:
    if not product_ids:
        return {}
    rows = db.execute(
        text(
            "SELECT product_id, currency, min(price) AS low, max(price) AS high FROM variants "
            "WHERE product_id = ANY(:ids) AND status = 'active' GROUP BY product_id, currency "
            "ORDER BY product_id, CASE currency WHEN 'USD' THEN 0 ELSE 1 END"
        ),
        {"ids": product_ids},
    ).all()
    prices: dict[uuid.UUID, list[dict[str, str]]] = {}
    for row in rows:
        prices.setdefault(row.product_id, []).append(
            {"currency": row.currency, "min": money(row.low), "max": money(row.high)}
        )
    return prices


def _summary(row: Any, prices: list[dict[str, str]]) -> dict[str, Any]:
    if not row.any_available:
        state = "out"
    elif row.any_low:
        state = "low"
    else:
        state = "ok"
    return {
        "id": str(row.id),
        "code": row.code,
        "name_en": row.name_en,
        "name_ar": row.name_ar,
        "status": row.status,
        "main_photo_id": str(row.main_photo_id) if row.main_photo_id else None,
        "store_ids": [str(s) for s in row.store_ids],
        "variant_count": row.variant_count,
        "available_total": int(row.available_total),
        "stock_state": state,
        "prices": prices,
    }
