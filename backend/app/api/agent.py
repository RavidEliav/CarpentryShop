"""AI design agent endpoints: a chat turn returns a reply and maybe a signed proposal;
applying a proposal verifies it and returns the new design. The server stores nothing."""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app.agent.language import Language
from app.agent.orchestrator import AgentUnavailable, run_turn
from app.config import Settings, get_settings, get_signing_key
from app.domain.apply import apply_ops
from app.domain.catalog import load_catalog
from app.domain.errors import DomainError
from app.domain.schema import SAFE_TEXT_PATTERN
from app.services import signing

router = APIRouter(prefix="/api")

MAX_HISTORY = 30
# Safe text, but chat messages may contain line breaks from the composer.
MESSAGE_TEXT_PATTERN = SAFE_TEXT_PATTERN.replace(r"\x00-\x1f", r"\x00-\x09\x0b-\x1f")


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    text: Annotated[str, Field(min_length=1, max_length=2000, pattern=MESSAGE_TEXT_PATTERN)]


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    messages: Annotated[list[ChatMessage], Field(min_length=1, max_length=MAX_HISTORY)]
    design: dict
    revision: Annotated[int, Field(ge=1)]
    language: Language = "he"


class SignedProposal(BaseModel):
    model_config = ConfigDict(extra="ignore")  # summary/changes travel along but are not trusted
    proposalId: Annotated[str, Field(pattern=r"^prp_[0-9a-f]{16}$")]
    baseRevision: Annotated[int, Field(ge=1)]
    baseHash: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    ops: list[dict]
    signature: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class ApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    design: dict
    revision: Annotated[int, Field(ge=1)]
    proposal: SignedProposal
    language: Language = "he"


# Customer-facing API messages per UI language (domain errors keep their engine-owned text).
MESSAGES: dict[str, dict[str, str]] = {
    "AGENT_UNAVAILABLE": {"he": "המעצב החכם עדיין לא מוגדר בשרת הזה.", "en": "The AI designer is not configured on this server.", "es": "El diseñador con IA aún no está configurado en este servidor."},
    "INVALID_REQUEST": {"he": "ההודעה האחרונה חייבת להגיע מהלקוח.", "en": "The last message must come from the customer.", "es": "El último mensaje debe ser del cliente."},
    "AGENT_ERROR": {"he": "המעצב החכם לא זמין כרגע. נסה שוב בעוד רגע.", "en": "The AI designer is unavailable right now. Please try again in a moment.", "es": "El diseñador con IA no está disponible ahora. Inténtalo de nuevo en un momento."},
    "BAD_SIGNATURE": {"he": "לא ניתן לאמת את ההצעה. בקש מהמעצב שוב.", "en": "This proposal could not be verified. Ask the designer again.", "es": "No se pudo verificar esta propuesta. Vuelve a pedírsela al diseñador."},
    "NO_SPEECH": {"he": "לא שמעתי דיבור. נסה שוב.", "en": "I couldn't hear any speech. Please try again.", "es": "No he oído nada. Inténtalo de nuevo."},
    "UNSUPPORTED_AUDIO": {"he": "פורמט השמע לא נתמך.", "en": "This audio format is not supported.", "es": "Este formato de audio no es compatible."},
    "AUDIO_TOO_LARGE": {"he": "ההקלטה ארוכה מדי.", "en": "The recording is too long.", "es": "La grabación es demasiado larga."},
    "BAD_REPLY_SIGNATURE": {"he": "אפשר להקריא רק תשובות של המעצב.", "en": "Only the designer's own replies can be read aloud.", "es": "Solo se pueden leer en voz alta las respuestas del diseñador."},
    "STALE": {"he": "העיצוב השתנה אחרי שההצעה נוצרה. בקש מהמעצב הצעה חדשה.", "en": "The design changed after this proposal was made. Ask the designer to re-propose.", "es": "El diseño cambió después de crear esta propuesta. Pide al diseñador una nueva."},
}


def localized(status: int, code: str, language: str) -> JSONResponse:
    return error(status, code, MESSAGES[code][language])


def error(status: int, code: str, message: str, path: str | None = None) -> JSONResponse:
    body: dict[str, Any] = {"code": code, "message": message}
    if path:
        body["path"] = path
    return JSONResponse(status_code=status, content={"success": False, "error": body})


@lru_cache
def _openai_client(api_key: str) -> Any:
    from openai import OpenAI  # imported lazily: only needed when the agent is configured

    return OpenAI(api_key=api_key, timeout=60, max_retries=1)


def get_llm_client(settings: Annotated[Settings, Depends(get_settings)]) -> Any:
    return _openai_client(settings.openai_api_key.strip()) if settings.agent_enabled else None


def _canonical(design: dict, catalog: dict) -> dict:
    """Parse + fully validate a client design (no ops)."""
    return apply_ops(design, [], catalog)


@router.post("/chat")
def chat(
    request: ChatRequest,
    settings: Annotated[Settings, Depends(get_settings)],
    client: Annotated[Any, Depends(get_llm_client)],
):
    if client is None:
        return localized(503, "AGENT_UNAVAILABLE", request.language)
    if request.messages[-1].role != "user":
        return localized(422, "INVALID_REQUEST", request.language)
    catalog = load_catalog()
    try:
        design = _canonical(request.design, catalog)
    except DomainError as exc:
        return error(422, exc.code, exc.message, exc.path)
    try:
        result = run_turn(
            client=client, model=settings.chat_model, messages=[m.model_dump() for m in request.messages],
            design=design, revision=request.revision, catalog=catalog, signing_key=get_signing_key(),
            language=request.language,
        )
    except AgentUnavailable:
        return localized(502, "AGENT_ERROR", request.language)
    # The reply is signed so /api/voice/speech only reads aloud what this server said.
    reply_signature = signing.sign_reply(get_signing_key(), result.reply)
    return {"success": True, "data": {"reply": result.reply, "replySignature": reply_signature, "proposal": result.proposal,
                                     "offerProfile": result.offer_profile}}


@router.post("/proposals/apply")
def apply_proposal(request: ApplyRequest):
    catalog = load_catalog()
    proposal = request.proposal
    try:
        design = _canonical(request.design, catalog)
    except DomainError as exc:
        return error(422, exc.code, exc.message, exc.path)
    valid = signing.verify(
        get_signing_key(), proposal.signature, proposal_id=proposal.proposalId, ops=proposal.ops,
        base_revision=proposal.baseRevision, base_hash=proposal.baseHash,
    )
    if not valid:
        return localized(400, "BAD_SIGNATURE", request.language)
    if request.revision != proposal.baseRevision or signing.design_hash(design) != proposal.baseHash:
        return localized(409, "STALE", request.language)
    try:
        updated = apply_ops(design, proposal.ops, catalog)
    except DomainError as exc:
        return error(422, exc.code, exc.message, exc.path)
    return {"success": True, "data": {"design": updated, "revision": request.revision + 1}}
