"""Product photos: staging, attaching, ordering, removal and the staged-photo purge (R50).

* ``stage`` — the API has already re-encoded the upload and written both files to storage
  (registering an ``on_rollback`` that removes them again); this records two ``files`` rows
  (kind ``product_photo``) and a staged ``product_photos`` row that belongs to no product and
  expires 24 hours later.
* ``usable`` / ``attach`` — a product save lists ``photo_ids`` in display order: each must be
  a live staged photo of this business or already one of this product's. ``attach`` runs
  under the product row lock (taken by ``app.services.catalog``), so the limit of 8 holds. It
  returns the storage paths of the photos the save removed; the caller deletes those files
  with ``on_commit``, so a rolled-back save never loses a file it still references.
* ``purge_staged`` — maintenance: removes staged photos past their expiry in the current
  business and returns their paths, for deletion after that business's transaction commits.

Everything runs in the caller's transaction and tenant context (row-level security).
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.storage import PHOTO_MIME

MAX_PER_PRODUCT = 8
STAGED_HOURS = 24


@dataclass(frozen=True)
class StoredImage:
    path: str
    size_bytes: int


def stage(
    db: Session,
    *,
    tenant_id: uuid.UUID,
    user_id: uuid.UUID,
    thumb: StoredImage,
    large: StoredImage,
    width: int,
    height: int,
) -> dict[str, Any]:
    """Record an uploaded photo as staged; returns the contract's ``Photo``."""
    file_ids = []
    for image in (thumb, large):
        file_id = uuid.uuid4()
        db.execute(
            text(
                "INSERT INTO files (id, tenant_id, kind, storage_path, mime, size_bytes, "
                "created_by_user_id) VALUES (:id, :tenant_id, 'product_photo', :path, :mime, "
                ":size, :user_id)"
            ),
            {
                "id": file_id,
                "tenant_id": tenant_id,
                "path": image.path,
                "mime": PHOTO_MIME,
                "size": image.size_bytes,
                "user_id": user_id,
            },
        )
        file_ids.append(file_id)
    photo_id = uuid.uuid4()
    db.execute(
        text(
            "INSERT INTO product_photos (id, tenant_id, thumb_file_id, large_file_id, width, "
            "height, staged_expires_at, created_by_user_id) VALUES (:id, :tenant_id, :thumb, "
            ":large, :width, :height, now() + make_interval(hours => :hours), :user_id)"
        ),
        {
            "id": photo_id,
            "tenant_id": tenant_id,
            "thumb": file_ids[0],
            "large": file_ids[1],
            "width": width,
            "height": height,
            "hours": STAGED_HOURS,
            "user_id": user_id,
        },
    )
    return {"id": str(photo_id), "width": width, "height": height}


def usable(db: Session, product_id: uuid.UUID | None, photo_ids: Sequence[uuid.UUID]) -> bool:
    """Every id is a live staged photo of this business, or already this product's."""
    if not photo_ids:
        return True
    found = db.execute(
        text(
            "SELECT count(*) FROM product_photos WHERE id = ANY(:ids) AND ("
            "  (product_id IS NULL AND staged_expires_at > now()) "
            "  OR (CAST(:product AS uuid) IS NOT NULL AND product_id = CAST(:product AS uuid)))"
        ),
        {"ids": list(photo_ids), "product": product_id},
    ).scalar_one()
    return int(found) == len(set(photo_ids))


def _delete(db: Session, photo_ids: list[uuid.UUID]) -> list[str]:
    """Delete photos (and their file rows); returns the storage paths of their files."""
    if not photo_ids:
        return []
    db.execute(
        text("UPDATE variants SET photo_id = NULL, updated_at = now() WHERE photo_id = ANY(:ids)"),
        {"ids": photo_ids},
    )
    files = db.execute(
        text(
            "DELETE FROM product_photos WHERE id = ANY(:ids) RETURNING thumb_file_id, large_file_id"
        ),
        {"ids": photo_ids},
    ).all()
    file_ids = [f for row in files for f in (row.thumb_file_id, row.large_file_id)]
    paths = db.execute(
        text("DELETE FROM files WHERE id = ANY(:ids) RETURNING storage_path"), {"ids": file_ids}
    ).scalars()
    return list(paths)


def attach(db: Session, product_id: uuid.UUID, photo_ids: Sequence[uuid.UUID]) -> list[str]:
    """Make ``photo_ids`` the product's photos in this order; returns removed files' paths.

    Call ``usable`` first. Positions are rewritten in one go (the unique position constraint
    is deferred to the commit).
    """
    current = list(
        db.execute(
            text("SELECT id FROM product_photos WHERE product_id = :p"), {"p": product_id}
        ).scalars()
    )
    removed = [photo for photo in current if photo not in set(photo_ids)]
    paths = _delete(db, removed)
    for position, photo_id in enumerate(photo_ids):
        db.execute(
            text(
                "UPDATE product_photos SET product_id = :p, position = :position, "
                "staged_expires_at = NULL WHERE id = :id"
            ),
            {"p": product_id, "position": position, "id": photo_id},
        )
    return paths


def remove_all(db: Session, product_id: uuid.UUID) -> list[str]:
    """Delete every photo of a product (the product is being deleted)."""
    photos = list(
        db.execute(
            text("SELECT id FROM product_photos WHERE product_id = :p"), {"p": product_id}
        ).scalars()
    )
    return _delete(db, photos)


@dataclass(frozen=True)
class Purged:
    photos: int
    paths: list[str]


def purge_staged(db: Session) -> Purged:
    """Delete this business's staged photos whose 24 hours have passed (maintenance)."""
    expired = list(
        db.execute(
            text(
                "SELECT id FROM product_photos WHERE product_id IS NULL "
                "AND staged_expires_at <= now() FOR UPDATE"
            )
        ).scalars()
    )
    return Purged(photos=len(expired), paths=_delete(db, expired))


@dataclass(frozen=True)
class PhotoFiles:
    product_id: uuid.UUID | None
    thumb_file_id: uuid.UUID
    thumb_path: str
    large_file_id: uuid.UUID
    large_path: str


def find(db: Session, photo_id: uuid.UUID) -> PhotoFiles | None:
    row = db.execute(
        text(
            "SELECT p.product_id, p.thumb_file_id, t.storage_path AS thumb_path, "
            "p.large_file_id, l.storage_path AS large_path FROM product_photos p "
            "JOIN files t ON t.id = p.thumb_file_id JOIN files l ON l.id = p.large_file_id "
            "WHERE p.id = :id"
        ),
        {"id": photo_id},
    ).one_or_none()
    if row is None:
        return None
    return PhotoFiles(
        row.product_id, row.thumb_file_id, row.thumb_path, row.large_file_id, row.large_path
    )
