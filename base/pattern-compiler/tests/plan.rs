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
    // The push is a write edge at `*` of the cell behind the handle.
    assert_eq!(
        body["writes"],
        json!([{
            "target": { "kind": "handle", "slot": body["reads"][1], "path": ["*"] },
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
const copyBA = lift((x: { a: Cell<number>; b: Cell<number> }) => { x.a.set(x.b.get() + 1); return 0; });
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
    assert_eq!(cycles, [2, 3]);
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
    // optional positions ... One is at a data position, `event target`.
    // The others are in place (`inPlace`), at the positions of the
    // optional handles". The crate has one more at a data position,
    // `event attachments` (SPEC-NOTES 91).
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
    // The writes w0 to w5, as `target path [reference]`.
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
            // The "two further reference edges" the listing leaves out.
            "handle [binding messages : identity] */replyTo/quotes passes [event replyTo/quotes : identity]",
            "handle [binding messages : identity] */replyTo/thread passes [event replyTo/thread : identity]",
            // w4
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
    // "B1 function threadTitles reads s2; handles h0 slot s2". The room
    // calls `threadTitles` twice, so the use has an ordinal (§1.3). The
    // function reads `threadInfo?.get()`, which FA §7.1 makes static, so
    // the crate has a `value` slot where the listing has a handle
    // (SPEC-NOTES 104).
    let titles = body_named(&plan, "threadTitles#1");
    assert_eq!(titles["kind"], "function");
    assert_eq!(
        reads_of(&plan, titles),
        [
            "argument threadInfo : identity",
            "argument threadInfo : shape, inPlace",
            "argument threadInfo : value",
        ]
    );
    assert_eq!(titles["handles"], json!([]));
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
    // The crate has `identity` at `titles/*`, where the listing has
    // `value`: the title leaves the body in a record a helper built
    // (SPEC-NOTES 71, 104).
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
            (json!(["titles", "*"]), json!("identity")),
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
    // The crate lists the unresolved `identity` slot beside it.
    let key = body_named(&plan, "viewKeyOf#1");
    assert_eq!(key["kind"], "function");
    assert_eq!(
        reads_of(&plan, key),
        [
            "argument message : identity",
            "argument message : identity, resolved",
        ]
    );
    // "`p0` is the pick's choice point, an entry of `Plan.picks` with
    // `chosenBy: \"valueCode\"`".
    assert!(plan["picks"]
        .as_array()
        .expect("picks")
        .contains(&json!({ "chosenBy": "valueCode" })));
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
        other => panic!("an unexpected template {other:?}"),
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
    assert_eq!(shout["at"]["start"].as_u64().is_some(), true);
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
