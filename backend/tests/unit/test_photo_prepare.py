"""T019 — the generalised upload pipeline (``app.core.storage``, research R50).

``prepare_product_photo`` turns one upload into two clean WebP images (thumbnail fitting
320x320, large fitting 1080x1080, quality 80) and reports the large one's size. The decoded
format decides what is accepted, never a file name or MIME type (the function never sees
them). ``prepare_logo`` keeps M0's behaviour: 2 MB, one WebP fitting 512x512.
"""

from __future__ import annotations

import io
from typing import Any

import pytest
from PIL import Image

from app.core import storage
from app.core.storage import UploadRejected, prepare_logo, prepare_product_photo
from tests.integration.us3_support import huge_dimension_png, image_bytes, noise_png

MB = 1024 * 1024


def _open(data: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(data))
    image.load()
    return image


def test_limits_are_per_kind() -> None:
    assert storage.LOGO_MAX_BYTES == 2 * MB
    assert storage.PRODUCT_PHOTO_MAX_BYTES == 5 * MB
    assert storage.MAX_SOURCE_PIXELS == 40_000_000
    assert not hasattr(storage, "MAX_UPLOAD_BYTES")


@pytest.mark.parametrize("fmt", ["PNG", "JPEG", "WEBP"])
def test_png_jpeg_and_webp_are_accepted(fmt: str) -> None:
    photo = prepare_product_photo(image_bytes(fmt, (640, 480)))

    for data in (photo.thumb, photo.large):
        assert _open(data).format == "WEBP"
    assert (photo.width, photo.height) == (640, 480)
    assert _open(photo.large).size == (640, 480)  # never enlarged
    assert _open(photo.thumb).size == (320, 240)


def test_both_sizes_fit_their_boxes_and_keep_the_aspect_ratio() -> None:
    photo = prepare_product_photo(image_bytes("JPEG", (3000, 2000)))

    assert _open(photo.large).size == (1080, 720)
    assert _open(photo.thumb).size == (320, 213)
    assert (photo.width, photo.height) == (1080, 720)


def test_portrait_photo_fits_by_its_height() -> None:
    photo = prepare_product_photo(image_bytes("PNG", (1000, 2000)))

    assert _open(photo.large).size == (540, 1080)
    assert _open(photo.thumb).size == (160, 320)
    assert (photo.width, photo.height) == (540, 1080)


def test_both_images_are_encoded_as_webp_at_quality_80(monkeypatch: pytest.MonkeyPatch) -> None:
    data = image_bytes("PNG", (400, 400))
    saved: list[dict[str, Any]] = []
    real_save = Image.Image.save

    def spy(self: Image.Image, fp: Any, format: str | None = None, **params: Any) -> None:
        saved.append({"format": format, **params})
        real_save(self, fp, format=format, **params)

    monkeypatch.setattr(Image.Image, "save", spy)
    prepare_product_photo(data)

    assert [(call["format"], call.get("quality")) for call in saved] == [
        ("WEBP", 80),
        ("WEBP", 80),
    ]


def test_more_than_5_mb_is_too_large_before_anything_is_decoded() -> None:
    with pytest.raises(UploadRejected) as refused:
        prepare_product_photo(b"\x89PNG" + b"\x00" * (5 * MB))

    assert refused.value.code == "file_too_large"


def test_a_photo_between_2_and_5_mb_is_accepted_but_not_as_a_logo() -> None:
    data = noise_png((1000, 800))
    assert 2 * MB < len(data) <= 5 * MB

    photo = prepare_product_photo(data)

    assert (photo.width, photo.height) == (1000, 800)
    with pytest.raises(UploadRejected) as refused:
        prepare_logo(data)
    assert refused.value.code == "file_too_large"


def test_more_than_40_megapixels_is_refused_from_the_header_alone() -> None:
    data = huge_dimension_png(8000, 5001)
    assert len(data) < 1000

    with pytest.raises(UploadRejected) as refused:
        prepare_product_photo(data)

    assert refused.value.code == "file_too_large"


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"just some text, not a picture",
        b"<svg xmlns='http://www.w3.org/2000/svg'></svg>",
        image_bytes("GIF", (32, 32), mode="P"),
        image_bytes("BMP", (32, 32)),
        image_bytes("PNG", (64, 64))[:40],  # a truncated PNG
        b"\xff\xd8\xff\xe0" + b"<?php echo 'not a jpeg'; ?>" * 10,  # a JPEG signature only
    ],
    ids=["empty", "text", "svg", "gif", "bmp", "truncated-png", "disguised-jpeg"],
)
def test_anything_but_a_png_jpeg_or_webp_picture_is_not_an_image(data: bytes) -> None:
    with pytest.raises(UploadRejected) as refused:
        prepare_product_photo(data)

    assert refused.value.code == "file_not_image"


def test_exif_orientation_is_applied() -> None:
    exif = Image.Exif()
    exif[0x0112] = 6  # Orientation: rotate 90 degrees clockwise to display
    data = image_bytes("JPEG", (400, 200), exif=exif.tobytes())

    photo = prepare_product_photo(data)

    assert (photo.width, photo.height) == (200, 400)
    assert _open(photo.large).size == (200, 400)
    assert _open(photo.thumb).size == (160, 320)


def test_no_metadata_survives() -> None:
    exif = Image.Exif()
    exif[0x010F] = "SpyCam"  # Make
    exif[0x8298] = "Secret Owner"  # Copyright
    data = image_bytes("JPEG", (300, 300), exif=exif.tobytes(), icc_profile=b"fake icc profile")

    photo = prepare_product_photo(data)

    for out in (photo.thumb, photo.large):
        image = _open(out)
        assert not image.getexif()
        for key in ("exif", "icc_profile", "xmp", "XML:com.adobe.xmp"):
            assert key not in image.info
        assert b"SpyCam" not in out and b"Secret Owner" not in out


def test_transparency_is_kept() -> None:
    photo = prepare_product_photo(image_bytes("PNG", (100, 100), mode="RGBA"))

    assert _open(photo.large).mode == "RGBA"


def test_logo_keeps_its_m0_behaviour() -> None:
    logo = prepare_logo(image_bytes("PNG", (2000, 1000)))

    image = _open(logo)
    assert image.format == "WEBP"
    assert image.size == (512, 256)
    with pytest.raises(UploadRejected) as refused:
        prepare_logo(b"x" * (2 * MB + 1))
    assert refused.value.code == "file_too_large"
    with pytest.raises(UploadRejected) as refused:
        prepare_logo(b"not an image")
    assert refused.value.code == "file_not_image"
