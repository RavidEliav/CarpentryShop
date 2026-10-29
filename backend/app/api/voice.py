"""Voice for the AI designer: speech-to-text in, text-to-speech out. A chained pipeline: the
transcript goes through the normal /api/chat turn, so voice never bypasses the signed proposal
and its Confirm step. The server stores nothing."""

from __future__ import annotations

import logging
import re
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field

from app.agent.language import Language
from app.api.agent import MESSAGE_TEXT_PATTERN, get_llm_client, localized
from app.config import Settings, get_settings, get_signing_key
from app.services import signing

router = APIRouter(prefix="/api/voice")
log = logging.getLogger(__name__)

# ASSUMPTION: configurable defaults (OPENAI_TRANSCRIBE_MODEL / OPENAI_TTS_MODEL / OPENAI_TTS_VOICE).
DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe"
DEFAULT_TTS_MODEL = "gpt-4o-mini-tts"
DEFAULT_TTS_VOICE = "marin"

# The browser records at 32 kbps and stops at 60 s (~240 KB). The byte cap is not a duration
# limit: low-bitrate audio can be longer. shortcut: no duration check; add rate limiting (open item).
MAX_AUDIO_BYTES = 1_000_000
MAX_TRANSCRIPT_CHARS = 2000  # the chat message limit
MAX_SPEECH_CHARS = 1000
AUDIO_TYPES = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/wav": "wav", "audio/mpeg": "mp3"}
# Measured on real Hebrew audio (2026-10-16): English instructions that name Hebrew speak it most
# clearly; instructions written in Hebrew made the speech worse.
SPEECH_STYLE = (
    "Speak in the language of the text. For Hebrew, use fluent native Israeli Hebrew pronunciation. "
    "Calm, friendly furniture designer; clear and concise."
)
# Domain vocabulary in all three languages: fixes Hebrew misrecognitions and writes sizes as digits,
# without forcing a language (English or Spanish speech stays as spoken).
TRANSCRIBE_PROMPT = (
    "שיחה על עיצוב ארון בגדים, בעברית, באנגלית או בספרדית: ארון, תא, מדף, מגירה, מוט תלייה, מחיצה, "
    "דלתות הזזה, דלתות ציר, רוחב, גובה, עומק, סנטימטר, מט, מבריק. "
    "Wardrobe design in Hebrew, English or Spanish: shelf, drawer, hanging rail, sliding doors, width, cm. "
    "Diseño de armario: estante, cajón, barra de colgar, puertas correderas, ancho, alto, cm."
)
PROMPTABLE_MODELS = {"gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"}
# Abbreviations TTS reads letter by letter; spoken as words instead.
SPOKEN_UNITS = {'ס"מ': "סנטימטר", "ס״מ": "סנטימטר", 'מ"מ': "מילימטר", "מ״מ": "מילימטר"}


def spoken(text: str) -> str:
    for short, word in SPOKEN_UNITS.items():
        text = text.replace(short, word)
    return text



def _model(value: str, default: str) -> str:
    return value.strip() or default


async def _read_capped(request: Request) -> bytes | None:
    """The body, or None once it passes MAX_AUDIO_BYTES (stops reading early)."""
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_AUDIO_BYTES:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/transcribe")
async def transcribe(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    client: Annotated[Any, Depends(get_llm_client)],
    language: Annotated[Language, Query()] = "he",
):
    if client is None:
        return localized(503, "AGENT_UNAVAILABLE", language)
    media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if media_type not in AUDIO_TYPES:
        return localized(415, "UNSUPPORTED_AUDIO", language)
    audio = await _read_capped(request)
    if audio is None:
        return localized(413, "AUDIO_TOO_LARGE", language)
    if not audio:
        return localized(422, "NO_SPEECH", language)
    # No language hint: the customer may speak either language, and the chat switches to whichever
    # the transcript is written in. `language` only localizes the error messages.
    model = _model(settings.openai_transcribe_model, DEFAULT_TRANSCRIBE_MODEL)
    try:
        # The OpenAI client is synchronous: run it off the event loop, or one slow upstream call
        # would stall every other request (health checks included).
        result = await run_in_threadpool(
            client.audio.transcriptions.create,
            model=model,
            file=(f"speech.{AUDIO_TYPES[media_type]}", audio, media_type),
            **({"prompt": TRANSCRIBE_PROMPT} if model in PROMPTABLE_MODELS else {}),
        )
    except Exception:  # never echo upstream error text to the customer
        log.exception("transcription failed")
        return localized(502, "AGENT_ERROR", language)
    text = " ".join((getattr(result, "text", "") or "").split())[:MAX_TRANSCRIPT_CHARS]
    if not text or not re.fullmatch(MESSAGE_TEXT_PATTERN, text):  # must be sendable as a chat message
        return localized(422, "NO_SPEECH", language)
    return {"success": True, "data": {"text": text}}


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: Annotated[str, Field(min_length=1, max_length=MAX_SPEECH_CHARS, pattern=MESSAGE_TEXT_PATTERN)]
    language: Language = "he"
    signature: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]  # replySignature from /api/chat


@router.post("/speech")
def speech(
    request: SpeechRequest,
    settings: Annotated[Settings, Depends(get_settings)],
    client: Annotated[Any, Depends(get_llm_client)],
):
    if client is None:
        return localized(503, "AGENT_UNAVAILABLE", request.language)
    # Only the agent's own replies are spoken: this is not an open text-to-speech proxy.
    if not signing.verify_reply(get_signing_key(), request.signature, request.text):
        return localized(403, "BAD_REPLY_SIGNATURE", request.language)
    try:
        result = client.audio.speech.create(
            model=_model(settings.openai_tts_model, DEFAULT_TTS_MODEL),
            voice=_model(settings.openai_tts_voice, DEFAULT_TTS_VOICE),
            input=spoken(request.text), instructions=SPEECH_STYLE, response_format="mp3",
        )
        audio = result.read() if hasattr(result, "read") else result.content
    except Exception:
        log.exception("speech synthesis failed")
        return localized(502, "AGENT_ERROR", request.language)
    return Response(content=audio, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
