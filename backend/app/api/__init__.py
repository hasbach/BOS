"""HTTP API blueprints, all under ``/api/v1``."""

from __future__ import annotations

from flask import Flask


def register_blueprints(app: Flask) -> None:
    from app.api import audit, auth, me, ops, staff

    for module in (auth, me, staff, audit, ops):
        app.register_blueprint(module.bp)
