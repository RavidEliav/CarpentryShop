import io
import time
from datetime import date

from fastapi.testclient import TestClient
from pypdf import PdfReader

from app.api import export
from app.domain.apply import apply_ops
from app.domain.catalog import load_catalog
from app.export.pdf import render_pdf
from app.main import app
from tests.domain.conftest import load_design

client = TestClient(app)


def text_of(pdf: bytes) -> str:
    return "\n".join(page.extract_text() for page in PdfReader(io.BytesIO(pdf)).pages)


def test_export_returns_a_pdf_attachment():
    response = client.post("/api/export/pdf", json={"design": load_design("basic"), "language": "en"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"] == 'attachment; filename="banai-wardrobe-2000x2400x600mm.pdf"'
    assert response.headers["cache-control"] == "no-store"
    assert response.content.startswith(b"%PDF")


def test_english_pdf_has_the_sheets_dimensions_and_codes():
    text = text_of(render_pdf(load_design("basic"), load_catalog(), "en", date(2026, 10, 16)))
    for expected in ("How the wardrobe will look", "Front: doors closed", "Interior front: doors removed",
                     "Plan (top view)", "Suggested build sequence", "Component list",
                     "2000 × 2400 × 600", "1964 × 2364", "A-S1", "C-DW2", "B-R1", "DR3",
                     "Width check: 18 + 643 + 18 + 643 + 18 + 642 + 18 = 2000", "Melamine board", "16.10.2026"):
        assert expected in text, expected


def test_hebrew_pdf_is_hebrew_and_keeps_numbers_left_to_right():
    pdf = render_pdf(load_design("basic"), load_catalog(), "he", date(2026, 10, 16))
    text = text_of(pdf)
    assert "18 + 643 + 18 + 643 + 18 + 642 + 18 = 2000" in text
    assert "2000 × 2400 × 600" in text
    # Glyphs are drawn in visual order; text extraction restores the logical order.
    assert "רשימת רכיבים" in text
    assert "לוח מלמין" in text
    assert "שלבי עבודה מוצעים" in text


def test_never_claims_the_design_is_manufacturable():
    for language in ("he", "en"):
        text = text_of(render_pdf(load_design("basic"), load_catalog(), language, date(2026, 10, 16))).lower()
        assert "manufacturable" not in text and "ready for production" not in text
    assert "Construction details are decided by the carpenter" in text_of(
        render_pdf(load_design("basic"), load_catalog(), "en", date(2026, 10, 16)))


def test_sliding_and_open_wardrobes_render():
    catalog = load_catalog()
    sliding = apply_ops(load_design("basic"), [{"op": "configure_doors", "type": "sliding", "count": 2}], catalog)
    open_ = apply_ops(load_design("basic"), [{"op": "configure_doors", "type": "none"}], catalog)
    assert "Sliding door" in text_of(render_pdf(sliding, catalog, "en", date(2026, 10, 16)))
    text = text_of(render_pdf(open_, catalog, "en", date(2026, 10, 16)))
    assert "Front: doors closed" not in text and "The wardrobe is open, with no doors." in text


def test_custom_hebrew_colour_name_is_shown():
    catalog = load_catalog()
    design = apply_ops(load_design("basic"), [{"op": "set_material", "target": "carcass",
                                               "color": {"custom": True, "name": "ירוק מרווה", "hex": "#9caf88"}}], catalog)
    text = text_of(render_pdf(design, catalog, "en", date(2026, 10, 16)))
    assert "ירוק מרווה" in text and "custom" in text


def test_invalid_design_is_rejected_with_the_domain_error():
    design = load_design("basic")
    design["compartments"][0]["width"] += 1
    response = client.post("/api/export/pdf", json={"design": design, "language": "en"})
    assert response.status_code == 422
    assert response.json()["success"] is False
    assert response.json()["error"]["code"] == "WIDTH_MISMATCH"


def test_unknown_keys_bad_language_and_bad_json_are_rejected():
    for body in ({"design": load_design("basic"), "language": "fr"},
                 {"design": load_design("basic"), "revision": 1},
                 {"language": "en"}):
        response = client.post("/api/export/pdf", json=body)
        assert response.status_code == 422 and response.json()["error"]["code"] == "INVALID_REQUEST"
    response = client.post("/api/export/pdf", content=b"{not json", headers={"content-type": "application/json"})
    assert response.status_code == 422


def test_oversized_body_is_rejected_before_parsing():
    response = client.post("/api/export/pdf", content=b"x" * (export.MAX_BODY_BYTES + 1),
                           headers={"content-type": "application/json"})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "TOO_LARGE"


def test_deeply_nested_json_is_a_422_not_a_500():
    response = client.post("/api/export/pdf", content=b"[" * 100_000, headers={"content-type": "application/json"})
    assert response.status_code == 422


def test_busy_server_answers_503_with_retry_after(monkeypatch):
    monkeypatch.setattr(export, "MAX_CONCURRENT_RENDERS", 0)
    response = client.post("/api/export/pdf", json={"design": load_design("basic"), "language": "en"})
    assert response.status_code == 503
    assert response.headers["retry-after"] == "2"
    assert response.json()["error"]["code"] == "BUSY"
    assert export._active_renders == 0


def test_worst_case_design_renders_quickly():
    """20 compartments with 300 items (the schema caps) stays well within a request budget."""
    catalog = load_catalog()
    design = apply_ops(None, [{"op": "create_wardrobe", "width": 6000, "height": 3500, "depth": 1200,
                               "compartmentCount": 20}, {"op": "configure_doors", "type": "hinged"}], catalog)
    ops = []
    for compartment in design["compartments"]:
        for n in range(15):
            ops.append({"op": "add_shelf", "compartmentId": compartment["id"], "y": 100 + n * 200, "thickness": 5})
    for start in range(0, len(ops), 100):  # at most 100 ops per batch
        design = apply_ops(design, ops[start:start + 100], catalog)
    started = time.perf_counter()
    pdf = render_pdf(design, catalog, "he", date(2026, 10, 16))
    assert time.perf_counter() - started < 5
    assert len(PdfReader(io.BytesIO(pdf)).pages) > 20  # detail sheets + paginated component list
