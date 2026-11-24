"""T013 (M0), T016 (M1) — the permission map equals the written contracts.

The contract tables are parsed from the markdown files themselves (every feature's
``contracts/permissions.md``), so the code cannot drift from the documents the product owner
approved. M1's table overrides the same permissions' rows of M0's "Reserved for later
milestones" table; ``STORE_SCOPED`` is the union of the store-scoped rows of M0's enforced
table and M1's table.
"""

from __future__ import annotations

import itertools
import re
import uuid
from pathlib import Path

import pytest

from app.core.permissions import (
    ROLE_PERMISSIONS,
    STORE_SCOPED,
    Access,
    Decision,
    Policy,
    PolicyKind,
    Role,
    authenticated,
    operator_only,
    permissions_for,
    policy_of,
    public,
    require,
    start_tab_for,
    tabs_for,
)
from tests.paths import PERMISSIONS_CONTRACTS, feature_file

ROLE_COLUMNS = [Role.OWNER, Role.MANAGER, Role.SALES, Role.PACKING, Role.DISPATCH]
M0_CONTRACT = feature_file("001-platform-foundation", "contracts/permissions.md")
M1_CONTRACT = feature_file("002-native-catalog-inventory", "contracts/permissions.md")


def _table_after(contract: Path, heading: str) -> list[list[str]]:
    """Rows (as lists of cell strings) of the first table under a '## heading'."""
    text = contract.read_text(encoding="utf-8")
    section = text.split(f"## {heading}", 1)[1].split("\n## ", 1)[0]
    rows = [line for line in section.splitlines() if line.startswith("|")]
    body = rows[2:]  # skip header and separator
    return [[cell.strip() for cell in row.strip("|").split("|")] for row in body]


def _contract_matrix(contract: Path, heading: str) -> dict[str, tuple[set[Role], bool]]:
    """permission -> (roles that have it, store-scoped?)."""
    matrix: dict[str, tuple[set[Role], bool]] = {}
    for cells in _table_after(contract, heading):
        names = re.findall(r"`([a-z_.]+)`", cells[0])
        roles = {role for role, cell in zip(ROLE_COLUMNS, cells[1:6], strict=True) if cell == "✓"}
        scoped = cells[6] == "✓"
        for name in names:
            matrix[name] = (roles, scoped)
    return matrix


M0 = _contract_matrix(M0_CONTRACT, "M0 permissions (enforced now)")
RESERVED = {
    name: (roles, False)
    for name, (roles, _) in _contract_matrix(
        M0_CONTRACT, "Reserved for later milestones (defined now, not exercised in M0)"
    ).items()
}
M1 = _contract_matrix(M1_CONTRACT, "M1 permissions (enforced now)")
# M1's rows override the same permissions' rows of M0's reserved table.
CONTRACT = {**M0, **RESERVED, **M1}
CONTRACT_STORE_SCOPED = {name for name, (_, scoped) in {**M0, **M1}.items() if scoped}


def test_contract_files_were_parsed() -> None:
    assert PERMISSIONS_CONTRACTS == [M0_CONTRACT, M1_CONTRACT]
    assert len(M0) == 8
    assert "staff.manage_owners" in M0
    assert "order.confirm" in RESERVED and "order.create" in RESERVED
    assert set(M1) == {"catalog.view", "catalog.manage", "stock.adjust"}


def test_m1_rows_override_reserved_rows_and_change_no_grant() -> None:
    # Every M1 permission was reserved in M0, and no role gains or loses one (contract item 1).
    assert set(M1) <= set(RESERVED)
    for name, (roles, _) in M1.items():
        assert roles == RESERVED[name][0], name


def test_catalog_view_is_store_scoped_and_catalog_manage_and_stock_adjust_are_not() -> None:
    assert M1["catalog.view"][1] is True
    assert M1["catalog.manage"][1] is False
    assert M1["stock.adjust"][1] is False
    assert "catalog.view" in STORE_SCOPED
    assert "catalog.manage" not in STORE_SCOPED
    assert "stock.adjust" not in STORE_SCOPED


@pytest.mark.parametrize("permission", sorted(CONTRACT))
@pytest.mark.parametrize("role", ROLE_COLUMNS)
def test_each_cell_of_the_contract_table(role: Role, permission: str) -> None:
    expected_roles, _ = CONTRACT[permission]

    assert (permission in ROLE_PERMISSIONS[role]) is (role in expected_roles)


def test_code_defines_no_permission_that_is_not_in_the_contract() -> None:
    defined = set().union(*ROLE_PERMISSIONS.values())

    assert defined == set(CONTRACT)


def test_store_scoped_permissions_match_the_contract() -> None:
    assert CONTRACT_STORE_SCOPED == STORE_SCOPED == {"store.view", "catalog.view"}


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
    for tab, visible_to, _ in _table_after(M0_CONTRACT, "Shell tabs (M0)"):
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


# ---- endpoint policies (T024) ---------------------------------------------------------------


def test_each_policy_decorator_declares_its_policy() -> None:
    @public
    def a() -> None: ...

    @authenticated
    def b() -> None: ...

    @authenticated(self_only=True)
    def c() -> None: ...

    @require("staff.view")
    def d() -> None: ...

    @require("store.view", store_param="store_id")
    def e() -> None: ...

    @operator_only
    def f() -> None: ...

    assert policy_of(a) == Policy(PolicyKind.PUBLIC)
    assert policy_of(b) == Policy(PolicyKind.AUTHENTICATED)
    assert policy_of(c) == Policy(PolicyKind.AUTHENTICATED, self_only=True)
    assert policy_of(d) == Policy(PolicyKind.PERMISSION, permission="staff.view")
    assert policy_of(e) == Policy(
        PolicyKind.PERMISSION, permission="store.view", store_param="store_id"
    )
    assert policy_of(f) == Policy(PolicyKind.OPERATOR)


def test_decorators_return_the_same_function_so_order_with_route_does_not_matter() -> None:
    def view() -> None: ...

    assert require("staff.view")(view) is view


def test_undecorated_view_has_no_policy() -> None:
    def view() -> None: ...

    assert policy_of(view) is None
    assert policy_of(None) is None


def test_a_view_cannot_get_two_policies() -> None:
    with pytest.raises(ValueError, match="already"):

        @public
        @require("staff.view")
        def view() -> None: ...


def test_unknown_permission_is_rejected_when_declared() -> None:
    with pytest.raises(ValueError, match="unknown permission"):
        require("staff.fly")


def test_store_param_is_only_for_store_scoped_permissions() -> None:
    with pytest.raises(ValueError, match="not store-scoped"):
        require("staff.view", store_param="store_id")


# ---- M1: store scope applied to the data (T016, research R52) ------------------------------


def test_store_limited_user_is_denied_the_catalog_of_another_store() -> None:
    access = Access(roles=frozenset({Role.SALES}), all_stores=False, store_ids=frozenset({STORE_A}))

    assert access.check("catalog.view", store_id=STORE_A) is Decision.ALLOWED
    assert access.check("catalog.view", store_id=STORE_B) is Decision.STORE_DENIED
    assert access.check("catalog.view") is Decision.ALLOWED


@pytest.mark.parametrize("permission", ["catalog.manage", "stock.adjust"])
def test_catalog_management_ignores_the_store(permission: str) -> None:
    access = Access(roles=frozenset({Role.MANAGER}), all_stores=True, store_ids=frozenset())

    assert access.check(permission, store_id=STORE_B) is Decision.ALLOWED


def test_store_filtered_declaration_is_accepted_for_catalog_view() -> None:
    @require("catalog.view", store_filtered=True)
    def view() -> None: ...

    assert policy_of(view) == Policy(
        PolicyKind.PERMISSION, permission="catalog.view", store_filtered=True
    )
    assert policy_of(view).store_param is None  # type: ignore[union-attr]


def test_plain_require_is_not_store_filtered() -> None:
    @require("catalog.view")
    def view() -> None: ...

    assert policy_of(view).store_filtered is False  # type: ignore[union-attr]


@pytest.mark.parametrize("permission", ["catalog.manage", "stock.adjust", "staff.view"])
def test_store_filtered_is_only_for_store_scoped_permissions(permission: str) -> None:
    with pytest.raises(ValueError, match="not store-scoped"):
        require(permission, store_filtered=True)


def test_store_filtered_and_store_param_cannot_both_be_declared() -> None:
    with pytest.raises(ValueError, match="store_filtered"):
        require("store.view", store_param="store_id", store_filtered=True)


def test_store_view_keeps_its_store_param_behaviour() -> None:
    @require("store.view", store_param="store_id")
    def view() -> None: ...

    assert policy_of(view) == Policy(
        PolicyKind.PERMISSION, permission="store.view", store_param="store_id"
    )
    assert policy_of(view).store_filtered is False  # type: ignore[union-attr]
