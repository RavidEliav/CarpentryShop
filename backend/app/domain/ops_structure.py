"""Handlers for layout ops (wardrobe, dimensions, compartments, partitions, doors, removal).

Handlers receive a private deep copy (`draft`), edit it in place and return it;
the caller re-validates the result. Integer arithmetic only (parity with JS).
"""

from __future__ import annotations

from app.domain import ids
from app.domain import ops as op_types
from app.domain.defaults import DEFAULT_PANEL_THICKNESS, DEFAULT_SLIDING_DOOR_COUNT, LIMITS, default_appearance
from app.domain.errors import INVALID_OP, NOT_FOUND, OUT_OF_RANGE, DomainError
from app.domain.geometry import partition_left_edge
from app.domain.lookup import ITEM_KINDS, compartment_index, locate, partition_index, require_range


def _given(value, fallback):
    return value if value is not None else fallback


def _empty_compartment(compartment_id: str, width: int) -> dict:
    return {"id": compartment_id, "width": width, "shelves": [], "drawers": [], "rails": []}


def _door(door_id: str, compartment_ids: list[str], hinge_side: str | None) -> dict:
    return {"id": door_id, "compartmentIds": compartment_ids, "hingeSide": hinge_side, "appearance": None}


def _ids_or_new(given: list[str] | None, count: int, prefix: str, path: str) -> list[str]:
    if given is None:
        return [ids.new_id(prefix) for _ in range(count)]
    if len(given) != count:
        raise DomainError(INVALID_OP, path, f"expected {count} ids, got {len(given)}")
    return list(given)


def _require_min_widths(widths: list[int], path: str) -> None:
    minimum = LIMITS["compartmentWidth"][0]
    if any(w < minimum for w in widths):
        raise DomainError(OUT_OF_RANGE, path, f"a compartment would be narrower than {minimum} mm")


def _require_dimension_ranges(op, path: str) -> None:
    for field in ("width", "height", "depth"):
        value = getattr(op, field)
        if value is not None:
            require_range(value, field, f"{path}.{field}")


def create_wardrobe(_draft: dict | None, op: op_types.CreateWardrobe, path: str) -> dict:
    _require_dimension_ranges(op, path)
    require_range(op.compartment_count, "compartmentCount", f"{path}.compartmentCount")
    n = op.compartment_count
    panel = _given(op.panel_thickness, DEFAULT_PANEL_THICKNESS)
    partition = _given(op.partition_thickness, panel)
    available = op.width - 2 * panel - (n - 1) * partition
    base, remainder = available // n, available % n
    widths = [base + (1 if i < remainder else 0) for i in range(n)]
    _require_min_widths(widths, f"{path}.compartmentCount")
    compartment_ids = _ids_or_new(op.compartment_ids, n, ids.COMPARTMENT, f"{path}.compartmentIds")
    partition_ids = _ids_or_new(op.partition_ids, n - 1, ids.PARTITION, f"{path}.partitionIds")
    return {
        "schemaVersion": 1,
        "units": "mm",
        "dimensions": {"width": op.width, "height": op.height, "depth": op.depth},
        "carcass": {"panelThickness": panel, "appearance": default_appearance()},
        "compartments": [_empty_compartment(cid, w) for cid, w in zip(compartment_ids, widths)],
        "partitions": [{"id": pid, "thickness": partition} for pid in partition_ids],
        "doors": {"type": "none", "appearance": default_appearance(), "items": []},
    }


def update_dimensions(draft: dict, op: op_types.UpdateDimensions, path: str) -> dict:
    if op.width is None and op.height is None and op.depth is None:
        raise DomainError(INVALID_OP, path, "give at least one of width, height, depth")
    _require_dimension_ranges(op, path)
    if op.width is not None:
        compartments = draft["compartments"]
        fixed = 2 * draft["carcass"]["panelThickness"] + sum(p["thickness"] for p in draft["partitions"])
        old_available = sum(c["width"] for c in compartments)
        new_available = op.width - fixed
        scaled = [c["width"] * new_available // old_available for c in compartments[:-1]]
        scaled.append(new_available - sum(scaled))
        _require_min_widths(scaled, f"{path}.width")
        for compartment, width in zip(compartments, scaled):
            compartment["width"] = width
        draft["dimensions"]["width"] = op.width
    if op.height is not None:
        draft["dimensions"]["height"] = op.height
    if op.depth is not None:
        draft["dimensions"]["depth"] = op.depth
    return draft


def configure_doors(draft: dict, op: op_types.ConfigureDoors, path: str) -> dict:
    doors = draft["doors"]
    if op.type == "none":
        if op.doors is not None or op.count is not None or op.ids is not None:
            raise DomainError(INVALID_OP, path, "type 'none' takes no doors, count or ids")
        doors.update(type="none", items=[])
    elif op.type == "sliding":
        if op.doors is not None:
            raise DomainError(INVALID_OP, path, "sliding doors take count/ids, not a doors list")
        count = _given(op.count, len(op.ids) if op.ids is not None else DEFAULT_SLIDING_DOOR_COUNT)
        require_range(count, "slidingDoorCount", f"{path}.count")
        door_ids = _ids_or_new(op.ids, count, ids.DOOR, f"{path}.ids")
        doors.update(type="sliding", items=[_door(did, [], None) for did in door_ids])
    else:
        doors.update(type="hinged", items=_hinged_items(draft, op, path))
    return draft


def _hinged_items(draft: dict, op: op_types.ConfigureDoors, path: str) -> list[dict]:
    if op.count is not None:
        raise DomainError(INVALID_OP, path, "hinged doors take a doors list or ids, not count")
    if op.doors is None:
        compartments = draft["compartments"]
        door_ids = _ids_or_new(op.ids, len(compartments), ids.DOOR, f"{path}.ids")
        return [_door(did, [c["id"]], "left" if i % 2 == 0 else "right")
                for i, (did, c) in enumerate(zip(door_ids, compartments))]
    if op.ids is not None:
        raise DomainError(INVALID_OP, path, "give ids inside each door spec")
    if not op.doors:
        raise DomainError(INVALID_OP, f"{path}.doors", "hinged doors need at least one door; use type 'none'")
    return [_door(d.id or ids.new_id(ids.DOOR), list(d.compartment_ids), d.hinge_side)
            for d in op.doors]


def add_compartment(draft: dict, op: op_types.AddCompartment, path: str) -> dict:
    compartments, partitions = draft["compartments"], draft["partitions"]
    n = len(compartments)
    if not 0 <= op.position <= n:
        raise DomainError(INVALID_OP, f"{path}.position", f"position must be within 0..{n}")
    thickness = _given(op.partition_thickness, draft["carcass"]["panelThickness"])
    donor = compartments[op.position] if op.position < n else compartments[-1]
    donor["width"] -= op.width + thickness
    _require_min_widths([donor["width"], op.width], f"{path}.width")
    new = _empty_compartment(op.id or ids.new_id(ids.COMPARTMENT), op.width)
    partition = {"id": op.partition_id or ids.new_id(ids.PARTITION), "thickness": thickness}
    if 0 < op.position < n:
        _extend_spanning_doors(draft, compartments[op.position - 1]["id"], compartments[op.position]["id"], new["id"])
    draft["compartments"] = compartments[: op.position] + [new] + compartments[op.position:]
    draft["partitions"] = partitions[: op.position] + [partition] + partitions[op.position:]
    return draft


def _extend_spanning_doors(draft: dict, left_id: str, right_id: str, new_id: str) -> None:
    """A hinged door spanning the insertion point also spans the new compartment."""
    for door in draft["doors"]["items"]:
        cids = door["compartmentIds"]
        if left_id in cids and right_id in cids:
            cids.insert(cids.index(right_id), new_id)


def modify_compartment(draft: dict, op: op_types.ModifyCompartment, path: str) -> dict:
    compartments = draft["compartments"]
    if len(compartments) == 1:
        raise DomainError(INVALID_OP, path, "a single compartment always spans the full interior width")
    index = compartment_index(draft, op.compartment_id, f"{path}.compartmentId")
    neighbour = compartments[index + 1] if index < len(compartments) - 1 else compartments[index - 1]
    neighbour["width"] -= op.width - compartments[index]["width"]
    compartments[index]["width"] = op.width
    _require_min_widths([op.width, neighbour["width"]], f"{path}.width")
    return draft


def add_partition(draft: dict, op: op_types.AddPartition, path: str) -> dict:
    index = compartment_index(draft, op.compartment_id, f"{path}.compartmentId")
    compartment = draft["compartments"][index]
    thickness = _given(op.thickness, draft["carcass"]["panelThickness"])
    right_width = compartment["width"] - op.offset - thickness
    _require_min_widths([op.offset, right_width], f"{path}.offset")
    compartment["width"] = op.offset
    new_id = op.new_compartment_id or ids.new_id(ids.COMPARTMENT)
    draft["compartments"].insert(index + 1, _empty_compartment(new_id, right_width))
    draft["partitions"].insert(index, {"id": op.id or ids.new_id(ids.PARTITION), "thickness": thickness})
    for door in draft["doors"]["items"]:
        if compartment["id"] in door["compartmentIds"]:
            at = door["compartmentIds"].index(compartment["id"])
            door["compartmentIds"].insert(at + 1, new_id)
    return draft


def modify_partition(draft: dict, op: op_types.ModifyPartition, path: str) -> dict:
    if op.position is None and op.thickness is None:
        raise DomainError(INVALID_OP, path, "give position and/or thickness")
    j = partition_index(draft, op.partition_id, f"{path}.partitionId")
    left, right = draft["compartments"][j], draft["compartments"][j + 1]
    left_edge = partition_left_edge(draft, j)
    if op.thickness is not None:
        right["width"] -= op.thickness - draft["partitions"][j]["thickness"]
        draft["partitions"][j]["thickness"] = op.thickness
    if op.position is not None:
        delta = op.position - left_edge
        left["width"] += delta
        right["width"] -= delta
    _require_min_widths([left["width"], right["width"]],
                        f"{path}.position" if op.position is not None else f"{path}.thickness")
    return draft


def mirror_layout(draft: dict, _op: op_types.MirrorLayout, _path: str) -> dict:
    """Reverse the compartments left to right. Ids, widths and items move with their compartment;
    partitions reverse too, so the width invariant holds. Hinged doors keep their compartments
    (reordered left to right) and swap hinge sides; doors are listed left to right again."""
    draft["compartments"].reverse()
    draft["partitions"].reverse()
    doors = draft["doors"]
    doors["items"].reverse()
    if doors["type"] == "hinged":
        for door in doors["items"]:
            door["compartmentIds"].reverse()
            door["hingeSide"] = "right" if door["hingeSide"] == "left" else "left"
    return draft


def remove_component(draft: dict, op: op_types.RemoveComponent, path: str) -> dict:
    found = locate(draft, op.id)
    if found is None:
        raise DomainError(NOT_FOUND, f"{path}.id", "no component with this id")
    kind, index, item_index = found
    if kind in ITEM_KINDS:
        del draft["compartments"][index][kind][item_index]
    elif kind == "compartment":
        _remove_compartment(draft, index, f"{path}.id")
    elif kind == "partition":
        _merge_at_partition(draft, index)
    else:
        del draft["doors"]["items"][index]
        _normalize_doors(draft)
    return draft


def _remove_compartment(draft: dict, index: int, path: str) -> None:
    compartments, partitions = draft["compartments"], draft["partitions"]
    if len(compartments) == 1:
        raise DomainError(INVALID_OP, path, "the last compartment cannot be removed")
    is_last = index == len(compartments) - 1
    partition_at = index - 1 if is_last else index
    absorber = compartments[index - 1] if is_last else compartments[index + 1]
    absorber["width"] += compartments[index]["width"] + partitions[partition_at]["thickness"]
    removed_id = compartments[index]["id"]
    del compartments[index]
    del partitions[partition_at]
    for door in draft["doors"]["items"]:
        door["compartmentIds"] = [cid for cid in door["compartmentIds"] if cid != removed_id]
    draft["doors"]["items"] = [d for d in draft["doors"]["items"]
                               if d["compartmentIds"] or draft["doors"]["type"] != "hinged"]
    _normalize_doors(draft)


def _merge_at_partition(draft: dict, j: int) -> None:
    """Merge compartments j and j+1 into j. Covering doors merge into the first one in list order."""
    compartments = draft["compartments"]
    left, right = compartments[j], compartments[j + 1]
    left["width"] += draft["partitions"][j]["thickness"] + right["width"]
    for kind in ITEM_KINDS:
        left[kind] = left[kind] + right[kind]
    del compartments[j + 1]
    del draft["partitions"][j]
    order = {c["id"]: i for i, c in enumerate(compartments)}
    covering = []
    for door in draft["doors"]["items"]:
        door["compartmentIds"] = list(dict.fromkeys(left["id"] if cid == right["id"] else cid
                                                    for cid in door["compartmentIds"]))
        if left["id"] in door["compartmentIds"]:
            covering.append(door)
    if len(covering) > 1:
        keeper = covering[0]
        union = {cid for door in covering for cid in door["compartmentIds"]}
        keeper["compartmentIds"] = sorted(union, key=order.__getitem__)
        dropped = {id(door) for door in covering[1:]}
        draft["doors"]["items"] = [d for d in draft["doors"]["items"] if id(d) not in dropped]


def _normalize_doors(draft: dict) -> None:
    """After a door or compartment removal leaves no doors, the type becomes 'none'."""
    if draft["doors"]["type"] != "none" and not draft["doors"]["items"]:
        draft["doors"]["type"] = "none"


STRUCTURE_HANDLERS = {
    op_types.CreateWardrobe: create_wardrobe,
    op_types.UpdateDimensions: update_dimensions,
    op_types.ConfigureDoors: configure_doors,
    op_types.AddCompartment: add_compartment,
    op_types.ModifyCompartment: modify_compartment,
    op_types.AddPartition: add_partition,
    op_types.ModifyPartition: modify_partition,
    op_types.MirrorLayout: mirror_layout,
    op_types.RemoveComponent: remove_component,
}
