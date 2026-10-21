import base64
import io
from datetime import date

import pytest
from PIL import Image
from pypdf import PdfReader

from app.export.image import MAX_IMAGE_BYTES, InvalidImage, clean_snapshot
from app.export.pdf import render_pdf
from app.domain.catalog import load_catalog
from tests.domain.conftest import load_design
from tests.export.test_export_api import client


def data_url(image: Image.Image, fmt: str = "JPEG", mime: str = "jpeg", **save) -> str:
    out = io.BytesIO()
    image.save(out, format=fmt, **save)
    return f"data:image/{mime};base64," + base64.b64encode(out.getvalue()).decode()


def picture(size=(600, 650), colour=(200, 160, 110)) -> Image.Image:
    return Image.new("RGB", size, colour)


def test_a_valid_snapshot_is_re_encoded_as_a_clean_jpeg():
    raw = io.BytesIO()
    picture().save(raw, format="PNG", pnginfo=None)
    url = "data:image/png;base64," + base64.b64encode(raw.getvalue()).decode()
    cleaned = clean_snapshot(url)
    with Image.open(io.BytesIO(cleaned)) as image:
        assert image.format == "JPEG" and image.size == (600, 650) and not image.info.get("exif")


def test_comments_from_the_input_never_reach_the_pdf_image():
    cleaned = clean_snapshot(data_url(picture(), comment=b"hidden-note-123"))
    assert b"hidden-note-123" not in cleaned
    with Image.open(io.BytesIO(cleaned)) as image:
        assert not image.info.get("comment")


def test_progressive_jpegs_are_rejected_before_decoding():
    """A progressive JPEG can repeat scans thousands of times (minutes of CPU per request)."""
    with pytest.raises(InvalidImage):
        clean_snapshot(data_url(picture(), progressive=True))


def test_extra_scan_markers_are_rejected_before_decoding():
    raw = base64.b64decode(data_url(picture()).split(",", 1)[1])
    padded = raw[:-2] + bytes((0xFF, 0xDA)) * 5 + raw[-2:]
    with pytest.raises(InvalidImage):
        clean_snapshot("data:image/jpeg;base64," + base64.b64encode(padded).decode())


@pytest.mark.parametrize("bad", [
    "not a data url",
    "data:image/gif;base64,R0lGODlhAQABAAAAACw=",                      # wrong format
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",                      # svg is never accepted
    "data:image/jpeg;base64,!!!!",                                    # not base64
    "data:image/jpeg;base64," + base64.b64encode(b"\x89PNG not really").decode(),  # junk bytes
])
def test_malformed_snapshots_are_rejected(bad):
    with pytest.raises(InvalidImage):
        clean_snapshot(bad)


def test_declared_format_must_match_the_bytes():
    with pytest.raises(InvalidImage):
        clean_snapshot(data_url(picture(), "PNG", "jpeg"))


def test_size_limits():
    with pytest.raises(InvalidImage):
        clean_snapshot(data_url(picture((100, 100))))       # too small
    with pytest.raises(InvalidImage):
        clean_snapshot(data_url(picture((3000, 800))))      # too wide
    truncated = data_url(picture())[:-200]
    with pytest.raises(InvalidImage):
        clean_snapshot(truncated + "=" * (-len(truncated.split(",")[1]) % 4))


def test_oversized_payload_is_rejected_before_decoding():
    huge = "data:image/jpeg;base64," + "A" * (MAX_IMAGE_BYTES * 4 // 3 + 400)
    with pytest.raises(InvalidImage):
        clean_snapshot(huge)


def test_the_snapshot_appears_on_the_first_page():
    snapshot = clean_snapshot(data_url(picture()))
    pdf = render_pdf(load_design("basic"), load_catalog(), "en", date(2026, 10, 16), snapshot=snapshot)
    reader = PdfReader(io.BytesIO(pdf))
    first = reader.pages[0]
    assert "Wardrobe sheet: picture and technical drawing" in first.extract_text()
    assert len(first.images) == 1
    assert len(PdfReader(io.BytesIO(render_pdf(load_design("basic"), load_catalog(), "en", date(2026, 10, 16)))).pages[0].images) == 0


def test_api_accepts_a_snapshot_and_rejects_a_bad_one():
    body = {"design": load_design("basic"), "language": "he", "image": data_url(picture())}
    response = client.post("/api/export/pdf", json=body)
    assert response.status_code == 200 and response.content.startswith(b"%PDF")
    body["image"] = "data:image/png;base64," + base64.b64encode(b"<svg onload=alert(1)>").decode()
    response = client.post("/api/export/pdf", json=body)
    assert response.status_code == 422
    assert response.json()["error"] == {"code": "INVALID_IMAGE", "message": "תמונת הארון אינה תקינה.", "path": "image"}
