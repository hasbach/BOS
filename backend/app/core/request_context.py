"""The life of one ``/api/v1`` request (T026, constitution Principle I).

1. State-changing methods must carry the CSRF header (403 ``csrf_required``).
2. The view's declared policy is read (``app.core.permissions``). A view without one never
   runs. ``@public`` views get no session and no request transaction.
3. The session cookie is resolved to a server-side session (``app.core.sessions``).
4. ONE transaction is opened for the request (``g.db``) and given either the session's tenant
   context or operator context. The user (or operator) is re-read from the database on every
   request, so a role change or a deactivation applies on the very next request.
5. The policy is enforced; refusals of signed-in users are recorded in the business's own
   history, in a separate transaction so they survive the refused request's rollback.
6. After the view: commit if the response status is below 400, otherwise roll back. The
   transaction is always closed, which also forgets the tenant context, so nothing leaks to
   the next request that reuses the pooled connection. A lock timeout or deadlock, in the
   view (``app.errors``) or at commit (here), is answered 503 ``try_again`` with
   ``Retry-After: 1`` and nothing applied (research R42).
7. Only after a successful commit, callbacks registered with ``on_commit`` run (for
   example sending an email), so nothing leaves the system for work that was rolled back.
   Callbacks registered with ``on_rollback`` run instead when the transaction does not
   commit (for example removing a file written for work that was then rolled back).

Operators exist only under ``/api/v1/ops/``; business users never do. A session of the
wrong kind for an area gets 404 ``not_found``, so neither area reveals the other.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, ClassVar, Literal, NoReturn

from flask import Flask, Response, current_app, g, jsonify, request
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core import audit, sessions
from app.core.db import get_engine, transaction
from app.core.permissions import Access, Decision, Policy, PolicyKind, Role, policy_of
from app.core.security import csrf_ok
from app.core.sessions import SessionRecord
from app.core.tenancy import enter_operator, enter_tenant
from app.errors import ApiError, error_body, is_lock_error, try_again_response

API_PREFIX = "/api/v1/"
OPS_PREFIX = "/api/v1/ops/"

log = logging.getLogger("bos.request_context")


@dataclass(frozen=True)
class UserPrincipal:
    """A signed-in business user, as re-read from the database for this request."""

    session_id: uuid.UUID
    user_id: uuid.UUID
    tenant_id: uuid.UUID
    name: str
    locale: str
    roles: frozenset[Role]
    access: Access
    is_operator: ClassVar[bool] = False


@dataclass(frozen=True)
class OperatorPrincipal:
    """A signed-in platform operator."""

    session_id: uuid.UUID
    operator_id: uuid.UUID
    name: str
    email: str
    is_operator: ClassVar[bool] = True


Principal = UserPrincipal | OperatorPrincipal


def _not_found() -> ApiError:
    # Same body as Flask's own 404 for an unknown URL (see app.errors).
    return ApiError(404, "not_found", "Not Found")


def _unauthenticated() -> ApiError:
    return ApiError(401, "unauthenticated", "Sign-in required")


# ---- what views use -------------------------------------------------------------------------


def current_principal() -> Principal | None:
    principal = g.get("principal")
    assert principal is None or isinstance(principal, UserPrincipal | OperatorPrincipal)
    return principal


def current_user() -> UserPrincipal:
    principal = current_principal()
    if not isinstance(principal, UserPrincipal):
        raise _unauthenticated()
    return principal


def current_operator() -> OperatorPrincipal:
    principal = current_principal()
    if not isinstance(principal, OperatorPrincipal):
        raise _unauthenticated()
    return principal


def request_db() -> Session:
    """The request's transaction (signed-in requests only)."""
    db = g.get("db")
    if not isinstance(db, Session):
        raise RuntimeError("this request has no transaction (public route?)")
    return db


def on_commit(callback: Callable[[], object]) -> None:
    """Run ``callback`` once this request's transaction has committed (signed-in requests).

    For effects outside the database, such as sending an email: they must never happen for
    work that is then rolled back. Callbacks run in the order given, only after a successful
    commit, never after a rollback. A callback that fails is logged and does not change the
    response (the database work is already saved).
    """
    request_db()  # only requests with a transaction have a commit to wait for
    callbacks: list[Callable[[], object]] = g.setdefault("on_commit", [])
    callbacks.append(callback)


def on_rollback(callback: Callable[[], object]) -> None:
    """Run ``callback`` if this request's transaction does not commit (signed-in requests).

    The undo for an effect made outside the database *before* the commit, such as a file
    written to storage that the transaction is about to reference: if the work is rolled
    back (an error response, an exception, or a failed commit), the file is removed again.
    Callbacks run in the order given; a callback that fails is logged.
    """
    request_db()
    callbacks: list[Callable[[], object]] = g.setdefault("on_rollback", [])
    callbacks.append(callback)


def not_found_in_tenant(
    target_type: str | None = None, target_id: uuid.UUID | None = None
) -> NoReturn:
    """Refuse a record the caller's business does not have: 404 ``not_found``.

    Call it whenever a looked-up record is not found. Row-level security hides other
    businesses' rows, so "missing" and "belongs to someone else" cannot be told apart, and
    must not be: both are answered identically and recorded as ``access.denied_tenant``.
    """
    principal = current_principal()
    if isinstance(principal, UserPrincipal):
        _record_denied(
            principal, "access.denied_tenant", target_type=target_type, target_id=target_id
        )
    raise _not_found()


def not_found_in_store(store_id: uuid.UUID, permission: str) -> NoReturn:
    """Refuse a store the caller may not work in: 404 ``not_found``, ``access.denied_store``.

    The same answer and record as the permission decorator's store check, for rules it
    cannot express (a store-limited user and a store that has been deactivated).
    """
    principal = current_principal()
    if isinstance(principal, UserPrincipal):
        _record_denied(
            principal, "access.denied_store", permission=permission, store_id=str(store_id)
        )
    raise _not_found()


def not_found_in_scope(target_type: str, target_id: uuid.UUID, permission: str) -> NoReturn:
    """Refuse a record of this business that lies outside the caller's stores: 404 ``not_found``.

    For ``store_filtered`` routes (research R52): the record exists in the caller's business
    but none of its stores is one the caller may work in. The answer is identical to a
    missing record (``not_found_in_tenant``); the refusal is recorded as
    ``access.denied_store`` with the permission and the target.
    """
    principal = current_principal()
    if isinstance(principal, UserPrincipal):
        _record_denied(
            principal,
            "access.denied_store",
            target_type=target_type,
            target_id=target_id,
            permission=permission,
        )
    raise _not_found()


RefusalCode = Literal["forbidden", "cannot_modify_self"]

_REFUSAL_MESSAGES: dict[str, str] = {
    "forbidden": "Not allowed",
    "cannot_modify_self": "You cannot change your own access",
}


def refuse(
    code: RefusalCode,
    *,
    target_type: str | None = None,
    target_id: uuid.UUID | None = None,
    **data: Any,
) -> NoReturn:
    """Refuse an action on a visible record that a rule forbids: 403 with ``code``.

    For checks a route's declared permission cannot express (a manager acting on an owner,
    anyone acting on themselves). Recorded as ``access.denied_permission`` with ``data`` (for
    example the permission that was missing), like a refusal by the declared permission.
    """
    principal = current_principal()
    if isinstance(principal, UserPrincipal):
        _record_denied(
            principal,
            "access.denied_permission",
            target_type=target_type,
            target_id=target_id,
            **data,
        )
    raise ApiError(403, code, _REFUSAL_MESSAGES[code])


# ---- lifecycle --------------------------------------------------------------------------------


def register_request_context(app: Flask) -> None:
    app.before_request(_before)
    app.after_request(_after)
    app.teardown_request(_teardown)


def _is_api(path: str) -> bool:
    return path.startswith(API_PREFIX)


def _is_ops(path: str) -> bool:
    return path.startswith(OPS_PREFIX)


def _before() -> None:
    g.principal = None
    if not _is_api(request.path):
        return
    rule = request.url_rule
    if rule is None:
        return  # unknown URL or method: Flask answers 404 / 405 with the usual envelope
    if not csrf_ok(request.method, request.headers):
        raise ApiError(403, "csrf_required", "Missing X-BOS-CSRF header")
    policy = policy_of(current_app.view_functions.get(rule.endpoint))
    if policy is None:
        # Fail closed. The route-coverage test catches this before it can ship.
        log.error("route %s has no access policy; refusing", rule.rule)
        raise ApiError(500, "internal_error", "Internal error")
    if policy.kind is PolicyKind.PUBLIC:
        return
    _authenticate(policy)


def _authenticate(policy: Policy) -> None:
    db = Session(get_engine(), expire_on_commit=False)
    db.begin()
    g.db = db

    wants_operator = policy.kind is PolicyKind.OPERATOR
    ops_area = _is_ops(request.path)
    record = _find_session(db, ops_area=ops_area)
    if record is None:
        raise _unauthenticated()
    if record.is_operator is not wants_operator or wants_operator is not ops_area:
        raise _not_found()

    if record.is_operator:
        g.principal = _load_operator(db, record)
        return
    principal = _load_user(db, record)
    g.principal = principal
    if policy.kind is PolicyKind.PERMISSION:
        _check_permission(principal, policy)


def _find_session(db: Session, *, ops_area: bool) -> SessionRecord | None:
    """The live session of the cookie for this area first, then of the other cookie.

    Looking at the other cookie too is what lets a session of the wrong kind be answered
    with 404 rather than 401. A cookie only counts if it holds a session of its own kind.
    """
    names = (
        (sessions.OPERATOR_COOKIE, sessions.USER_COOKIE)
        if ops_area
        else (sessions.USER_COOKIE, sessions.OPERATOR_COOKIE)
    )
    for name in names:
        token = request.cookies.get(name)
        if not token:
            continue
        record = sessions.lookup(db, token)
        if record is not None and record.is_operator is (name == sessions.OPERATOR_COOKIE):
            return record
    return None


def _load_user(db: Session, record: SessionRecord) -> UserPrincipal:
    assert record.user_id is not None and record.tenant_id is not None
    enter_tenant(db, record.tenant_id)
    user = db.execute(
        text(
            "SELECT id, name, locale, roles, all_stores, status FROM users "
            "WHERE id = :id AND tenant_id = :tenant_id"
        ),
        {"id": record.user_id, "tenant_id": record.tenant_id},
    ).one_or_none()
    if user is None or user.status != "active":
        _revoke(record)
        raise _unauthenticated()
    tenant_status = db.execute(
        text("SELECT status FROM tenants WHERE id = :id"), {"id": record.tenant_id}
    ).scalar_one_or_none()
    if tenant_status is None:
        raise _unauthenticated()
    if tenant_status == "suspended":
        raise ApiError(403, "business_suspended", "This business is suspended")
    if tenant_status != "active":
        raise ApiError(403, "business_pending", "This business is not active yet")
    store_ids = db.execute(
        text("SELECT store_id FROM user_stores WHERE user_id = :id"), {"id": record.user_id}
    ).scalars()
    roles = frozenset(Role(role) for role in user.roles)
    return UserPrincipal(
        session_id=record.id,
        user_id=record.user_id,
        tenant_id=record.tenant_id,
        name=user.name,
        locale=user.locale,
        roles=roles,
        access=Access(roles=roles, all_stores=user.all_stores, store_ids=frozenset(store_ids)),
    )


def _load_operator(db: Session, record: SessionRecord) -> OperatorPrincipal:
    from app import get_config

    assert record.operator_id is not None
    enter_operator(db)
    operator = db.execute(
        text("SELECT id, name, email, is_active FROM operators WHERE id = :id"),
        {"id": record.operator_id},
    ).one_or_none()
    allowed = get_config(current_app).operator_emails
    if operator is None or not operator.is_active or operator.email not in allowed:
        _revoke(record)
        raise _unauthenticated()
    return OperatorPrincipal(
        session_id=record.id,
        operator_id=operator.id,
        name=operator.name,
        email=operator.email,
    )


def _check_permission(principal: UserPrincipal, policy: Policy) -> None:
    assert policy.permission is not None
    store_id = _store_argument(policy.store_param) if policy.store_param else None
    decision = principal.access.check(policy.permission, store_id)
    if decision is Decision.NO_PERMISSION:
        _record_denied(principal, "access.denied_permission", permission=policy.permission)
        raise ApiError(403, "forbidden", "Not allowed")
    if decision is Decision.STORE_DENIED:
        _record_denied(
            principal,
            "access.denied_store",
            permission=policy.permission,
            store_id=str(store_id),
        )
        raise _not_found()


def _store_argument(name: str) -> uuid.UUID:
    args = request.view_args or {}
    if name not in args:
        raise RuntimeError(f"route {request.url_rule} has no argument {name!r}")
    value = args[name]
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except ValueError:
        raise _not_found() from None


def _record_denied(
    principal: UserPrincipal,
    event: Literal["access.denied_permission", "access.denied_tenant", "access.denied_store"],
    *,
    target_type: str | None = None,
    target_id: uuid.UUID | None = None,
    **data: Any,
) -> None:
    _abandon_request_transaction()
    # Path only: the query string may hold personal data.
    audit.record_denied(
        get_engine(),
        tenant_id=principal.tenant_id,
        actor_id=principal.user_id,
        event=event,
        target_type=target_type,
        target_id=target_id,
        data={"path": request.path, "method": request.method, **data},
        ip=request.remote_addr,
    )


def _abandon_request_transaction() -> None:
    """Roll back the request's work before a refusal is written on another connection.

    The request is about to fail, so its work would be rolled back anyway. Doing it first
    releases its row locks (for example the session's ``last_seen_at`` update, or a lock on
    the tenant row that the history insert's foreign-key check would wait for), so the
    second connection can never wait on the first.
    """
    db = g.get("db")
    if isinstance(db, Session):
        db.rollback()


def _revoke(record: SessionRecord) -> None:
    """End a session that may no longer be used; its own transaction survives the refusal."""
    _abandon_request_transaction()
    with transaction(get_engine()) as db:
        sessions.revoke(db, record.id, user_id=record.user_id, operator_id=record.operator_id)


def _after(response: Response) -> Response:
    db = g.pop("db", None)
    callbacks: list[Callable[[], object]] = g.pop("on_commit", [])
    undo: list[Callable[[], object]] = g.pop("on_rollback", [])
    if db is None:
        return response
    committed = False
    try:
        if response.status_code < 400:
            db.commit()
            committed = True
        else:
            db.rollback()
    except Exception as exc:
        if is_lock_error(exc):
            # A lock timeout or deadlock at commit: nothing was applied (research R42).
            log.warning("lock timeout or deadlock at commit; answered try_again")
            response = try_again_response()
        else:
            log.exception("could not finish the request transaction")
            response = jsonify(error_body("internal_error", "Internal error"))
            response.status_code = 500
    finally:
        db.close()
    if committed:
        _run_after_commit(callbacks)
    else:
        _run_callbacks(undo, "a callback run after rollback failed")
    return response


def _run_after_commit(callbacks: list[Callable[[], object]]) -> None:
    _run_callbacks(callbacks, "a callback run after commit failed")


def _run_callbacks(callbacks: list[Callable[[], object]], failure: str) -> None:
    for callback in callbacks:
        try:
            callback()
        except Exception:
            log.exception(failure)


def _teardown(exc: BaseException | None) -> None:
    g.pop("on_commit", None)  # never run for a request that did not finish normally
    undo: list[Callable[[], object]] = g.pop("on_rollback", [])
    db = g.pop("db", None)
    if db is not None:
        db.close()  # rolls back anything not committed
    # Only here when the request ended without passing through ``_after``: nothing committed.
    _run_callbacks(undo, "a callback run after rollback failed")
