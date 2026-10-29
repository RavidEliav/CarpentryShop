"""Typed operation protocol (discriminated on `op`). Mirrored in frontend/src/domain/opsSchema.js.

Ops may come from an LLM, so ids are pattern-checked (never echoed raw), ints are
bounded, and lists are capped. Optional fields accept explicit `null`.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, TypeAdapter, ValidationError

from app.domain.errors import SCHEMA_INVALID, DomainError
from app.domain.schema import (
    MAX_LIST,
    AnyId,
    CompartmentId,
    DoorId,
    DrawerId,
    Int,
    PartitionId,
    RailId,
    Ref,
    ShelfId,
    StrictModel,
    schema_error,
)

MAX_OPS = 100
Target = Annotated[str, Field(pattern=r"^(carcass|doors|(cmp|prt|shf|drw|rail|dr)_[A-Za-z0-9_-]{1,40})$")]


class CreateWardrobe(StrictModel):
    op: Literal["create_wardrobe"]
    width: Int
    height: Int
    depth: Int
    compartment_count: Int
    panel_thickness: Int | None = None
    partition_thickness: Int | None = None
    compartment_ids: Annotated[list[CompartmentId], Field(max_length=MAX_LIST)] | None = None
    partition_ids: Annotated[list[PartitionId], Field(max_length=MAX_LIST)] | None = None


class UpdateDimensions(StrictModel):
    op: Literal["update_dimensions"]
    width: Int | None = None
    height: Int | None = None
    depth: Int | None = None


class DoorSpec(StrictModel):
    id: DoorId | None = None
    compartment_ids: Annotated[list[CompartmentId], Field(max_length=MAX_LIST)]
    hinge_side: Literal["left", "right"]


class ConfigureDoors(StrictModel):
    op: Literal["configure_doors"]
    type: Literal["hinged", "sliding", "none"]
    doors: Annotated[list[DoorSpec], Field(max_length=MAX_LIST)] | None = None
    count: Int | None = None
    ids: Annotated[list[DoorId], Field(max_length=MAX_LIST)] | None = None


class AddCompartment(StrictModel):
    op: Literal["add_compartment"]
    position: Int
    width: Int
    id: CompartmentId | None = None
    partition_id: PartitionId | None = None
    partition_thickness: Int | None = None


class ModifyCompartment(StrictModel):
    op: Literal["modify_compartment"]
    compartment_id: CompartmentId
    width: Int


class AddPartition(StrictModel):
    op: Literal["add_partition"]
    compartment_id: CompartmentId
    offset: Int
    id: PartitionId | None = None
    new_compartment_id: CompartmentId | None = None
    thickness: Int | None = None


class ModifyPartition(StrictModel):
    op: Literal["modify_partition"]
    partition_id: PartitionId
    position: Int | None = None
    thickness: Int | None = None


class MirrorLayout(StrictModel):
    op: Literal["mirror_layout"]


class AddShelf(StrictModel):
    op: Literal["add_shelf"]
    compartment_id: CompartmentId
    y: Int
    thickness: Int | None = None
    id: ShelfId | None = None


class ModifyShelf(StrictModel):
    op: Literal["modify_shelf"]
    id: ShelfId
    y: Int | None = None
    thickness: Int | None = None


class AddDrawer(StrictModel):
    op: Literal["add_drawer"]
    compartment_id: CompartmentId
    y: Int
    height: Int
    id: DrawerId | None = None


class ModifyDrawer(StrictModel):
    op: Literal["modify_drawer"]
    id: DrawerId
    y: Int | None = None
    height: Int | None = None


class AddRail(StrictModel):
    op: Literal["add_rail"]
    compartment_id: CompartmentId
    y: Int
    id: RailId | None = None


class ModifyRail(StrictModel):
    op: Literal["modify_rail"]
    id: RailId
    y: Int


class SetMaterial(StrictModel):
    op: Literal["set_material"]
    target: Target
    material: Ref | None = None
    color: Ref | None = None
    finish: Ref | None = None
    clear: bool = False


class RemoveComponent(StrictModel):
    op: Literal["remove_component"]
    id: AnyId


Op = Annotated[
    CreateWardrobe | UpdateDimensions | ConfigureDoors | AddCompartment | ModifyCompartment
    | AddPartition | ModifyPartition | MirrorLayout | AddShelf | ModifyShelf | AddDrawer | ModifyDrawer
    | AddRail | ModifyRail | SetMaterial | RemoveComponent,
    Field(discriminator="op"),
]

_OP_ADAPTER: TypeAdapter[Op] = TypeAdapter(Op)


def parse_ops(raw_ops: object) -> list:
    """Validate the batch container, then each op (error path `ops[i]`)."""
    if not isinstance(raw_ops, list):
        raise DomainError(SCHEMA_INVALID, "ops", "ops must be an array")
    if len(raw_ops) > MAX_OPS:
        raise DomainError(SCHEMA_INVALID, "ops", f"at most {MAX_OPS} ops per batch")
    return [parse_op(raw, index) for index, raw in enumerate(raw_ops)]


def parse_op(raw: object, index: int) -> StrictModel:
    try:
        return _OP_ADAPTER.validate_python(raw)
    except ValidationError as error:
        raise schema_error(error, prefix=f"ops[{index}]") from None
