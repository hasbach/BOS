"""Uploaded files: a small storage interface, a local-disk backend and image checks.

M0 T068 (store logos, research R14), generalised in M1 T031 for product photos (R50).

**Paths are always made here.** A stored file is ``tenant/<tenant_id>/<random>.webp``; the
random part is 32 bytes from ``secrets``. Nothing a client sends (file name, MIME type, form
field) ever reaches a path, and every path handed back to the backend is checked against that
exact shape and must resolve inside the storage root, so a path from anywhere else is refused
with ``StorageError``.

**Images are decoded, never trusted.** Every upload goes through one path (``_decode``): a
size limit per kind (store logo 2 MB, product photo 5 MB; ``file_too_large``), Pillow
restricted to the PNG, JPEG and WebP decoders (the decoded format decides; extension and
client MIME type are ignored), anything else refused (``file_not_image``), the dimensions
checked from the header *before* decoding so a small file that claims a huge picture (over
40 megapixels) is refused without allocating it (``file_too_large``), then the EXIF
orientation applied. Every output is re-encoded as WebP from a fresh image holding only the
pixels, so no metadata (EXIF, ICC, XMP, text chunks) survives.

* ``prepare_logo``: one WebP fitting 512x512 (unchanged from M0).
* ``prepare_product_photo``: a thumbnail fitting 320x320 and a large image fitting
  1080x1080, both WebP at quality 80, plus the large image's width and height.

The backend is chosen by ``storage_for(app)``: a backend placed in
``app.extensions["bos_storage"]`` if any (for later milestones or tests), else the local disk
at ``Config.upload_dir``. Product photos can move to object storage behind the same
interface without touching callers.
"""

from __future__ import annotations

import io
import os
import re
import secrets
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Literal, Protocol

from flask import Flask
from PIL import Image, ImageOps, UnidentifiedImageError

# Upload limits per kind, checked before anything is decoded.
LOGO_MAX_BYTES = 2 * 1024 * 1024
PRODUCT_PHOTO_MAX_BYTES = 5 * 1024 * 1024
# A 40-megapixel picture still decodes in a sensible amount of memory (about 160 MB as RGBA);
# anything larger is refused from its header alone. Same for every kind.
MAX_SOURCE_PIXELS = 40_000_000
ACCEPTED_FORMATS = ("PNG", "JPEG", "WEBP")

LOGO_MAX_SIDE = 512
LOGO_QUALITY = 85
LOGO_MIME = "image/webp"

PHOTO_THUMB_SIDE = 320
PHOTO_LARGE_SIDE = 1080
PHOTO_QUALITY = 80
PHOTO_MIME = "image/webp"

_PATH = re.compile(
    r"tenant/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-]{20,64}\.webp"
)


class StorageError(ValueError):
    """A storage path that this module did not make (or that leaves the storage root)."""


class UploadRejected(ValueError):
    """An upload that is not an acceptable logo. ``code`` is the stable error code."""

    def __init__(self, code: Literal["file_too_large", "file_not_image"]) -> None:
        super().__init__(code)
        self.code: Literal["file_too_large", "file_not_image"] = code


class Storage(Protocol):
    def save(self, tenant_id: uuid.UUID, data: bytes) -> str:
        """Store ``data`` under a new server-generated path and return that path."""

    def open(self, path: str) -> BinaryIO:
        """Open a stored file for reading; ``FileNotFoundError`` if it is gone."""

    def delete(self, path: str) -> None:
        """Remove a stored file; nothing happens if it is already gone."""


class LocalDiskStorage:
    """Files on a local disk (a Docker volume in production) under one root directory."""

    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = Path(root)

    def _full_path(self, path: str) -> Path:
        if not isinstance(path, str) or not _PATH.fullmatch(path):
            raise StorageError("not a storage path")
        root = self.root.resolve()
        full = (root / path).resolve()
        if not full.is_relative_to(root):
            raise StorageError("storage path outside the root")
        return full

    def save(self, tenant_id: uuid.UUID, data: bytes) -> str:
        path = f"tenant/{uuid.UUID(str(tenant_id))}/{secrets.token_urlsafe(32)}.webp"
        full = self._full_path(path)
        full.parent.mkdir(parents=True, exist_ok=True)
        # Written next to its final place, then renamed: a reader never sees half a file.
        handle, temporary = tempfile.mkstemp(dir=full.parent, suffix=".part")
        try:
            with os.fdopen(handle, "wb") as out:
                out.write(data)
            os.replace(temporary, full)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise
        return path

    def open(self, path: str) -> BinaryIO:
        return self._full_path(path).open("rb")

    def delete(self, path: str) -> None:
        self._full_path(path).unlink(missing_ok=True)


def storage_for(app: Flask) -> Storage:
    override = app.extensions.get("bos_storage")
    if override is not None:
        return override  # type: ignore[no-any-return]
    from app import get_config

    return LocalDiskStorage(get_config(app).upload_dir)


# ---- images -----------------------------------------------------------------------------------


def _decode(data: bytes, max_bytes: int, largest_side: int) -> Image.Image:
    """The upload's pixels, upright, as RGB or RGBA; or ``UploadRejected``.

    ``largest_side`` is the biggest output that will be made, so a JPEG can be scaled down
    while it is decoded.
    """
    if len(data) > max_bytes:
        raise UploadRejected("file_too_large")
    try:
        with Image.open(io.BytesIO(data), formats=ACCEPTED_FORMATS) as source:
            width, height = source.size
            if width <= 0 or height <= 0:
                raise UploadRejected("file_not_image")
            if width * height > MAX_SOURCE_PIXELS:
                raise UploadRejected("file_too_large")
            if source.format == "JPEG":
                # Lets the JPEG decoder scale down while decoding (by 1/2, 1/4 or 1/8).
                source.draft("RGB", (largest_side * 2, largest_side * 2))
            source.load()
            image = ImageOps.exif_transpose(source)
            has_alpha = image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info
            return image.convert("RGBA" if has_alpha else "RGB")
    except UploadRejected:
        raise
    except Image.DecompressionBombError:
        raise UploadRejected("file_too_large") from None
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, EOFError, TypeError):
        raise UploadRejected("file_not_image") from None


def _webp(image: Image.Image, side: int, quality: int) -> tuple[bytes, tuple[int, int]]:
    """``image`` shrunk to fit ``side`` x ``side`` (never enlarged), as a metadata-free WebP."""
    fitted = image.copy()
    fitted.thumbnail((side, side), Image.Resampling.LANCZOS)
    clean = Image.new(fitted.mode, fitted.size)  # pixels only: no metadata is carried over
    clean.paste(fitted)
    out = io.BytesIO()
    clean.save(out, format="WEBP", quality=quality, method=4)
    return out.getvalue(), clean.size


def prepare_logo(data: bytes) -> bytes:
    """The upload as a clean WebP of at most 512x512, or ``UploadRejected`` (2 MB limit)."""
    image = _decode(data, LOGO_MAX_BYTES, LOGO_MAX_SIDE)
    logo, _ = _webp(image, LOGO_MAX_SIDE, LOGO_QUALITY)
    return logo


@dataclass(frozen=True)
class PreparedPhoto:
    """A product photo ready to store: two WebP images and the large one's size."""

    thumb: bytes
    large: bytes
    width: int
    height: int


def prepare_product_photo(data: bytes) -> PreparedPhoto:
    """Thumbnail (fits 320x320) and large (fits 1080x1080) WebP at quality 80 (5 MB limit)."""
    image = _decode(data, PRODUCT_PHOTO_MAX_BYTES, PHOTO_LARGE_SIDE)
    large, (width, height) = _webp(image, PHOTO_LARGE_SIDE, PHOTO_QUALITY)
    thumb, _ = _webp(image, PHOTO_THUMB_SIDE, PHOTO_QUALITY)
    return PreparedPhoto(thumb=thumb, large=large, width=width, height=height)
