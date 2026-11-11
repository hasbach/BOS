"""HTTP API blueprints, all under ``/api/v1``."""

from __future__ import annotations

from flask import Flask


def register_blueprints(app: Flask) -> None:
    from app.api import audit, auth, me, ops

    for module in (auth, me, audit, ops):
        app.register_blueprint(module.bp)
