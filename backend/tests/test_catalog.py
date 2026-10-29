"""Catalog entries reach every part of the app: the API, the agent's prompt, the domain engine and the
carpenter PDF (Hebrew names)."""

import re
from datetime import date

from fastapi.testclient import TestClient

from app.agent.prompts import build_system_prompt
from app.agent.tools import PROPOSE
from app.domain.apply import apply_ops
from app.domain.catalog import load_catalog
from app.domain.defaults import basic_wardrobe
from app.export.pdf import render_pdf
from app.export.strings import CATALOG_NAMES
from app.main import app
from tests.agent.fakes import FakeClient, completion, propose, tool_call
from tests.agent.test_agent import chat_body, make_client  # noqa: F401 (pytest fixture)
from tests.domain.conftest import load_design
from tests.export.test_export_api import text_of

NEW_COLORS = {"olive_green": "ירוק זית", "terracotta": "טרקוטה"}
NEW_MATERIAL = ("solid_oak", "עץ אלון מלא")
OLIVE_CARCASS = {"op": "set_material", "target": "carcass", "color": {"catalogId": "olive_green"}}


def test_new_colours_and_material_are_served():
    catalog = TestClient(app).get("/api/catalog").json()["data"]
    colors = {entry["id"]: entry for entry in catalog["colors"]}
    for color_id in NEW_COLORS:
        assert re.fullmatch(r"#[0-9a-f]{6}", colors[color_id]["hex"])
    assert NEW_MATERIAL[0] in {entry["id"] for entry in catalog["materials"]}


def test_every_catalog_entry_has_a_hebrew_name():
    catalog = load_catalog()
    ids = {entry["id"] for entries in catalog.values() for entry in entries}
    assert ids - CATALOG_NAMES["he"].keys() == set()


def test_agent_prompt_lists_the_hebrew_name_with_the_id():
    prompt = build_system_prompt(basic_wardrobe(), load_catalog())
    assert '"id":"olive_green","name":"Olive green","hex":"#6b6f45","nameHe":"ירוק זית"' in prompt
    assert '"id":"solid_oak","name":"Solid oak","nameHe":"עץ אלון מלא"' in prompt


def test_hebrew_olive_request_becomes_a_signed_olive_proposal(make_client):  # noqa: F811
    fake = FakeClient(completion(calls=[tool_call(PROPOSE, propose([OLIVE_CARCASS]))]))
    data = make_client(fake).post("/api/chat", json=chat_body("תצבע בירוק זית")).json()["data"]
    assert data["proposal"]["ops"] == [OLIVE_CARCASS]
    assert "ירוק זית" in fake.requests[0]["messages"][0]["content"]


def test_new_entries_apply_and_show_in_the_hebrew_pdf():
    catalog = load_catalog()
    design = apply_ops(load_design("basic"), [
        {"op": "set_material", "target": "carcass", "color": {"catalogId": "olive_green"},
         "material": {"catalogId": NEW_MATERIAL[0]}},
        {"op": "set_material", "target": "dr_right", "color": {"catalogId": "terracotta"}},
    ], catalog)
    text = text_of(render_pdf(design, catalog, "he", date(2026, 10, 23)))
    for name in [*NEW_COLORS.values(), NEW_MATERIAL[1]]:
        assert name in text, name
