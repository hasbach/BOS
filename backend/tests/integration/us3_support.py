"""Helpers shared by the User Story 3 tests (stores, logos, business settings)."""

from __future__ import annotations

import dataclasses
import io
import os
import struct
import zlib
from pathlib import Path
from typing import Any

from flask import Flask
from flask.testing import FlaskClient
from PIL import Image

from app.config import Config
from tests.integration.us1_support import CSRF

STORES = "/api/v1/stores"
BUSINESS = "/api/v1/business"

TWO_MB = 2 * 1024 * 1024


def with_upload_dir(app: Flask, upload_dir: Path) -> Flask:
    """Point the app's logo storage at a test's own temporary directory."""
    cfg: Config = app.extensions["bos_config"]
    app.extensions["bos_config"] = dataclasses.replace(cfg, upload_dir=str(upload_dir))
    return app


def stored_files(upload_dir: Path) -> list[Path]:
    """Every file under the upload directory (temporary files included)."""
    return sorted(p for p in upload_dir.rglob("*") if p.is_file())


# ---- images made in the test ------------------------------------------------------------------


def image_bytes(
    fmt: str, size: tuple[int, int] = (64, 48), mode: str = "RGB", **save: Any
) -> bytes:
    image = Image.new(mode, size, color=(200, 30, 60) if mode == "RGB" else None)
    buffer = io.BytesIO()
    image.save(buffer, format=fmt, **save)
    return buffer.getvalue()


def noise_png(size: tuple[int, int]) -> bytes:
    """A real PNG that does not compress: about ``3 * width * height`` bytes."""
    image = Image.frombytes("RGB", size, os.urandom(size[0] * size[1] * 3))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", compress_level=0)
    return buffer.getvalue()


def huge_dimension_png(width: int, height: int) -> bytes:
    """A small, valid-looking PNG whose header claims enormous dimensions."""
    data = bytearray(image_bytes("PNG", (8, 8)))
    # Signature (8 bytes), then the IHDR chunk: length (4), type (4), data (13), CRC (4).
    assert data[12:16] == b"IHDR"
    data[16:24] = struct.pack(">II", width, height)
    data[29:33] = struct.pack(">I", zlib.crc32(bytes(data[12:29])) & 0xFFFFFFFF)
    return bytes(data)


def upload(
    client: FlaskClient,
    store_id: Any,
    data: bytes,
    *,
    filename: str = "logo.png",
    content_type: str = "image/png",
) -> Any:
    return client.put(
        f"{STORES}/{store_id}/logo",
        data={"file": (io.BytesIO(data), filename, content_type)},
        content_type="multipart/form-data",
        headers=CSRF,
    )
