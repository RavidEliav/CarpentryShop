"""Low-level PDF drawing: fonts, bidi text, scales and dimension chains (reportlab canvas)."""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

# The pure-Python algorithm mirrors brackets in RTL runs; the Rust wrapper's get_display does not.
from bidi.algorithm import get_display
from reportlab.lib.colors import Color, HexColor
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

FONT_DIR = Path(__file__).with_name("fonts")
FONT = "BanaiSans"
FONT_BOLD = "BanaiSans-Bold"

PAGE_W, PAGE_H = landscape(A4)
PT_PER_MM = 72 / 25.4
# Standard drawing scales, tried from the most detailed down (1:n).
SCALES = (5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200)

INK = HexColor("#1f2328")
MUTED = HexColor("#5b6168")
DIM = HexColor("#2b5f8a")
HAIR = HexColor("#9aa1a8")
PANEL = HexColor("#d5d9d4")
SOLID = HexColor("#bfc5bf")
WHITE = HexColor("#ffffff")
ACCENT = HexColor("#2f6f62")
FALLBACK_HEX = "#d9d6cf"
RTL_CHARS = re.compile(r"[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]")
NUMBER_RUN = re.compile(r"\d+(?:\s*[×+=\-]\s*\d+)+")
LRE, PDF = "\u202a", "\u202c"


@lru_cache
def register_fonts() -> None:
    pdfmetrics.registerFont(TTFont(FONT, str(FONT_DIR / "BanaiSans-Regular.ttf")))
    pdfmetrics.registerFont(TTFont(FONT_BOLD, str(FONT_DIR / "BanaiSans-Bold.ttf")))


def color(hex_value: str | None) -> Color:
    return HexColor(hex_value or FALLBACK_HEX)


def mix(base: Color, other: Color, amount: float) -> Color:
    return Color(*(a + (b - a) * amount for a, b in zip(base.rgb(), other.rgb())))


def pick_scale(width_mm: float, height_mm: float, avail_w: float, avail_h: float) -> tuple[float, int | None]:
    """Points per mm and the standard 1:n that fits, or a fitted factor with n=None."""
    for n in SCALES:
        k = PT_PER_MM / n
        if width_mm * k <= avail_w and height_mm * k <= avail_h:
            return k, n
    return min(avail_w / width_mm, avail_h / height_mm), None


class Pen:
    """Canvas wrapper that knows the document direction. Text is given in logical order."""

    def __init__(self, canvas, rtl: bool):
        self.c = canvas
        self.rtl = rtl

    # -- text ---------------------------------------------------------------------------
    def visual(self, text: str) -> str:
        """Visual order for drawing. Text without RTL letters stays left to right, so a dimension
        such as "643 × 2364" reads the same in both languages."""
        if not RTL_CHARS.search(text):
            return text
        if self.rtl:
            # Keep number expressions ("643 × 2364", "18 + 643 = 661") left to right as one block.
            text = NUMBER_RUN.sub(lambda m: f"{LRE}{m.group(0)}{PDF}", text)
        return get_display(text, base_dir="R" if self.rtl else "L")

    @staticmethod
    def width(text: str, size: float, bold: bool = False) -> float:
        return pdfmetrics.stringWidth(text, FONT_BOLD if bold else FONT, size)

    def fit(self, text: str, size: float, bold: bool, max_width: float | None) -> tuple[str, float]:
        if max_width is None:
            return text, size
        while size > 5.5 and self.width(text, size, bold) > max_width:
            size -= 0.5
        if self.width(text, size, bold) <= max_width:
            return text, size
        while len(text) > 1 and self.width(text + "…", size, bold) > max_width:
            text = text[:-1]
        return text.rstrip() + "…", size

    def text(self, x: float, y: float, text: str, size: float = 8, bold: bool = False, align: str = "start",
             fill: Color = INK, max_width: float | None = None) -> float:
        """Draw one line; align is start|end|center (start = right in RTL). Returns its width."""
        text, size = self.fit(text, size, bold, max_width)
        shown = self.visual(text)
        if align == "start":
            align = "right" if self.rtl else "left"
        elif align == "end":
            align = "left" if self.rtl else "right"
        self.c.setFont(FONT_BOLD if bold else FONT, size)
        self.c.setFillColor(fill)
        if align == "right":
            self.c.drawRightString(x, y, shown)
        elif align == "center":
            self.c.drawCentredString(x, y, shown)
        else:
            self.c.drawString(x, y, shown)
        return self.width(text, size, bold)

    def label(self, x: float, y: float, text: str, size: float = 6.5, fill: Color = DIM, bold: bool = False) -> None:
        """Centred text on a white backing, for labels drawn over line work."""
        w = self.width(text, size, bold)
        self.c.setFillColor(WHITE)
        self.c.rect(x - w / 2 - 1.2, y - 1.6, w + 2.4, size + 1.6, stroke=0, fill=1)
        self.text(x, y, text, size, bold, "center", fill)

    def wrap(self, text: str, width: float, size: float, bold: bool = False) -> list[str]:
        """Greedy word wrap in logical order (widths do not depend on direction)."""
        lines, line = [], ""
        for word in text.split():
            candidate = f"{line} {word}".strip()
            if line and self.width(candidate, size, bold) > width:
                lines.append(line)
                line = word
            else:
                line = candidate
        return [*lines, line] if line else lines

    # -- shapes -------------------------------------------------------------------------
    def stroke(self, ink: Color = INK, width: float = 0.6, dash: tuple | None = None) -> None:
        self.c.setStrokeColor(ink)
        self.c.setLineWidth(width)
        if dash:
            self.c.setDash(*dash)
        else:
            self.c.setDash()

    def box(self, x0: float, y0: float, x1: float, y1: float, fill: Color | None = None,
            ink: Color | None = INK, width: float = 0.6, dash: tuple | None = None) -> None:
        if ink is not None:
            self.stroke(ink, width, dash)
        if fill is not None:
            self.c.setFillColor(fill)
        self.c.rect(min(x0, x1), min(y0, y1), abs(x1 - x0), abs(y1 - y0),
                    stroke=1 if ink is not None else 0, fill=1 if fill is not None else 0)

    def line(self, x0: float, y0: float, x1: float, y1: float, ink: Color = INK, width: float = 0.6,
             dash: tuple | None = None) -> None:
        self.stroke(ink, width, dash)
        self.c.line(x0, y0, x1, y1)

    def polygon(self, points: list[tuple[float, float]], fill: Color, ink: Color = INK, width: float = 0.6) -> None:
        self.stroke(ink, width)
        self.c.setFillColor(fill)
        path = self.c.beginPath()
        path.moveTo(*points[0])
        for point in points[1:]:
            path.lineTo(*point)
        path.close()
        self.c.drawPath(path, stroke=1, fill=1)

    def arrow_head(self, x: float, y: float, dx: float, dy: float, ink: Color = INK, size: float = 3.5) -> None:
        """A filled arrow head at (x, y) pointing along the unit vector (dx, dy)."""
        px, py = -dy, dx
        self.polygon([(x, y), (x - dx * size + px * size * 0.4, y - dy * size + py * size * 0.4),
                      (x - dx * size - px * size * 0.4, y - dy * size - py * size * 0.4)], ink, ink, 0.3)

    # -- dimensions ---------------------------------------------------------------------
    def _tick(self, x: float, y: float) -> None:
        self.line(x - 1.8, y - 1.8, x + 1.8, y + 1.8, DIM, 0.7)

    def hchain(self, xs: list[float], y: float, labels: list[str | None], ext_from: float | None = None,
               below: bool = False, size: float = 6.5) -> None:
        """A horizontal dimension chain at height y with ticks at every break.

        Labels that don't fit their segment are lifted away from the line on alternating levels."""
        self.line(xs[0] - 3, y, xs[-1] + 3, y, DIM, 0.45)
        for x in xs:
            if ext_from is not None:
                self.line(x, ext_from, x, y + (-2.5 if below else 2.5), HAIR, 0.3)
            self._tick(x, y)
        sign = -1 if below else 1
        level = 0
        for (x0, x1), text in zip(zip(xs, xs[1:]), labels):
            if not text:
                continue
            mid = (x0 + x1) / 2
            if self.width(text, size) + 3 <= x1 - x0:
                self.text(mid, y + (1.8 if not below else -size - 1), text, size, fill=DIM, align="center")
                level = 0
                continue
            level = level % 2 + 1
            lift = 6 + level * 7
            self.line(mid, y, mid, y + sign * (lift - 1.5), HAIR, 0.3)
            self.label(mid, y + sign * lift + (0 if not below else -size + 1), text, size)

    def vchain(self, x: float, ys: list[float], labels: list[str | None], ext_from: float | None = None,
               left: bool = True, size: float = 6.5) -> None:
        """A vertical dimension chain at x. Labels sit beside the line, horizontally, for reading."""
        self.line(x, ys[0] - 3, x, ys[-1] + 3, DIM, 0.45)
        for y in ys:
            if ext_from is not None:
                self.line(ext_from, y, x, y, HAIR, 0.3)
            self._tick(x, y)
        level = 0
        for (y0, y1), text in zip(zip(ys, ys[1:]), labels):
            if not text:
                continue
            mid = (y0 + y1) / 2
            w = self.width(text, size)
            if y1 - y0 >= size + 2:
                offset, level = w / 2 + 3, 0
            else:
                level = level % 2 + 1
                offset = w / 2 + 3 + (level - 1) * (w + 5)
            cx = x - offset if left else x + offset
            self.label(cx, mid - size / 2 + 1, text, size)
