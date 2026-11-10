"""T013 — the permission map equals the written contract (contracts/permissions.md).

The contract tables are parsed from the markdown file itself, so the code cannot drift from
the document the product owner approved.
"""

from __future__ import annotations

import itertools
import re
import uuid

import pytest

from app.core.permissions import (
    ROLE_PERMISSIONS,
    STORE_SCOPED,
    Access,
    Decision,
    Role,
    permissions_for,
    start_tab_for,
    tabs_for,
)
from tests.paths import PERMISSIONS_CONTRACT

ROLE_COLUMNS = [Role.OWNER, Role.MANAGER, Role.SALES, Role.PACKING, Role.DISPATCH]


def _table_after(heading: str) -> list[list[str]]:
    """Rows (as lists of cell strings) of the first table under a '## heading'."""
    text = PERMISSIONS_CONTRACT.read_text(encoding="utf-8")
    section = text.split(f"## {heading}", 1)[1].split("\n## ", 1)[0]
    rows = [line for line in section.splitlines() if line.startswith("|")]
    body = rows[2:]  # skip header and separator
    return [[cell.strip() for cell in row.strip("|").split("|")] for row in body]


def _contract_matrix(heading: str) -> dict[str, tuple[set[Role], bool]]:
    """permission -> (roles that have it, store-scoped?)."""
    matrix: dict[str, tuple[set[Role], bool]] = {}
    for cells in _table_after(heading):
        names = re.findall(r"`([a-z_.]+)`", cells[0])
        roles = {role for role, cell in zip(ROLE_COLUMNS, cells[1:6], strict=True) if cell == "✓"}
        scoped = cells[6] == "✓"
        for name in names:
            matrix[name] = (roles, scoped)
    return matrix


M0 = _contract_matrix("M0 permissions (enforced now)")
RESERVED = {
    name: (roles, False)
    for name, (roles, _) in _contract_matrix(
        "Reserved for later milestones (defined now, not exercised in M0)"
    ).items()
}
CONTRACT = {**M0, **RESERVED}


def test_contract_file_was_parsed() -> None:
    assert len(M0) == 8
    assert "staff.manage_owners" in M0
    assert "order.confirm" in RESERVED and "order.create" in RESERVED


@pytest.mark.parametrize("permission", sorted(CONTRACT))
@pytest.mark.parametrize("role", ROLE_COLUMNS)
def test_each_cell_of_the_contract_table(role: Role, permission: str) -> None:
    expected_roles, _ = CONTRACT[permission]

    assert (permission in ROLE_PERMISSIONS[role]) is (role in expected_roles)


def test_code_defines_no_permission_that_is_not_in_the_contract() -> None:
    defined = set().union(*ROLE_PERMISSIONS.values())

    assert defined == set(CONTRACT)


def test_store_scoped_permissions_match_the_contract() -> None:
    assert {name for name, (_, scoped) in M0.items() if scoped} == STORE_SCOPED


def test_permissions_are_the_union_of_roles() -> None:
    combined = permissions_for([Role.SALES, Role.PACKING])

    assert combined == ROLE_PERMISSIONS[Role.SALES] | ROLE_PERMISSIONS[Role.PACKING]
    assert "order.create" in combined and "packing.work" in combined
    assert "staff.manage" not in combined


def test_no_roles_means_no_permissions() -> None:
    assert permissions_for([]) == frozenset()


STORE_A, STORE_B = uuid.uuid4(), uuid.uuid4()


def test_missing_permission_is_reported_as_such() -> None:
    access = Access(roles=frozenset({Role.SALES}), all_stores=True, store_ids=frozenset())

    assert access.check("staff.manage") is Decision.NO_PERMISSION


def test_store_limited_user_is_allowed_on_their_store_and_denied_on_another() -> None:
    access = Access(roles=frozenset({Role.SALES}), all_stores=False, store_ids=frozenset({STORE_A}))

    assert access.check("store.view", store_id=STORE_A) is Decision.ALLOWED
    assert access.check("store.view", store_id=STORE_B) is Decision.STORE_DENIED


def test_all_stores_user_passes_store_scope_everywhere() -> None:
    access = Access(roles=frozenset({Role.PACKING}), all_stores=True, store_ids=frozenset())

    assert access.check("store.view", store_id=STORE_B) is Decision.ALLOWED


@pytest.mark.parametrize("role", [Role.OWNER, Role.MANAGER])
def test_owners_and_managers_always_have_all_stores(role: Role) -> None:
    # Even if the stored flag were wrong, the rule from the contract holds.
    access = Access(roles=frozenset({role}), all_stores=False, store_ids=frozenset())

    assert access.sees_all_stores is True
    assert access.check("store.view", store_id=STORE_B) is Decision.ALLOWED


def test_permission_without_store_scope_ignores_the_store() -> None:
    access = Access(roles=frozenset({Role.MANAGER}), all_stores=True, store_ids=frozenset())

    assert access.check("store.manage", store_id=STORE_B) is Decision.ALLOWED


def test_store_scoped_permission_checked_without_a_store_only_tests_the_permission() -> None:
    access = Access(roles=frozenset({Role.SALES}), all_stores=False, store_ids=frozenset({STORE_A}))

    assert access.check("store.view") is Decision.ALLOWED


def test_missing_permission_wins_over_store_denial() -> None:
    access = Access(roles=frozenset(), all_stores=False, store_ids=frozenset())

    assert access.check("store.view", store_id=STORE_A) is Decision.NO_PERMISSION


TAB_NAMES = {
    "Sales": "sales",
    "Packing": "packing",
    "Delivery": "delivery",
    "Orders": "orders",
    "More": "more",
}
ROLE_NAMES = {
    "Owner": Role.OWNER,
    "Manager": Role.MANAGER,
    "Sales": Role.SALES,
    "Packing": Role.PACKING,
    "Dispatch": Role.DISPATCH,
}


def _tab_visibility() -> dict[str, set[Role]]:
    visibility: dict[str, set[Role]] = {}
    for tab, visible_to, _ in _table_after("Shell tabs (M0)"):
        if visible_to == "everyone":
            visibility[TAB_NAMES[tab]] = set(ROLE_COLUMNS)
        else:
            visibility[TAB_NAMES[tab]] = {
                ROLE_NAMES[name.strip()] for name in visible_to.split(",")
            }
    return visibility


ALL_ROLE_SETS = [
    frozenset(combo)
    for size in range(1, len(ROLE_COLUMNS) + 1)
    for combo in itertools.combinations(ROLE_COLUMNS, size)
]


@pytest.mark.parametrize(
    "roles", ALL_ROLE_SETS, ids=lambda rs: "+".join(sorted(r.value for r in rs))
)
def test_tabs_for_every_role_combination_match_the_contract(roles: frozenset[Role]) -> None:
    visibility = _tab_visibility()
    expected = [
        tab for tab in ["sales", "packing", "delivery", "orders", "more"] if visibility[tab] & roles
    ]

    assert tabs_for(roles) == expected


@pytest.mark.parametrize(
    ("roles", "expected"),
    [
        ({Role.OWNER}, "sales"),
        ({Role.MANAGER}, "sales"),
        ({Role.MANAGER, Role.PACKING}, "sales"),
        ({Role.SALES}, "sales"),
        ({Role.PACKING}, "packing"),
        ({Role.DISPATCH}, "delivery"),
        ({Role.SALES, Role.PACKING}, "sales"),
        ({Role.PACKING, Role.DISPATCH}, "packing"),
    ],
)
def test_start_tab_follows_the_contract_order(roles: set[Role], expected: str) -> None:
    assert start_tab_for(roles) == expected


def test_start_tab_is_always_one_of_the_visible_tabs() -> None:
    for roles in ALL_ROLE_SETS:
        assert start_tab_for(roles) in tabs_for(roles)
