"""T056 — owner and self protection on the staff API (FR-018, FR-019, FR-019a).

* Nobody changes their own roles, stores or status, or issues a reset link for themselves:
  403 ``cannot_modify_self``.
* A manager cannot invite an owner, grant ``owner``, or change, deactivate or reset an
  owner: 403 ``forbidden``, recorded as ``access.denied_permission``.
* The last active owner can never be demoted or deactivated: 409 ``last_owner``. Since the
  person acting on an owner is always an owner themselves, this can only be reached through
  a race (or a stale principal), so both are tested.
"""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from flask import Flask
from flask.testing import FlaskClient
from sqlalchemy import Engine

from app.config import Config
from app.core.db import engine_of
from app.core.tenancy import tenant_transaction
from app.errors import ApiError
from app.services import staff
from tests.dbsupport import TwoTenants
from tests.integration.us1_support import (
    CSRF,
    app_for,
    error,
    history,
    ok,
    owner_sql,
    owner_value,
    refused,
    shared_app_fixture,
)

UserClient = Callable[[uuid.UUID, uuid.UUID], FlaskClient]

STAFF = "/api/v1/staff"
INVITE = "/api/v1/staff/invitations"


@pytest.fixture()
def worlds(fresh_staffed_tenants: TwoTenants) -> TwoTenants:
    return fresh_staffed_tenants


@pytest.fixture(scope="module")
def shared_app(config: Config) -> Iterator[Flask]:
    yield from shared_app_fixture(config)


@pytest.fixture()
def app(shared_app: Flask, worlds: TwoTenants) -> Flask:
    return app_for(shared_app, worlds)


def _patch(client: FlaskClient, user_id: uuid.UUID, **body: Any) -> Any:
    return client.patch(f"{STAFF}/{user_id}", json=body, headers=CSRF)


def _active_owners(owner: Engine, tenant_id: uuid.UUID) -> int:
    return int(
        owner_value(
            owner,
            "SELECT count(*) FROM users WHERE tenant_id = :t AND status = 'active' "
            "AND 'owner' = ANY(roles)",
            t=tenant_id,
        )
    )


def _make_second_owner(owner: Engine, worlds: TwoTenants) -> uuid.UUID:
    """Turn the manager of business A into a second owner."""
    user = worlds.a.user("manager")
    owner_sql(owner, "UPDATE users SET roles = '{owner}' WHERE id = :u", u=user)
    return user


def _roles(owner: Engine, user_id: uuid.UUID) -> list[str]:
    return list(owner_value(owner, "SELECT roles FROM users WHERE id = :u", u=user_id))


# ---- nobody changes themselves -----------------------------------------------------------------


@pytest.mark.parametrize("role", ["owner", "manager"])
@pytest.mark.parametrize(
    "body",
    [{"roles": ["sales"]}, {"status": "inactive"}, {"all_stores": True}, {}],
    ids=["roles", "status", "stores", "empty"],
)
def test_nobody_changes_their_own_access(
    user_client: UserClient,
    owner_engine: Engine,
    worlds: TwoTenants,
    role: str,
    body: dict[str, Any],
) -> None:
    a = worlds.a
    me = a.user(role)

    refused(_patch(user_client(me, a.tenant_id), me, **body), 403, "cannot_modify_self")

    assert _roles(owner_engine, me) == [role]
    assert owner_value(owner_engine, "SELECT status FROM users WHERE id = :u", u=me) == "active"
    assert history(owner_engine, a.tenant_id, "user.roles_changed") == []


@pytest.mark.parametrize("role", ["owner", "manager"])
def test_nobody_issues_a_reset_link_for_themselves(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, role: str
) -> None:
    a = worlds.a
    me = a.user(role)

    refused(
        user_client(me, a.tenant_id).post(f"{STAFF}/{me}/password-reset", headers=CSRF),
        403,
        "cannot_modify_self",
    )

    assert owner_value(
        owner_engine, "SELECT count(*) FROM password_resets WHERE user_id = :u", u=me
    ) == (1 if role == "owner" else 0)  # the fixture's own row


# ---- managers and owners -----------------------------------------------------------------------


def _denied_owner_actions(owner: Engine, tenant_id: uuid.UUID) -> list[Any]:
    return [
        e
        for e in history(owner, tenant_id, "access.denied_permission")
        if e.data.get("permission") == "staff.manage_owners"
    ]


def test_a_manager_cannot_invite_an_owner(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    manager = user_client(a.user("manager"), a.tenant_id)

    refused(
        manager.post(
            INVITE,
            json={"name": "New Boss", "email": "boss@example.test", "roles": ["sales", "owner"]},
            headers=CSRF,
        ),
        403,
        "forbidden",
    )

    assert (
        owner_value(
            owner_engine,
            "SELECT count(*) FROM invitations WHERE invitee_email = 'boss@example.test'",
        )
        == 0
    )
    [entry] = _denied_owner_actions(owner_engine, a.tenant_id)
    assert entry.actor_id == a.user("manager")


def test_an_owner_can_invite_an_owner(user_client: UserClient, worlds: TwoTenants) -> None:
    a = worlds.a

    body = ok(
        user_client(a.user_id, a.tenant_id).post(
            INVITE,
            json={"name": "Partner", "email": "partner@example.test", "roles": ["owner"]},
            headers=CSRF,
        ),
        201,
    )

    assert (body["invitation"]["roles"], body["invitation"]["all_stores"]) == (["owner"], True)


@pytest.mark.parametrize(
    "body",
    [{"roles": ["sales", "owner"]}, {"roles": ["owner"]}],
    ids=["add-owner", "only-owner"],
)
def test_a_manager_cannot_grant_owner(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, body: dict[str, Any]
) -> None:
    a = worlds.a
    manager = user_client(a.user("manager"), a.tenant_id)

    refused(_patch(manager, a.user("sales"), **body), 403, "forbidden")

    assert _roles(owner_engine, a.user("sales")) == ["sales"]
    assert len(_denied_owner_actions(owner_engine, a.tenant_id)) == 1


@pytest.mark.parametrize(
    "body",
    [{"roles": ["manager"]}, {"status": "inactive"}, {"roles": ["owner", "sales"]}, {}],
    ids=["demote", "deactivate", "add-role", "empty"],
)
def test_a_manager_cannot_change_an_owner(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, body: dict[str, Any]
) -> None:
    a = worlds.a
    manager = user_client(a.user("manager"), a.tenant_id)
    owner_phone = user_client(a.user_id, a.tenant_id)
    ok(owner_phone.get("/api/v1/me"))

    refused(_patch(manager, a.user_id, **body), 403, "forbidden")

    assert _roles(owner_engine, a.user_id) == ["owner"]
    assert ok(owner_phone.get("/api/v1/me"))["user"]["roles"] == ["owner"]
    assert len(_denied_owner_actions(owner_engine, a.tenant_id)) == 1


def test_a_manager_cannot_issue_a_reset_link_for_an_owner(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    manager = user_client(a.user("manager"), a.tenant_id)

    refused(manager.post(f"{STAFF}/{a.user_id}/password-reset", headers=CSRF), 403, "forbidden")

    assert (
        owner_value(
            owner_engine, "SELECT count(*) FROM password_resets WHERE user_id = :u", u=a.user_id
        )
        == 1
    )  # only the fixture's own row
    assert len(_denied_owner_actions(owner_engine, a.tenant_id)) == 1


def test_a_manager_cannot_resend_or_revoke_an_owner_invitation(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    owner_sql(
        owner_engine, "UPDATE invitations SET roles = '{owner}' WHERE id = :i", i=a.invitation_id
    )
    manager = user_client(a.user("manager"), a.tenant_id)

    resend = manager.post(f"{INVITE}/{a.invitation_id}/resend", headers=CSRF)
    revoke = manager.delete(f"{INVITE}/{a.invitation_id}", headers=CSRF)

    # 403 is not (yet) documented for these two operations in the contract.
    assert [(r.status_code, error(r)) for r in (resend, revoke)] == [(403, "forbidden")] * 2
    assert (
        owner_value(owner_engine, "SELECT status FROM invitations WHERE id = :i", i=a.invitation_id)
        == "pending"
    )
    assert len(_denied_owner_actions(owner_engine, a.tenant_id)) == 2


def test_a_manager_can_reset_and_change_non_owners(
    user_client: UserClient, worlds: TwoTenants
) -> None:
    a = worlds.a
    manager = user_client(a.user("manager"), a.tenant_id)

    ok(manager.post(f"{STAFF}/{a.user('sales')}/password-reset", headers=CSRF), 201)
    ok(_patch(manager, a.user("sales"), status="inactive"))


def test_an_owner_can_promote_a_manager_to_owner_and_demote_another_owner(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    owner = user_client(a.user_id, a.tenant_id)

    promoted = ok(_patch(owner, a.user("manager"), roles=["owner"]))
    demoted = ok(_patch(owner, a.user("manager"), roles=["manager"]))

    assert promoted["roles"] == ["owner"] and promoted["all_stores"] is True
    assert demoted["roles"] == ["manager"]
    assert _active_owners(owner_engine, a.tenant_id) == 1


# ---- the last owner ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "change", [{"roles": ["manager"]}, {"status": "inactive"}], ids=["demote", "deactivate"]
)
def test_the_last_active_owner_cannot_be_demoted_or_deactivated(
    app: Flask, owner_engine: Engine, worlds: TwoTenants, change: dict[str, Any]
) -> None:
    """A principal loaded just before another owner was demoted still acts as an owner:
    the rule is enforced on what the database holds under the tenant lock."""
    a = worlds.a
    stale_owner = a.user("manager")  # was an owner when its request started

    with app.app_context(), tenant_transaction(engine_of(app), a.tenant_id) as db:
        with pytest.raises(ApiError) as refusal:
            staff.update_member(
                db,
                staff.Actor(user_id=stale_owner, tenant_id=a.tenant_id, manages_owners=True),
                a.user_id,
                staff.MemberChange(roles=change.get("roles"), status=change.get("status")),
            )

    assert (refusal.value.status, refusal.value.code) == (409, "last_owner")
    assert _active_owners(owner_engine, a.tenant_id) == 1
    assert _roles(owner_engine, a.user_id) == ["owner"]


def test_an_inactive_owner_does_not_count_as_an_owner(
    app: Flask, owner_engine: Engine, worlds: TwoTenants
) -> None:
    a = worlds.a
    second = _make_second_owner(owner_engine, worlds)
    owner_sql(owner_engine, "UPDATE users SET status = 'inactive' WHERE id = :u", u=second)

    with app.app_context(), tenant_transaction(engine_of(app), a.tenant_id) as db:
        with pytest.raises(ApiError) as refusal:
            staff.update_member(
                db,
                staff.Actor(user_id=second, tenant_id=a.tenant_id, manages_owners=True),
                a.user_id,
                staff.MemberChange(status="inactive"),
            )

    assert refusal.value.code == "last_owner"


@pytest.mark.parametrize(
    "change", [{"roles": ["manager"]}, {"status": "inactive"}], ids=["demote", "deactivate"]
)
def test_two_owners_removing_each_other_at_once_leave_one_owner(
    user_client: UserClient, owner_engine: Engine, worlds: TwoTenants, change: dict[str, Any]
) -> None:
    a = worlds.a
    second = _make_second_owner(owner_engine, worlds)
    pairs = [(a.user_id, second), (second, a.user_id)]
    clients = [user_client(actor, a.tenant_id) for actor, _ in pairs]
    barrier = threading.Barrier(2)
    results: list[Any] = [None, None]

    def send(index: int) -> None:
        barrier.wait()
        results[index] = _patch(clients[index], pairs[index][1], **change)

    threads = [threading.Thread(target=send, args=(i,)) for i in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    statuses = sorted(r.status_code for r in results)
    assert statuses[0] == 200, [r.get_json() for r in results]
    loser = next(r for r in results if r.status_code != 200)
    # The loser either waited for the tenant lock (409), or started after the winner
    # committed and is no longer an owner (403) or no longer signed in (401).
    assert (loser.status_code, loser.get_json()["error"]["code"]) in {
        (409, "last_owner"),
        (403, "forbidden"),
        (401, "unauthenticated"),
    }
    assert _active_owners(owner_engine, a.tenant_id) == 1
