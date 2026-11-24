"""Route-coverage harness (T011, research R31).

Every ``/api/v1`` route must declare an access policy (``app.core.permissions``), and every
route that is not public must have tests that try to break isolation. A test proves one such
case and says so with ``covers``::

    @covers("GET", "/api/v1/stores/<uuid:store_id>", "cross_tenant")
    def test_store_of_another_business_is_not_found(...): ...

The rule is written exactly as Flask prints it (``rule.rule``, converters included).

Required cases per (method, rule):

* ``@public``                      — none.
* ``@authenticated``                — ``cross_tenant``, unless declared ``self_only=True``.
* ``@require(p)``                   — ``cross_tenant`` and ``missing_permission``.
* ``@require(p, store_param=...)``  — also ``cross_store``.
* ``@require(p, store_filtered=True)`` — also ``cross_store`` (the store scope is applied to
  the data, research R52).
* ``@operator_only``                — ``tenant_user_refused``.

Besides missing cases the harness reports: ``policy`` (no declared policy), ``ops_area``
(an operator route outside ``/api/v1/ops/`` or a business-user route inside it),
``store_param`` (the declared store argument is not part of the rule) and
``no_such_route`` (a registered case for a route or method that does not exist).
"""

from __future__ import annotations

import importlib
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeVar

from flask import Flask

from app.core.permissions import PolicyKind, policy_of

API_PREFIX = "/api/v1/"
OPS_PREFIX = "/api/v1/ops/"
CASE_KINDS = frozenset({"cross_tenant", "missing_permission", "cross_store", "tenant_user_refused"})
_IGNORED_METHODS = frozenset({"HEAD", "OPTIONS"})
_TESTS_DIR = Path(__file__).resolve().parents[1]

_Test = TypeVar("_Test", bound=Callable[..., Any])


@dataclass(frozen=True, order=True)
class Case:
    method: str
    rule: str
    kind: str

    def __str__(self) -> str:
        return f"({self.method}, {self.rule}, {self.kind})"


@dataclass
class Registry:
    cases: set[Case] = field(default_factory=set)

    def covers(self, method: str, rule: str, *kinds: str) -> Callable[[_Test], _Test]:
        """Mark a test as proving the given isolation case(s) for one route."""
        if not kinds:
            raise ValueError("give at least one isolation case kind")
        for kind in kinds:
            if kind not in CASE_KINDS:
                raise ValueError(f"unknown isolation case kind {kind!r}")
        new = {Case(method.upper(), rule, kind) for kind in kinds}

        def register(test: _Test) -> _Test:
            self.cases |= new
            return test

        return register


REGISTRY = Registry()
covers = REGISTRY.covers


def load_all_cases() -> frozenset[Case]:
    """Import every test module (so each registers its cases) and return all cases.

    Importing explicitly makes the result the same whether pytest collected the whole suite
    or only this folder.
    """
    for path in sorted(_TESTS_DIR.rglob("test_*.py")):
        relative = path.relative_to(_TESTS_DIR.parent).with_suffix("")
        importlib.import_module(".".join(relative.parts))
    return frozenset(REGISTRY.cases)


def _required(kind: PolicyKind, *, self_only: bool, store: bool) -> set[str]:
    if kind is PolicyKind.PUBLIC:
        return set()
    if kind is PolicyKind.OPERATOR:
        return {"tenant_user_refused"}
    if kind is PolicyKind.AUTHENTICATED:
        return set() if self_only else {"cross_tenant"}
    required = {"cross_tenant", "missing_permission"}
    if store:
        required.add("cross_store")
    return required


def missing_coverage(app: Flask, cases: Iterable[Case]) -> list[Case]:
    """Everything that is wrong or missing, sorted by rule, method and kind."""
    registered = set(cases)
    problems: set[Case] = set()
    existing: set[tuple[str, str]] = set()

    for rule in app.url_map.iter_rules():
        if not rule.rule.startswith(API_PREFIX):
            continue
        policy = policy_of(app.view_functions.get(rule.endpoint))
        for method in sorted((rule.methods or set()) - _IGNORED_METHODS):
            existing.add((method, rule.rule))
            if policy is None:
                problems.add(Case(method, rule.rule, "policy"))
                continue
            in_ops = rule.rule.startswith(OPS_PREFIX)
            if policy.kind is PolicyKind.OPERATOR and not in_ops:
                problems.add(Case(method, rule.rule, "ops_area"))
            if policy.kind in (PolicyKind.AUTHENTICATED, PolicyKind.PERMISSION) and in_ops:
                problems.add(Case(method, rule.rule, "ops_area"))
            if policy.store_param is not None and policy.store_param not in rule.arguments:
                problems.add(Case(method, rule.rule, "store_param"))
            needed = _required(
                policy.kind,
                self_only=policy.self_only,
                store=policy.store_param is not None or policy.store_filtered,
            )
            for kind in needed:
                if Case(method, rule.rule, kind) not in registered:
                    problems.add(Case(method, rule.rule, kind))

    for case in registered:
        if (case.method, case.rule) not in existing:
            problems.add(Case(case.method, case.rule, "no_such_route"))

    return sorted(problems, key=lambda c: (c.rule, c.method, c.kind))


def assert_covered(app: Flask, cases: Iterable[Case]) -> None:
    problems = missing_coverage(app, cases)
    if problems:
        listing = "\n".join(f"  {problem}" for problem in problems)
        raise AssertionError(
            "Route isolation coverage is incomplete. Missing (method, rule, kind):\n"
            f"{listing}\n"
            "Declare a policy on the view (app.core.permissions) and mark the test that proves "
            "each case with tests.isolation.coverage.covers(method, rule, kind)."
        )
