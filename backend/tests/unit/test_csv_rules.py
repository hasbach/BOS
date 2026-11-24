# ruff: noqa: RUF001 — intentionally test non-ASCII digits and separators.
from app.services.catalog_import import parse_csv, validate_rows


def test_header_matching_and_later_rows_inherit_product_fields() -> None:
    data = (
        " PRODUCT_CODE , NAME_AR ,stores,option1_name,option1_value,price,currency\n"
        'A,قميص, main | AUX ,Colour,Red,"٨٩٬٥٠٠",LBP\n'
        "a,,,,Blue,2,USD\n"
    ).encode()
    products, errors = validate_rows(parse_csv(data), {"main": "store-a", "aux": "store-b"}, set())
    assert errors == []
    [product] = products
    assert product.name_ar == "قميص"
    assert set(product.store_ids) == {"store-a", "store-b"}
    assert [(v.sku, v.price, v.opening_quantity, v.low_stock_level) for v in product.variants] == [
        ("A-RED", "89500", 0, None),
        ("A-BLUE", "2", 0, None),
    ]


def test_collects_independent_errors_in_spreadsheet_rows() -> None:
    data = (
        "product_code,name_en,stores,option1_name,option1_value,sku,price,currency,"
        "opening_quantity,low_stock_level\n"
        "A,First,Main,Size,S,REF,10,USD,,\n"
        "A,Other,Missing,,S,ref,,EUR,-٢,1.2\n"
        "A,,,,,bad sku,2,USD,,\n"
        "?bad,B,,,,,1,USD,,\n"
    ).encode()
    _, errors = validate_rows(parse_csv(data), {"main": "store-a"}, set())
    assert {(e["row"], e["column"], e["code"]) for e in errors} == {
        (3, "name_en", "inconsistent_product"),
        (3, "stores", "inconsistent_product"),
        (3, "stores", "unknown_store"),
        (3, "option1_value", "duplicate_combination"),
        (3, "sku", "duplicate_in_file"),
        (3, "price", "required"),
        (3, "currency", "invalid_currency"),
        (3, "opening_quantity", "negative"),
        (3, "low_stock_level", "not_whole"),
        (4, "option1_value", "missing_option_value"),
        (4, "sku", "invalid"),
        (5, "product_code", "invalid"),
    }


def test_large_description_still_reports_all_row_errors() -> None:
    csv = f"product_code,name_en,description_en,price,currency\nA,Hat,{'x' * 200_000},,USD\n"
    _, errors = validate_rows(parse_csv(csv.encode()), {}, set())
    assert {(e["row"], e["column"], e["code"]) for e in errors} == {
        (2, "description_en", "too_long"),
        (2, "price", "required"),
    }


def test_suggestions_reserve_all_explicit_skus_and_catalog_keys() -> None:
    data = b"product_code,name_en,sku,price,currency\nA,N,,1,USD\nB,N,A,1,USD\nA-2,N,,1,USD\n"
    products, errors = validate_rows(parse_csv(data), {}, {"a-2"})
    assert errors == []
    assert [p.variants[0].sku for p in products] == ["A-3", "A", "A-2-2"]


def test_option_limits_and_full_matrix() -> None:
    header = (
        "product_code,name_en,option1_name,option1_value,option2_name,option2_value,"
        "price,currency\n"
    )
    data = header + "".join(f"A,N,X,{i},Y,{j},1,USD\n" for i in range(21) for j in range(5))
    _, errors = validate_rows(parse_csv(data.encode()), {}, set())
    assert {e["code"] for e in errors} == {"too_many_values", "too_many_variants"}
    sparse = header + "A,N,X,Red,Y,Small,1,USD\nA,,,Green,,Large,1,USD\n"
    _, errors = validate_rows(parse_csv(sparse.encode()), {}, set())
    assert [e["code"] for e in errors] == ["missing_option_value"]
    three = header + "A,N,X,Red,Y,Small,1,USD\nA,,Z,Green,,Large,1,USD\n"
    _, errors = validate_rows(parse_csv(three.encode()), {}, set())
    assert "too_many_options" in {e["code"] for e in errors}
