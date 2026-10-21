from app.domain.apply import apply_ops
from app.domain.catalog import load_catalog
from app.domain.geometry import interior_height
from app.export import layout
from tests.domain.conftest import load_design


def test_letters_run_past_z():
    assert [layout.letter(i) for i in (0, 1, 25, 26, 27)] == ["A", "B", "Z", "AA", "AB"]


def test_items_are_coded_bottom_up_per_kind():
    design = load_design("basic")
    codes = [(item.code, item.y) for item in layout.compartment_items(design, 2)]
    assert codes == [("C-DW1", 0), ("C-DW2", 200), ("C-S1", 800), ("C-S2", 1400)]


def test_vertical_chain_covers_the_interior_height_without_gaps():
    design = load_design("basic")
    for index in range(len(design["compartments"])):
        chain = layout.vertical_chain(design, index)
        assert chain[0].start == 0 and chain[-1].end == interior_height(design)
        assert all(a.end == b.start for a, b in zip(chain, chain[1:]))
        assert sum(seg.length for seg in chain) == interior_height(design)


def test_vertical_chain_marks_shelves_drawers_and_rail_splits():
    chain = layout.vertical_chain(load_design("basic"), 1)  # shelf at 2000, rail at 1900
    assert [(s.start, s.end, s.kind) for s in chain] == [
        (0, 1900, "clear"), (1900, 2000, "clear"), (2000, 2018, "shelf"), (2018, 2364, "clear"),
    ]


def test_width_chain_sums_to_the_overall_width():
    design = load_design("basic")
    chain = layout.width_chain(design)
    assert [s.length for s in chain] == [18, 643, 18, 643, 18, 642, 18]
    assert sum(s.length for s in chain) == design["dimensions"]["width"]
    assert all(a.end == b.start for a, b in zip(chain, chain[1:]))


def test_hinged_doors_span_the_compartments_they_cover():
    design = apply_ops(load_design("basic"), [{"op": "configure_doors", "type": "hinged", "doors": [
        {"compartmentIds": ["cmp_left", "cmp_middle"], "hingeSide": "left"},
        {"compartmentIds": ["cmp_right"], "hingeSide": "right"},
    ]}], load_catalog())
    panels = layout.door_panels(design)
    assert [(p.code, p.x0, p.x1, p.hinge, p.letters) for p in panels] == [
        ("DR1", 0, 1304, "left", ("A", "B")),  # 643 + 18 + 643
        ("DR2", 1322, 1964, "right", ("C",)),
    ]


def test_sliding_doors_share_the_interior_width():
    design = apply_ops(load_design("basic"), [{"op": "configure_doors", "type": "sliding", "count": 3}], load_catalog())
    panels = layout.door_panels(design)
    assert len(panels) == 3 and panels[0].x0 == 0 and panels[-1].x1 == 1964
    assert layout.covered_letters(design) == {"A", "B", "C"}


def test_component_rows_follow_the_design():
    rows = {row.code: row for row in layout.component_rows(load_design("basic"))}
    assert rows["C1"].size == (2000, 2400, 600, 18)
    assert rows["P1"].size == (2364, 600, 18) and rows["P1"].compartment == "A|B"
    assert rows["DR2"].size == (643, 2364)
    assert rows["A-S1"].size == (643, 600, 18) and rows["A-S1"].height == 400
    assert rows["C-DW2"].size == (642, 200) and rows["C-DW2"].height == 200
    assert rows["B-R1"].size == (643,) and rows["B-R1"].appearance is None
    assert not any(row.override for row in rows.values())


def test_an_item_colour_override_is_flagged():
    design = apply_ops(load_design("basic"), [
        {"op": "set_material", "target": "shf_l1", "color": {"catalogId": "walnut"}},
    ], load_catalog())
    row = next(r for r in layout.component_rows(design) if r.code == "A-S1")
    assert row.override and row.appearance["color"] == {"catalogId": "walnut"}
