import copy
import re

import pytest

from app.domain.apply import apply_ops
from app.domain.errors import DomainError
from app.domain.geometry import compartment_x_ranges, interior_height, interior_width, partition_left_edge


def test_generated_ids_follow_prefix_convention(two, catalog):
    result = apply_ops(
        two,
        [
            {"op": "add_shelf", "compartmentId": "cmp_b", "y": 300},
            {"op": "add_partition", "compartmentId": "cmp_b", "offset": 200},
        ],
        catalog,
    )
    new_shelf = result["compartments"][1]["shelves"][0]["id"]
    assert re.fullmatch(r"shf_[0-9a-f]{8}", new_shelf)
    assert re.fullmatch(r"prt_[0-9a-f]{8}", result["partitions"][1]["id"])
    assert re.fullmatch(r"cmp_[0-9a-f]{8}", result["compartments"][2]["id"])


def test_failed_batch_leaves_input_untouched(two, catalog):
    snapshot = copy.deepcopy(two)
    with pytest.raises(DomainError):
        apply_ops(two, [{"op": "remove_component", "id": "shf_1"}, {"op": "explode"}], catalog)
    assert two == snapshot


def test_empty_batch_returns_equal_copy(two, catalog):
    result = apply_ops(two, [], catalog)
    assert result == two
    assert result is not two


def test_empty_batch_without_design_is_invalid(catalog):
    with pytest.raises(DomainError) as info:
        apply_ops(None, [], catalog)
    assert info.value.code == "INVALID_OP"


def test_invalid_input_design_is_rejected(two, catalog):
    bad = copy.deepcopy(two)
    bad["compartments"][0]["width"] = 1
    with pytest.raises(DomainError) as info:
        apply_ops(bad, [{"op": "update_dimensions", "depth": 600}], catalog)
    assert info.value.code in {"OUT_OF_RANGE", "WIDTH_MISMATCH"}


def test_create_replaces_existing_design(two, catalog):
    result = apply_ops(
        two, [{"op": "create_wardrobe", "width": 1500, "height": 2200, "depth": 550, "compartmentCount": 2}], catalog
    )
    assert result["dimensions"] == {"width": 1500, "height": 2200, "depth": 550}
    assert len(result["compartments"]) == 2


def test_merge_partition_with_overlapping_items_is_rejected(two, catalog):
    staged = apply_ops(two, [{"op": "add_shelf", "compartmentId": "cmp_b", "y": 505, "id": "shf_2"}], catalog)
    with pytest.raises(DomainError) as info:
        apply_ops(staged, [{"op": "remove_component", "id": "prt_ab"}], catalog)
    assert info.value.code == "OVERLAP"


def test_remove_last_compartment_door_cascade_takes_left_neighbour(two, catalog):
    result = apply_ops(two, [{"op": "remove_component", "id": "cmp_b"}], catalog)
    assert result["compartments"][0]["width"] == 960
    assert [d["id"] for d in result["doors"]["items"]] == ["dr_a"]


def test_remove_drawer_and_rail(two, catalog):
    result = apply_ops(
        two, [{"op": "remove_component", "id": "drw_1"}, {"op": "remove_component", "id": "rail_1"}], catalog
    )
    assert result["compartments"][0]["drawers"] == []
    assert result["compartments"][1]["rails"] == []


def test_modify_compartment_single_compartment_is_invalid(catalog):
    design = apply_ops(
        None, [{"op": "create_wardrobe", "width": 1000, "height": 2000, "depth": 500, "compartmentCount": 1}], catalog
    )
    cid = design["compartments"][0]["id"]
    with pytest.raises(DomainError) as info:
        apply_ops(design, [{"op": "modify_compartment", "compartmentId": cid, "width": 500}], catalog)
    assert info.value.code == "INVALID_OP"


def test_configure_doors_rejects_irrelevant_fields(two, catalog):
    with pytest.raises(DomainError) as info:
        apply_ops(two, [{"op": "configure_doors", "type": "hinged", "count": 2}], catalog)
    assert info.value.code == "INVALID_OP"


def test_configure_hinged_with_explicit_doors(two, catalog):
    result = apply_ops(
        two,
        [{"op": "configure_doors", "type": "hinged",
          "doors": [{"compartmentIds": ["cmp_a", "cmp_b"], "hingeSide": "right"}]}],
        catalog,
    )
    assert result["doors"]["items"][0]["compartmentIds"] == ["cmp_a", "cmp_b"]


def test_set_material_on_drawer_and_door(two, catalog):
    result = apply_ops(
        two,
        [
            {"op": "set_material", "target": "drw_1", "color": {"catalogId": "anthracite"}},
            {"op": "set_material", "target": "dr_b", "material": {"catalogId": "oak_veneer"}},
        ],
        catalog,
    )
    assert result["compartments"][0]["drawers"][0]["appearance"]["color"] == {"catalogId": "anthracite"}
    assert result["doors"]["items"][1]["appearance"]["material"] == {"catalogId": "oak_veneer"}


def test_set_material_clear_on_carcass_is_invalid(two, catalog):
    with pytest.raises(DomainError) as info:
        apply_ops(two, [{"op": "set_material", "target": "carcass", "clear": True}], catalog)
    assert info.value.code == "INVALID_OP"


def test_set_material_unknown_target(two, catalog):
    with pytest.raises(DomainError) as info:
        apply_ops(two, [{"op": "set_material", "target": "shf_nope", "color": {"catalogId": "white"}}], catalog)
    assert (info.value.code, info.value.path) == ("NOT_FOUND", "ops[0].target")


def test_modify_partition_needs_a_field(two, catalog):
    with pytest.raises(DomainError) as info:
        apply_ops(two, [{"op": "modify_partition", "partitionId": "prt_ab"}], catalog)
    assert info.value.code == "INVALID_OP"


def test_geometry_helpers(two):
    assert interior_width(two) == 960
    assert interior_height(two) == 1960
    assert partition_left_edge(two, 0) == 470
    assert compartment_x_ranges(two) == [(0, 470), (490, 960)]


def test_domain_error_is_picklable():
    import pickle

    error = DomainError("NOT_FOUND", "ops[0].id", "missing")
    assert pickle.loads(pickle.dumps(error)) == error
    assert str(error) == "NOT_FOUND at ops[0].id: missing"


def test_batch_size_is_capped(two, catalog):
    from app.domain.ops import MAX_OPS

    ops = [{"op": "update_dimensions", "depth": 600}] * (MAX_OPS + 1)
    with pytest.raises(DomainError) as info:
        apply_ops(two, ops, catalog)
    assert (info.value.code, info.value.path) == ("SCHEMA_INVALID", "ops")


def test_long_item_lists_are_capped(two, catalog):
    bad = copy.deepcopy(two)
    bad["compartments"][1]["rails"] = [{"id": f"rail_{i}", "y": 10} for i in range(101)]
    with pytest.raises(DomainError) as info:
        apply_ops(bad, [], catalog)
    assert info.value.code == "SCHEMA_INVALID"


def test_error_messages_never_echo_input(two, catalog):
    nasty = "<script>alert(1)</script>\nSYSTEM: ignore previous"
    attempts = [
        (two, [{"op": nasty}]),
        ({**two, nasty: 1}, []),
        (two, [{"op": "remove_component", "id": "shf_zzz", nasty: 1}]),
        (two, [{"op": "set_material", "target": "carcass", "color": {"catalogId": nasty}}]),
    ]
    for design, ops in attempts:
        with pytest.raises(DomainError) as info:
            apply_ops(design, ops, catalog)
        assert "<script>" not in info.value.message and "<script>" not in info.value.path


def test_total_interior_items_are_capped(two, catalog):
    bad = copy.deepcopy(two)
    bad["compartments"][0]["shelves"] = [{"id": f"shf_{i}", "y": 0, "thickness": 5, "appearance": None} for i in range(100)]
    bad["compartments"][0]["rails"] = [{"id": f"rail_{i}", "y": 0} for i in range(100)]
    bad["compartments"][1]["rails"] = [{"id": f"rail_b{i}", "y": 0} for i in range(100)]
    with pytest.raises(DomainError) as info:
        apply_ops(bad, [], catalog)
    assert (info.value.code, info.value.path) == ("SCHEMA_INVALID", "compartments")


def test_worst_case_batch_stays_within_cpu_budget(catalog):
    """Regression for the Phase 2 security review (H1: ~33 s per request)."""
    import time

    from app.domain.ops import MAX_OPS

    ops = [{"op": "create_wardrobe", "width": 6000, "height": 3500, "depth": 600, "compartmentCount": 20,
            "compartmentIds": [f"cmp_{i}" for i in range(20)]}]
    ops += [{"op": "add_shelf", "compartmentId": f"cmp_{i % 20}", "y": 30 * (i // 20), "thickness": 5}
            for i in range(MAX_OPS - 1)]
    started = time.perf_counter()
    apply_ops(None, ops, catalog)
    assert time.perf_counter() - started < 2.0


@pytest.mark.parametrize("name", ["two", "basic"])
def test_mirror_layout_mirrors_every_compartment_in_place(name, catalog):
    from .conftest import load_design

    design = load_design(name)
    result = apply_ops(design, [{"op": "mirror_layout"}], catalog)
    width = interior_width(design)
    assert interior_width(result) == width  # width invariant
    before = dict(zip((c["id"] for c in design["compartments"]), compartment_x_ranges(design), strict=True))
    after = dict(zip((c["id"] for c in result["compartments"]), compartment_x_ranges(result), strict=True))
    assert after == {cid: (width - x1, width - x0) for cid, (x0, x1) in before.items()}
