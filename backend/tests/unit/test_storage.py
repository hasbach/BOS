"""Local-disk storage regression tests."""

from __future__ import annotations

import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

import pytest

from app.core.storage import LocalDiskStorage, prepare_product_photo
from tests.integration.us3_support import image_bytes


@pytest.mark.skipif(os.name != "nt", reason="Windows realpath handles missing parents differently")
def test_concurrent_first_uploads_to_same_tenant(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Run real Windows filesystem probes, only pausing the first one after it notices
    # that the destination's parent is missing. The other upload creates that parent.
    getfinalpathname = vars(os.path)["_getfinalpathname"]
    missing_parent = Event()
    parent_created = Event()

    def pause_on_missing_parent(path: str) -> str:
        try:
            return getfinalpathname(path)
        except OSError as error:
            if path.endswith(".webp") and error.winerror == 3 and not missing_parent.is_set():
                missing_parent.set()
                assert parent_created.wait(10), "second upload did not create the parent"
            raise

    monkeypatch.setattr(os.path, "_getfinalpathname", pause_on_missing_parent)
    tenant = uuid.uuid4()
    first_photo = prepare_product_photo(image_bytes("PNG", (128, 128)))
    second_photo = prepare_product_photo(image_bytes("PNG", (192, 192)))
    first_storage = LocalDiskStorage(tmp_path)
    second_storage = LocalDiskStorage(tmp_path)

    with ThreadPoolExecutor(max_workers=1) as worker:
        pending = worker.submit(first_storage.save, tenant, first_photo.thumb)
        try:
            assert missing_parent.wait(10), "first upload did not encounter a missing parent"
            second = second_storage.save(tenant, second_photo.thumb)
        finally:
            parent_created.set()
        first = pending.result(timeout=10)

    assert first != second
    for path, photo, storage in (
        (first, first_photo, first_storage),
        (second, second_photo, second_storage),
    ):
        with storage.open(path) as image:
            assert image.read() == photo.thumb
