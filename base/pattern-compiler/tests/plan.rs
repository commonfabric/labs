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
    // this way, and resolves to the slot or the output `template` names."
    let plan = plan_of(&program(LIST), "List");
    let binding = &plan["bindings"][0];
    assert_eq!(binding["handler"], json!({ "body": 2 }));
    assert_eq!(binding["name"], "addItem");
    let state = &binding["state"][0];
    assert_eq!(state["path"], json!(["items"]));
    assert_eq!(state["capture"], "link");
    assert_eq!(
        slot_line(&plan, &state["bound"]["slot"]),
        "argument items : identity"
    );
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
    assert_eq!(
        plan["outputs"][0],
        json!({ "path": ["total"], "cone": 0, "kept": true, "constraints": [] })
    );
    assert_eq!(
        plan["outputs"][1],
        json!({ "path": [], "interim": "text", "cone": 1, "kept": false, "constraints": [] })
    );
    // `label(total)`: the input is a value the instance computed, so the
    // body has an entry of `computed` and no slot (PL §3.9).
    assert_eq!(plan["bodies"][1]["reads"], json!([]));
    assert_eq!(
        plan["bodies"][1]["computed"],
        json!([{ "at": [], "observes": "value" }])
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
    assert_eq!(names, ["onClick#1", "onClick#2"]);
    // "A handler is one record however many bindings name it."
    assert_eq!(plan["bodies"].as_array().expect("bodies").len(), 1);
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
            let bound = &entry["bound"];
            let to = match bound.get("slot") {
                Some(slot) => line(slot),
                None => {
                    assert!(bound.get("binding").is_some(), "{bound}");
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
