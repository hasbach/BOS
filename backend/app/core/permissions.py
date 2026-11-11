"""Roles, permissions and shell tabs.

This module is the code form of ``specs/001-platform-foundation/contracts/permissions.md``.
A test parses that document and fails if this map differs from it, so change the contract
first, then this file.
"""

from __future__ import annotations

import enum
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, overload


class Role(enum.StrEnum):
    OWNER = "owner"
    MANAGER = "manager"
    SALES = "sales"
    PACKING = "packing"
    DISPATCH = "dispatch"


_EVERYONE = frozenset(Role)
_OWNER = frozenset({Role.OWNER})
_MANAGEMENT = frozenset({Role.OWNER, Role.MANAGER})
_SELLING = _MANAGEMENT | {Role.SALES}
_PACKING = _MANAGEMENT | {Role.PACKING}
_DISPATCH = _MANAGEMENT | {Role.DISPATCH}

# permission -> roles that have it
_GRANTS: dict[str, frozenset[Role]] = {
    # --- M0: enforced now ---
    "business.view": _EVERYONE,
    "settings.manage": _MANAGEMENT,
    "store.view": _EVERYONE,
    "store.manage": _MANAGEMENT,
    "staff.view": _MANAGEMENT,
    "staff.manage": _MANAGEMENT,
    "staff.manage_owners": _OWNER,
    "audit.view": _OWNER,
    # --- Reserved for later milestones: defined now, not exercised in M0 ---
    "catalog.view": _EVERYONE,
    "catalog.manage": _MANAGEMENT,
    "stock.adjust": _MANAGEMENT,
    "order.create": _SELLING,
    "order.confirm": _SELLING,
    "order.cancel": _SELLING,
    "order.amend": _SELLING,
    "packing.work": _PACKING,
    "dispatch.work": _DISPATCH,
    "settlement.manage": _DISPATCH,
    "reports.view": _MANAGEMENT,
    "chat.view": _SELLING,
    "chat.send": _SELLING,
    "integration.manage": _OWNER,
}

ROLE_PERMISSIONS: dict[Role, frozenset[str]] = {
    role: frozenset(name for name, roles in _GRANTS.items() if role in roles) for role in Role
}

# Permissions that additionally require the action to concern one of the user's stores.
STORE_SCOPED: frozenset[str] = frozenset({"store.view"})

# Tab -> roles that see it, in display order.
_TABS: tuple[tuple[str, frozenset[Role]], ...] = (
    ("sales", _SELLING),
    ("packing", _PACKING),
    ("delivery", _DISPATCH),
    ("orders", _EVERYONE),
    ("more", _EVERYONE),
)


def permissions_for(roles: Iterable[Role]) -> frozenset[str]:
    """The union of the permissions of every role the user holds."""
    result: set[str] = set()
    for role in roles:
        result |= ROLE_PERMISSIONS[role]
    return frozenset(result)


def tabs_for(roles: Iterable[Role]) -> list[str]:
    held = frozenset(roles)
    return [tab for tab, visible_to in _TABS if visible_to & held]


def start_tab_for(roles: Iterable[Role]) -> str:
    """Owner/Manager -> Sales; otherwise Sales, then Packing, then Dispatch."""
    held = frozenset(roles)
    if held & _SELLING:
        return "sales"
    if Role.PACKING in held:
        return "packing"
    if Role.DISPATCH in held:
        return "delivery"
    return "more"


class Decision(enum.Enum):
    ALLOWED = "allowed"
    NO_PERMISSION = "no_permission"  # -> 403 forbidden, access.denied_permission
    STORE_DENIED = "store_denied"  # -> 404 not_found, access.denied_store


@dataclass(frozen=True)
class Access:
    """What one user may do: their roles and the stores they are limited to."""

    roles: frozenset[Role]
    all_stores: bool
    store_ids: frozenset[uuid.UUID]

    @property
    def permissions(self) -> frozenset[str]:
        return permissions_for(self.roles)

    @property
    def sees_all_stores(self) -> bool:
        # Owners and managers always have every store, whatever the stored flag says.
        return self.all_stores or bool(self.roles & _MANAGEMENT)

    def can_see_store(self, store_id: uuid.UUID) -> bool:
        return self.sees_all_stores or store_id in self.store_ids

    def check(self, permission: str, store_id: uuid.UUID | None = None) -> Decision:
        if permission not in self.permissions:
            return Decision.NO_PERMISSION
        if store_id is not None and permission in STORE_SCOPED and not self.can_see_store(store_id):
            return Decision.STORE_DENIED
        return Decision.ALLOWED


# ---- endpoint policies ----------------------------------------------------------------------
#
# Every view under /api/v1 declares exactly one policy. The decorators only *declare* it (they
# set an attribute and return the same function); ``app.core.request_context`` enforces it
# before the view runs and refuses any view that has none. The route-coverage test
# (tests/isolation/test_route_coverage.py) reads the same attribute.


class PolicyKind(enum.StrEnum):
    PUBLIC = "public"  # no session needed
    AUTHENTICATED = "authenticated"  # any signed-in, active business user
    PERMISSION = "permission"  # a signed-in business user holding one permission
    OPERATOR = "operator"  # a signed-in platform operator, only under /api/v1/ops/


@dataclass(frozen=True)
class Policy:
    kind: PolicyKind
    permission: str | None = None
    # Name of the view argument holding a store id the permission is checked against.
    store_param: str | None = None
    # Declares that an AUTHENTICATED route only touches the caller's own data, so it needs no
    # cross-tenant isolation case. Must be explicit.
    self_only: bool = False


POLICY_ATTR = "bos_policy"


class _Declarer:
    """A decorator that declares one policy and returns the view unchanged."""

    def __init__(self, policy: Policy) -> None:
        self.policy = policy

    def __call__[V: Callable[..., Any]](self, view: V, /) -> V:
        if getattr(view, POLICY_ATTR, None) is not None:
            raise ValueError(f"{view.__name__} already has an access policy")
        setattr(view, POLICY_ATTR, self.policy)
        return view


def policy_of(view: object) -> Policy | None:
    policy = getattr(view, POLICY_ATTR, None)
    return policy if isinstance(policy, Policy) else None


def public[V: Callable[..., Any]](view: V) -> V:
    """No session needed (health, sign-in, link preview...)."""
    return _Declarer(Policy(PolicyKind.PUBLIC))(view)


@overload
def authenticated[V: Callable[..., Any]](view: V, /) -> V: ...
@overload
def authenticated(*, self_only: bool = False) -> _Declarer: ...
def authenticated[V: Callable[..., Any]](
    view: V | None = None, /, *, self_only: bool = False
) -> V | _Declarer:
    """Any signed-in, active business user. Use for routes about the caller's own data."""
    declare = _Declarer(Policy(PolicyKind.AUTHENTICATED, self_only=self_only))
    return declare if view is None else declare(view)


def require(permission: str, store_param: str | None = None) -> _Declarer:
    """A signed-in business user with ``permission``.

    With ``store_param``, the view argument of that name is a store id, and the store must be
    one of the user's stores: otherwise 404 ``not_found`` and ``access.denied_store``.
    """
    if permission not in _GRANTS:
        raise ValueError(f"unknown permission {permission!r}")
    if store_param is not None and permission not in STORE_SCOPED:
        raise ValueError(f"{permission!r} is not store-scoped; store_param makes no sense")
    return _Declarer(Policy(PolicyKind.PERMISSION, permission=permission, store_param=store_param))


def operator_only[V: Callable[..., Any]](view: V) -> V:
    """A signed-in platform operator; the route must be under /api/v1/ops/."""
    return _Declarer(Policy(PolicyKind.OPERATOR))(view)
