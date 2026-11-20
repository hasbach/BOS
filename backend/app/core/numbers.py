"""Strict decimal syntax for human-entered CSV cells (R48, R53)."""

import re

_TRANSLATE = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹\u066b\u066c", "01234567890123456789.,")
_WHOLE = re.compile(r"[0-9]+")
_PRICE = re.compile(r"(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?")


def normalise_number(raw: str, *, whole: bool = False) -> str:
    """Return ASCII digits with an optional decimal point, or raise ValueError."""
    cell = raw.strip().translate(_TRANSLATE)
    if not (_WHOLE if whole else _PRICE).fullmatch(cell):
        raise ValueError("invalid numeric cell")
    return cell.replace(",", "")
