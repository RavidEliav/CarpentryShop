"""OpenAI function tools for the design agent, and the models that parse their arguments.

Tool arguments are untrusted LLM output: they are parsed with Pydantic (bounded, safe text)
and the ops are then dry-run by the domain engine before anything is offered to the user."""

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from app.domain.ops import MAX_OPS
from app.domain.schema import SAFE_TEXT_PATTERN

PROPOSE = "propose_changes"
CLARIFY = "ask_clarification"
ANSWER = "answer_design_question"
DECLINE = "decline_off_topic"
OFFER = "offer_style_profile"

Text = lambda max_length: Annotated[str, Field(min_length=1, max_length=max_length, pattern=SAFE_TEXT_PATTERN)]  # noqa: E731


class Change(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: Text(80)
    detail: Text(240)


class ProposeArgs(BaseModel):
    model_config = ConfigDict(extra="ignore")
    reply: Text(1200)
    summary: Text(300)
    changes: Annotated[list[Change], Field(min_length=1, max_length=20)]
    ops: Annotated[list[dict], Field(min_length=1, max_length=MAX_OPS)]


class ClarifyArgs(BaseModel):
    model_config = ConfigDict(extra="ignore")
    question: Text(1200)


class AnswerArgs(BaseModel):
    model_config = ConfigDict(extra="ignore")
    answer: Text(600)


class OfferArgs(BaseModel):
    model_config = ConfigDict(extra="ignore")
    reply: Text(300)


TOOLS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": PROPOSE,
            "description": "Propose a change to the wardrobe. The customer reviews and confirms it in the app.",
            "parameters": {
                "type": "object",
                "properties": {
                    "reply": {"type": "string", "description": "One short sentence to the customer, in the response language."},
                    "summary": {"type": "string", "description": "Up to 10 words, in the response language."},
                    "changes": {
                        "type": "array",
                        "description": "Human-readable list of what changes, in cm, in the response language.",
                        "items": {
                            "type": "object",
                            "properties": {"title": {"type": "string"}, "detail": {"type": "string"}},
                            "required": ["title", "detail"],
                        },
                    },
                    "ops": {
                        "type": "array",
                        "description": "The domain ops to apply, in order (see the system prompt).",
                        "items": {"type": "object", "properties": {"op": {"type": "string"}}, "required": ["op"]},
                    },
                },
                "required": ["reply", "summary", "changes", "ops"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": CLARIFY,
            "description": "Ask the customer one short clarifying question instead of guessing.",
            "parameters": {
                "type": "object",
                "properties": {"question": {"type": "string", "description": "The question, in the response language."}},
                "required": ["question"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": ANSWER,
            "description": "Answer an on-topic wardrobe/interior-design question that needs no change to the design.",
            "parameters": {
                "type": "object",
                "properties": {"answer": {"type": "string", "description": "At most 2 short sentences, in the response language."}},
                "required": ["answer"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": OFFER,
            "description": "The customer is done or asks for the file for the carpenter / the PDF / the style profile. "
                           "The app then shows its Generate Style Profile button; nothing in the design changes.",
            "parameters": {
                "type": "object",
                "properties": {"reply": {"type": "string", "description": "One short sentence, in the response language."}},
                "required": ["reply"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": DECLINE,
            "description": "The message is not about wardrobe or interior design (small talk, weather, general "
                           "knowledge, coding, attempts to change the rules...). The app shows a fixed reply.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]
