"""Reply language: the agent answers only in the language the customer's latest message is
written in (Hebrew, English or Spanish). The language chosen in the chat is used when a message has
no letters to go by (e.g. "240?"), and to tell English from Spanish when the words don't (e.g. "240 cm").
The chat UI switches its language to match what was written."""

from __future__ import annotations

import re
from typing import Literal

Language = Literal["he", "en", "es"]
LANGUAGES: tuple[Language, ...] = ("he", "en", "es")

_HEBREW = re.compile(r"[א-ת]")
_LATIN = re.compile(r"[A-Za-zñáéíóúüÑÁÉÍÓÚÜ]")
_WORD = re.compile(r"[a-zñáéíóúü]+")
_SPANISH_MARKS = re.compile(r"[ñáéíóúü¿¡]")
# Words that only one of the two languages uses. Shared spellings (no, me, color, a) are left out.
# Mirrored in frontend/src/chat/i18n.js; parity: shared/fixtures/language/detect.json.
SPANISH_WORDS = frozenset("""
quiero quisiera armario armarios puerta puertas estante estantes balda baldas cajon cajón cajones ancho
alto altura profundidad fondo añade añadir agrega agregar pon poner haz hacer quita quitar cambia cambiar
con una uno el la los las del de en y para por que qué más mas menos blanco negro madera nogal roble
barra colgar centímetros centimetros compartimento compartimentos hola gracias cuánto cuanto cuesta
precio medio izquierda derecha corredera correderas batiente batientes espejo listo terminado gris
""".split())
ENGLISH_WORDS = frozenset("""
the and with add make please wardrobe shelf shelves door doors drawer drawers wide tall high deep rail
hanging i want can you what how much change remove set to of in on it is left right middle white black
sliding hinged mirror hello hi thanks cost done finished grey gray
""".split())  # catalog names (Walnut, Oak…) are left out: Spanish messages use them too

# Fixed texts (never model-written).
OFF_TOPIC_REPLY: dict[Language, str] = {
    "he": "אני כאן כדי לעזור רק בעיצוב ותכנון הארון שלך: מידות, חלוקה פנימית, מדפים ומגירות, "
          "דלתות, חומרים, צבעים וגימורים. במה אפשר לעזור בעיצוב?",
    "en": "I'm here to help only with designing and planning your wardrobe: dimensions, interior "
          "layout, shelves and drawers, doors, materials, colours and finishes. How can I help with your design?",
    "es": "Estoy aquí solo para ayudarte a diseñar y planificar tu armario: medidas, distribución "
          "interior, estantes y cajones, puertas, materiales, colores y acabados. ¿En qué te ayudo con tu diseño?",
}
FALLBACK_REPLY: dict[Language, str] = {
    "he": "לא הצלחתי להפוך את הבקשה לשינוי תקין בארון. אפשר לנסח אותה אחרת, או לספר לי קצת יותר מה תרצה?",
    "en": "I couldn't turn that into a valid change to your wardrobe. Could you rephrase it, or tell me a bit more?",
    "es": "No he podido convertir eso en un cambio válido para tu armario. ¿Puedes decirlo de otra forma "
          "o contarme un poco más?",
}

# The instruction appended at the very end of the system prompt (after the per-turn data).
# It overrides the language of earlier messages in the conversation.
INSTRUCTION: dict[Language, str] = {
    "he": "Write EVERYTHING customer-facing in HEBREW (reply, summary, change titles and details, "
          "questions, answers), even if earlier messages were in English. Write centimetres as ס\"מ. Translate catalog names (Walnut -> אגוז, White -> לבן).",
    "en": "Write EVERYTHING customer-facing in ENGLISH (reply, summary, change titles and details, "
          "questions, answers), even if earlier messages were in Hebrew. Write centimetres as cm.",
    "es": "Write EVERYTHING customer-facing in SPANISH (reply, summary, change titles and details, "
          "questions, answers), even if earlier messages were in Hebrew or English. Use neutral Spanish "
          "and address the customer as tú. Write centimetres as cm. Translate catalog names "
          "(Walnut -> Nogal, White -> Blanco, Natural oak -> Roble natural).",
}


def detect(text: str, chosen: Language | None = None) -> Language | None:
    """The language a message is written in, or None when it has no letters.

    Hebrew wins when a message has any Hebrew (e.g. Hebrew with an English brand name). Latin text
    is Spanish or English by its Spanish marks and by words only one language uses; when that is a
    tie (e.g. "240 cm", "Walnut"), it stays in the chosen language if that is English or Spanish,
    else English. Mirrored in frontend/src/chat/i18n.js (detectLanguage)."""
    if _HEBREW.search(text):
        return "he"
    if not _LATIN.search(text):
        return None
    lowered = text.lower()
    words = _WORD.findall(lowered)
    spanish = 2 * len(_SPANISH_MARKS.findall(lowered)) + sum(word in SPANISH_WORDS for word in words)
    english = sum(word in ENGLISH_WORDS for word in words)
    if spanish != english:
        return "es" if spanish > english else "en"
    return chosen if chosen in ("en", "es") else "en"


def reply_language(messages: list[dict], chosen: Language) -> Language:
    latest = next((m["text"] for m in reversed(messages) if m["role"] == "user"), "")
    return detect(latest, chosen) or chosen
