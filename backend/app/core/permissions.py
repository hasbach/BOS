"""Roles, permissions and shell tabs.

This module is the code form of ``specs/001-platform-foundation/contracts/permissions.md``.
A test parses that document and fails if this map differs from it, so change the contract
first, then this file.
"""

from __future__ import annotations

import enum
import uuid
from collections.abc import Iterable
from dataclasses import dataclass


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
