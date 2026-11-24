"""HTTP API blueprints, all under ``/api/v1``."""

from __future__ import annotations

from flask import Flask


def register_blueprints(app: Flask) -> None:
    from app.api import (
        audit,
        auth,
        business,
        catalog,
        catalog_import,
        catalog_photos,
        me,
        ops,
        staff,
        stock,
        stores,
    )

    for module in (
        auth,
        me,
        business,
        stores,
        staff,
        audit,
        ops,
        catalog,
        catalog_import,
        catalog_photos,
        stock,
    ):
        app.register_blueprint(module.bp)
