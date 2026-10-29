"""Spanish as a third language: detection (parity with the frontend), agent replies, API errors and the PDF."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.agent.language import FALLBACK_REPLY, INSTRUCTION, LANGUAGES, OFF_TOPIC_REPLY, detect, reply_language
from app.agent.tools import DECLINE
from app.api import agent as agent_api
from app.api import designs as designs_api
from app.api import export as export_api
from app.config import get_settings
from app.domain.catalog import load_catalog
from app.domain.defaults import basic_wardrobe
from app.export.pdf import render_pdf
from app.export.strings import CATALOG_NAMES, STRINGS
from app.main import create_app
from tests.agent.fakes import FakeClient, completion, tool_call
from tests.agent.test_agent import make_client  # noqa: F401 (pytest fixture)

FIXTURE = Path(__file__).resolve().parents[3] / "shared" / "fixtures" / "language" / "detect.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=lambda case: f"{case['text']!r}/{case['chosen']}")
def test_detection_matches_the_shared_fixture(case):
    assert detect(case["text"], case["chosen"]) == case["expected"]


def test_reply_language_follows_spanish_and_keeps_it_for_neutral_messages():
    assert reply_language([{"role": "user", "text": "Quiero tres cajones"}], "he") == "es"
    assert reply_language([{"role": "user", "text": "240 cm"}], "es") == "es"
    assert reply_language([{"role": "user", "text": "240?"}], "es") == "es"


def test_every_language_table_has_spanish():
    assert LANGUAGES == ("he", "en", "es")
    for table in (OFF_TOPIC_REPLY, FALLBACK_REPLY, INSTRUCTION, STRINGS, CATALOG_NAMES):
        assert set(table) == set(LANGUAGES)
    for messages in (agent_api.MESSAGES, designs_api.MESSAGES, export_api.MESSAGES):
        for code, texts in messages.items():
            assert set(texts) == set(LANGUAGES), code
    assert set(STRINGS["es"]) == set(STRINGS["en"])  # the PDF has every text in Spanish
    assert set(CATALOG_NAMES["es"]) == set(CATALOG_NAMES["he"])


def test_spanish_message_gets_a_spanish_only_instruction(make_client):
    fake = FakeClient(completion(calls=[tool_call(DECLINE, {})]))
    body = {"messages": [{"role": "user", "text": "¿Qué tiempo hace hoy?"}], "design": basic_wardrobe(),
            "revision": 1, "language": "en"}
    data = make_client(fake).post("/api/chat", json=body).json()["data"]
    assert data["reply"] == OFF_TOPIC_REPLY["es"]
    assert "in SPANISH" in fake.requests[0]["messages"][0]["content"].split("## RESPONSE LANGUAGE")[-1]


def test_api_errors_can_be_spanish(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "")
    get_settings.cache_clear()
    try:
        client = TestClient(create_app())
        body = {"messages": [{"role": "user", "text": "hola"}], "design": basic_wardrobe(), "revision": 1, "language": "es"}
        assert client.post("/api/chat", json=body).json()["error"]["message"].startswith("El diseñador")
        export = client.post("/api/export/pdf", json={"design": basic_wardrobe(), "language": "es", "extra": 1})
        assert export.json()["error"]["message"] == "La solicitud no es válida."
    finally:
        get_settings.cache_clear()


def test_the_pdf_renders_in_spanish():
    pdf = render_pdf(basic_wardrobe(), load_catalog(), "es", date(2026, 10, 23))
    assert pdf.startswith(b"%PDF") and len(pdf) > 10_000


def test_the_pdf_endpoint_accepts_spanish():
    client = TestClient(create_app())
    response = client.post("/api/export/pdf", json={"design": basic_wardrobe(), "language": "es"})
    assert response.status_code == 200 and response.headers["Content-Type"].startswith("application/pdf")


def test_the_pdf_text_is_spanish_with_accents():
    import io

    from pypdf import PdfReader

    pdf = render_pdf(basic_wardrobe(), load_catalog(), "es", date(2026, 10, 23))
    text = "\n".join(page.extract_text() for page in PdfReader(io.BytesIO(pdf)).pages)
    assert "Notas para el carpintero" in text
    assert "Cajón" in text or "cajón" in text or "Compartimento" in text
    assert "Notes for the carpenter" not in text
