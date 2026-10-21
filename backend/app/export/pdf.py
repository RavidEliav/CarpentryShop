"""Builds the carpenter PDF from a validated design: an illustration, the wardrobe data, dimensioned
drawings (front, interior, plan and side section), a build sequence and the component list.

The input must already be a canonical design (validated by the domain engine); this module only
reads it. Every number shown comes from the design or from app.export.layout.
"""

from __future__ import annotations

import io
import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date

from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from app.domain.catalog import SECTIONS
from app.domain.geometry import compartment_x_ranges, interior_height, interior_width, partition_left_edge
from app.export import layout
from app.export.draw import (
    ACCENT, DIM, HAIR, INK, MUTED, PAGE_H, PAGE_W, PANEL, WHITE,
    Pen, color, mix, pick_scale, register_fonts,
)
from app.export.strings import CATALOG_NAMES, STRINGS

MARGIN = 22
TITLE_H = 44
X0, X1 = MARGIN + 12, PAGE_W - MARGIN - 12
Y0, Y1 = MARGIN + TITLE_H + 10, PAGE_H - MARGIN - 12
TOP = Y1 - 26  # below the sheet heading
BLACK = color("#000000")


@dataclass
class Page:
    title: str
    scale: str
    draw: Callable[[], None]


@dataclass(frozen=True)
class View:
    """Maps outer design millimetres to page points."""
    ox: float
    oy: float
    k: float

    def x(self, mm: float) -> float:
        return self.ox + mm * self.k

    def y(self, mm: float) -> float:
        return self.oy + mm * self.k


def place(area: tuple[float, float, float, float], size: tuple[float, float],
          margins: tuple[float, float, float, float]) -> tuple[View, int | None]:
    """Fit a drawing of size (w, h) mm into area (x0, y0, x1, y1) leaving (left, right, bottom, top) pt."""
    ax0, ay0, ax1, ay1 = area
    left, right, bottom, top = margins
    aw, ah = ax1 - ax0 - left - right, ay1 - ay0 - bottom - top
    k, n = pick_scale(size[0], size[1], aw, ah)
    return View(ax0 + left + (aw - size[0] * k) / 2, ay0 + bottom + (ah - size[1] * k) / 2, k), n


class Document:
    def __init__(self, design: dict, catalog: dict, language: str, today: date, snapshot: bytes | None = None):
        register_fonts()
        self.snapshot = snapshot  # a cleaned JPEG of the app's 3D view, or None
        self.d = design
        self.catalog = catalog
        self.lang = language
        self.s = STRINGS[language]
        self.rtl = self.s["dir"] == "rtl"
        self.today = today
        self.buffer = io.BytesIO()
        self.c = canvas.Canvas(self.buffer, pagesize=(PAGE_W, PAGE_H), invariant=1)
        self.pen = Pen(self.c, self.rtl)
        self.W, self.H, self.D = (design["dimensions"][k] for k in ("width", "height", "depth"))
        self.T = design["carcass"]["panelThickness"]
        self.ranges = compartment_x_ranges(design)

    # -- helpers -----------------------------------------------------------------------
    @property
    def start_x(self) -> float:
        return X1 if self.rtl else X0

    def scale_label(self, n: int | None) -> str:
        return f"1:{n}" if n else self.s["notToScale"]

    def ref_name(self, field: str, ref: dict) -> str:
        if ref.get("custom"):
            return f"{ref['name']} ({self.s['custom']})"
        translated = CATALOG_NAMES[self.lang].get(ref["catalogId"])
        if translated:
            return translated
        return next(e["name"] for e in self.catalog[SECTIONS[field]] if e["id"] == ref["catalogId"])

    def hex_of(self, appearance: dict | None) -> str | None:
        if not appearance:
            return None
        ref = appearance["color"]
        if ref.get("custom"):
            return ref.get("hex")
        return next(e.get("hex") for e in self.catalog["colors"] if e["id"] == ref["catalogId"])

    def tint(self, appearance: dict | None, amount: float = 0.5):
        """The chosen colour, lightened so line work and dimensions stay readable on it."""
        return mix(color(self.hex_of(appearance)), WHITE, amount)

    @property
    def body_tint(self):
        return self.tint(self.d["carcass"]["appearance"])

    def appearance_text(self, appearance: dict) -> str:
        return " · ".join(self.ref_name(f, appearance[f]) for f in ("material", "color", "finish"))

    # -- build -------------------------------------------------------------------------
    def build(self) -> bytes:
        self.c.setTitle(self.s["docTitle"])
        self.c.setAuthor("BanAI")
        self.c.setSubject(f"{self.W} × {self.H} × {self.D} mm")
        self.c.setCreator("BanAI Wardrobe Designer")
        pages = self.plan_pages()
        for number, page in enumerate(pages, start=1):
            self.frame(page, number, len(pages))
            page.draw()
            self.c.showPage()
        self.c.save()
        return self.buffer.getvalue()

    def plan_pages(self) -> list[Page]:
        pages = [Page(self.s["sheetTitle"], self.s["asNoted"], self.page_sheet),
                 Page(self.s["illustration"], self.s["notToScale"], self.page_illustration),
                 Page(self.s["overview"], "—", self.page_summary)]
        if self.d["doors"]["type"] != "none":
            pages.append(self.page_front(doors=True))
        pages.append(self.page_front(doors=False))
        if self.crowded():
            pages.extend(self.page_detail(i) for i in range(len(self.d["compartments"])))
        pages.append(Page(self.s["planSection"], self.s["asNoted"], self.page_plan_section))
        pages.extend(self.pages_steps())
        pages.extend(self.pages_schedule())
        return pages

    def frame(self, page: Page, number: int, total: int) -> None:
        pen = self.pen
        pen.box(MARGIN, MARGIN, PAGE_W - MARGIN, PAGE_H - MARGIN, ink=INK, width=0.9)
        pen.text(self.start_x, Y1 - 12, page.title, 13, bold=True, fill=INK)
        # Title block: a row of labelled cells over a disclaimer line.
        top = MARGIN + TITLE_H
        pen.line(MARGIN, top, PAGE_W - MARGIN, top, INK, 0.9)
        pen.line(MARGIN, MARGIN + 15, PAGE_W - MARGIN, MARGIN + 15, HAIR, 0.4)
        pen.text(PAGE_W / 2, MARGIN + 5, self.s["disclaimer"], 6.5, fill=MUTED, align="center",
                 max_width=PAGE_W - 2 * MARGIN - 12)
        cells = [
            ("", self.s["brand"], 1.5), ("", self.s["docTitle"], 2.8), (self.s["sheet"], page.title, 2.2),
            (self.s["scale"], page.scale, 0.9), ("", self.s["units"], 0.9),
            (self.s["date"], self.today.strftime("%d.%m.%Y"), 0.9),
            (self.s["sheet"], f"{number} {self.s['of']} {total}", 0.9),
        ]
        if self.rtl:
            cells.reverse()
        unit = (PAGE_W - 2 * MARGIN) / sum(w for *_, w in cells)
        x = MARGIN
        for index, (label, value, weight) in enumerate(cells):
            w = weight * unit
            if index:
                pen.line(x, MARGIN + 15, x, top, HAIR, 0.4)
            cx = x + w / 2
            if label:
                pen.text(cx, top - 10, label, 5.8, fill=MUTED, align="center", max_width=w - 6)
                pen.text(cx, top - 22, value, 7.6, bold=True, align="center", max_width=w - 6)
            else:
                pen.text(cx, top - 17, value, 7.6, bold=True, align="center", max_width=w - 6,
                         fill=ACCENT if index == (len(cells) - 1 if self.rtl else 0) else INK)
            x += w

    # -- front elevation (shared by the illustration and the technical sheets) ---------
    def draw_front(self, v: View, colored: bool, doors: bool, codes: bool) -> None:
        pen, d, T, W, H = self.pen, self.d, self.T, self.W, self.H
        carcass = d["carcass"]["appearance"]
        body = color(self.hex_of(carcass)) if colored else self.body_tint
        ink = mix(body, BLACK, 0.55) if colored else INK
        pen.box(v.x(0), v.y(0), v.x(W), v.y(H), body, ink, 0.7)
        inside = mix(body, BLACK, 0.3) if colored else WHITE
        pen.box(v.x(T), v.y(T), v.x(W - T), v.y(H - T), inside, ink, 0.5)
        for index, partition in enumerate(d["partitions"]):
            left = T + partition_left_edge(d, index)
            pen.box(v.x(left), v.y(T), v.x(left + partition["thickness"]), v.y(H - T), body, ink, 0.5)
        for index, compartment in enumerate(d["compartments"]):
            self.draw_items(v, index, compartment, colored, codes, body, ink)
        if doors:
            self.draw_doors(v, colored, codes, ink)

    def draw_items(self, v: View, index: int, compartment: dict, colored: bool, codes: bool, body, ink) -> None:
        pen, T = self.pen, self.T
        x0, x1 = self.ranges[index]
        own = {e["id"]: e["appearance"] for key in ("shelves", "drawers") for e in compartment[key]}
        for item in layout.compartment_items(self.d, index):
            appearance = own.get(item.id) or self.d["carcass"]["appearance"]
            fill = color(self.hex_of(appearance)) if colored else self.tint(appearance)
            if item.kind == "shelf":
                pen.box(v.x(T + x0), v.y(T + item.y), v.x(T + x1), v.y(T + item.y + item.size),
                        mix(fill, WHITE, 0.12) if colored else mix(fill, BLACK, 0.15), ink, 0.4)
                if codes:
                    pen.text(v.x(T + x0) + 2, v.y(T + item.y + item.size) + 1.5, item.code, 5.5, fill=MUTED, align="left")
            elif item.kind == "drawer":
                y0, y1 = v.y(T + item.y) + 0.6, v.y(T + item.y + item.size) - 0.6
                pen.box(v.x(T + x0) + 0.8, y0, v.x(T + x1) - 0.8, y1, fill if colored else mix(fill, WHITE, 0.3), ink, 0.5)
                mid_x, mid_y = (v.x(T + x0) + v.x(T + x1)) / 2, (y0 + y1) / 2
                handle = min(80, (v.x(T + x1) - v.x(T + x0)) * 0.35) / 2
                pen.line(mid_x - handle, mid_y + (y1 - y0) * 0.18, mid_x + handle, mid_y + (y1 - y0) * 0.18,
                         mix(ink, WHITE, 0.2) if colored else MUTED, 1.4 if colored else 0.8)
                if codes:
                    pen.text(mid_x, mid_y - 5, item.code, 5.5, fill=MUTED, align="center")
            else:
                y = v.y(T + item.y)
                rail = color("#8d949b") if colored else INK
                pen.line(v.x(T + x0) + 2, y, v.x(T + x1) - 2, y, rail, 1.6 if colored else 1.0)
                for x in (v.x(T + x0) + 2, v.x(T + x1) - 2):
                    pen.stroke(rail, 0.6)
                    self.c.setFillColor(rail)
                    self.c.circle(x, y, 1.4, stroke=0, fill=1)
                if codes:
                    pen.text(v.x(T + x0) + 4, y - 7, item.code, 5.5, fill=MUTED, align="left")

    def draw_doors(self, v: View, colored: bool, codes: bool, ink) -> None:
        pen, T, H = self.pen, self.T, self.H
        doors = self.d["doors"]
        panels = layout.door_panels(self.d)
        top, bottom = v.y(H - T) - 0.8, v.y(T) + 0.8
        if doors["type"] == "sliding" and colored:
            # Overlapping panels on two tracks, as in the 3D view (visual only).
            count = len(panels)
            overlap = 60 if count > 1 else 0
            width = (interior_width(self.d) + (count - 1) * overlap) / count
            order = sorted(range(count), key=lambda i: i % 2 == 0)  # back track first
            for i in order:
                x0 = T + i * (width - overlap)
                fill = color(self.hex_of(panels[i].appearance))
                pen.box(v.x(x0), bottom, v.x(x0 + width), top, fill if i % 2 == 0 else mix(fill, BLACK, 0.08),
                        mix(fill, BLACK, 0.5), 0.6)
                hx = v.x(x0 + (40 if i == count - 1 and count > 1 else width - 40))
                self.handle(hx, bottom, top, v)
            return
        for panel in panels:
            x0, x1 = v.x(T + panel.x0) + 0.8, v.x(T + panel.x1) - 0.8
            fill = color(self.hex_of(panel.appearance)) if colored else self.tint(panel.appearance, 0.6)
            pen.box(x0, bottom, x1, top, fill, mix(fill, BLACK, 0.5) if colored else INK, 0.7)
            if colored:
                free = x0 + v.k * 40 if panel.hinge == "right" else x1 - v.k * 40
                self.handle(free, bottom, top, v)
                continue
            mid_y = (bottom + top) / 2
            if panel.hinge:
                hinge_x, free_x = (x0, x1) if panel.hinge == "left" else (x1, x0)
                pen.line(free_x, top, hinge_x, mid_y, MUTED, 0.5, (3, 2))
                pen.line(free_x, bottom, hinge_x, mid_y, MUTED, 0.5, (3, 2))
                hinge = self.s["hingeLeft" if panel.hinge == "left" else "hingeRight"]
            else:
                ax0, ax1 = x0 + (x1 - x0) * 0.25, x1 - (x1 - x0) * 0.25
                pen.line(ax0, mid_y - 18, ax1, mid_y - 18, MUTED, 0.6)
                pen.arrow_head(ax1, mid_y - 18, 1, 0, MUTED)
                pen.arrow_head(ax0, mid_y - 18, -1, 0, MUTED)
                hinge = self.s["slidingDoor"]
            if codes:
                cx = (x0 + x1) / 2
                pen.label(cx, mid_y + 10, panel.code, 8, INK, bold=True)
                pen.label(cx, mid_y - 2, f"{round(panel.x1 - panel.x0)} × {interior_height(self.d)}", 6.5, MUTED)
                pen.label(cx, mid_y - 30, hinge, 6.5, MUTED)
        if doors["type"] == "hinged" and not colored:
            covered = layout.covered_letters(self.d)
            for index, (x0, x1) in enumerate(self.ranges):
                if layout.letter(index) not in covered:
                    pen.label((v.x(T + x0) + v.x(T + x1)) / 2, (bottom + top) / 2, self.s["open"], 7, MUTED)

    def handle(self, x: float, bottom: float, top: float, v: View) -> None:
        length = min(400 * v.k, (top - bottom) * 0.4)
        centre = min(max(v.y(1050), bottom + length / 2 + 4), top - length / 2 - 4)
        self.pen.box(x - 1.1, centre - length / 2, x + 1.1, centre + length / 2, color("#9aa0a6"), color("#6b7177"), 0.3)

    # -- page: wardrobe sheet (picture + dimensioned drawing) ---------------------------
    def page_sheet(self) -> None:
        pen, s = self.pen, self.s
        half = (X1 - X0 - 24) / 2
        picture, drawing = (X1 - half, X0) if self.rtl else (X0, X0 + half + 24)
        top = TOP - 4
        # The picture: the app's own 3D view, or the drawn illustration when there is none.
        box = (picture, Y0 + 30, picture + half, top - 14)
        pen.box(*box, mix(PANEL, WHITE, 0.6), HAIR, 0.4)
        if self.snapshot:
            self.c.drawImage(ImageReader(io.BytesIO(self.snapshot)), box[0] + 4, box[1] + 4, half - 8, box[3] - box[1] - 8,
                             preserveAspectRatio=True, anchor="c")
        else:
            self.oblique((box[0] + 8, box[1] + 8, box[2] - 8, box[3] - 8), doors=self.d["doors"]["type"] != "none")
        pen.text(picture + half / 2, top - 6, s["photoCaption"], 9, bold=True, align="center")
        pen.text(picture + half / 2, Y0 + 14, f"{self.W} × {self.H} × {self.D} {s['mm']} · {s['illustrationNote']}", 6.8,
                 fill=MUTED, align="center", max_width=half)
        # The drawing: the interior front with the chosen colours and the main dimensions.
        view, n = place((drawing, Y0 + 10, drawing + half, top - 14), (self.W, self.H), (6, 70, 66, 22))
        self.draw_front(view, colored=False, doors=False, codes=False)
        self.letters(view)
        self.outer_dims(view, doors=False)
        pen.text(drawing + half / 2, top - 6, f"{s['drawingCaption']} · {self.scale_label(n)}", 9, bold=True, align="center")

    # -- page: illustration ------------------------------------------------------------
    def page_illustration(self) -> None:
        has_doors = self.d["doors"]["type"] != "none"
        views = [(self.s["closedView"], True), (self.s["openView"], False)] if has_doors else [(self.s["openView"], False)]
        width = (X1 - X0) / len(views)
        ordered = list(reversed(views)) if self.rtl else views
        for index, (caption, doors) in enumerate(ordered):
            bx0 = X0 + index * width
            self.oblique((bx0 + 10, Y0 + 40, bx0 + width - 10, TOP - 6), doors)
            self.pen.text(bx0 + width / 2, Y0 + 22, caption, 10, bold=True, align="center")
        self.pen.text(PAGE_W / 2, Y0 + 6, f"{self.W} × {self.H} × {self.D} {self.s['mm']} · {self.s['illustrationNote']}",
                      7.5, fill=MUTED, align="center", max_width=X1 - X0)

    def oblique(self, area: tuple[float, float, float, float], doors: bool) -> None:
        """Cabinet oblique view: the true front, with the top and right side receding at 35°."""
        W, H, D = self.W, self.H, self.D
        dx, dy = D * 0.5 * math.cos(math.radians(35)), D * 0.5 * math.sin(math.radians(35))
        ax0, ay0, ax1, ay1 = area
        k = min((ax1 - ax0) / (W + dx), (ay1 - ay0) / (H + dy)) * 0.92
        v = View(ax0 + ((ax1 - ax0) - (W + dx) * k) / 2, ay0 + ((ay1 - ay0) - (H + dy) * k) / 2, k)
        body = color(self.hex_of(self.d["carcass"]["appearance"]))
        edge = mix(body, BLACK, 0.55)
        self.c.setFillColor(mix(WHITE, BLACK, 0.12))
        self.c.ellipse(v.x(-W * 0.04), v.y(-dy * 0.35), v.x(W * 1.04 + dx), v.y(dy * 0.55), stroke=0, fill=1)
        pt = lambda x, y: (v.x(x), v.y(y))  # noqa: E731
        self.pen.polygon([pt(0, H), pt(W, H), pt(W + dx, H + dy), pt(dx, H + dy)], mix(body, WHITE, 0.25), edge, 0.6)
        self.pen.polygon([pt(W, 0), pt(W + dx, dy), pt(W + dx, H + dy), pt(W, H)], mix(body, BLACK, 0.18), edge, 0.6)
        self.draw_front(v, colored=True, doors=doors, codes=False)

    # -- page: summary -----------------------------------------------------------------
    def page_summary(self) -> None:
        s, d = self.s, self.d
        half = (X1 - X0 - 30) / 2
        first, second = (X1 - half, X0) if self.rtl else (X0, X0 + half + 30)
        letters = [layout.letter(i) for i in range(len(d["compartments"]))]
        counts = {k: sum(len(c[k]) for c in d["compartments"]) for k in ("shelves", "drawers", "rails")}
        doors = d["doors"]
        door_text = s[doors["type"]] + (f" · {len(doors['items'])}" if doors["items"] else "")
        thicknesses = {p["thickness"] for p in d["partitions"]}
        partitions = ("—" if not d["partitions"] else
                      f"{len(d['partitions'])} × {thicknesses.pop()}" if len(thicknesses) == 1 else
                      " · ".join(f"P{i + 1} {p['thickness']}" for i, p in enumerate(d["partitions"])))
        rows = [
            (s["overallSize"], f"{self.W} × {self.H} × {self.D}"),
            (s["interiorSize"], f"{interior_width(d)} × {interior_height(d)}"),
            (s["panelThickness"], str(self.T)),
            (s["compartments"], f"{len(letters)} ({', '.join(letters)})"),
            (s["compartmentWidths"], " · ".join(f"{l} {c['width']}" for l, c in zip(letters, d["compartments"]))),
            (s["partitions"], partitions),
            (s["doors"], door_text),
            (s["interiorItems"], " · ".join(f"{counts[k]} {s[k]}" for k in ("shelves", "drawers", "rails"))),
            (s["carcass"], self.appearance_text(d["carcass"]["appearance"])),
        ]
        if doors["type"] != "none":
            rows.append((s["doors"], self.appearance_text(doors["appearance"])))
        self.key_values(first, half, TOP, s["summary"], rows)
        y = self.materials(second, half, TOP) - 26
        start = second + half if self.rtl else second
        sign = -1 if self.rtl else 1
        self.pen.text(start, y, s["notes"], 10, bold=True, fill=ACCENT)
        y -= 18
        for n in range(1, 7):
            for index, line in enumerate(self.pen.wrap(s[f"note{n}"], half - 12, 7.6)):
                if index == 0:
                    self.pen.text(start, y, "•", 7.6, fill=MUTED)
                self.pen.text(start + sign * 10, y, line, 7.6)
                y -= 10.5
            y -= 4

    def key_values(self, x: float, width: float, top: float, heading: str, rows: list[tuple[str, str]]) -> None:
        pen = self.pen
        start = x + width if self.rtl else x
        pen.text(start, top - 4, heading, 10, bold=True, fill=ACCENT)
        y = top - 22
        key_w = width * 0.42
        for key, value in rows:
            pen.line(x, y - 4, x + width, y - 4, HAIR, 0.3)
            pen.text(start, y, key, 7.5, fill=MUTED, max_width=key_w - 6)
            value_x = start - key_w if self.rtl else start + key_w
            for n, line in enumerate(pen.wrap(value, width - key_w, 8, True)[:2]):
                pen.text(value_x, y - n * 10, line, 8, bold=True, max_width=width - key_w)
                if n:
                    y -= 10
            y -= 17

    def materials(self, x: float, width: float, top: float) -> float:
        pen, s, d = self.pen, self.s, self.d
        start = x + width if self.rtl else x
        pen.text(start, top - 4, s["materials"], 10, bold=True, fill=ACCENT)
        groups: dict[str, tuple[dict, list[str]]] = {}

        def add(appearance: dict, usage: str) -> None:
            key = repr(sorted((f, sorted(appearance[f].items())) for f in ("material", "color", "finish")))
            groups.setdefault(key, (appearance, []))[1].append(usage)

        add(d["carcass"]["appearance"], f"{s['carcass']} (C1)")
        if d["doors"]["type"] != "none":
            add(d["doors"]["appearance"], s["doors"])
        for row in layout.component_rows(d):
            if row.override:
                add(row.appearance, row.code)
        y = top - 24
        for appearance, usages in list(groups.values())[:9]:
            swatch = color(self.hex_of(appearance))
            sx = start - 12 if self.rtl else start
            pen.box(sx, y - 3, sx + 12, y + 9, swatch, mix(swatch, BLACK, 0.5), 0.4)
            tx = start - 18 if self.rtl else start + 18
            pen.text(tx, y + 3, self.appearance_text(appearance), 8, bold=True, max_width=width - 18)
            pen.text(tx, y - 7, ", ".join(usages), 7, fill=MUTED, max_width=width - 18)
            pen.line(x, y - 12, x + width, y - 12, HAIR, 0.3)
            y -= 27
        pen.text(start, y + 2, s["inheritNote"], 7, fill=MUTED, max_width=width)
        return y

    # -- pages: technical front elevations ---------------------------------------------
    def crowded(self) -> bool:
        _, n = place((X0, Y0, X1, TOP), (self.W, self.H), (10, 80, 70, 24))
        k = (1 / n if n else 1 / 200) * 72 / 25.4
        return min(c["width"] for c in self.d["compartments"]) * k < 70

    def page_front(self, doors: bool) -> Page:
        view, n = place((X0, Y0, X1, TOP), (self.W, self.H), (10, 80, 70, 24))

        def draw() -> None:
            self.draw_front(view, colored=False, doors=doors, codes=True)
            self.letters(view)
            if not doors:
                self.inner_chains(view)
            self.outer_dims(view, doors)
        return Page(self.s["frontClosed" if doors else "frontOpen"], self.scale_label(n), draw)

    def letters(self, v: View) -> None:
        for index, (x0, x1) in enumerate(self.ranges):
            self.pen.text((v.x(self.T + x0) + v.x(self.T + x1)) / 2, v.y(self.H) + 7, layout.letter(index), 10,
                          bold=True, fill=ACCENT, align="center")

    def inner_chains(self, v: View) -> None:
        for index, (_, x1) in enumerate(self.ranges):
            chain = layout.vertical_chain(self.d, index)
            ys = [v.y(self.T + chain[0].start), *(v.y(self.T + seg.end) for seg in chain)]
            labels = [None if seg.kind == "shelf" else str(seg.length) for seg in chain]
            self.pen.vchain(v.x(self.T + x1) - 5, ys, labels, left=True, size=6)

    def outer_dims(self, v: View, doors: bool) -> None:
        pen, W, H, T = self.pen, self.W, self.H, self.T
        if doors and self.d["doors"]["type"] == "hinged":
            edges = sorted({0, W, *(T + round(p.x0) for p in layout.door_panels(self.d)),
                            *(T + round(p.x1) for p in layout.door_panels(self.d))})
            pen.hchain([v.x(x) for x in edges], v.y(0) - 18, [str(b - a) for a, b in zip(edges, edges[1:])],
                       v.y(0) - 2, below=True)
        else:
            chain = layout.width_chain(self.d)
            pen.hchain([v.x(chain[0].start), *(v.x(seg.end) for seg in chain)], v.y(0) - 18,
                       [str(seg.length) for seg in chain], v.y(0) - 2, below=True)
        pen.hchain([v.x(0), v.x(W)], v.y(0) - 52, [str(W)], v.y(0) - 2, below=True, size=8)
        pen.vchain(v.x(W) + 18, [v.y(0), v.y(T), v.y(H - T), v.y(H)], [str(T), str(H - 2 * T), str(T)],
                   v.x(W) + 2, left=False)
        pen.vchain(v.x(W) + 50, [v.y(0), v.y(H)], [str(H)], v.x(W) + 2, left=False, size=8)

    def page_detail(self, index: int) -> Page:
        x0, x1 = self.ranges[index]
        width = x1 - x0
        view, n = place((X0, Y0, X1, TOP), (width + 2 * self.T, self.H), (150, 150, 30, 24))

        def draw() -> None:
            pen, T, H = self.pen, self.T, self.H
            # Shift so the compartment's left neighbour panel starts at x = 0.
            v = View(view.ox - x0 * view.k, view.oy, view.k)
            pen.box(v.x(x0), v.y(0), v.x(x1 + 2 * T), v.y(H), self.body_tint, INK, 0.7)
            pen.box(v.x(x0 + T), v.y(T), v.x(x1 + T), v.y(H - T), WHITE, INK, 0.5)
            self.draw_items(v, index, self.d["compartments"][index], False, False, self.body_tint, INK)
            pen.text((v.x(x0 + T) + v.x(x1 + T)) / 2, v.y(H) + 7, layout.letter(index), 12, bold=True,
                     fill=ACCENT, align="center")
            chain = layout.vertical_chain(self.d, index)
            ys = [v.y(T + chain[0].start), *(v.y(T + seg.end) for seg in chain)]
            pen.vchain(v.x(x1 + 2 * T) + 20, ys, [None if seg.kind == "shelf" else str(seg.length) for seg in chain],
                       v.x(x1 + T), left=False, size=7)
            items = layout.compartment_items(self.d, index)
            if not items:
                pen.label((v.x(x0 + T) + v.x(x1 + T)) / 2, v.y(H / 2), self.s["noItems"], 8, MUTED)
            for item in items:
                y = v.y(T + item.y + (item.size / 2 if item.kind == "drawer" else 0))
                pen.line(v.x(x0) - 6, y, v.x(x0 + T) + 4, y, HAIR, 0.3)
                text = f"{item.code} · {item.y}" + (f"–{item.y + item.size}" if item.kind == "drawer" else "")
                pen.text(v.x(x0) - 9, y - 2.5, text, 7, align="right", fill=INK)
            pen.hchain([v.x(x0 + T), v.x(x1 + T)], v.y(0) - 18, [str(width)], v.y(0) - 2, below=True, size=8)
        title = f"{self.s['detail']} {layout.letter(index)}"
        return Page(title, self.scale_label(n), draw)

    # -- page: plan and side section ---------------------------------------------------
    def page_plan_section(self) -> None:
        pen, s, d, W, D, H, T = self.pen, self.s, self.d, self.W, self.D, self.H, self.T
        panels = layout.door_panels(d)
        swing = max((p.x1 - p.x0 for p in panels), default=0) if d["doors"]["type"] == "hinged" else 45
        share = min(max(W / (W + D * 1.4), 0.5), 0.72)
        split = X0 + (X1 - X0) * share
        plan_area, section_area = (X0, Y0, split, TOP), (split + 10, Y0, X1, TOP)
        if self.rtl:
            plan_area, section_area = (X1 - (split - X0), Y0, X1, TOP), (X0, Y0, X1 - (split - X0) - 10, TOP)
        pv, pn = place(plan_area, (W, D + swing), (10, 60, 20, 44))
        v = View(pv.ox, pv.oy + swing * pv.k, pv.k)
        pen.text((plan_area[0] + plan_area[2]) / 2, TOP - 6, f"{s['plan']} · {self.scale_label(pn)}", 9, bold=True,
                 align="center")
        pen.box(v.x(0), v.y(0), v.x(W), v.y(D), WHITE, INK, 0.6)
        body = self.body_tint
        pen.box(v.x(0), v.y(0), v.x(T), v.y(D), body, INK, 0.5)
        pen.box(v.x(W - T), v.y(0), v.x(W), v.y(D), body, INK, 0.5)
        for index, partition in enumerate(d["partitions"]):
            left = T + partition_left_edge(d, index)
            pen.box(v.x(left), v.y(0), v.x(left + partition["thickness"]), v.y(D), body, INK, 0.5)
        for index, (x0, x1) in enumerate(self.ranges):
            pen.text((v.x(T + x0) + v.x(T + x1)) / 2, v.y(D / 2) - 4, layout.letter(index), 10, bold=True,
                     fill=ACCENT, align="center")
        pen.text(v.x(W / 2), v.y(D) + 4, s["back"], 7, fill=MUTED, align="center")
        if d["doors"]["type"] == "hinged":
            for panel in panels:
                hx = v.x(T + (panel.x0 if panel.hinge == "left" else panel.x1))
                r = (panel.x1 - panel.x0) * v.k
                pen.line(hx, v.y(0), hx, v.y(0) - r, INK, 1.1)
                pen.stroke(MUTED, 0.4, (2, 2))
                self.c.arc(hx - r, v.y(0) - r, hx + r, v.y(0) + r, 270 if panel.hinge == "left" else 180, 90)
                pen.text(hx + (4 if panel.hinge == "left" else -4), v.y(0) - r * 0.5, panel.code, 6.5,
                         fill=INK, align="left" if panel.hinge == "left" else "right")
        elif d["doors"]["type"] == "sliding":
            for i, panel in enumerate(panels):
                y0 = v.y(-6 - (i % 2) * 20)
                pen.box(v.x(T + panel.x0), y0, v.x(T + panel.x1), y0 - 14 * v.k, WHITE, INK, 0.5)
        pen.text(v.x(W / 2), pv.oy - 14, s["front"], 7, fill=MUTED, align="center")
        chain = layout.width_chain(d)
        pen.hchain([v.x(chain[0].start), *(v.x(seg.end) for seg in chain)], v.y(D) + 18,
                   [str(seg.length) for seg in chain], v.y(D) + 2)
        pen.vchain(v.x(W) + 14, [v.y(0), v.y(D)], [str(D)], v.x(W) + 2, left=False, size=7.5)

        # Side section through the busiest compartment, front on the left.
        index = max(range(len(d["compartments"])), key=lambda i: len(layout.compartment_items(d, i)))
        sv, sn = place(section_area, (D, H), (40, 80, 40, 44))
        pen.text((section_area[0] + section_area[2]) / 2, TOP - 6,
                 f"{s['sectionThrough']} {layout.letter(index)} · {self.scale_label(sn)}", 9, bold=True, align="center")
        pen.box(sv.x(0), sv.y(0), sv.x(D), sv.y(H), WHITE, INK, 0.6)
        pen.box(sv.x(0), sv.y(0), sv.x(D), sv.y(T), body, INK, 0.5)
        pen.box(sv.x(0), sv.y(H - T), sv.x(D), sv.y(H), body, INK, 0.5)
        for item in layout.compartment_items(d, index):
            if item.kind == "shelf":
                pen.box(sv.x(0), sv.y(T + item.y), sv.x(D), sv.y(T + item.y + item.size), mix(body, BLACK, 0.15), INK, 0.4)
            elif item.kind == "drawer":
                pen.box(sv.x(0), sv.y(T + item.y) + 0.6, sv.x(D) - 2, sv.y(T + item.y + item.size) - 0.6, None,
                        MUTED, 0.4, (2, 1.5))
                pen.box(sv.x(0), sv.y(T + item.y) + 0.6, sv.x(18), sv.y(T + item.y + item.size) - 0.6, WHITE, INK, 0.5)
            else:
                pen.stroke(INK, 0.6)
                self.c.circle(sv.x(D / 2), sv.y(T + item.y), max(12 * sv.k, 1.2), stroke=1, fill=0)
            pen.text(sv.x(D / 2), sv.y(T + item.y + item.size) + 2, item.code, 5.5, fill=MUTED, align="center")
        pen.text(sv.x(0), sv.y(0) - 12, s["front"], 7, fill=MUTED, align="center")
        pen.text(sv.x(D), sv.y(0) - 12, s["back"], 7, fill=MUTED, align="center")
        chain = layout.vertical_chain(d, index)
        ys = [sv.y(0), sv.y(T), *(sv.y(T + seg.end) for seg in chain), sv.y(H)]
        labels = [str(T), *(None if seg.kind == "shelf" else str(seg.length) for seg in chain), str(T)]
        pen.vchain(sv.x(D) + 16, ys, labels, sv.x(D) + 2, left=False, size=6)
        pen.hchain([sv.x(0), sv.x(D)], sv.y(0) - 30, [str(D)], sv.y(0) - 2, below=True, size=7.5)

    # -- pages: build sequence (two flowing columns) -----------------------------------
    def step_blocks(self) -> list[tuple[str, str]]:
        s, d = self.s, self.d
        f = lambda key, **kw: s[key].format(**kw)  # noqa: E731
        iw, ih = interior_width(d), interior_height(d)
        letters = [layout.letter(i) for i in range(len(d["compartments"]))]
        blocks = [("step", f("stepCarcass", w=self.W, h=self.H, d=self.D, t=self.T, iw=iw, ih=ih))]
        if d["partitions"]:
            widths = " · ".join(f"{l} {c['width']}" for l, c in zip(letters, d["compartments"]))
            blocks.append(("step", f("stepPartitions", n=len(d["partitions"]), ih=ih, widths=widths)))
            for index, partition in enumerate(d["partitions"]):
                blocks.append(("bullet", f("stepPartitionAt", code=f"P{index + 1}", t=partition["thickness"],
                                           x=partition_left_edge(d, index))))
        else:
            blocks.append(("step", f("stepNoPartitions", iw=iw)))
        chain = layout.width_chain(d)
        blocks.append(("bullet", f("stepWidthCheck", sum=" + ".join(str(seg.length) for seg in chain), w=self.W)))
        blocks.append(("step", s["stepInterior"]))
        for index, compartment in enumerate(d["compartments"]):
            parts = []
            for item in layout.compartment_items(d, index):
                if item.kind == "shelf":
                    parts.append(f("itemShelf", code=item.code, y=item.y, t=item.size))
                elif item.kind == "drawer":
                    parts.append(f("itemDrawer", code=item.code, y0=item.y, y1=item.y + item.size, h=item.size))
                else:
                    parts.append(f("itemRail", code=item.code, y=item.y, w=compartment["width"]))
            head = f("stepCompartment", l=letters[index], w=compartment["width"])
            blocks.append(("bullet", f"{head} {'; '.join(parts) if parts else s['noItems']}."))
        doors = d["doors"]
        if doors["type"] == "hinged":
            blocks.append(("step", s["hinged"] + ":"))
            for panel in layout.door_panels(d):
                hinge = s["hingeLeft" if panel.hinge == "left" else "hingeRight"]
                blocks.append(("bullet", f("stepHingedDoor", code=panel.code, letters="+".join(panel.letters),
                                           hinge=hinge, w=round(panel.x1 - panel.x0), h=ih)))
            if layout.covered_letters(d) != set(letters):
                blocks.append(("bullet", s["notCountedFor"]))
        elif doors["type"] == "sliding":
            blocks.append(("step", f("stepSlidingDoors", n=len(doors["items"]), iw=iw, w=round(iw / len(doors["items"])))))
        else:
            blocks.append(("step", s["stepNoDoors"]))
        blocks.append(("step", s["stepFinishes"]))
        blocks.append(("bullet", f"{s['carcass']}: {self.appearance_text(d['carcass']['appearance'])}"))
        if doors["type"] != "none":
            blocks.append(("bullet", f"{s['doors']}: {self.appearance_text(doors['appearance'])}"))
        for row in layout.component_rows(d):
            if row.override:
                blocks.append(("bullet", f"{row.code}: {self.appearance_text(row.appearance)}"))
        blocks.append(("h", s["notes"]))
        blocks.extend(("bullet", s[f"note{n}"]) for n in range(1, 7))
        blocks.append(("bullet", s["disclaimer"]))
        return blocks

    def pages_steps(self) -> list[Page]:
        column_w = (X1 - X0 - 30) / 2
        size, lead = 8.4, 12.2
        lines: list[tuple[str, str, str]] = []  # (kind, marker, text)
        step = 0
        for kind, text in self.step_blocks():
            if kind == "h":
                lines.append(("gap", "", ""))
                lines.append(("h", "", text))
                continue
            marker = ""
            indent = 16 if kind == "step" else 26
            if kind == "step":
                step += 1
                marker = f"{step}."
            else:
                marker = "•"
            for n, line in enumerate(self.pen.wrap(text, column_w - indent, size, kind == "step")):
                lines.append((kind, marker if n == 0 else "", line))
            lines.append(("space", "", ""))
        while lines and lines[0][0] == "gap":
            lines.pop(0)
        per_column = int((TOP - Y0) / lead)
        columns = [lines[i:i + per_column] for i in range(0, len(lines), per_column)]
        pages = []
        for p in range(0, len(columns), 2):
            chunk = columns[p:p + 2]
            title = self.s["buildSteps"] + ("" if p == 0 else f" ({self.s['continued']})")
            pages.append(Page(title, "—", lambda chunk=chunk: self.draw_columns(chunk, column_w, size, lead)))
        return pages

    def draw_columns(self, columns: list, column_w: float, size: float, lead: float) -> None:
        pen = self.pen
        for index, column in enumerate(columns):
            left = X0 + index * (column_w + 30) if not self.rtl else X1 - column_w - index * (column_w + 30)
            start = left + column_w if self.rtl else left
            sign = -1 if self.rtl else 1
            y = TOP - 4
            for kind, marker, text in column:
                if kind == "h":
                    pen.text(start, y, text, 10.5, bold=True, fill=ACCENT)
                elif kind in ("step", "bullet"):
                    indent = 16 if kind == "step" else 26
                    if marker:
                        pen.text(start + sign * (indent - 14), y, marker, size, bold=kind == "step",
                                 fill=ACCENT if kind == "step" else MUTED)
                    pen.text(start + sign * indent, y, text, size, bold=kind == "step")
                y -= lead if kind != "space" else lead * 0.35

    # -- pages: component list ---------------------------------------------------------
    def schedule_rows(self) -> list[list[str]]:
        s = self.s
        rows = []
        for row in layout.component_rows(self.d):
            size = row.size
            if row.kind == "carcass":
                text = s["sizeCarcass"].format(w=size[0], h=size[1], d=size[2], t=size[3])
            elif row.kind == "partition":
                text = s["sizePartition"].format(h=size[0], d=size[1], t=size[2])
            elif row.kind == "door":
                text = s["sizeDoor"].format(w=size[0], h=size[1])
            elif row.kind == "shelf":
                text = s["sizeShelf"].format(w=size[0], d=size[1], t=size[2])
            elif row.kind == "drawer":
                text = s["sizeDrawer"].format(w=size[0], h=size[1])
            else:
                text = s["sizeRail"].format(w=size[0])
            kind = s["slidingDoor"] if row.kind == "door" and self.d["doors"]["type"] == "sliding" else s[row.kind]
            if row.kind == "door" and self.d["doors"]["type"] == "hinged":
                hinge = next(p.hinge for p in layout.door_panels(self.d) if p.code == row.code)
                kind = f"{s['door']} · {s['hingeLeft' if hinge == 'left' else 'hingeRight']}"
            if row.override:
                kind += f" ({s['override']})"
            appearance = row.appearance
            rows.append([
                row.code, kind, row.compartment.replace("|", " | "), "—" if row.height is None else str(row.height), text,
                *(self.ref_name(f, appearance[f]) if appearance else "—" for f in ("material", "color", "finish")),
                self.hex_of(appearance) or "",
            ])
        return rows

    def pages_schedule(self) -> list[Page]:
        rows = self.schedule_rows()
        row_h = 15
        per_page = int((TOP - Y0) / row_h) - 1
        chunks = [rows[i:i + per_page] for i in range(0, len(rows), per_page)] or [[]]
        return [Page(self.s["schedule"] + ("" if n == 0 else f" ({self.s['continued']})"), "—",
                     lambda chunk=chunk: self.draw_table(chunk, row_h)) for n, chunk in enumerate(chunks)]

    def draw_table(self, rows: list[list[str]], row_h: float) -> None:
        pen, s = self.pen, self.s
        headers = [s["code"], s["item"], s["compartment"], s["height"], s["size"], s["material"], s["color"], s["finish"]]
        weights = [0.7, 1.9, 0.8, 1.1, 2.7, 1.4, 1.4, 0.9]
        unit = (X1 - X0) / sum(weights)
        widths = [w * unit for w in weights]
        edges = []
        x = X1 if self.rtl else X0
        for w in widths:
            edges.append((x - w, x) if self.rtl else (x, x + w))
            x = x - w if self.rtl else x + w
        y = TOP
        pen.box(X0, y - row_h, X1, y, PANEL, None)
        for (a, b), header in zip(edges, headers):
            pen.text(b - 4 if self.rtl else a + 4, y - row_h + 4.5, header, 7, bold=True, max_width=b - a - 8)
        y -= row_h
        for n, row in enumerate(rows):
            if n % 2:
                pen.box(X0, y - row_h, X1, y, mix(PANEL, WHITE, 0.7), None)
            for col, ((a, b), value) in enumerate(zip(edges, row[:8])):
                tx = b - 4 if self.rtl else a + 4
                if col == 6 and row[8]:
                    sx = b - 12 if self.rtl else a + 4
                    swatch = color(row[8])
                    pen.box(sx, y - row_h + 3.5, sx + 8, y - row_h + 11.5, swatch, mix(swatch, BLACK, 0.5), 0.3)
                    tx = b - 15 if self.rtl else a + 15
                pen.text(tx, y - row_h + 4.5, value, 7, bold=col == 0, max_width=b - a - (19 if col == 6 else 8))
            pen.line(X0, y - row_h, X1, y - row_h, HAIR, 0.25)
            y -= row_h
        pen.box(X0, y, X1, TOP, None, INK, 0.5)
        for a, _ in edges[1:] if not self.rtl else [(b, a) for a, b in edges[1:]]:
            pen.line(a, y, a, TOP, HAIR, 0.3)


def render_pdf(design: dict, catalog: dict, language: str, today: date, snapshot: bytes | None = None) -> bytes:
    """The carpenter PDF for a canonical design (validate it first with the domain engine). `snapshot`
    is a JPEG already cleaned by app.export.image.clean_snapshot."""
    return Document(design, catalog, language, today, snapshot).build()
