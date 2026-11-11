"""Contract-test fixtures (T032). The checks themselves live in ``tests.contract.support`` so
that endpoint tests in other folders can import ``assert_matches_contract`` directly."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from tests.contract.support import assert_matches_contract


@pytest.fixture()
def contract() -> Callable[[Any], None]:
    """``contract(response)``: fail unless the response matches the contract."""
    return assert_matches_contract
