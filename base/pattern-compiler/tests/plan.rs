//! Plan emission, first slice (`plan-and-label-templates.md`, cited as
//! PL): the records of §1.1 for a pattern, the order of §1.4, the names of
//! §1.3, the worked example of §6.2, and `side-write:cycle`.

use pattern_compiler::program::{analyze, ProgramAnalysis, SourceFile};
use serde_json::{json, Value};

fn program(text: &str) -> ProgramAnalysis {
    analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: text.to_string(),
    }])
}

fn plan_of(analysis: &ProgramAnalysis, name: &str) -> Value {
    let found = analysis
        .modules
        .iter()
        .flat_map(|module| &module.plans)
        .find(|plan| plan.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("no pattern named {name}"));
    assert!(
        found.unsupported.is_empty(),
        "unsupported: {:?}",
        found.unsupported
    );
    found.plan.clone()
}

/// A slot in the notation of PL §6.2: `root path : class`.
fn slot_line(plan: &Value, index: &Value) -> String {
    let slot = &plan["slots"][index.as_u64().expect("a slot index") as usize];
    let path: Vec<&str> = slot["path"]
        .as_array()
        .expect("a path")
        .iter()
        .map(|segment| segment.as_str().expect("a segment"))
        .collect();
    let mut line = format!(
        "{} {} : {}",
        slot["root"]["kind"].as_str().expect("a root"),
        path.join("/"),
        slot["observes"].as_str().expect("a class")
    );
    if slot["resolved"] == json!(true) {
        line.push_str(", resolved");
    }
    if slot["inPlace"] == json!(true) {
        line.push_str(", inPlace");
    }
    line
}

const LIST: &str = r#"import { Cell, Writable, computed, handler, lift, pattern, UI } from "commonfabric";
interface Item { title: string; done: boolean }
const add = handler<{ title: string }, { items: Cell<Item[]> }>((event, state) => {
  state.items.push({ title: event.title, done: false });
});
const count = lift((x: { items: Item[] }) => x.items.length);
const label = lift((n: number) => { return "n=" + n; });
export const List = pattern<{ items: Cell<Item[]>; heading: string }>(({ items, heading }) => {
  const filter = Writable.perSession.of("");
  const total = count({ items });
  const text = label(total);
  const addItem = add({ items });
  return {
    [UI]: <div>{heading}{text}{items.map((item) => <span>{item.title}</span>)}</div>,
    total,
    addItem,
    heading,
  };
});
"#;

#[test]
fn a_state_cell_takes_the_name_of_its_const_and_the_scope_of_its_constructor() {
    // PL §1.3: "A declaration assigned to a `const` takes the variable's
    // name". `StateCell.scope` is "space" | "user" | "session".
    let plan = plan_of(&program(LIST), "List");
    assert_eq!(
        plan["stateCells"],
        json!([{ "name": "filter", "scope": "session", "within": [] }])
    );
}

#[test]
fn a_handler_is_one_body_whose_slots_have_the_roots_event_and_binding() {
    // PL §1.1: `SlotRoot` "The payload of the event a handler was invoked
    // with" and "The state a handler was bound to: its captures".
    let plan = plan_of(&program(LIST), "List");
    let body = &plan["bodies"][2];
    assert_eq!(body["kind"], "handler");
    assert_eq!(body["name"], "add");
    let reads: Vec<String> = body["reads"]
        .as_array()
        .expect("reads")
        .iter()
        .map(|slot| slot_line(&plan, slot))
        .collect();
    assert_eq!(reads, ["event title : value", "binding items : identity"]);
    assert_eq!(
        plan["slots"][1]["root"],
        json!({ "kind": "event", "handler": 2 })
    );
    // The push is a write edge at `*` of the cell behind the handle, with
    // the handler's template (PL §3.11, §3.12).
    assert_eq!(
        body["writes"],
        json!([{
            "target": { "kind": "handle", "slot": body["reads"][1], "path": ["*"] },
            "template": {
                "op": "derive",
                "inputs": [
                    { "op": "slot", "slot": body["reads"][0] },
                    { "op": "slot", "slot": body["reads"][1] },
                ],
                "by": { "body": 2 },
            },
            "constraints": [],
        }])
    );
}

#[test]
fn a_binding_of_the_reactive_tier_binds_every_path_by_reference() {
    // PL §1.1, `Binding.state`: "In the reactive tier every path is bound
    // this way, and resolves to what `place` names." "`template` is the
    // label of the same place: the `slot` node, the output's template, or
    // `const`."
    let plan = plan_of(&program(LIST), "List");
    let binding = &plan["bindings"][0];
    assert_eq!(binding["handler"], json!({ "body": 2 }));
    assert_eq!(binding["name"], "addItem");
    let state = &binding["state"][0];
    assert_eq!(state["path"], json!(["items"]));
    assert_eq!(state["capture"], "link");
    assert_eq!(
        slot_line(&plan, &state["place"]["slot"]),
        "argument items : identity"
    );
    assert_eq!(
        state["template"],
        json!({ "op": "slot", "slot": state["place"]["slot"] })
    );
    assert!(state.get("bound").is_none());
}

#[test]
fn a_state_path_of_a_binding_resolves_to_an_output_a_stream_or_a_constant() {
    // PL §1.1, `Binding.state.place`: "A slot of the instance; an output
    // of the instance (`Plan.outputs`); the stream of another binding of
    // the reactive tier (`Plan.bindings`); or a constant written at the
    // binding, which the plan holds and nothing stores."
    let analysis = program(
        r#"import { Cell, handler, pattern } from "commonfabric";
const inner = handler<{ n: number }, { count: Cell<number> }>((event, state) => { state.count.set(event.n); });
const outer = handler<unknown, { total: number; step: number; go: unknown }>((_, state) => { console.log(state.total, state.step, state.go); });
export const P = pattern<{ count: Cell<number>; a: number }>(({ count, a }) => {
  const total = a + 1;
  const go = inner({ count });
  const run = outer({ total, step: 2, go });
  return { run };
});
"#,
    );
    let plan = plan_of(&analysis, "P");
    let binding = plan["bindings"]
        .as_array()
        .expect("bindings")
        .iter()
        .find(|binding| binding["name"] == "run")
        .expect("the binding");
    let state = binding["state"].as_array().expect("state");
    let at = |name: &str| {
        state
            .iter()
            .find(|entry| entry["path"] == json!([name]))
            .unwrap_or_else(|| panic!("no path {name}"))
    };
    assert_eq!(at("step")["place"], json!({ "constant": 2 }));
    assert_eq!(at("step")["template"], json!({ "op": "const" }));
    assert_eq!(at("go")["place"], json!({ "stream": 0 }));
    let output = at("total")["place"]["output"].as_u64().expect("an output") as usize;
    assert_eq!(plan["outputs"][output]["interim"], "total");
    assert_eq!(at("total")["template"], plan["outputs"][output]["template"]);
}

#[test]
fn a_value_another_cone_uses_is_an_output_and_an_edge_names_it() {
    // PL §1.4: "An output that another cone, a `pick`, or a collection
    // refers to is an entry of `Plan.outputs` whether or not it is kept.
    // An interim output has `kept: false`".
    let plan = plan_of(&program(LIST), "List");
    let entries: Vec<&str> = plan["cones"]
        .as_array()
        .expect("cones")
        .iter()
        .map(|cone| cone["entry"].as_str().expect("an entry"))
        .collect();
    assert_eq!(entries, ["total", "text", "map", "$UI", "result"]);
    // The template is that of the body `count`: a `derive` over its one
    // slot.
    assert_eq!(
        plan["outputs"][0],
        json!({
            "path": ["total"],
            "cone": 0,
            "kept": true,
            "constraints": [],
            "template": {
                "op": "derive",
                "inputs": [{ "op": "slot", "slot": 0 }],
                "by": { "body": 0 },
            },
        })
    );
    // `text` is `label(total)`: a `derive` by the body `label` over the
    // template of `total`.
    assert_eq!(
        plan["outputs"][1],
        json!({
            "path": [],
            "interim": "text",
            "cone": 1,
            "kept": false,
            "constraints": [],
            "template": {
                "op": "derive",
                "inputs": [plan["outputs"][0]["template"].clone()],
                "by": { "body": 1 },
            },
        })
    );
    // `label(total)`: the input is a value the instance computed, so the
    // body has an entry of `computed` and no slot (PL §3.9).
    assert_eq!(plan["bodies"][1]["reads"], json!([]));
    assert_eq!(
        plan["bodies"][1]["computed"],
        json!([{
            "at": [],
            "observes": "value",
            "template": plan["outputs"][0]["template"].clone(),
        }])
    );
    assert!(plan["edges"]
        .as_array()
        .expect("edges")
        .contains(&json!({ "from": 0, "to": 1, "via": { "kind": "output", "output": 0 } })));
}

#[test]
fn an_element_construct_is_a_collection_and_its_body_reads_element_slots() {
    // PL §1.1: `Collection.source` "The input collection", and a slot
    // root "The current element of a collection".
    let plan = plan_of(&program(LIST), "List");
    let collection = &plan["collections"][0];
    assert_eq!(collection["bodyUses"], json!({ "index": false }));
    assert_eq!(
        slot_line(&plan, &collection["source"]["slot"]),
        "argument items : enumeration"
    );
    let cone = &plan["cones"][2];
    let slots: Vec<String> = cone["slots"]
        .as_array()
        .expect("slots")
        .iter()
        .map(|slot| slot_line(&plan, slot))
        .collect();
    assert_eq!(slots, ["element title : identity"]);
    // The assembled result names its collection (PL §1.4).
    assert_eq!(plan["outputs"][2]["collection"], 0);
}

#[test]
fn two_declarations_with_one_name_take_the_name_and_an_ordinal() {
    // PL §1.3: "Where two declarations of one pattern body have the same
    // name by these rules, each takes the name and its ordinal among
    // them, in source order."
    let analysis = program(
        r#"import { Cell, handler, pattern, UI } from "commonfabric";
const bump = handler<{ by: number }, { n: Cell<number> }>((event, state) => { state.n.set(event.by); });
export const Two = pattern<{ a: Cell<number>; b: Cell<number> }>(({ a, b }) => {
  return { [UI]: <div><button onClick={bump({ n: a })} /><button onClick={bump({ n: b })} /></div> };
});
"#,
    );
    let plan = plan_of(&analysis, "Two");
    let names: Vec<&str> = plan["bindings"]
        .as_array()
        .expect("bindings")
        .iter()
        .map(|binding| binding["name"].as_str().expect("a name"))
        .collect();
    // "two bindings of a handler `save` are `save#1` and `save#2`": the
    // handler's name comes before the attribute's.
    assert_eq!(names, ["bump#1", "bump#2"]);
    // "A handler is one record however many bindings name it." The body
    // is not one more declaration of that name (SPEC-NOTES 113).
    assert_eq!(plan["bodies"].as_array().expect("bodies").len(), 1);
    assert_eq!(plan["bodies"][0]["name"], "bump");
}

const WRITES: &str = r#"import { Cell, lift, pattern } from "commonfabric";
const copyAB = lift((x: { a: Cell<number>; b: Cell<number> }) => { x.b.set(x.a.get() + 1); return 0; });
const copyBA = lift((x: { a: Cell<number>; b: Cell<number> }) => {
  x.a.set(x.b.get() + 1); return 0; });
const own = lift((x: { a: Cell<number> }) => { x.a.set(x.a.get() + 1); return 0; });
export const Cycle = pattern<{ a: Cell<number>; b: Cell<number> }>(({ a, b }) => {
  const one = copyAB({ a, b });
  const two = copyBA({ a, b });
  return { one, two };
});
export const Chain = pattern<{ a: Cell<number>; b: Cell<number>; c: Cell<number> }>(({ a, b, c }) => {
  const late = copyAB({ a: b, b: c });
  const early = copyAB({ a, b });
  return { late, early };
});
export const Own = pattern<{ a: Cell<number> }>(({ a }) => {
  const one = own({ a });
  return { one };
});
"#;

#[test]
fn a_static_side_write_is_an_edge_to_each_cone_with_a_slot_that_reads_the_target() {
    // FA §6.3: "Where the target is a state cell or names its handle by a
    // slot, the plan lists a `ConeEdge` from that cone to each cone with
    // a slot that reads the target". PL §1.4: "`Plan.cones` is listed so
    // that every edge of `Plan.edges` that is not on a cycle goes from a
    // lower index to a higher one."
    let plan = plan_of(&program(WRITES), "Chain");
    let entries: Vec<&str> = plan["cones"]
        .as_array()
        .expect("cones")
        .iter()
        .map(|cone| cone["entry"].as_str().expect("an entry"))
        .collect();
    assert_eq!(entries, ["early", "late"]);
    let edges = plan["edges"].as_array().expect("edges");
    assert_eq!(edges.len(), 1);
    assert_eq!(edges[0]["from"], 0);
    assert_eq!(edges[0]["to"], 1);
    assert_eq!(edges[0]["via"]["kind"], "handle");
    assert_eq!(
        slot_line(&plan, &edges[0]["via"]["slot"]),
        "argument b : identity"
    );
}

#[test]
fn a_cycle_through_a_static_side_write_is_reported_and_a_read_of_the_own_target_is_not() {
    // LS §10.3: "The edges of the plan form a cycle through a static
    // side-write of a `lift` or a `computed` ... A body that reads its
    // own write target is reported as `side-write:not-idempotent` and not
    // here".
    let analysis = program(WRITES);
    let cycles: Vec<u32> = analysis.modules[0]
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.id == "side-write:cycle")
        .map(|diagnostic| diagnostic.line)
        .collect();
    // The report names the side-write and not the function: `x.b.set`
    // on line 2, and `x.a.set` on line 4.
    assert_eq!(cycles, [2, 4]);
    let plan = plan_of(&analysis, "Cycle");
    let edges = plan["edges"].as_array().expect("edges");
    // PL §1.4: "An edge from a cone to itself or to a cone with a lower
    // index is therefore on a cycle".
    assert!(edges
        .iter()
        .any(|edge| edge["from"] == 1 && edge["to"] == 0));
    let own = plan_of(&analysis, "Own");
    assert_eq!(own["edges"][0]["from"], own["edges"][0]["to"]);
}

#[test]
fn a_pattern_called_in_the_reactive_tier_is_compiled_in_under_a_site_step() {
    // PL §1.1: "A pattern compiled into another has no plan of its own
    // ... Its slots, bodies and cones are entries of the enclosing plan".
    // §1.3: "A `site` step contributes the name of a call that is
    // compiled into the plan".
    let analysis = program(
        r#"import { Writable, pattern } from "commonfabric";
const Row = pattern<{ title: string }>(({ title }) => {
  const open = Writable.of(false);
  return { title, open };
});
export const Outer = pattern<{ title: string }>(({ title }) => {
  const row = Row({ title });
  return { row };
});
"#,
    );
    let plan = plan_of(&analysis, "Outer");
    assert_eq!(
        plan["stateCells"],
        json!([{ "name": "open", "scope": "space", "within": [{ "site": "row" }] }])
    );
    assert_eq!(plan["children"], json!([]));
}

#[test]
fn a_pattern_that_is_the_default_export_of_a_module_is_compiled_in_as_a_named_one_is() {
    // PL §1.1, as above. The pattern has no name in its module: the site
    // takes the name of the `const` the call is assigned to (§1.3).
    let analysis = analyze(&[
        SourceFile {
            path: "row.tsx".to_string(),
            text: r#"import { Writable, pattern } from "commonfabric";
export default pattern<{ title: string }>(({ title }) => {
  const open = Writable.of(false);
  return { title, open };
});
"#
            .to_string(),
        },
        SourceFile {
            path: "outer.tsx".to_string(),
            text: r#"import { pattern } from "commonfabric";
import Row from "./row.tsx";
export const Outer = pattern<{ title: string }>(({ title }) => {
  const row = Row({ title });
  return { row };
});
"#
            .to_string(),
        },
    ]);
    let plan = plan_of(&analysis, "Outer");
    assert_eq!(
        plan["stateCells"],
        json!([{ "name": "open", "scope": "space", "within": [{ "site": "row" }] }])
    );
}

#[test]
fn a_call_of_a_standard_library_function_is_expression_code_that_consumes_its_arguments() {
    // PL §1.4: a cone is expression code over slots; a conversion such as
    // `String(n)` is an operator over its operand (note 91).
    let analysis = program(
        r#"import { pattern } from "commonfabric";
export const Shown = pattern<{ n: number }>(({ n }) => {
  const text = String(n);
  return { text };
});
"#,
    );
    let plan = plan_of(&analysis, "Shown");
    let cone = &plan["cones"][0];
    assert_eq!(cone["entry"], "text");
    let slots: Vec<String> = cone["slots"]
        .as_array()
        .expect("slots")
        .iter()
        .map(|slot| slot_line(&plan, slot))
        .collect();
    assert_eq!(slots, ["argument n : value"]);
}

#[test]
fn an_element_construct_over_an_array_written_in_place_has_an_output_as_its_source() {
    // PL §1.1, `Collection.source`: "An array the instance computed
    // (`Plan.outputs`)". An array written in the reactive tier, over
    // slots or over constants, is computed by a cone of its own, so that
    // the cone that uses the assembled result does not precede the body.
    let analysis = program(
        r#"import { pattern, UI } from "commonfabric";
export const Pair = pattern<{ a: string; b: string }>(({ a, b }) => {
  const shown = [a, b].map((text) => text + "!");
  const fixed = ["x", "y"].map((text) => text + a);
  return { shown, fixed };
});
"#,
    );
    let plan = plan_of(&analysis, "Pair");
    let collections = plan["collections"].as_array().expect("collections");
    assert_eq!(collections.len(), 2);
    for collection in collections {
        let output = collection["source"]["output"]
            .as_u64()
            .expect("an output as the source") as usize;
        let cone = plan["outputs"][output]["cone"].as_u64().expect("a cone") as usize;
        // The cone of the array is not the cone of the body.
        let body_output = plan["outputs"]
            .as_array()
            .expect("outputs")
            .iter()
            .find(|other| other["collection"] == json!(0) || other["collection"] == json!(1))
            .expect("an assembled result");
        assert_ne!(json!(cone), body_output["cone"]);
    }
    let first = plan["outputs"][collections[0]["source"]["output"].as_u64().unwrap() as usize]
        ["cone"]
        .as_u64()
        .unwrap() as usize;
    let slots: Vec<String> = plan["cones"][first]["slots"]
        .as_array()
        .expect("slots")
        .iter()
        .map(|slot| slot_line(&plan, slot))
        .collect();
    assert_eq!(slots, ["argument a : identity", "argument b : identity"]);
}

/// The slots of the cone whose entry is `entry`, in the notation of PL
/// §6.2.
fn cone_slots(plan: &Value, entry: &str) -> Vec<String> {
    let cone = plan["cones"]
        .as_array()
        .expect("cones")
        .iter()
        .find(|cone| cone["entry"] == entry)
        .unwrap_or_else(|| panic!("no cone {entry}"));
    cone["slots"]
        .as_array()
        .expect("slots")
        .iter()
        .map(|slot| slot_line(plan, slot))
        .collect()
}

#[test]
fn a_context_read_in_the_reactive_tier_has_the_slots_of_pl_section_3_16() {
    let analysis = program(
        r#"import { Cell, equals, linksOf, pattern, principalOf, spaceAccess, spaceOf, toIndentedDebugString } from "commonfabric";
interface Item { title: string }
export const Context = pattern<{ a: Cell<Item>; b: Cell<Item>; list: Item[] }>(({ a, b, list }) => {
  const where = spaceOf(a);
  const same = equals(a, b);
  const links = linksOf(list);
  const who = principalOf(a);
  const access = spaceAccess(b);
  const shown = toIndentedDebugString(list);
  return { where, same, links, who, access, shown };
});
"#,
    );
    let plan = plan_of(&analysis, "Context");
    // "`spaceOf(x)`: The `identity` slot of `x`, resolved".
    assert_eq!(
        cone_slots(&plan, "where"),
        ["argument a : identity, resolved"]
    );
    // "`equals(a, b)`: The `identity` slots of both operands, resolved".
    assert_eq!(
        cone_slots(&plan, "same"),
        [
            "argument a : identity, resolved",
            "argument b : identity, resolved"
        ]
    );
    // "`linksOf(list)`: The `enumeration` slot of the list and the
    // `identity` slot of each element".
    assert_eq!(
        cone_slots(&plan, "links"),
        ["argument list : enumeration", "argument list/* : identity"]
    );
    // "`principalOf`: The `identity` slot of the target, resolved, and a
    // `labelMetadata` slot on it".
    assert_eq!(
        cone_slots(&plan, "who"),
        [
            "argument a : identity, resolved",
            "argument a : labelMetadata"
        ]
    );
    // "`spaceAccess`: `dynamic`, of kind `space`, through the `identity`
    // slot of the operand, resolved".
    assert_eq!(
        cone_slots(&plan, "access"),
        ["argument b : identity, resolved"]
    );
    let of = plan["dynamicReads"]
        .as_array()
        .expect("dynamic reads")
        .iter()
        .find(|read| read["why"]["kind"] == "space")
        .expect("a dynamic read of kind space")["why"]["of"]
        .clone();
    assert_eq!(slot_line(&plan, &of), "argument b : identity, resolved");
    // BI: "Every operand by `value`, over its whole subtree".
    assert_eq!(cone_slots(&plan, "shown"), ["argument list : value"]);
}

#[test]
fn the_method_forms_of_equals_and_equal_links_have_the_slots_of_the_function() {
    // LS §4.7: "`a.equals(b)` and `X.equals(a, b)`, and the three forms
    // mean the same." PL §3.16: "`a.equalLinks(b)`: The `identity` slots
    // of both operands, not resolved".
    let analysis = program(
        r#"import { Cell, pattern } from "commonfabric";
interface Item { title: string }
export const Same = pattern<{ a: Cell<Item>; b: Cell<Item> }>(({ a, b }) => {
  const same = a.equals(b);
  const stored = a.equalLinks(b);
  return { same, stored };
});
"#,
    );
    let plan = plan_of(&analysis, "Same");
    assert_eq!(
        cone_slots(&plan, "same"),
        [
            "argument a : identity, resolved",
            "argument b : identity, resolved"
        ]
    );
    assert_eq!(
        cone_slots(&plan, "stored"),
        ["argument a : identity", "argument b : identity"]
    );
}

#[test]
fn a_dynamic_read_of_kind_space_in_a_body_names_the_slot_of_its_operand() {
    // PL §1.1, `DynamicReads`: "The access list of the space an
    // `identity` slot's target lives in, or of the space a `value` slot
    // names."
    let analysis = program(
        r#"import { Cell, lift, pattern, spaceAccess } from "commonfabric";
interface Item { title: string }
const allowed = lift((x: { item: Cell<Item>; on: boolean }) => { if (x.on) { return spaceAccess(x.item) !== undefined; } return false; });
export const Gate = pattern<{ item: Cell<Item>; on: boolean }>(({ item, on }) => {
  const open = allowed({ item, on });
  return { open };
});
"#,
    );
    let plan = plan_of(&analysis, "Gate");
    let of = plan["dynamicReads"]
        .as_array()
        .expect("dynamic reads")
        .iter()
        .find(|read| read["why"]["kind"] == "space")
        .expect("a dynamic read of kind space")["why"]["of"]
        .clone();
    assert_eq!(slot_line(&plan, &of), "argument item : identity");
}

#[test]
fn a_scan_is_a_collection_with_a_predicate_cone_and_a_selector_the_runtime_supplies() {
    // PL §3.13: "`some` is a `fold` of the predicate's template through
    // the first truthy element". §1.1, `Selector`: "For the `through` of
    // a `fold` it is 0." "`xs.find(...)`: `pick` over the collection";
    // `Pick.chosenBy` `runtime`: "the runtime chooses an element of a
    // collection from per-element results".
    let analysis = program(
        r#"import { pattern } from "commonfabric";
interface Item { title: string; done: boolean }
export const Scan = pattern<{ items: Item[] }>(({ items }) => {
  const anyDone = items.some((item) => item.done);
  const first = items.find((item) => item.done);
  const where = items.findIndex((item) => item.title === "x");
  const all = items.every((item) => item.done);
  return { anyDone, first, where, all };
});
"#,
    );
    let plan = plan_of(&analysis, "Scan");
    let names: Vec<&str> = plan["collections"]
        .as_array()
        .expect("collections")
        .iter()
        .map(|collection| collection["name"].as_str().expect("a name"))
        .collect();
    assert_eq!(names, ["anyDone", "first", "where", "all"]);
    for collection in plan["collections"].as_array().expect("collections") {
        assert_eq!(
            slot_line(&plan, &collection["source"]["slot"]),
            "argument items : enumeration"
        );
    }
    assert_eq!(cone_slots(&plan, "anyDone"), ["element done : value"]);
    assert_eq!(cone_slots(&plan, "where"), ["element title : value"]);
    assert_eq!(
        plan["selectors"],
        json!([{ "arity": 0 }, { "arity": 0 }, { "arity": 0 }, { "arity": 0 }])
    );
    assert_eq!(plan["picks"], json!([{ "chosenBy": "runtime" }]));
    // The result is an output the runtime produces, as it assembles the
    // result of a `map`: it names the collection and the predicate's cone.
    let output = plan["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .find(|output| output["path"] == json!(["anyDone"]))
        .expect("the output of the scan");
    assert_eq!(output["collection"], json!(0));
}

// ----- PL §6.2: the plan for the slice of FabriChat -----

fn fabrichat() -> ProgramAnalysis {
    let directory = format!(
        "{}/../../patterns/system/fabrichat",
        env!("CARGO_MANIFEST_DIR")
    );
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&directory).expect("the FabriChat sources") {
        let path = entry.expect("a directory entry").path();
        let name = path.to_string_lossy().to_string();
        if name.ends_with(".tsx") || name.ends_with(".ts") {
            let text = std::fs::read_to_string(&path).expect("a source file");
            files.push(SourceFile { path: name, text });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    analyze(&files)
}

#[test]
fn the_send_handler_and_its_binding_are_the_records_of_pl_section_6_2() {
    let analysis = fabrichat();
    let room = analysis
        .modules
        .iter()
        .flat_map(|module| &module.plans)
        .find(|plan| plan.name.as_deref() == Some("FabriChatRoomCore"))
        .expect("the room pattern");
    let plan = &room.plan;
    let (index, body) = plan["bodies"]
        .as_array()
        .expect("bodies")
        .iter()
        .enumerate()
        .find(|(_, body)| body["name"] == "commitSend")
        .expect("B0");
    assert_eq!(body["kind"], "handler");
    let line = |slot: &Value| slot_line(plan, slot);
    let mut reads: Vec<String> = body["reads"]
        .as_array()
        .expect("reads")
        .iter()
        .map(line)
        .collect();
    reads.sort();
    // The slots e0 to e8 and b0 to b4 of the listing.
    let listed = [
        "binding joined : identity",
        "binding messages : identity",
        "binding myProfile : identity, resolved",
        "binding myProfile : shape",
        "binding threadInfo : identity",
        "event attachments : enumeration",
        "event attachments/* : identity",
        "event body : value",
        "event replyTo : shape",
        "event replyTo/quotes : identity",
        "event replyTo/shownIn : value",
        "event replyTo/thread : identity",
        "event target/value : value",
        "event threadTitle : value",
    ];
    // "It leaves out the `shape` slots that footprint analysis records at
    // optional positions ... Two are at data positions, `event target`
    // and `event attachments`. ... The others are in place (`inPlace`),
    // at the positions of the optional handles: among them `binding
    // myProfile`, `binding joined`, `event replyTo/thread` and `event
    // replyTo/quotes`."
    let left_out = [
        "binding joined : shape, inPlace",
        "binding myProfile : shape, inPlace",
        "binding threadInfo : shape, inPlace",
        "event attachments : shape",
        "event attachments/* : shape, inPlace",
        "event replyTo/quotes : shape, inPlace",
        "event replyTo/thread : shape, inPlace",
        "event target : shape",
    ];
    let mut expected: Vec<String> = listed
        .iter()
        .chain(&left_out)
        .map(|line| line.to_string())
        .collect();
    expected.sort();
    assert_eq!(reads, expected);
    // "handles h0 slot e3, h1 slot e5, h2 slot e6, h3 slot b3".
    let handles: Vec<String> = body["handles"]
        .as_array()
        .expect("handles")
        .iter()
        .map(|handle| line(&handle["handle"]["slot"]))
        .collect();
    assert_eq!(
        handles,
        [
            "event attachments/* : identity",
            "event replyTo/quotes : identity",
            "event replyTo/thread : identity",
            "binding threadInfo : identity",
        ]
    );
    // "calls n0 createCell, identified by order".
    assert_eq!(
        body["calls"],
        json!([{ "kind": "createCell", "scope": "space", "identifiedBy": "order" }])
    );
    // The writes w0 to w7, as `target path [reference]`.
    let writes: Vec<String> = body["writes"]
        .as_array()
        .expect("writes")
        .iter()
        .map(|write| {
            let target = &write["target"];
            let path: Vec<&str> = target["path"]
                .as_array()
                .expect("a path")
                .iter()
                .map(|segment| segment.as_str().expect("a segment"))
                .collect();
            let mut text = match target["kind"].as_str() {
                Some("handle") => format!("handle [{}] {}", line(&target["slot"]), path.join("/")),
                Some("created") => format!("created n{}", target["call"]),
                other => panic!("an unexpected target {other:?}"),
            };
            if let Some(passes) = write["reference"].get("passes") {
                text.push_str(&format!(" passes [{}]", line(passes)));
            }
            if let Some(one_of) = write["reference"].get("oneOf") {
                let names: Vec<String> =
                    one_of.as_array().expect("oneOf").iter().map(line).collect();
                text.push_str(&format!(" one of [{}]", names.join(", ")));
            }
            text.trim_end().to_string()
        })
        .collect();
    assert_eq!(
        writes,
        [
            // w3
            "created n0",
            // w5
            "handle [binding joined : identity]",
            // w0
            "handle [binding messages : identity] *",
            // w2
            "handle [binding messages : identity] */attachments/* one of [event attachments/* : identity]",
            // w1
            "handle [binding messages : identity] */authorProfile passes [binding myProfile : identity, resolved]",
            // w7: "w7 handle b2 */replyTo/quotes passes e6".
            "handle [binding messages : identity] */replyTo/quotes passes [event replyTo/quotes : identity]",
            // w6: "w6 handle b2 */replyTo/thread passes e5".
            "handle [binding messages : identity] */replyTo/thread passes [event replyTo/thread : identity]",
            // w4: "w4 handle b3 * T_send", an `addUnique`.
            "handle [binding threadInfo : identity] *",
        ]
    );
    // "envelopes handle b3 *".
    assert_eq!(body["envelopes"].as_array().expect("envelopes").len(), 1);
    assert_eq!(body["envelopes"][0]["path"], json!(["*"]));
    assert_eq!(
        line(&body["envelopes"][0]["slot"]),
        "binding threadInfo : identity"
    );
    // The binding: "sendMessage handler B0, state myProfile slot s1 link,
    // messages slot s0 link, threadInfo slot s2 link, joined the stream
    // of another binding link".
    let binding = plan["bindings"]
        .as_array()
        .expect("bindings")
        .iter()
        .find(|binding| binding["name"] == "sendMessage")
        .expect("the binding");
    assert_eq!(binding["handler"], json!({ "body": index }));
    let state: Vec<String> = binding["state"]
        .as_array()
        .expect("state")
        .iter()
        .map(|entry| {
            let bound = &entry["place"];
            let to = match bound.get("slot") {
                Some(slot) => line(slot),
                None => {
                    assert!(bound.get("stream").is_some(), "{bound}");
                    "the stream of another binding".to_string()
                }
            };
            format!(
                "{} {} {}",
                entry["path"][0].as_str().expect("a path"),
                to,
                entry["capture"].as_str().expect("a capture")
            )
        })
        .collect();
    assert_eq!(
        state,
        [
            "joined the stream of another binding link",
            "messages argument messages : identity link",
            "myProfile argument myProfile : identity link",
            "threadInfo argument threadInfo : identity link",
        ]
    );
    // The middle column of the listing is the member `place`, and
    // `template` is the label of the same place.
    for entry in binding["state"].as_array().expect("state") {
        match entry["place"].get("slot") {
            Some(slot) => assert_eq!(entry["template"], json!({ "op": "slot", "slot": slot })),
            None => assert_eq!(entry["template"], json!({ "op": "const" })),
        }
    }
    // "T_send has ... dynamic(handle B0.h0) ... dynamic(link through b2)":
    // the dynamic reads of the plan that name B0's handles.
    let through_handles = plan["dynamicReads"]
        .as_array()
        .expect("dynamicReads")
        .iter()
        .filter(|read| read["why"]["kind"] == "handle" && read["why"]["body"] == json!(index))
        .count();
    assert_eq!(through_handles, 4);
}

fn pattern_plan(analysis: &ProgramAnalysis, name: &str) -> Value {
    analysis
        .modules
        .iter()
        .flat_map(|module| &module.plans)
        .find(|plan| plan.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("no pattern named {name}"))
        .plan
        .clone()
}

fn body_named<'p>(plan: &'p Value, name: &str) -> &'p Value {
    plan["bodies"]
        .as_array()
        .expect("bodies")
        .iter()
        .find(|body| body["name"] == name)
        .unwrap_or_else(|| panic!("no body named {name}"))
}

/// The template of a use of a body: that of the computed input another
/// body has from it.
fn facts_template(plan: &Value, name: &str) -> Value {
    let index = body_index(plan, name);
    plan["bodies"]
        .as_array()
        .expect("bodies")
        .iter()
        .flat_map(|body| body["computed"].as_array().expect("computed"))
        .map(|input| input["template"].clone())
        .find(|template| template["by"]["body"] == json!(index))
        .unwrap_or_else(|| panic!("no computed input from {name}"))
}

fn body_index(plan: &Value, name: &str) -> usize {
    plan["bodies"]
        .as_array()
        .expect("bodies")
        .iter()
        .position(|body| body["name"] == name)
        .unwrap_or_else(|| panic!("no body named {name}"))
}

fn reads_of(plan: &Value, body: &Value) -> Vec<String> {
    body["reads"]
        .as_array()
        .expect("reads")
        .iter()
        .map(|slot| slot_line(plan, slot))
        .collect()
}

#[test]
fn the_function_bodies_of_the_room_are_the_records_of_pl_section_6_2() {
    // "`facts` is two calls of authored functions, `B1` and `B2`, bodies
    // of kind `function`, and the result of `B1` is a computed input of
    // `B2`."
    let analysis = fabrichat();
    let plan = pattern_plan(&analysis, "FabriChatRoomCore");
    // "B1 function threadTitles#1 reads s2 s3 s4 s5", and "`B1` has no
    // entry in `handles`": `s2` the handle, `s3` "the list's
    // enumeration", `s4` "the `root` handle of each record", and `s5`
    // "each `title`". Of the four `shape` slots the listing gives `B1`,
    // the crate has the one in place at `threadInfo` and the one at the
    // root of the list. The tests at `threadInfo/*` and at
    // `threadInfo/*/root` are decided by the type, and FA §2.3 removes
    // their entries (SPEC-NOTES 160).
    let titles = body_named(&plan, "threadTitles#1");
    assert_eq!(titles["kind"], "function");
    assert_eq!(
        reads_of(&plan, titles),
        [
            "argument threadInfo : identity",
            "argument threadInfo : shape, inPlace",
            "argument threadInfo : enumeration",
            "argument threadInfo : shape",
            "argument threadInfo/*/root : identity",
            "argument threadInfo/*/title : value",
        ]
    );
    assert_eq!(titles["handles"], json!([]));
    // "T_titles = derive(by B1) [ s2 s3 s4 s5 dynamic(link through s4) ]":
    // "the links followed below it are a `dynamic` node of kind `link`".
    let template = facts_template(&plan, "threadTitles#1");
    let dynamic: Vec<&Value> = template["inputs"]
        .as_array()
        .expect("inputs")
        .iter()
        .filter(|input| input["op"] == "dynamic")
        .collect();
    assert_eq!(dynamic.len(), 1);
    let read = &plan["dynamicReads"][dynamic[0]["reads"].as_u64().expect("reads") as usize];
    assert_eq!(read["why"]["kind"], json!("link"));
    assert_eq!(
        slot_line(&plan, &read["why"]["through"]),
        "argument threadInfo/*/root : identity"
    );
    // "B2 function messageFacts reads s0; computed titles/* : value
    // T_titles; handles h0 slot s0". "`B2` reads `titles[key]` on a
    // record, so its computed inputs include `titles : enumeration`
    // beside `titles/* : value`".
    let facts = body_named(&plan, "messageFacts");
    assert_eq!(facts["kind"], "function");
    let reads = reads_of(&plan, facts);
    assert!(
        reads.contains(&"argument messages : identity".to_string()),
        "{reads:?}"
    );
    let handles: Vec<String> = facts["handles"]
        .as_array()
        .expect("handles")
        .iter()
        .map(|handle| slot_line(&plan, &handle["handle"]["slot"]))
        .collect();
    assert_eq!(handles, ["argument messages : identity"]);
    // "`B2` records `titles/* : value`. The title leaves `B1` in a record
    // the body built, and such a member is recorded by the type of the
    // position its projection names, a string here" (FA §3.8).
    let computed: Vec<(Value, Value)> = facts["computed"]
        .as_array()
        .expect("computed")
        .iter()
        .map(|input| (input["at"].clone(), input["observes"].clone()))
        .collect();
    assert_eq!(
        computed,
        [
            (json!(["titles"]), json!("enumeration")),
            (json!(["titles", "*"]), json!("value")),
        ]
    );
    // "computed titles/* : value T_titles": each entry has the template
    // of what `B1` returned.
    for input in facts["computed"].as_array().expect("computed") {
        assert_eq!(
            input["template"]["by"]["body"],
            json!(body_index(&plan, "threadTitles#1"))
        );
    }
    // "By the partition of section 1.4, the cones of the slice are
    // `facts`, `isEmpty`, the JSX tree ... The result of `B1` is computed
    // and used inside the cone `facts` ... [It is not] an entry of
    // `Plan.outputs`."
    let cones = plan["cones"].as_array().expect("cones");
    let cone_of = |entry: &str| {
        cones
            .iter()
            .position(|cone| cone["entry"] == entry)
            .unwrap_or_else(|| panic!("no cone {entry}"))
    };
    let facts_cone = cone_of("facts");
    assert_eq!(
        cones[facts_cone]["bodies"],
        json!([
            body_index(&plan, "threadTitles#1"),
            body_index(&plan, "messageFacts")
        ])
    );
    cone_of("isEmpty");
    cone_of("$UI");
    for output in plan["outputs"].as_array().expect("outputs") {
        if output["cone"] == json!(facts_cone) {
            // "`facts.main`, `facts.entries`, `facts.places` ... are
            // interim outputs".
            // "Kept outputs in the slice: the room's `messages` output
            // (from `facts.list`)".
            if output["kept"] == json!(true) {
                assert_eq!(
                    output["path"].as_array().and_then(|path| path.last()),
                    Some(&json!("messages"))
                );
                continue;
            }
            assert_eq!(output["interim"], "facts");
            assert!(
                output["path"] == json!(["main"])
                    || output["path"] == json!(["entries"])
                    || output["path"] == json!(["places"]),
                "{output}"
            );
            assert_eq!(
                output["template"]["by"]["body"],
                json!(body_index(&plan, "messageFacts"))
            );
        }
    }
    // "c1 = collection source: output facts.main, bodyUses: { index:
    // false }". The output is interim, at the path `main` below `facts`.
    let main = plan["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .position(|output| output["interim"] == "facts" && output["path"] == json!(["main"]))
        .expect("the output facts.main");
    assert_eq!(plan["outputs"][main]["kept"], json!(false));
    let c1 = plan["collections"]
        .as_array()
        .expect("collections")
        .iter()
        .find(|collection| collection["source"] == json!({ "output": main }))
        .expect("c1");
    assert_eq!(c1["bodyUses"], json!({ "index": false }));
    assert_eq!(c1["within"], json!([]));
}

#[test]
fn the_function_bodies_of_a_row_are_the_records_of_pl_section_6_2() {
    // The listing compiles the row into the room, so that its slots have
    // the root `element`. The crate does not compile in a pattern used as
    // a JSX tag, and the row has a plan of its own, in which the message
    // is the argument (SPEC-NOTES 105).
    let analysis = fabrichat();
    let plan = pattern_plan(&analysis, "FabriChatMessageRow");
    // "B3 function bodyText reads m0 m1 m2 m4": the element's `shape`,
    // `body : value`, and `authorProfile : shape`. `m1`, the reference at
    // the element, belongs to the element construct and is not in the
    // row's own plan. "`m4` is at a position of handle type, so it has
    // `inPlace`".
    let text = body_named(&plan, "bodyText#1");
    assert_eq!(text["kind"], "function");
    assert_eq!(
        reads_of(&plan, text),
        [
            "argument message : shape",
            "argument message/authorProfile : shape, inPlace",
            "argument message/body : value",
        ]
    );
    assert_eq!(text["handles"], json!([]));
    // "B4 function viewKeyOf reads m6": `(root) : identity, resolved`.
    // "`viewKeyOf` uses the handle that the static resolution returned
    // and not `message` itself, so the body has the resolved `identity`
    // entry and no plain entry beside it".
    let key = body_named(&plan, "viewKeyOf#1");
    assert_eq!(key["kind"], "function");
    assert_eq!(
        reads_of(&plan, key),
        ["argument message : identity, resolved"]
    );
    // "`p0` is the pick's choice point, an entry of `Plan.picks` with
    // `chosenBy: \"valueCode\"`".
    assert!(plan["picks"]
        .as_array()
        .expect("picks")
        .contains(&json!({ "chosenBy": "valueCode" })));
    // "The cones of the slice are ... per row `text`, `isEdited`, the
    // row's key, `replies` and `threadLabel`. ... the conditions of
    // `T_edited` and `T_label` [are computed and used] inside the cones
    // `isEdited` and `threadLabel`. None of the three is an entry of
    // `Plan.outputs`." The source declares the key inside the `computed`
    // of `replies`, so the crate has it in that cone, with `B4`
    // (SPEC-NOTES 114).
    let cones = plan["cones"].as_array().expect("cones");
    let cone = |entry: &str| {
        cones
            .iter()
            .find(|cone| cone["entry"] == entry)
            .unwrap_or_else(|| panic!("no cone {entry}"))
    };
    assert_eq!(
        cone("text")["bodies"],
        json!([body_index(&plan, "bodyText#1")])
    );
    assert_eq!(
        cone("isEdited")["selectors"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(
        cone("replies")["bodies"],
        json!([body_index(&plan, "viewKeyOf#1")])
    );
    assert_eq!(cone("replies")["picks"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        cone("threadLabel")["selectors"].as_array().map(Vec::len),
        Some(1)
    );
    for output in plan["outputs"].as_array().expect("outputs") {
        let name = output["interim"].as_str().unwrap_or("");
        assert!(
            !matches!(name, "condition" | "branch" | "operand"),
            "{output}"
        );
    }
}

#[test]
fn a_binding_made_in_a_body_names_its_handler_and_what_each_path_of_the_state_holds() {
    // PL §1.1, `Binding.state`: "`link`: the path is bound by reference.
    // It holds a cell handle ... `copy`: a scalar, or a container the body
    // computed". "For a path bound by reference in a function body: the
    // reference the binding holds". "For a binding made in a function
    // body, `within` is where the `bind` site's body sits".
    let analysis = program(
        r#"import { Cell, handler, pattern } from "commonfabric";
const inc = handler<{ by: number }, { count: Cell<number>; step: number }>((event, state) => {
  state.count.set(state.count.get() + event.by * state.step);
});
const make = handler<{ n: number }, { count: Cell<number>; out: Cell<unknown> }>((event, state) => {
  state.out.set(inc({ count: state.count, step: event.n }));
});
export const Maker = pattern<{ count: Cell<number>; out: Cell<unknown> }>(({ count, out }) => {
  return { maker: make({ count, out }) };
});
"#,
    );
    let plan = plan_of(&analysis, "Maker");
    let make = body_named(&plan, "make");
    let inc = plan["bodies"]
        .as_array()
        .expect("bodies")
        .iter()
        .position(|body| body["name"] == "inc")
        .expect("the bound handler is a body of the plan");
    let binding = make["calls"][0]["binding"].as_u64().expect("a binding") as usize;
    assert_eq!(make["calls"][0]["kind"], "bind");
    let record = &plan["bindings"][binding];
    assert_eq!(record["handler"], json!({ "body": inc }));
    assert_eq!(record["within"], json!([]));
    assert!(record.get("name").is_none());
    let state: Vec<String> = record["state"]
        .as_array()
        .expect("state")
        .iter()
        .map(|entry| {
            let mut line = format!(
                "{} {}",
                entry["path"][0].as_str().expect("a path"),
                entry["capture"].as_str().expect("a capture")
            );
            if let Some(passes) = entry["reference"].get("passes") {
                line.push_str(&format!(" passes [{}]", slot_line(&plan, passes)));
            }
            line
        })
        .collect();
    assert_eq!(
        state,
        ["count link passes [binding count : identity]", "step copy"]
    );
}

// ----- PL §1.1, `Template`, and §3: the first templates -----

fn output_named<'p>(plan: &'p Value, interim: &str) -> &'p Value {
    plan["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .find(|output| {
            (output["interim"] == interim && output["path"] == json!([]))
                || output["path"] == json!([interim])
        })
        .unwrap_or_else(|| panic!("no output {interim}"))
}

/// A template in the notation of PL §6.2.
fn template_line(plan: &Value, template: &Value) -> String {
    match template["op"].as_str() {
        Some("const") => "const".to_string(),
        Some("slot") => format!("[{}]", slot_line(plan, &template["slot"])),
        Some("dynamic") => {
            let why = &plan["dynamicReads"][template["reads"].as_u64().unwrap() as usize]["why"];
            format!("dynamic({})", why["kind"].as_str().unwrap())
        }
        Some("derive") => {
            let inputs: Vec<String> = template["inputs"]
                .as_array()
                .expect("inputs")
                .iter()
                .map(|input| template_line(plan, input))
                .collect();
            let by = match template["by"].get("body") {
                Some(body) => format!(
                    "by {}",
                    plan["bodies"][body.as_u64().unwrap() as usize]["name"]
                        .as_str()
                        .unwrap()
                ),
                None => "expression".to_string(),
            };
            format!("derive({by}) {{ {} }}", inputs.join(" "))
        }
        Some("select") => {
            let branches: Vec<String> = template["branches"]
                .as_array()
                .expect("branches")
                .iter()
                .map(|branch| template_line(plan, branch))
                .collect();
            format!(
                "select({} ? {})",
                template_line(plan, &template["condition"]),
                branches.join(" | ")
            )
        }
        Some("fold") => format!(
            "fold({}{}: {})",
            plan["collections"][template["collection"].as_u64().unwrap() as usize]["name"]
                .as_str()
                .unwrap(),
            if template.get("through").is_some() {
                " through"
            } else {
                ""
            },
            template_line(plan, &template["body"])
        ),
        Some("pick") => {
            let from = &template["from"];
            let from = if let Some(slot) = from.get("container") {
                format!("container [{}]", slot_line(plan, slot))
            } else if let Some(output) = from.get("output") {
                let output = &plan["outputs"][output.as_u64().unwrap() as usize];
                format!(
                    "output {}/{}",
                    output["interim"].as_str().unwrap_or(""),
                    output["path"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|segment| segment.as_str().unwrap())
                        .collect::<Vec<_>>()
                        .join("/")
                )
            } else {
                format!(
                    "collection {}",
                    plan["collections"][from["collection"].as_u64().unwrap() as usize]["name"]
                        .as_str()
                        .unwrap()
                )
            };
            format!(
                "pick({}, choice {}, body {})",
                from,
                template_line(plan, &template["choice"]),
                template_line(plan, &template["body"])
            )
        }
        other => panic!("an unexpected template {other:?} in {template}"),
    }
}

#[test]
fn an_operator_over_slots_and_a_projection_have_the_templates_of_pl_section_3() {
    // PL §3.3: "`a.b` is the slot at the extended path". §1.1: "`derive`:
    // A new value computed from the inputs", by "emitted expression
    // code"; "`const`: A literal ... Contributes nothing."
    let analysis = program(
        r#"import { pattern } from "commonfabric";
export const Sum = pattern<{ order: { price: number; count: number } }>(({ order }) => {
  const total = order.price * order.count + 1;
  return { total };
});
"#,
    );
    let plan = plan_of(&analysis, "Sum");
    let total = output_named(&plan, "total");
    assert_eq!(
        template_line(&plan, &total["template"]),
        "derive(expression) { derive(expression) { [argument order/price : value] [argument order/count : value] } const }"
    );
}

#[test]
fn a_body_has_the_template_of_its_footprint_as_t_titles_and_t_facts_have() {
    // PL §6.2: "T_titles = derive(by B1) [ s2 dynamic(handle B1.h0) ]",
    // "T_facts = derive(by B2) [ s0 T_titles dynamic(handle B2.h0) ]",
    // "T_empty = derive(expression) [ T_facts, const ]".
    let analysis = program(
        r#"import { Cell, computed, pattern } from "commonfabric";
interface Message { body: string }
function titlesOf(info: Cell<Record<string, string>>, on: boolean): Record<string, string> {
  if (on) { return info.get(); }
  return {};
}
function factsOf(messages: Cell<Message[]>, titles: Record<string, string>, on: boolean): { main: string[] } {
  const main: string[] = [];
  if (on) { for (const message of messages.get()) { main.push(titles[message.body] ?? ""); } }
  return { main };
}
export const Room = pattern<{ messages: Cell<Message[]>; info: Cell<Record<string, string>>; on: boolean }>(({ messages, info, on }) => {
  const facts = computed(() => factsOf(messages, titlesOf(info, on), on));
  const isEmpty = computed(() => facts.main.length === 0);
  return { isEmpty };
});
"#,
    );
    let plan = plan_of(&analysis, "Room");
    let t_titles =
        "derive(by titlesOf) { [argument info : identity] [argument on : value] dynamic(handle) }";
    let t_facts = format!(
        "derive(by factsOf) {{ [argument messages : identity] [argument on : value] {t_titles} dynamic(handle) }}"
    );
    let empty = output_named(&plan, "isEmpty");
    assert_eq!(
        template_line(&plan, &empty["template"]),
        format!("derive(expression) {{ {t_facts} const }}")
    );
    // "computed titles/* : value T_titles": the entry of `Body.computed`
    // has the template of what the other body returned.
    let body = body_named(&plan, "factsOf");
    for input in body["computed"].as_array().expect("computed") {
        assert_eq!(template_line(&plan, &input["template"]), t_titles);
    }
}

// ----- bringing the records in line with PL as corrected -----

const STATE_WRITE: &str = r#"import { Cell, Writable, lift, pattern } from "commonfabric";
const note = lift((x: { seen: Cell<{ n: number }>; n: number }) => { x.seen.key("n").set(x.n); return 0; });
const show = lift((x: { seen: { n: number } }) => x.seen.n + 1);
export const P = pattern<{ n: number }>(({ n }) => {
  const seen = Writable.of({ n: 0 });
  const noted = note({ seen, n });
  const shown = show({ seen });
  return { noted, shown };
});
"#;

#[test]
fn a_write_through_a_state_cell_has_a_target_of_kind_state() {
    // FA §6.2: "Where the body is used with a state cell of the instance
    // as the handle, the target has the kind `state`." PL §1.1,
    // `WriteEdge.target`: `{ kind: "state"; cell: Index; path: Path }`.
    let plan = plan_of(&program(STATE_WRITE), "P");
    let body = body_named(&plan, "note");
    assert_eq!(
        body["writes"][0]["target"],
        json!({ "kind": "state", "cell": 0, "path": ["n"] })
    );
    // PL §3.11: "For a target with root `state` the rule is the same with
    // the cell's root in the place of the handle's path".
    let edges = plan["edges"].as_array().expect("edges");
    assert!(
        edges.contains(&json!({
            "from": 0, "to": 1,
            "via": { "kind": "state", "cell": 0, "path": ["n"] },
        })),
        "{edges:?}"
    );
}

#[test]
fn a_shape_slot_is_in_place_by_the_type_of_its_position() {
    // PL §1.1, `Slot.inPlace`: "A `shape` slot at a position of handle
    // type, or of reference type, has it (section 2.5)." The handle
    // `flag` is tested and never used, so no `identity` entry is beside
    // the `shape` entry. The container `box` is tested and passed on by
    // reference, and its position has a data type.
    let analysis = program(
        r#"import { Cell, lift, pattern } from "commonfabric";
const probe = lift((x: { flag?: Cell<number>; box?: { n: number } }) => {
  return { set: x.flag !== undefined, box: x.box === undefined ? undefined : x.box };
});
export const P = pattern<{ flag?: Cell<number>; box?: { n: number } }>(({ flag, box }) => {
  return { probed: probe({ flag, box }) };
});
"#,
    );
    let plan = plan_of(&analysis, "P");
    let reads = reads_of(&plan, body_named(&plan, "probe"));
    assert_eq!(
        reads,
        [
            "argument box : identity",
            "argument box : shape",
            "argument flag : shape, inPlace",
        ]
    );
}

#[test]
fn a_declaration_assigned_to_nothing_takes_its_base_name_before_the_place_it_is_written_at() {
    // PL §1.3: "A declaration assigned to nothing takes a base name from
    // what it is: the callee's name for a call site, a child, or a use of
    // a body; the built-in's or the method's name for an operation and a
    // collection; the handler's name for a binding of a named handler".
    // "A declaration assigned to nothing that has no base name by the
    // second rule takes the name of the place it is written at: the
    // property of the object literal, or the JSX attribute."
    let analysis = program(
        r#"import { Cell, computed, handler, lift, pattern, UI } from "commonfabric";
const add = handler<{ title: string }, { items: Cell<string[]> }>((event, state) => { state.items.push(event.title); });
const size = lift((x: { title: string }) => x.title.length);
const Row = pattern<{ title: string }>(({ title }) => {
  const shout = title + "!";
  return { shout, length: size({ title }) };
});
export const P = pattern<{ items: Cell<string[]>; title: string }>(({ items, title }) => {
  const named = items.map((item) => item + "?");
  return {
    [UI]: <div onClick={add({ items })}>{title}</div>,
    row: Row({ title }),
    shown: items.map((item) => item + "."),
    total: computed(() => { let n = 0; for (const item of items.get()) { n += item.length; } return n; }),
    named,
  };
});
"#,
    );
    let plan = plan_of(&analysis, "P");
    let names = |table: &str| -> Vec<String> {
        plan[table]
            .as_array()
            .expect("a table")
            .iter()
            .map(|record| record["name"].as_str().expect("a name").to_string())
            .collect()
    };
    assert_eq!(names("collections"), ["named", "map"]);
    assert_eq!(names("bindings"), ["add"]);
    // "That is the case for a `computed` ... whose function is an arrow
    // written in place, which has no callee's name."
    assert_eq!(names("bodies"), ["add", "size", "total"]);
    // "A `site` step holds the name of its call by the same rules."
    let shout = plan["cones"]
        .as_array()
        .expect("cones")
        .iter()
        .find(|cone| cone["entry"] == "shout")
        .expect("the cone of the row");
    assert_eq!(shout["entry"], "shout");
    let output = plan["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .find(|output| output["path"] == json!(["row", "shout"]))
        .expect("the kept output");
    assert_eq!(output["kept"], json!(true));
    assert!(shout["at"]["start"].as_u64().is_some());
    assert!(plan.to_string().contains(r#"{"site":"Row"}"#), "{plan}");
}

#[test]
fn a_child_a_body_instantiates_is_named_by_the_body_and_the_index_of_its_site() {
    // PL §1.3: "A `Child` that a site of `Body.calls` instantiates has
    // the body's `name`, `/n`, and the index of the site in `Body.calls`:
    // `openRoom/n0`." The body's name is the one it has in the plan, with
    // its ordinal.
    let analysis = program(
        r#"import { Cell, Writable, lift, pattern } from "commonfabric";
const Row = pattern<{ title: string }>(({ title }) => { return { title }; });
const make = lift((x: { title: string }) => {
  const seen = new Cell<number>(0);
  const row = Row({ title: x.title });
  return { seen, row };
});
export const P = pattern<{ title: string }>(({ title }) => {
  return { one: make({ title }), two: make({ title }) };
});
"#,
    );
    let plan = pattern_plan(&analysis, "P");
    let bodies = plan["bodies"].as_array().expect("bodies");
    assert_eq!(bodies[0]["name"], "make#1");
    assert_eq!(bodies[1]["name"], "make#2");
    for (body, expected) in bodies.iter().zip(["make#1/n1", "make#2/n1"]) {
        let calls = body["calls"].as_array().expect("calls");
        let site = calls
            .iter()
            .position(|call| call["kind"] == "instantiate")
            .expect("an instantiate site");
        assert_eq!(site, 1);
        let child = calls[site]["child"].as_u64().expect("a child") as usize;
        assert_eq!(plan["children"][child]["name"], expected);
    }
}

fn edge_lines(plan: &Value) -> Vec<String> {
    plan["edges"]
        .as_array()
        .expect("edges")
        .iter()
        .filter(|edge| edge["via"]["kind"] != "output")
        .map(|edge| {
            format!(
                "{} -> {}",
                plan["cones"][edge["from"].as_u64().unwrap() as usize]["entry"]
                    .as_str()
                    .unwrap(),
                plan["cones"][edge["to"].as_u64().unwrap() as usize]["entry"]
                    .as_str()
                    .unwrap()
            )
        })
        .collect()
}

#[test]
fn a_value_slot_above_a_handle_reads_its_cell_where_its_type_has_data_there() {
    // PL §3.11, "Which slots read a `handle` target": "Its path is a
    // proper prefix of the handle's path, its class is `value`, and its
    // schema has a data type at the handle's position, so that the read
    // continues through the link stored there. A `value` slot whose
    // schema has a handle type at the position stops there ... and a slot
    // of another class above the position does not reach the cell."
    let analysis = program(
        r#"import { Cell, lift, pattern } from "commonfabric";
const write = lift((x: { n: Cell<number>; v: number }) => { x.n.set(x.v); return 0; });
const whole = lift((x: { box: { n: number } }) => JSON.stringify(x.box));
const stops = lift((x: { box: { n: Cell<number> } }) => JSON.stringify(x.box));
const above = lift((x: { box: { n: number } }) => x.box === undefined);
export const P = pattern<{ box: { n: Cell<number> }; v: number }>(({ box, v }) => {
  const a = write({ n: box.n, v });
  const b = whole({ box });
  const c = stops({ box });
  const d = above({ box });
  return { a, b, c, d };
});
"#,
    );
    let plan = plan_of(&analysis, "P");
    assert_eq!(edge_lines(&plan), ["a -> b"]);
}

#[test]
fn a_shape_slot_in_place_below_the_position_of_a_handle_reads_its_cell() {
    // PL §3.11: "Two slots at the handle's own position are excepted: the
    // handle's `identity` slot, and a `shape` slot with `inPlace` there."
    // A `shape` slot in place at a position inside the cell is not.
    let analysis = program(
        r#"import { Cell, lift, pattern } from "commonfabric";
const write = lift((x: { a: Cell<{ inner?: Cell<number> }> }) => { x.a.set({}); return 0; });
const probe = lift((x: { a: { inner?: Cell<number> } }) => x.a.inner !== undefined);
const held = lift((x: { a?: Cell<{ inner?: Cell<number> }> }) => x.a !== undefined);
export const P = pattern<{ a: Cell<{ inner?: Cell<number> }> }>(({ a }) => {
  const one = write({ a });
  const two = probe({ a });
  const three = held({ a });
  return { one, two, three };
});
"#,
    );
    let plan = plan_of(&analysis, "P");
    let probe = body_named(&plan, "probe");
    assert_eq!(
        reads_of(&plan, probe),
        ["argument a/inner : shape, inPlace"]
    );
    assert_eq!(
        reads_of(&plan, body_named(&plan, "held")),
        ["argument a : shape, inPlace"]
    );
    assert_eq!(edge_lines(&plan), ["one -> two"]);
}

#[test]
fn an_edge_from_a_cone_to_itself_is_reported_unless_a_body_reads_its_own_target() {
    // `scheduler-and-serving-loop.md` §8.2: "The compiler reports an edge
    // to a cone with a lower index, and an edge from a cone to itself
    // where no body of the cone reads its own write target, as a warning
    // that names the side-write, `side-write:cycle`."
    let analysis = program(
        r#"import { Cell, computed, lift, pattern } from "commonfabric";
function put(n: Cell<number>, v: number): number {
  n.set(v);
  return 0;
}
function read(n: Cell<number>): number { return n.get(); }
const own = lift((x: { a: Cell<number> }) => {
  x.a.set(x.a.get() + 1);
  return 0;
});
export const Self = pattern<{ a: Cell<number>; v: number }>(({ a, v }) => {
  const both = computed(() => put(a, v) + read(a));
  return { both };
});
export const Own = pattern<{ a: Cell<number> }>(({ a }) => {
  const one = own({ a });
  return { one };
});
"#,
    );
    let plan = plan_of(&analysis, "Self");
    assert_eq!(edge_lines(&plan), ["both -> both"]);
    let cycles: Vec<(u32, u32)> = analysis.modules[0]
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.id == "side-write:cycle")
        .map(|diagnostic| (diagnostic.line, diagnostic.column))
        .collect();
    // The report names the side-write, `n.set(v)`, and not the function.
    assert_eq!(cycles, [(3, 3)]);
    let own = plan_of(&analysis, "Own");
    assert_eq!(edge_lines(&own), ["one -> one"]);
}

// ----- PL §3: `select`, `pick`, `fold`, and the templates of the records -----

fn interim_template(plan: &Value, name: &str) -> String {
    template_line(plan, &output_named(plan, name)["template"])
}

#[test]
fn a_conditional_and_a_logical_operator_are_a_select() {
    // PL §3.5: "`c ? a : b` produces `select` with `condition` the
    // template of `c` and two branches. `a && b` is `select(a, [b, a])`
    // ... `a || b` and `??` are analogous." "The condition's slots have
    // the class the test needs: `value` at the root for a scalar
    // condition, `shape` at the root for a record or array".
    let analysis = program(
        r#"import { pattern } from "commonfabric";
export const P = pattern<{ on: boolean; a: string; b: string; box?: { n: number } }>(({ on, a, b, box }) => {
  const one = on ? a : b;
  const two = a && b;
  const three = a || b;
  const four = box ? a : b;
  const five = a ?? b;
  return { one, two, three, four, five };
});
"#,
    );
    let plan = plan_of(&analysis, "P");
    let a = "[argument a : identity]";
    let b = "[argument b : identity]";
    assert_eq!(
        interim_template(&plan, "one"),
        format!("select([argument on : value] ? {a} | {b})")
    );
    assert_eq!(
        interim_template(&plan, "two"),
        format!("select([argument a : value] ? {b} | {a})")
    );
    assert_eq!(
        interim_template(&plan, "three"),
        format!("select([argument a : value] ? {a} | {b})")
    );
    assert_eq!(
        interim_template(&plan, "four"),
        format!("select([argument box : shape] ? {a} | {b})")
    );
    assert_eq!(
        interim_template(&plan, "five"),
        format!("select([argument a : shape] ? {a} | {b})")
    );
    // Each `select` has a selector of its own, of arity 2, that its cone
    // lists.
    assert_eq!(plan["selectors"].as_array().expect("selectors").len(), 5);
    let one = &output_named(&plan, "one")["template"];
    assert_eq!(
        plan["selectors"][one["selector"].as_u64().unwrap() as usize],
        json!({ "arity": 2 })
    );
}

#[test]
fn a_dynamic_key_is_a_pick_over_a_container_slot_an_output_or_a_select_over_static_keys() {
    // PL §3.18: "`a[k]` | The container slot of `a`, or the output that
    // computes `a` | The template of `k` joined with the `shape` of the
    // chosen child". "One of them is the `shape` slot at the path of `a`
    // followed by `*`, which `choice` joins. `from` names that slot as
    // `container` ... The plan has no slot at the path of `a` itself on
    // account of the pick". "When `a` is a constructed object with a
    // static key set, the compiler emits a `select` over its keys in
    // place of a `pick`".
    let analysis = program(
        r#"import { lift, pattern } from "commonfabric";
const build = lift((x: { n: number }) => { const out: Record<string, number> = {}; out["a"] = x.n; return out; });
export const P = pattern<{ table: Record<string, number>; key: string; n: number; m: number }>(({ table, key, n, m }) => {
  const chosen = table[key];
  const built = build({ n });
  const found = built[key];
  const made = { x: n, y: m };
  const member = made[key];
  return { chosen, found, member };
});
"#,
    );
    let plan = plan_of(&analysis, "P");
    assert_eq!(
        interim_template(&plan, "chosen"),
        "pick(container [argument table/* : shape], choice derive(expression) { [argument key : value] [argument table/* : shape] }, body [argument table/* : value])"
    );
    assert!(!plan["slots"]
        .as_array()
        .expect("slots")
        .iter()
        .any(|slot| slot["path"] == json!(["table"])));
    assert_eq!(
        interim_template(&plan, "found"),
        "pick(output built/, choice [argument key : value], body derive(by build) { [argument n : value] })"
    );
    assert_eq!(
        interim_template(&plan, "member"),
        "select([argument key : value] ? [argument n : identity] | [argument m : identity] | const)"
    );
    // "Every `pick` node has a choice point of its own".
    assert_eq!(
        plan["picks"],
        json!([{ "chosenBy": "valueCode" }, { "chosenBy": "valueCode" }])
    );
}

const FOLDS: &str = r#"import { pattern } from "commonfabric";
interface Item { title: string; done: boolean; tags: string[] }
export const P = pattern<{ items: Item[] }>(({ items }) => {
  const titles = items.map((item) => item.title);
  const open = items.filter((item) => !item.done);
  const tags = items.flatMap((item) => item.tags);
  const any = items.some((item) => item.done);
  const first = items.find((item) => item.done);
  const numbered = items.map((item, index) => index + 1);
  return { titles, open, tags, any, first, numbered };
});
"#;

fn collection_named<'p>(plan: &'p Value, name: &str) -> &'p Value {
    plan["collections"]
        .as_array()
        .expect("collections")
        .iter()
        .find(|collection| collection["name"] == name)
        .unwrap_or_else(|| panic!("no collection {name}"))
}

#[test]
fn the_membership_of_a_map_a_filter_and_a_flat_map_are_the_templates_of_pl_sections_3_6_and_3_7() {
    let plan = plan_of(&program(FOLDS), "P");
    let enumeration = "[argument items : enumeration]";
    // §3.6: "For a `map` over an input collection, the `enumeration` slot
    // of that collection."
    assert_eq!(
        template_line(&plan, &collection_named(&plan, "titles")["membership"]),
        enumeration
    );
    // §3.7: "`fold` over the source with body the template of `pred`,
    // joined with the source's membership."
    assert_eq!(
        template_line(&plan, &collection_named(&plan, "open")["membership"]),
        "fold(open: derive(expression) { [element done : value] })"
    );
    // §3.7: "`fold` over the source with body the `enumeration` of the
    // segment `body` returns, joined with the source's membership."
    assert_eq!(
        template_line(&plan, &collection_named(&plan, "tags")["membership"]),
        "fold(tags: [element tags : enumeration])"
    );
    // §1.4: the assembled entry's "`template` is the collection's
    // membership template", and a per-element entry's "`path` has `*` at
    // the position of each enclosing collection ... its `template` is
    // over `element` slots."
    let outputs = plan["outputs"].as_array().expect("outputs");
    let at = |path: Value| {
        outputs
            .iter()
            .find(|output| output["path"] == path)
            .unwrap_or_else(|| panic!("no output at {path}"))
    };
    assert_eq!(
        template_line(&plan, &at(json!(["titles"]))["template"]),
        enumeration
    );
    assert_eq!(
        template_line(&plan, &at(json!(["titles", "*"]))["template"]),
        "[element title : identity]"
    );
    assert!(at(json!(["titles", "*"])).get("collection").is_none());
    // §3.7: "An element of the result is the source element, passed
    // through: `slot` templates over the source's `element` root".
    assert_eq!(
        template_line(&plan, &at(json!(["open", "*"]))["template"]),
        "[element  : identity]"
    );
    // §3.6: "A body that uses the index adds the collection's
    // `enumeration` to its element template".
    assert_eq!(
        template_line(&plan, &at(json!(["numbered", "*"]))["template"]),
        format!("derive(expression) {{ {enumeration} const }}")
    );
}

#[test]
fn a_scan_is_a_fold_through_the_deciding_element_and_find_is_a_pick() {
    // PL §3.13: "`some` is a `fold` of the predicate's template through
    // the first truthy element ... Each is joined with the collection's
    // membership." "`xs.find((x) => pred)`. `pick` over the collection.
    // The choice is the `fold` through the first match, joined with
    // membership; the body is the matching element, passed through".
    let plan = plan_of(&program(FOLDS), "P");
    let any = &output_named(&plan, "any")["template"];
    assert_eq!(
        template_line(&plan, any),
        "fold(any through: [element done : value])"
    );
    let through = any["through"].as_u64().expect("through") as usize;
    assert_eq!(plan["selectors"][through], json!({ "arity": 0 }));
    let first = &output_named(&plan, "first")["template"];
    assert_eq!(
        template_line(&plan, first),
        "pick(collection first, choice fold(first through: [element done : value]), body [element  : identity])"
    );
    assert_eq!(
        plan["picks"][first["pick"].as_u64().unwrap() as usize],
        json!({ "chosenBy": "runtime" })
    );
}

#[test]
fn the_templates_of_a_row_are_those_of_pl_section_6_2() {
    let analysis = fabrichat();
    let plan = pattern_plan(&analysis, "FabriChatMessageRow");
    let message = "[argument message : shape]";
    // "T_text = derive(by B3) [ m0 m1 m2 m4 ]". The row is a plan of its
    // own, so the slots are at `argument message`, and `m1` is not among
    // them (SPEC-NOTES 114).
    assert_eq!(
        interim_template(&plan, "text"),
        format!("derive(by bodyText#1) {{ {message} [argument message/authorProfile : shape, inPlace] [argument message/body : value] }}")
    );
    // "T_isSet = derive(expression) [ m0 m1 m5 ]", "T_edited = select(
    // condition: T_isSet, branches: [ derive(expression) [ m3 ], T_isSet
    // ] )", with `m5` at `editedAt : shape` and `m3` at `body : shape`.
    let is_set = format!("derive(expression) {{ {message} [argument message/editedAt : shape] }}");
    assert_eq!(
        interim_template(&plan, "isEdited"),
        format!("select({is_set} ? derive(expression) {{ [argument message/body : shape] }} | {is_set})")
    );
    // "T_key = derive(by B4) [ m6 ]", "T_place = pick( p0, from: output
    // facts.places, choice: T_key, body: T_facts )", "T_repl = select(
    // condition: T_place, branches: [ T_place, const ] )". In the row's
    // own plan `places` is a slot, so the pick is over a container slot
    // and its choice joins the `shape` of the chosen child (§3.18).
    // "`T_repl` leaves out the guard on a missing key, which is one more
    // `select` on `T_key`": the crate has it.
    let key = "derive(by viewKeyOf#1) { [argument message : identity, resolved] }";
    let place = format!("pick(container [argument places/* : shape], choice derive(expression) {{ {key} [argument places/* : shape] }}, body [argument places/* : value])");
    let guarded = format!("select(derive(expression) {{ {key} }} ? const | {place})");
    let replies = format!("select({guarded} ? {guarded} | const)");
    assert_eq!(interim_template(&plan, "replies"), replies);
    // "T_label = select( condition: derive(expression) [ T_repl, const
    // ], branches: [ const, derive(expression) [ T_repl ] ] )". "A
    // template literal is a `derive` over the templates of its
    // substitutions (section 3.19), and its text is no operand", and
    // the condition "is an operator with two operands, one of them a
    // constant, so it has the `const` node".
    assert_eq!(
        interim_template(&plan, "threadLabel"),
        format!("select(derive(expression) {{ {replies} const }} ? const | derive(expression) {{ {replies} }})")
    );
    // "`p0` is the pick's choice point": the pick of `replies` names it,
    // and its cone lists it.
    let template = &output_named(&plan, "replies")["template"];
    let pick = &template["condition"]["branches"][1];
    assert_eq!(pick["op"], "pick");
    assert_eq!(
        plan["picks"][pick["pick"].as_u64().unwrap() as usize],
        json!({ "chosenBy": "valueCode" })
    );
}

#[test]
fn the_templates_of_the_room_are_those_of_pl_section_6_2() {
    let analysis = fabrichat();
    let plan = pattern_plan(&analysis, "FabriChatRoomCore");
    // "T_send = derive(by B0) [ e0 ... b4 dynamic(handle B0.h0) ...
    // dynamic(handle B0.h3) dynamic(link through b2) ]", and "`T_send`
    // has three further `dynamic` nodes of kind `link`, through `e3`,
    // `e5` and `e6`."
    let send = body_index(&plan, "commitSend");
    let body = &plan["bodies"][send];
    let write = &body["writes"][0];
    let template = &write["template"];
    assert_eq!(template["by"], json!({ "body": send }));
    let inputs = template["inputs"].as_array().expect("inputs");
    let slots: Vec<&Value> = inputs
        .iter()
        .filter(|input| input["op"] == "slot")
        .collect();
    assert_eq!(slots.len(), body["reads"].as_array().expect("reads").len());
    let dynamic: Vec<String> = inputs
        .iter()
        .filter(|input| input["op"] == "dynamic")
        .map(|input| {
            let why = &plan["dynamicReads"][input["reads"].as_u64().unwrap() as usize]["why"];
            match why["kind"].as_str() {
                Some("handle") => format!("handle h{}", why["handle"]),
                Some("link") => format!("link through [{}]", slot_line(&plan, &why["through"])),
                other => panic!("an unexpected dynamic read {other:?}"),
            }
        })
        .collect();
    assert_eq!(
        dynamic,
        [
            "handle h0",
            "handle h1",
            "handle h2",
            "handle h3",
            "link through [event attachments/* : identity]",
            "link through [event replyTo/quotes : identity]",
            "link through [event replyTo/thread : identity]",
            "link through [binding messages : identity]",
        ]
    );
    // "w0 handle b2 * T_send", "w3 created n0 T_send", "w4 handle b3 *
    // T_send", "w5 handle b4 T_send": every write edge of the body has
    // the body's template, and for a reference edge it "applies where
    // the check fails" (§1.1, `WriteEdge.template`).
    for write in body["writes"].as_array().expect("writes") {
        assert_eq!(&write["template"], template);
    }
    // "c1 = collection source: output facts.main membership: T_facts".
    let main = plan["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .position(|output| output["interim"] == "facts" && output["path"] == json!(["main"]))
        .expect("the output facts.main");
    let c1 = plan["collections"]
        .as_array()
        .expect("collections")
        .iter()
        .find(|collection| collection["source"] == json!({ "output": main }))
        .expect("c1");
    assert_eq!(c1["membership"], plan["outputs"][main]["template"]);
    assert_eq!(
        c1["membership"]["by"],
        json!({ "body": body_index(&plan, "messageFacts") })
    );
}

#[test]
fn a_write_edge_an_operation_and_a_binding_made_in_a_body_have_their_templates() {
    // PL §3.11: "The label of the written value is the edge's template
    // ... the body's template when a sandboxed body performs the write."
    // §1.1, `Operation.input`: "for an effect, the join of the templates
    // of its request". §3.14: a scalar copied into a binding has `T_b`.
    let analysis = program(
        r#"import { Cell, fetchJson, handler, pattern } from "commonfabric";
const inc = handler<{ by: number }, { count: Cell<number>; step: number }>((event, state) => {
  state.count.set(state.count.get() + event.by * state.step);
});
const make = handler<{ n: number }, { count: Cell<number>; out: Cell<unknown> }>((event, state) => {
  state.out.set(inc({ count: state.count, step: event.n }));
});
export const P = pattern<{ count: Cell<number>; out: Cell<unknown>; url: string }>(({ count, out, url }) => {
  const data = fetchJson({ url, mode: "json" });
  return { maker: make({ count, out }), data };
});
"#,
    );
    let plan = plan_of(&analysis, "P");
    let make = body_index(&plan, "make");
    let t_make =
        "derive(by make) { [event n : value] [binding count : identity] [binding out : identity] }";
    let body = &plan["bodies"][make];
    assert_eq!(template_line(&plan, &body["writes"][0]["template"]), t_make);
    let binding = &plan["bindings"][body["calls"][0]["binding"].as_u64().unwrap() as usize];
    for entry in binding["state"].as_array().expect("state") {
        assert_eq!(template_line(&plan, &entry["template"]), t_make);
    }
    // The request of the effect: one write edge per path, each with the
    // template of what is written there, and the operation's input is
    // their join.
    let cone = plan["cones"]
        .as_array()
        .expect("cones")
        .iter()
        .find(|cone| cone["entry"] == "data")
        .expect("the cone of the request");
    let writes: Vec<String> = cone["writes"]
        .as_array()
        .expect("writes")
        .iter()
        .map(|write| {
            format!(
                "{} {}",
                write["target"]["path"][0].as_str().unwrap(),
                template_line(&plan, &write["template"])
            )
        })
        .collect();
    assert_eq!(writes, ["mode const", "url [argument url : identity]"]);
    assert_eq!(
        template_line(&plan, &plan["operations"][0]["input"]),
        "[argument url : identity]"
    );
}

const WISHES: &str = r##"import { pattern, wish } from "commonfabric";
export const Wishes = pattern<{ tag: string; where: string }>(({ tag, where }) => {
  const fav = wish<{ title: string }>({ query: "#favorites" });
  const me = wish<{ name: string }>({ query: "#profile" });
  const quiet = wish<{ name: string }>({ query: "#profile", headless: true });
  const now = wish<number>({ query: "#now" });
  const tick = wish<number>({ query: "#now/5" });
  const note = wish<{ name: string }>({ query: "#note", scope: ["."] });
  const person = wish<{ name: string }>({ query: "#person", scope: [".", "~"] });
  const local = wish<{ name: string }>({ query: "/a/b", path: [where] });
  const face = wish<string>({ query: "#profilePicture" });
  const any = wish<{ name: string }>({ query: tag });
  return { title: fav.result.title, name: note.result.name, any: any.result };
});
"##;

fn operation_named<'p>(plan: &'p Value, name: &str) -> (usize, &'p Value) {
    plan["operations"]
        .as_array()
        .expect("operations")
        .iter()
        .enumerate()
        .find(|(_, operation)| operation["name"] == json!(name))
        .unwrap_or_else(|| panic!("no operation named {name}"))
}

fn names_of(plan: &Value, table: &str) -> Vec<String> {
    plan[table]
        .as_array()
        .expect("a table")
        .iter()
        .map(|record| record["name"].as_str().expect("a name").to_string())
        .collect()
}

#[test]
fn a_wish_is_one_operation_whose_operands_are_request_edges_and_whose_reads_are_one_search_entry() {
    // PL §3.19, "`wish`": "An `Operation` of kind `wish`, with
    // `implementation: { builtin: "wish" }`", the operands written "by a
    // `WriteEdge` with target `request`, at the path of the operand's
    // name", "`Operation.input` is the join of those templates, and it is
    // `const` for a call whose operands are all constants", and "one entry
    // of `Plan.dynamicReads` of kind `search` that names the operation".
    let plan = plan_of(&program(WISHES), "Wishes");
    let (fav, operation) = operation_named(&plan, "fav");
    assert_eq!(operation["kind"], json!("wish"));
    assert_eq!(operation["implementation"], json!({ "builtin": "wish" }));
    assert_eq!(operation["input"], json!({ "op": "const" }));
    let writes: Vec<&Value> = plan["cones"]
        .as_array()
        .expect("cones")
        .iter()
        .flat_map(|cone| cone["writes"].as_array().expect("writes"))
        .filter(|write| write["target"]["of"] == json!({ "operation": fav }))
        .collect();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0]["target"]["kind"], json!("request"));
    assert_eq!(writes[0]["target"]["path"], json!(["query"]));
    assert_eq!(writes[0]["template"], json!({ "op": "const" }));
    let searches: Vec<&Value> = plan["dynamicReads"]
        .as_array()
        .expect("dynamic reads")
        .iter()
        .filter(|read| read["why"]["kind"] == json!("search"))
        .collect();
    assert_eq!(searches.len(), 10, "one entry for each wish");
    assert!(searches.contains(&&json!({ "why": { "kind": "search", "operation": fav } })));
    // An operand that is not a constant has its template, and the input
    // is the join.
    let (_, local) = operation_named(&plan, "local");
    assert_eq!(
        template_line(&plan, &local["input"]),
        "[argument where : identity]"
    );
    // "A reader has slots with root `operation` at the paths it reads,
    // and its template has the `slot` nodes."
    let title = plan["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .find(|output| output["path"] == json!(["title"]))
        .expect("the output title");
    assert_eq!(
        template_line(&plan, &title["template"]),
        "[operation result/title : identity]"
    );
}

#[test]
fn a_constant_query_decides_the_scope_and_the_records_beside_the_operation() {
    // The table of PL §3.19 from the constant query to its part.
    let plan = plan_of(&program(WISHES), "Wishes");
    let scope = |name: &str| operation_named(&plan, name).1.get("scope").cloned();
    // A well-known target of the home space.
    assert_eq!(scope("fav"), Some(json!("user")));
    assert_eq!(scope("me"), Some(json!("user")));
    // The clocks and a path of the current space have the scope of the
    // cone instance.
    assert_eq!(scope("now"), None);
    assert_eq!(scope("tick"), None);
    assert_eq!(scope("local"), None);
    assert_eq!(scope("face"), None);
    // "`user` unless the `scope` operand is a constant that names neither
    // `"~"` nor `"profile"`".
    assert_eq!(scope("note"), None);
    assert_eq!(scope("person"), Some(json!("user")));
    // "A query that is not a constant ... `Operation.scope` is `user`,
    // and the plan has the `StateCell` of the one-shot clock and a `Child`
    // for each of the three sidecars".
    assert_eq!(scope("any"), Some(json!("user")));
    assert_eq!(names_of(&plan, "stateCells"), ["now/now", "any/now"]);
    assert_eq!(
        names_of(&plan, "children"),
        [
            // "For a profile target without `headless: true`, a `Child`
            // for each of the two profile sidecars".
            "me/profileCreate",
            "me/profilePicker",
            // "Without `headless: true`, a `Child` for the suggestion
            // sidecar".
            "note/suggestion",
            "person/suggestion",
            "any/suggestion",
            "any/profileCreate",
            "any/profilePicker",
        ]
    );
}

const REDUCE: &str = r#"import { pattern } from "commonfabric";
interface Row { amount: number; done: boolean }
export const Sum = pattern<{ rows: Row[]; start: number }>(({ rows, start }) => {
  const total = rows.reduce((sum: number, row: Row) => sum + row.amount, start);
  const any = rows.some((row) => row.done);
  return { total, any };
});
"#;

#[test]
fn a_reduce_is_an_operation_whose_step_is_a_cone_over_a_collection_of_its_own() {
    // PL §3.13, "The record" of `reduce`.
    let plan = plan_of(&program(REDUCE), "Sum");
    let (index, operation) = operation_named(&plan, "total");
    assert_eq!(operation["kind"], json!("reduce"));
    // "The `reduce` has a `Collection` of its own, named `reduce`, whose
    // source is the receiver".
    let collection = collection_named(&plan, "reduce");
    assert_eq!(
        slot_line(&plan, &collection["source"]["slot"]),
        "argument rows : enumeration"
    );
    assert_eq!(collection["bodyUses"], json!({ "index": false }));
    // "The step is emitted as one cone, and `Operation.implementation`
    // is `{ cone }` with that cone."
    let cone = &plan["cones"][operation["implementation"]["cone"]
        .as_u64()
        .expect("a cone") as usize];
    let slots: Vec<String> = cone["slots"]
        .as_array()
        .expect("slots")
        .iter()
        .map(|slot| slot_line(&plan, slot))
        .collect();
    // "The step cone reads the accumulator through a slot with root
    // `operation` that names the `reduce` itself, at the empty path. ...
    // The slot is in `Cone.slots`".
    assert_eq!(slots, ["operation  : value", "element amount : value"]);
    let accumulator = cone["slots"][0].as_u64().expect("a slot") as usize;
    assert_eq!(
        plan["slots"][accumulator]["root"],
        json!({ "kind": "operation", "operation": index })
    );
    // "The step's result is an output of the step cone whose path has
    // `*`. Its template is the template of `expr`", and "the step's
    // template has `const` where the expression reads it".
    let step = plan["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .find(|output| output["interim"] == json!("total") && output["path"] == json!(["*"]))
        .expect("the output of the step");
    assert_eq!(
        template_line(&plan, &step["template"]),
        "derive(expression) { const [element amount : value] }"
    );
    // "The cone the `reduce` is written in computes `init` and writes it
    // into the operation's state by a `WriteEdge` with target `request`,
    // at the path `initial`, with the template of `init`."
    let writes: Vec<&Value> = plan["cones"]
        .as_array()
        .expect("cones")
        .iter()
        .flat_map(|cone| cone["writes"].as_array().expect("writes"))
        .collect();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0]["target"],
        json!({ "kind": "request", "of": { "operation": index }, "path": ["initial"] })
    );
    assert_eq!(
        template_line(&plan, &writes[0]["template"]),
        "[argument start : identity]"
    );
    // "`Operation.input` is the `fold` over the collection of the step's
    // template, joined with the template of `init`", and with the
    // collection's membership.
    assert_eq!(
        template_line(&plan, &operation["input"]),
        "derive(expression) { fold(reduce: derive(expression) { const [element amount : value] }) [argument start : identity] }"
    );
    // "A cone that uses it reads a slot with root `operation`."
    let total = plan["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .find(|output| output["path"] == json!(["total"]))
        .expect("the output total");
    assert_eq!(
        template_line(&plan, &total["template"]),
        "[operation  : identity]"
    );
}

#[test]
fn what_the_predicate_of_a_scan_returns_is_an_output_whose_path_has_a_star() {
    // PL §3.13, "The record of a scan": "What the callback returns is an
    // output whose path has `*`", beside the result, which "is an
    // `Output` with the member `collection`".
    let plan = plan_of(&program(REDUCE), "Sum");
    let outputs = plan["outputs"].as_array().expect("outputs");
    let predicate = outputs
        .iter()
        .find(|output| output["path"] == json!(["any", "*"]))
        .expect("the output of the predicate");
    assert_eq!(
        template_line(&plan, &predicate["template"]),
        "[element done : value]"
    );
    assert!(predicate.get("collection").is_none());
    let result = outputs
        .iter()
        .find(|output| output["path"] == json!(["any"]))
        .expect("the result of the scan");
    assert!(result.get("collection").is_some());
}

const LITERALS: &str = r#"import { cellFromUrl, pattern, SqliteDb } from "commonfabric";
interface Base { id: string; note?: string; kind: string }
export const Lit = pattern<{ base: Base; extra: string[]; more: string[]; label: string; db: SqliteDb; address: string }>(
  ({ base, extra, more, label, db, address }) => {
    const merged = { note: label, kind: label, ...base, id: label };
    const list = [label, ...extra, label, ...more];
    const holed = [label, , label];
    const keyed = { ["fixed"]: label };
    const linked = cellFromUrl({ url: address });
    const rows = db.query<{ n: number }>("select 1", { params: [label] });
    return {
      id: merged.id, note: merged.note, kind: merged.kind,
      head: list[0], rest: list,
      holed,
      fixed: keyed.fixed,
      cell: linked.cell,
      rows: rows.result,
    };
  },
);
"#;

fn kept<'p>(plan: &'p Value, path: Value) -> &'p Value {
    plan["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .find(|output| output["path"] == path)
        .unwrap_or_else(|| panic!("no output at {path}"))
}

#[test]
fn a_spread_in_an_object_literal_has_the_template_of_each_path_its_type_declares() {
    // PL §3.4, "A spread in an object literal".
    let plan = plan_of(&program(LITERALS), "Lit");
    // "A member written after the spread replaces the path."
    assert_eq!(
        template_line(&plan, &kept(&plan, json!(["id"]))["template"]),
        "[argument label : identity]"
    );
    // "A member written before the spread is replaced where the type of
    // `a` declares its path as required": "the template is the `slot`
    // node of the reference at `a.p`".
    assert_eq!(
        template_line(&plan, &kept(&plan, json!(["kind"]))["template"]),
        "[argument base/kind : identity]"
    );
    // "Where the type declares the path as optional ... the path is a
    // `select` whose condition is the `shape` of `a.p`."
    assert_eq!(
        template_line(&plan, &kept(&plan, json!(["note"]))["template"]),
        "select([argument base/note : shape] ? [argument base/note : identity] | [argument label : identity])"
    );
}

#[test]
fn a_spread_in_an_array_literal_puts_every_later_position_at_the_path_star() {
    // PL §3.4, "A spread in an array literal": "A member written before
    // the first spread has its own path and the template of its
    // expression", and "every position from the first spread on is at
    // the path `*`, and the template there is the join of the template
    // of each spread operand at `*`, of the templates of the members
    // written after the first spread, and of the array's `enumeration`",
    // which "is `derive` by expression code over the `enumeration` of
    // each spread operand".
    let plan = plan_of(&program(LITERALS), "Lit");
    assert_eq!(
        template_line(&plan, &kept(&plan, json!(["head"]))["template"]),
        "[argument label : identity]"
    );
    assert_eq!(
        template_line(&plan, &kept(&plan, json!(["rest", "*"]))["template"]),
        "derive(expression) { [argument extra/* : identity] [argument label : identity] [argument more/* : identity] derive(expression) { [argument extra : enumeration] [argument more : enumeration] } }"
    );
    // "A hole ... The position of the hole holds nothing, has no
    // template".
    let paths: Vec<&Value> = plan["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .map(|output| &output["path"])
        .filter(|path| path[0] == json!("holed"))
        .collect();
    assert_eq!(paths, [&json!(["holed", "0"]), &json!(["holed", "2"])]);
    // "A key that is static ... is the name it evaluates to."
    assert_eq!(
        template_line(&plan, &kept(&plan, json!(["fixed"]))["template"]),
        "[argument label : identity]"
    );
}

#[test]
fn cell_from_url_and_a_query_on_a_database_are_operations_of_kind_effect() {
    // PL §3.19, "`cellFromUrl`": "one `Operation` of kind `effect` with
    // `implementation: { builtin: "cellFromUrl" }`. A cone writes `url`,
    // `hosts` and `spaceHost` into its state by write edges with target
    // `request`, and a reader reads `pending` and `cell` through slots
    // with root `operation`."
    let plan = plan_of(&program(LITERALS), "Lit");
    let (index, linked) = operation_named(&plan, "linked");
    assert_eq!(linked["kind"], json!("effect"));
    assert_eq!(
        linked["implementation"],
        json!({ "builtin": "cellFromUrl" })
    );
    assert_eq!(
        template_line(&plan, &linked["input"]),
        "[argument address : identity]"
    );
    let cell = kept(&plan, json!(["cell"]));
    assert_eq!(
        template_line(&plan, &cell["template"]),
        "[operation cell : identity]"
    );
    assert_eq!(
        plan["slots"][cell["template"]["slot"].as_u64().unwrap() as usize]["root"],
        json!({ "kind": "operation", "operation": index })
    );
    // PL §3.14: "`db.query(...)` holds the handle by value as an operand
    // of a `sqliteQuery` request".
    let (rows, operation) = operation_named(&plan, "rows");
    assert_eq!(
        operation["implementation"],
        json!({ "builtin": "sqliteQuery" })
    );
    let mut paths: Vec<String> = plan["cones"]
        .as_array()
        .expect("cones")
        .iter()
        .flat_map(|cone| cone["writes"].as_array().expect("writes"))
        .filter(|write| write["target"]["of"] == json!({ "operation": rows }))
        .map(|write| {
            format!(
                "{} = {}",
                write["target"]["path"],
                template_line(&plan, &write["template"])
            )
        })
        .collect();
    paths.sort();
    assert_eq!(
        paths,
        [
            "[\"db\"] = [argument db : value]",
            "[\"params\",\"0\"] = [argument label : identity]",
            "[\"sql\"] = const",
        ]
    );
}

const TAGS: &str = r#"import { PatternFactory, Writable, pattern, UI } from "commonfabric";
interface Message { body: string }
const Row = pattern<{ message: Message; tone: string }>(({ message, tone }) => {
  const open = Writable.of(false);
  const shout = message.body + tone;
  return { [UI]: <span>{shout}</span>, shout };
});
export const Room = pattern<{ messages: Message[]; tone: string; View: PatternFactory<{ text: string }, unknown> }>(
  ({ messages, tone, View }) => {
    return {
      [UI]: <div>
        {messages.map((message) => <Row message={message} tone={tone} />)}
        <View text={tone} />
      </div>,
    };
  },
);
"#;

#[test]
fn a_tag_that_names_a_visible_pattern_is_compiled_in_under_a_site_step() {
    // PL §1.1: "A JSX tag that names a pattern is such a call ... Where
    // the tag names a pattern the compiler can see, the pattern is
    // compiled into the enclosing plan under a `site` step, and its
    // attributes are the paths of its argument". §6.2: "what it declares
    // has the `within` steps `{ element: c1 }` and
    // `{ site: FabriChatMessageRow }`, and its argument path `message` is
    // the element, which is why `m0` to `m6` have the root `element`."
    let plan = plan_of(&program(TAGS), "Room");
    let row = collection_named(&plan, "map");
    let collection = plan["collections"]
        .as_array()
        .expect("collections")
        .iter()
        .position(|other| other == row)
        .expect("the collection");
    assert_eq!(
        plan["stateCells"],
        json!([{
            "name": "open",
            "scope": "space",
            "within": [{ "element": collection }, { "site": "Row" }],
        }])
    );
    assert_eq!(
        interim_template(&plan, "shout"),
        "derive(expression) { [element body : value] [argument tone : value] }"
    );
}

#[test]
fn a_tag_that_names_a_factory_value_is_a_child() {
    // PL §1.1: "Where the tag names a factory value, the instantiation
    // is a `Child`", whose callee is "a factory value, named by its
    // `identity` slot".
    let plan = plan_of(&program(TAGS), "Room");
    let children = plan["children"].as_array().expect("children");
    assert_eq!(children.len(), 1);
    assert_eq!(children[0]["name"], json!("View"));
    assert_eq!(children[0]["within"], json!([]));
    assert_eq!(
        slot_line(&plan, &children[0]["callee"]["factory"]["slot"]),
        "argument View : identity"
    );
    // Its argument is the write edges with target `argument`.
    let writes: Vec<&Value> = plan["cones"]
        .as_array()
        .expect("cones")
        .iter()
        .flat_map(|cone| cone["writes"].as_array().expect("writes"))
        .filter(|write| write["target"]["kind"] == json!("argument"))
        .collect();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0]["target"],
        json!({ "kind": "argument", "child": 0, "path": ["text"] })
    );
    assert_eq!(
        template_line(&plan, &writes[0]["template"]),
        "[argument tone : identity]"
    );
}

#[test]
fn a_collection_names_its_construct_and_a_bound_index_names_the_collection() {
    // PL §1.1: `Collection.construct` "says what the runtime does with
    // the per-element results", and `Binding.state.place` is "the index
    // of the element in the collection of an enclosing element body",
    // with "for an index the membership that collection iterates" as
    // its template. "A path bound to `undefined` has no entry of
    // `state`."
    let analysis = program(
        r#"import { Cell, handler, pattern, UI } from "commonfabric";
const pickRow = handler<unknown, { at: number; chosen: Cell<number>; note?: string }>((_, state) => { state.chosen.set(state.at); });
export const P = pattern<{ rows: string[]; chosen: Cell<number> }>(({ rows, chosen }) => {
  const shown = rows.filter((row) => row !== "");
  const any = rows.some((row) => row === "x");
  const total = rows.reduce((sum, row) => sum + row.length, 0);
  return {
    [UI]: <ul>{rows.map((row, index) => <li onClick={pickRow({ at: index, chosen, note: undefined })}>{row}</li>)}</ul>,
    shown, any, total,
  };
});
"#,
    );
    let plan = plan_of(&analysis, "P");
    let constructs: Vec<&str> = plan["collections"]
        .as_array()
        .expect("collections")
        .iter()
        .map(|collection| collection["construct"].as_str().expect("a construct"))
        .collect();
    assert_eq!(constructs, ["filter", "some", "operation", "map"]);
    let state = plan["bindings"][0]["state"].as_array().expect("state");
    let paths: Vec<&Value> = state.iter().map(|entry| &entry["path"]).collect();
    assert_eq!(paths, [&json!(["at"]), &json!(["chosen"])]);
    assert_eq!(state[0]["place"], json!({ "index": 3 }));
    assert_eq!(state[0]["template"], plan["collections"][3]["membership"]);
}

#[test]
fn a_join_with_a_constant_or_with_itself_is_the_other_template_alone() {
    // PL §3.2, "A join": "A join with `const` is the other template
    // alone. A join of one template with itself is that template. A
    // `fold` joins the membership its collection iterates by its own
    // rule".
    let analysis = program(
        r#"import { fetchJson, pattern } from "commonfabric";
export const P = pattern<{ rows: string[]; url: string }>(({ rows, url }) => {
  const total = rows.reduce((sum, row) => sum + row.length, 0);
  const quote = fetchJson({ url, mode: "json" });
  const twice = fetchJson({ url, again: url });
  return { total, quote, twice };
});
"#,
    );
    let plan = plan_of(&analysis, "P");
    assert_eq!(
        template_line(&plan, &operation_named(&plan, "total").1["input"]),
        "fold(reduce: derive(expression) { const [element  : value] })"
    );
    assert_eq!(
        template_line(&plan, &operation_named(&plan, "quote").1["input"]),
        "[argument url : identity]"
    );
    assert_eq!(
        template_line(&plan, &operation_named(&plan, "twice").1["input"]),
        "[argument url : identity]"
    );
}

#[test]
fn each_declaration_of_an_element_callback_that_computes_is_a_cone() {
    // PL §1.4, "The cones of an element body": "Each `const` declaration
    // of the callback whose initializer computes is one cone, whose
    // `entry` is the declaration's name. ... A declaration whose
    // initializer only names a slot ... has no cone. The expression the
    // callback returns is one cone ... Its `entry` is the name of the
    // collection", and it is listed last.
    let analysis = program(
        r#"import { pattern } from "commonfabric";
export const P = pattern<{ rows: { title: string; n: number }[] }>(({ rows }) => {
  const lines = rows.map((row) => {
    const upper = row.title + "!";
    const double = row.n * 2;
    const name = row.title;
    return upper + double + name;
  });
  const plain = rows.map((row) => row.title);
  return { lines, plain };
});
"#,
    );
    let plan = plan_of(&analysis, "P");
    let entries: Vec<&str> = plan["cones"]
        .as_array()
        .expect("cones")
        .iter()
        .map(|cone| cone["entry"].as_str().expect("an entry"))
        .collect();
    assert_eq!(entries, ["upper", "double", "lines", "plain"]);
    assert_eq!(cone_slots(&plan, "upper"), ["element title : value"]);
    assert_eq!(cone_slots(&plan, "double"), ["element n : value"]);
    assert_eq!(cone_slots(&plan, "lines"), ["element title : value"]);
    assert_eq!(output_named(&plan, "upper")["cone"], 0);
    assert_eq!(output_named(&plan, "upper")["kept"], false);
    let outputs = plan["outputs"].as_array().expect("outputs");
    let element = outputs
        .iter()
        .find(|output| output["path"] == json!(["lines", "*"]))
        .expect("the per-element entry");
    assert_eq!(element["cone"], 2);
    assert_eq!(
        template_line(&plan, &element["template"]),
        "derive(expression) { derive(expression) { derive(expression) { [element title : value] const } derive(expression) { [element n : value] const } } [element title : value] }"
    );
    assert_eq!(output_named(&plan, "lines")["cone"], 2);
    let edges: Vec<String> = plan["edges"]
        .as_array()
        .expect("edges")
        .iter()
        .map(|edge| {
            let output = edge["via"]["output"].as_u64().expect("an output") as usize;
            format!(
                "{} -> {} {}",
                edge["from"],
                edge["to"],
                plan["outputs"][output]["interim"].as_str().unwrap_or("")
            )
        })
        .collect();
    assert_eq!(edges, ["0 -> 2 upper", "1 -> 2 double"]);
}

/// The outputs at and below a path, each as `path = template`.
fn entries_below(plan: &Value, first: &str) -> Vec<String> {
    plan["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .filter(|output| output["path"][0] == first || output["interim"] == first)
        .map(|output| {
            let path: Vec<&str> = output["path"]
                .as_array()
                .expect("a path")
                .iter()
                .map(|segment| segment.as_str().expect("a segment"))
                .collect();
            let template = match output.get("template") {
                Some(template) => template_line(plan, template),
                None => "none".to_string(),
            };
            format!("{} = {}", path.join("/"), template)
        })
        .collect()
}

#[test]
fn a_constructed_value_has_a_container_entry_and_an_entry_per_member_that_computes() {
    // PL §3.4, "The entries of a constructed value" and "A node whose
    // result is a constructed value": "For `c ? { x: a } : { x: b, y: d }`
    // the path `x` has `select(c, [a, b])`, the path `y` has
    // `select(c, [const, d])`, and the container entry has
    // `select(c, [const, const])`."
    let analysis = program(
        r#"import { pattern } from "commonfabric";
export const P = pattern<{ c: boolean; a: string; b: string; d: string; rows: { title: string; n: number }[] }>(({ c, a, b, d, rows }) => {
  const v = c ? { x: a } : { x: b, y: d };
  const out = rows.map((row) => ({ name: row.title, n: row.n + 1, fixed: 1 }));
  return { v, out };
});
"#,
    );
    let plan = plan_of(&analysis, "P");
    let c = "[argument c : value]";
    assert_eq!(
        entries_below(&plan, "v"),
        [
            format!("v = select({c} ? const | const)"),
            format!("v/x = select({c} ? [argument a : identity] | [argument b : identity])"),
            format!("v/y = select({c} ? const | [argument d : identity])"),
        ]
    );
    assert_eq!(
        entries_below(&plan, "out"),
        [
            "out = [argument rows : enumeration]",
            "out/* = const",
            "out/*/n = derive(expression) { [element n : value] const }",
            "out/*/name = [element title : identity]",
        ]
    );
}

#[test]
fn a_rendered_tree_has_the_paths_of_its_view_nodes() {
    // PL §3.4, "A JSX element": "the template of the path `props/title`
    // of an element is the template of the expression written at the
    // attribute `title`, and the template of `children/0` is that of the
    // first child. A child whose type is an array, the assembled result
    // of a `map` among them, is a spread child".
    let analysis = program(
        r#"import { pattern, UI } from "commonfabric";
export const P = pattern<{ t: string; a: string; b: string; rows: { title: string }[] }>(({ t, a, b, rows }) => {
  return {
    [UI]: (
      <div title={t} class="box">
        {a}
        <span>{b}</span>
        {rows.map((row) => <li>{row.title}</li>)}
        <hr />
      </div>
    ),
  };
});
"#,
    );
    let plan = plan_of(&analysis, "P");
    assert_eq!(
        entries_below(&plan, "$UI"),
        [
            "$UI = const",
            "$UI/children = derive(expression) { [element title : identity] [argument rows : enumeration] }",
            "$UI/children/* = derive(expression) { [element title : identity] [argument rows : enumeration] }",
            "$UI/children/0 = [argument a : identity]",
            "$UI/children/1/children/0 = [argument b : identity]",
            "$UI/props/title = [argument t : identity]",
        ]
    );
}

#[test]
fn the_identity_slot_at_the_root_of_a_state_cell_is_no_reader_of_a_write_to_it() {
    // PL §3.11: "One slot is excepted there: the `identity` slot at the
    // cell's root, with the empty path. ... So a cone whose body writes
    // a state cell and reads nothing of it has no edge to itself. Every
    // other slot of the root is a reader by the rule".
    let analysis = program(
        r#"import { Writable, lift, pattern } from "commonfabric";
const note = lift((x: { seen: Writable<number>; n: number }) => {
  x.seen.set(x.n);
  return x.n;
});
const peek = lift((x: { seen: Writable<number> }) => x.seen.get());
export const Quiet = pattern<{ n: number }>(({ n }) => {
  const seen = new Writable(0);
  const noted = note({ seen, n });
  return { noted };
});
export const Read = pattern<{ n: number }>(({ n }) => {
  const seen = new Writable(0);
  const noted = note({ seen, n });
  const shown = peek({ seen });
  return { noted, shown };
});
"#,
    );
    assert_eq!(edge_lines(&plan_of(&analysis, "Quiet")), Vec::<String>::new());
    assert_eq!(edge_lines(&plan_of(&analysis, "Read")), ["noted -> shown"]);
    assert!(!analysis.modules[0]
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.id == "side-write:cycle"));
}

#[test]
fn the_child_slots_of_a_pick_are_at_the_path_read_below_the_chosen_child() {
    // PL §3.18: "the chosen child's slots are slots of the plan whose
    // path is the path of `a`, `*` at the position of the key, and the
    // path the surrounding expression reads below the child, each with
    // the class of that read."
    let analysis = program(
        r#"import { pattern } from "commonfabric";
export const P = pattern<{ rows: { title: string; n: number }[]; i: number }>(({ rows, i }) => {
  const label = rows[i].title + "!";
  return { label };
});
"#,
    );
    let plan = plan_of(&analysis, "P");
    assert_eq!(
        template_line(&plan, &kept(&plan, json!(["label"]))["template"]),
        "derive(expression) { pick(container [argument rows/* : shape], choice derive(expression) { [argument i : value] [argument rows/* : shape] }, body [argument rows/*/title : value]) const }"
    );
    assert_eq!(
        cone_slots(&plan, "label"),
        [
            "argument i : value",
            "argument rows/* : shape",
            "argument rows/*/title : value"
        ]
    );
}

#[test]
fn the_length_of_a_collection_is_its_membership_and_of_a_string_its_value() {
    // PL §3.8: "`count()`, `.length` | The collection's membership", the
    // `enumeration` slot at the collection and no slot at `items/length`.
    let analysis = program(
        r#"import { computed, pattern } from "commonfabric";
interface Item { title: string }
export const Counted = pattern<{ items: Item[]; name: string }>(({ items, name }) => {
  const count = computed(() => items.length);
  const some = computed(() => items.length > 0);
  const wide = computed(() => name.length);
  const opt = computed(() => items?.length);
  return { count, some, wide, opt };
});
"#,
    );
    let plan = plan_of(&analysis, "Counted");
    let line = |name: &str| template_line(&plan, &output_named(&plan, name)["template"]);
    assert_eq!(line("count"), "[argument items : enumeration]");
    assert_eq!(
        line("some"),
        "derive(expression) { [argument items : enumeration] const }"
    );
    assert_eq!(line("wide"), "[argument name : value]");
    assert_eq!(cone_slots(&plan, "count"), ["argument items : enumeration"]);
    for slot in plan["slots"].as_array().expect("slots") {
        let path = slot["path"].as_array().expect("a path");
        assert!(path.last() != Some(&json!("length")), "{slot}");
    }
}
