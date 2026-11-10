"""Where tests find the written contracts they check the code against."""

from __future__ import annotations

import os
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]

SPECS_DIR = Path(os.environ.get("BOS_SPECS_DIR") or _REPO_ROOT / "specs")
FEATURE_DIR = SPECS_DIR / "001-platform-foundation"
PERMISSIONS_CONTRACT = FEATURE_DIR / "contracts" / "permissions.md"
OPENAPI_CONTRACT = FEATURE_DIR / "contracts" / "openapi.yaml"
