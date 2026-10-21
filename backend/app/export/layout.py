"""Pure drawing data derived from a validated design: component codes, dimension chains, door
layout and the component list. No PDF code here, so every number can be tested directly.

Coordinates follow the domain: interior x from the inner face of the left side panel, interior y
from the top face of the bottom panel, all in integer millimetres. Sizes are "as designed":
construction allowances (back panel, door overlay, drawer boxes) are left to the carpenter.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.domain.geometry import compartment_x_ranges, interior_height, interior_width


def letter(index: int) -> str:
    """A, B, ... Z, AA, AB, ... (the schema allows up to 20 compartments)."""
    name = ""
    index += 1
    while index:
        index, rest = divmod(index - 1, 26)
        name = chr(65 + rest) + name
    return name


@dataclass(frozen=True)
class Item:
    code: str
    kind: str  # shelf | drawer | rail
    id: str
    y: int
    size: int  # shelf thickness, drawer height, 0 for a rail


@dataclass(frozen=True)
class Segment:
    start: int
    end: int
    kind: str  # clear | shelf | drawer | panel | compartment | partition

    @property
    def length(self) -> int:
        return self.end - self.start


@dataclass(frozen=True)
class DoorPanel:
    code: str
    id: str
    x0: float  # interior x of the covered opening
    x1: float
    hinge: str | None  # left | right | None (sliding)
    letters: tuple[str, ...]
    appearance: dict


def compartment_items(design: dict, index: int) -> list[Item]:
    """Shelves (S), drawers (DW) and rails (R) of one compartment, bottom-up, numbered per kind."""
    compartment = design["compartments"][index]
    prefix = letter(index)
    items: list[Item] = []
    for kind, key, short, size_key in (
        ("shelf", "shelves", "S", "thickness"),
        ("drawer", "drawers", "DW", "height"),
        ("rail", "rails", "R", None),
    ):
        ordered = sorted(compartment[key], key=lambda entry: entry["y"])
        for number, entry in enumerate(ordered, start=1):
            size = entry[size_key] if size_key else 0
            items.append(Item(f"{prefix}-{short}{number}", kind, entry["id"], entry["y"], size))
    return sorted(items, key=lambda item: (item.y, item.kind != "drawer", item.code))


def vertical_chain(design: dict, index: int) -> list[Segment]:
    """Consecutive spans from the interior bottom to the interior top of one compartment.

    Shelves and drawers become their own segments, the gaps between them are "clear". Rails are
    points, so they split a clear gap. The lengths always sum to the interior height.
    """
    top = interior_height(design)
    solids = [(item.y, item.y + item.size, item.kind) for item in compartment_items(design, index) if item.kind != "rail"]
    rails = {item.y for item in compartment_items(design, index) if item.kind == "rail"}
    breaks = {0, top, *rails}
    for start, end, _ in solids:
        breaks.update((start, end))
    points = sorted(breaks)
    chain = []
    for start, end in zip(points, points[1:]):
        kind = next((k for s, e, k in solids if s <= start and end <= e), "clear")
        chain.append(Segment(start, end, kind))
    return chain


def width_chain(design: dict) -> list[Segment]:
    """Overall x from the outer left face: panel, compartment, partition, ..., panel."""
    panel = design["carcass"]["panelThickness"]
    chain = [Segment(0, panel, "panel")]
    for index, (x0, x1) in enumerate(compartment_x_ranges(design)):
        chain.append(Segment(panel + x0, panel + x1, "compartment"))
        if index < len(design["partitions"]):
            thickness = design["partitions"][index]["thickness"]
            chain.append(Segment(panel + x1, panel + x1 + thickness, "partition"))
    width = design["dimensions"]["width"]
    chain.append(Segment(width - panel, width, "panel"))
    return chain


def door_panels(design: dict) -> list[DoorPanel]:
    """Hinged doors span the compartments they cover; sliding panels share the interior width."""
    doors = design["doors"]
    ranges = compartment_x_ranges(design)
    index_of = {c["id"]: i for i, c in enumerate(design["compartments"])}
    if doors["type"] == "hinged":
        panels = []
        for number, door in enumerate(sorted(doors["items"], key=lambda d: index_of[d["compartmentIds"][0]]), start=1):
            indices = [index_of[cid] for cid in door["compartmentIds"]]
            panels.append(DoorPanel(
                f"DR{number}", door["id"], ranges[indices[0]][0], ranges[indices[-1]][1], door["hingeSide"],
                tuple(letter(i) for i in indices), door["appearance"] or doors["appearance"],
            ))
        return panels
    if doors["type"] == "sliding":
        count = len(doors["items"])
        share = interior_width(design) / count
        return [
            DoorPanel(f"DR{n + 1}", door["id"], n * share, (n + 1) * share, None, (), door["appearance"] or doors["appearance"])
            for n, door in enumerate(doors["items"])
        ]
    return []


def covered_letters(design: dict) -> set[str]:
    if design["doors"]["type"] != "hinged":
        return {letter(i) for i in range(len(design["compartments"]))} if design["doors"]["type"] == "sliding" else set()
    return {name for panel in door_panels(design) for name in panel.letters}


@dataclass(frozen=True)
class Row:
    code: str
    kind: str  # carcass | partition | door | shelf | drawer | rail
    compartment: str  # letter(s), or "" for whole-wardrobe parts
    height: int | None  # y from the interior bottom
    size: tuple[int, ...]  # mm, in the order the kind's label describes
    appearance: dict | None  # None = no appearance of its own (partition, rail)
    override: bool = False


def component_rows(design: dict) -> list[Row]:
    """The component list in build order: carcass, partitions, doors, then each compartment."""
    width, height, depth = (design["dimensions"][k] for k in ("width", "height", "depth"))
    panel = design["carcass"]["panelThickness"]
    carcass = design["carcass"]["appearance"]
    inner_h = interior_height(design)
    rows = [Row("C1", "carcass", "", None, (width, height, depth, panel), carcass)]
    for number, partition in enumerate(design["partitions"], start=1):
        rows.append(Row(f"P{number}", "partition", f"{letter(number - 1)}|{letter(number)}", None,
                        (inner_h, depth, partition["thickness"]), None))
    door_ids = {d["id"]: d for d in design["doors"]["items"]}
    for door in door_panels(design):
        rows.append(Row(door.code, "door", "+".join(door.letters), None, (round(door.x1 - door.x0), inner_h),
                        door.appearance, door_ids[door.id]["appearance"] is not None))
    for index, compartment in enumerate(design["compartments"]):
        by_id = {entry["id"]: entry for key in ("shelves", "drawers") for entry in compartment[key]}
        for item in compartment_items(design, index):
            own = by_id[item.id]["appearance"] if item.kind != "rail" else None
            if item.kind == "shelf":
                size = (compartment["width"], depth, item.size)
            elif item.kind == "drawer":
                size = (compartment["width"], item.size)
            else:
                size = (compartment["width"],)
            appearance = None if item.kind == "rail" else own or carcass
            rows.append(Row(item.code, item.kind, letter(index), item.y, size, appearance, own is not None))
    return rows
