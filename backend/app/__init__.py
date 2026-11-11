"""BOS API application factory."""

from __future__ import annotations

import logging
import time
import uuid

from flask import Flask, Response, g, jsonify, request
from flask.typing import ResponseReturnValue

from app.config import Config
from app.core.db import init_engine
from app.core.permissions import public
from app.errors import register_error_handlers

API_PREFIX = "/api/v1"

log = logging.getLogger("bos.request")


def create_app(config: Config | None = None) -> Flask:
    cfg = config or Config.from_env()

    app = Flask(__name__)
    app.config["SECRET_KEY"] = cfg.secret_key
    app.config["TESTING"] = cfg.testing
    # Unexpected errors always go through our handler, in tests too, so that the
    # "no internal details leak" behaviour is what gets tested.
    app.config["PROPAGATE_EXCEPTIONS"] = False
    app.config["MAX_CONTENT_LENGTH"] = 3 * 1024 * 1024  # hard cap; logos are limited to 2 MB
    app.extensions["bos_config"] = cfg

    _configure_logging(app)
    register_error_handlers(app)
    _register_request_logging(app)
    init_engine(app, cfg.database_url)

    from app.core.request_context import register_request_context

    register_request_context(app)

    @app.get(f"{API_PREFIX}/health")
    @public
    def health() -> ResponseReturnValue:
        return jsonify({"status": "ok"})

    from app.cli import register_cli

    register_cli(app)
    return app


def get_config(app: Flask) -> Config:
    cfg = app.extensions["bos_config"]
    assert isinstance(cfg, Config)
    return cfg


def _configure_logging(app: Flask) -> None:
    if not logging.getLogger().handlers:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(name)s %(message)s",
        )
    app.logger.setLevel(logging.INFO)


def _register_request_logging(app: Flask) -> None:
    @app.before_request
    def _start() -> None:
        g.request_id = uuid.uuid4().hex
        g.request_started = time.perf_counter()

    @app.after_request
    def _finish(response: Response) -> Response:
        response.headers["X-Request-ID"] = g.get("request_id", "")
        started = g.get("request_started")
        elapsed_ms = (time.perf_counter() - started) * 1000 if started else 0.0
        # Path only: query strings and bodies may hold personal data or tokens.
        log.info(
            "request_id=%s method=%s path=%s status=%s ms=%.1f",
            g.get("request_id", ""),
            request.method,
            request.path,
            response.status_code,
            elapsed_ms,
        )
        return response
