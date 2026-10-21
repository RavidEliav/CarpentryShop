"""One agent turn: OpenAI tool calling -> validated, signed proposal (never applied here).

Flow: the model either answers in text, asks a clarifying question, or proposes ops. Proposed
ops get ids filled in (so replaying an approved proposal is deterministic) and are dry-run on
the domain engine. An invalid batch is sent back to the model to repair, up to MAX_REPAIRS
times; after that the customer gets a clarification message instead of a broken proposal.
"""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from app.agent.language import FALLBACK_REPLY, OFF_TOPIC_REPLY, Language, reply_language
from app.agent.prompts import build_system_prompt
from app.agent.tools import ANSWER, CLARIFY, DECLINE, OFFER, PROPOSE, TOOLS, AnswerArgs, ClarifyArgs, OfferArgs, ProposeArgs
from app.domain import ids
from app.domain.apply import apply_ops
from app.domain.errors import DomainError
from app.services import signing

MAX_REPAIRS = 2
# Token budget: only the latest messages go to the model, and each completion is capped.
# The cap leaves room for the largest realistic batch of ops (a full new wardrobe).
HISTORY_WINDOW = 10
MAX_COMPLETION_TOKENS = 1200

# Add ops whose new-component id fields are filled in before signing.
_ID_FIELDS: dict[str, tuple[tuple[str, str], ...]] = {
    "add_shelf": (("id", ids.SHELF),),
    "add_drawer": (("id", ids.DRAWER),),
    "add_rail": (("id", ids.RAIL),),
    "add_compartment": (("id", ids.COMPARTMENT), ("partitionId", ids.PARTITION)),
    "add_partition": (("id", ids.PARTITION), ("newCompartmentId", ids.COMPARTMENT)),
}


@dataclass(frozen=True)
class TurnResult:
    reply: str
    proposal: dict | None = None
    offer_profile: bool = False  # show the Generate Style Profile (carpenter PDF) step


class AgentUnavailable(Exception):
    """The model provider failed (network, auth, quota...). Never carries provider text."""


def fill_ids(ops: list[dict]) -> list[dict]:
    """Give every new component an explicit id (copies; the input is not modified)."""
    filled = []
    for raw in ops:
        op = dict(raw)
        for field, prefix in _ID_FIELDS.get(op.get("op"), ()):
            if op.get(field) is None:
                op[field] = ids.new_id(prefix)
        if op.get("op") == "create_wardrobe" and isinstance(op.get("compartmentCount"), int):
            count = op["compartmentCount"]
            if op.get("compartmentIds") is None and 1 <= count <= 20:
                op["compartmentIds"] = [ids.new_id(ids.COMPARTMENT) for _ in range(count)]
            if op.get("partitionIds") is None and 1 <= count <= 20:
                op["partitionIds"] = [ids.new_id(ids.PARTITION) for _ in range(count - 1)]
        filled.append(op)
    return filled


def _history(messages: list[dict]) -> list[dict]:
    return [{"role": m["role"], "content": m["text"]} for m in messages[-HISTORY_WINDOW:]]


def _tool_message(call_id: str, content: dict) -> dict:
    return {"role": "tool", "tool_call_id": call_id, "content": json.dumps(content, default=str)}


def _build_proposal(args: ProposeArgs, ops: list[dict], revision: int, base_hash: str, key: bytes) -> dict:
    proposal_id = f"prp_{secrets.token_hex(8)}"
    return {
        "proposalId": proposal_id,
        "baseRevision": revision,
        "baseHash": base_hash,
        "ops": ops,
        "summary": args.summary,
        "changes": [change.model_dump() for change in args.changes],
        "signature": signing.sign(key, proposal_id=proposal_id, ops=ops, base_revision=revision, base_hash=base_hash),
    }


def run_turn(*, client: Any, model: str, messages: list[dict], design: dict, revision: int,
             catalog: dict, signing_key: bytes, language: Language = "he") -> TurnResult:
    """`design` must already be canonical (parsed and validated). The reply is in the language of the
    latest customer message; `language` (the chat's choice) is the fallback when it has no letters."""
    language = reply_language(messages, language)
    conversation: list[dict] = [{"role": "system", "content": build_system_prompt(design, catalog, language)}, *_history(messages)]
    base_hash = signing.design_hash(design)

    for _ in range(MAX_REPAIRS + 1):
        try:
            response = client.chat.completions.create(
                model=model, messages=conversation, tools=TOOLS, tool_choice="required", parallel_tool_calls=False,
                max_completion_tokens=MAX_COMPLETION_TOKENS,
            )
        except Exception as error:  # provider/network errors: never leak details to the customer
            raise AgentUnavailable() from error
        message = response.choices[0].message
        calls = message.tool_calls or []
        if not calls:
            # Every turn must be classified through a tool; free text is never shown to the customer.
            return TurnResult(reply=OFF_TOPIC_REPLY[language])

        conversation.append({
            "role": "assistant",
            "content": message.content,
            "tool_calls": [
                {"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}}
                for c in calls
            ],
        })
        call, extra = calls[0], calls[1:]
        for ignored in extra:
            conversation.append(_tool_message(ignored.id, {"error": "Only one tool call per turn is processed."}))

        try:
            arguments = json.loads(call.function.arguments or "{}")
            if call.function.name == DECLINE:
                return TurnResult(reply=OFF_TOPIC_REPLY[language])
            if call.function.name == CLARIFY:
                return TurnResult(reply=ClarifyArgs.model_validate(arguments).question)
            if call.function.name == ANSWER:
                return TurnResult(reply=AnswerArgs.model_validate(arguments).answer)
            if call.function.name == OFFER:
                return TurnResult(reply=OfferArgs.model_validate(arguments).reply, offer_profile=True)
            if call.function.name != PROPOSE:
                raise ValueError(f"unknown tool {call.function.name!r}")
            args = ProposeArgs.model_validate(arguments)
            ops = fill_ids(args.ops)
            apply_ops(design, ops, catalog)  # dry run on the engine's private copy
        except DomainError as error:
            conversation.append(_tool_message(call.id, {"error": error.to_dict(), "hint": "Fix the ops and call propose_changes again."}))
            continue
        except (ValidationError, ValueError, TypeError) as error:
            detail = error.errors(include_input=False, include_url=False) if isinstance(error, ValidationError) else str(error)
            conversation.append(_tool_message(call.id, {"error": "invalid tool arguments", "detail": detail}))
            continue
        return TurnResult(reply=args.reply, proposal=_build_proposal(args, ops, revision, base_hash, signing_key))

    return TurnResult(reply=FALLBACK_REPLY[language])
