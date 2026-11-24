//! Value-code emission (`src/emit.rs`): the JavaScript of the functions a
//! plan needs, and what the artifact holds beside the plan
//! (`execution-and-storage.md` §2.2, cited as ES).

use pattern_compiler::program::{analyze, SourceFile};
use serde_json::{json, Value};

/// The plan and the value code of the pattern `name` of one module.
fn emitted(text: &str, name: &str) -> (Value, Value) {
    pattern_compiler::emit::request(true);
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: text.to_string(),
    }]);
    pattern_compiler::emit::request(false);
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
    (
        found.plan.clone(),
        found.code.clone().expect("the value code"),
    )
}

/// The text of the one module of the value code.
fn source(code: &Value) -> String {
    assert_eq!(code["unsupported"], json!([]));
    code["modules"][0]["source"]
        .as_str()
        .expect("a source")
        .to_string()
}

/// The index of the slot with this root, path and class.
fn slot(plan: &Value, root: &str, path: &[&str], class: &str) -> usize {
    plan["slots"]
        .as_array()
        .expect("slots")
        .iter()
        .position(|slot| {
            slot["root"]["kind"] == json!(root)
                && slot["path"] == json!(path)
                && slot["observes"] == json!(class)
        })
        .unwrap_or_else(|| panic!("no slot {root} {path:?} : {class}"))
}

#[test]
fn a_name_of_the_reactive_tier_is_a_read_of_a_slot_the_cone_lists() {
    let (plan, code) = emitted(
        r#"import { computed, pattern } from "commonfabric";
export const P = pattern<{ secret: string; note: string }>(({ secret, note }) => {
  const both = computed(() => secret + note);
  return { both, note };
});
"#,
        "P",
    );
    let text = source(&code);
    let secret = slot(&plan, "argument", &["secret"], "value");
    let note = slot(&plan, "argument", &["note"], "value");
    assert!(
        text.contains(&format!(
            "($h.v($h.slot({secret})) + $h.v($h.slot({note})))"
        )),
        "{text}"
    );
    // A path the result passes on is read by its `identity` slot.
    let passed = slot(&plan, "argument", &["note"], "identity");
    assert!(text.contains(&format!("note: $h.slot({passed})")), "{text}");
    assert_eq!(code["unlistedReads"], json!([]));
}

#[test]
fn a_value_of_another_cone_is_read_as_its_output() {
    let (plan, code) = emitted(
        r#"import { computed, pattern } from "commonfabric";
export const P = pattern<{ secret: string }>(({ secret }) => {
  const shout = computed(() => secret.toUpperCase());
  const echo = computed(() => shout + "?");
  return { echo };
});
"#,
        "P",
    );
    let text = source(&code);
    // `shout` is an interim output, and the edge from its cone names it.
    let output = plan["edges"][0]["via"]["output"].as_u64().expect("an edge");
    assert!(
        text.contains(&format!("($h.v($h.output({output})) + (\"?\"))")),
        "{text}"
    );
    // The receiver of a method call is rewritten, and the call keeps it.
    assert!(text.contains(".toUpperCase()"), "{text}");
    assert_eq!(code["valuesWithoutOutput"], json!([]));
}

#[test]
fn a_member_read_of_a_value_of_another_cone_is_one_read_of_the_path_with_the_key() {
    let (plan, code) = emitted(
        r#"import { computed, pattern } from "commonfabric";
interface Item { key: string; title: string }
export const P = pattern<{ items: Item[] }>(({ items }) => {
  const facts = computed(() => {
    const places: Record<string, { replies: number }> = {};
    for (const item of items) places[item.key] = { replies: 1 };
    return { count: items.length, places };
  });
  return {
    count: facts.count,
    rows: items.map((item) => ({ replies: facts.places[item.key]?.replies ?? 0 })),
  };
});
"#,
        "P",
    );
    let text = source(&code);
    let output = plan["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .position(|output| output["collection"].is_null())
        .expect("the output of `facts`");
    // A static path, and a static path with a key that a pick chooses:
    // the reader depends on what `facts` holds there alone.
    assert!(
        text.contains(&format!("$h.output({output}, [\"count\"])")),
        "{text}"
    );
    assert!(
        text.contains(&format!("$h.output({output}, [\"places\", $h.pick(0, ")),
        "{text}"
    );
    assert!(
        !text.contains(&format!("$h.at($h.output({output}), ")),
        "{text}"
    );
}

#[test]
fn a_member_read_of_a_stored_record_by_a_key_reads_the_chosen_child_alone() {
    let (plan, code) = emitted(
        r#"import { pattern } from "commonfabric";
interface Item { key: string; title: string }
export const P = pattern<{ items: Item[]; places: Record<string, { replies: number }> }>(
  ({ items, places }) => ({
    rows: items.map((item) => ({ replies: places[item.key]?.replies ?? 0 })),
  }),
);
"#,
        "P",
    );
    let text = source(&code);
    let children = plan["slots"]
        .as_array()
        .expect("slots")
        .iter()
        .position(|slot| slot["path"] == json!(["places", "*"]) && slot["observes"] == "shape")
        .expect("the slot of the chosen child");
    assert!(
        text.contains(&format!("$h.slot({children}, [$h.pick(0, ")),
        "{text}"
    );
    assert!(
        !text.contains(&format!("$h.at($h.slot({children})")),
        "{text}"
    );
}

#[test]
fn types_are_removed_and_the_function_of_a_pattern_is_left_out() {
    let (plan, code) = emitted(
        r#"import { handler, pattern, Writable } from "commonfabric";
interface Entry { text: string }
type Tag = string;
const LIMIT: number = 3 as number;
const add = handler<{ text: string }, { log: Writable<Entry[]> }>((event, { log }) => {
  const entry: Entry = { text: event.text! };
  log.push(entry satisfies Entry);
});
export const P = pattern<{ tag: Tag }>(({ tag }) => {
  const log = Writable.of<Entry[]>([]);
  return { tag, log, add: add({ log }) };
});
"#,
        "P",
    );
    let text = source(&code);
    assert!(!text.contains("interface"), "{text}");
    assert!(!text.contains("Entry"), "{text}");
    assert!(text.contains("const LIMIT = 3;"), "{text}");
    assert!(
        text.contains("const entry = { text: event.text };"),
        "{text}"
    );
    assert!(text.contains("log.push(entry);"), "{text}");
    // In the place of its function the pattern has its identity, the
    // entry of `Plan.patterns` of its own plan: a function body that
    // calls the pattern names the callee's artifact with it.
    assert!(
        text.contains(&format!("pattern({})", plan["patterns"][0])),
        "{text}"
    );
    // The handler's body is one function, called with the event and the
    // state.
    assert!(text.contains("$rt.body(0, ($e, $s) => ("), "{text}");
}

/// The schema document a record of the plan names.
fn schema_named(text: &str, name: &str, id: &Value) -> Value {
    pattern_compiler::emit::request(true);
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: text.to_string(),
    }]);
    pattern_compiler::emit::request(false);
    analysis
        .modules
        .iter()
        .flat_map(|module| &module.plans)
        .find(|plan| plan.name.as_deref() == Some(name))
        .expect("the pattern")
        .schemas
        .iter()
        .find(|(known, _)| json!(known) == *id)
        .map(|(_, document)| document.clone())
        .unwrap_or_else(|| panic!("no schema {id}"))
}

#[test]
fn a_constant_first_value_is_the_default_of_the_schema_of_the_state_cell() {
    // Ruling Z3 (PL §1.3, "The first value of a state cell"): nothing is
    // written when the cell is created, so no function gives the value.
    let text = r#"import { pattern, Writable } from "commonfabric";
const START = { at: "", tags: ["a"] };
export const P = pattern<{ note: string }>(({ note }) => {
  const count = Writable.of<number>(7);
  const draft = Writable.of(START);
  const empty = Writable.of<string>();
  return { count, draft, empty, note };
});
"#;
    let (plan, code) = emitted(text, "P");
    let cells = plan["stateCells"].as_array().expect("state cells");
    assert_eq!(
        schema_named(text, "P", &cells[0]["schema"]),
        json!({ "type": "number", "default": 7 })
    );
    // A constant of the module with a static initializer is a constant.
    assert_eq!(
        schema_named(text, "P", &cells[1]["schema"])["default"],
        json!({ "at": "", "tags": ["a"] })
    );
    // A declaration that gives no value has a schema with no default.
    assert_eq!(
        schema_named(text, "P", &cells[2]["schema"]),
        json!({ "type": "string" })
    );
    for cell in cells {
        assert!(cell.get("first").is_none(), "{cell}");
    }
    assert!(!source(&code).contains("$rt.state("), "{}", source(&code));
    assert_eq!(code["states"], json!([]));
}

#[test]
fn a_first_value_that_is_not_a_constant_is_a_cone_with_a_write_edge_to_the_cell() {
    // Ruling Z3: the value is computed by a cone and written once, when
    // the cell is first created, through a write edge with target `state`
    // that `StateCell.first` names.
    let (plan, code) = emitted(
        r#"import { pattern, Writable } from "commonfabric";
export const P = pattern<{ start: number; items: string[] }>(({ start, items }) => {
  const count = Writable.of(start);
  const rows = items.map((item, index) => {
    const at = Writable.of(index);
    return { item, at };
  });
  return { count, rows };
});
"#,
        "P",
    );
    let text = source(&code);
    let cell = &plan["stateCells"][0];
    let first = &cell["first"];
    let cone = &plan["cones"][first["cone"].as_u64().expect("a cone") as usize];
    let write = &cone["writes"][first["write"].as_u64().expect("a write") as usize];
    assert_eq!(
        write["target"],
        json!({ "kind": "state", "cell": 0, "path": [] })
    );
    // The cone lists the slot the value reads.
    let start = slot(&plan, "argument", &["start"], "value");
    assert_eq!(cone["slots"], json!([start]));
    assert!(
        text.contains(&format!("$rt.state(0, ($h) => ($h.v($h.slot({start}))));")),
        "{text}"
    );
    // `cell(index)` in an element body: the cone lists the index slot.
    let index = slot(&plan, "index", &[], "value");
    let first = &plan["stateCells"][1]["first"];
    let cone = &plan["cones"][first["cone"].as_u64().expect("a cone") as usize];
    assert_eq!(cone["slots"], json!([index]));
    assert!(
        text.contains(&format!("$rt.state(1, ($h) => ($h.slot({index})));")),
        "{text}"
    );
    assert_eq!(code["states"], json!([0, 1]));
}

#[test]
fn an_element_construct_registers_the_function_of_its_body() {
    let (plan, code) = emitted(
        r#"import { pattern } from "commonfabric";
interface Item { title: string }
export const P = pattern<{ items: Item[] }>(({ items }) => {
  const numbered = items.map((item, index) => item.title + index);
  return { numbered };
});
"#,
        "P",
    );
    let text = source(&code);
    let title = slot(&plan, "element", &["title"], "value");
    let index = slot(&plan, "index", &[], "value");
    assert!(
        text.contains(&format!(
            "$rt.element(0, ($h) => (($h.v($h.slot({title})) + $h.slot({index}))));"
        )),
        "{text}"
    );
    // The cone of the body is evaluated per element of collection 0, and
    // the plan's `Cone` record says so (ruling Z10): the artifact holds
    // nothing beside the plan for it.
    let cone = plan["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .find(|output| output["collection"] == json!(0))
        .expect("the assembled output")["cone"]
        .as_u64()
        .expect("a cone") as usize;
    assert_eq!(plan["cones"][cone]["within"], json!([{ "element": 0 }]));
    assert!(code.get("coneWithin").is_none());
}

#[test]
fn a_host_element_is_a_view_node_and_a_handler_is_a_stream() {
    let (_, code) = emitted(
        r#"import { handler, pattern, UI, Writable } from "commonfabric";
const bump = handler<unknown, { count: Writable<number> }>((_, { count }) => {
  count.set(count.get() + 1);
});
export const P = pattern<{ label: string }>(({ label }) => {
  const count = Writable.of(0);
  return {
    [UI]: (
      <div class="row">
        <button onClick={bump({ count })}>
          add  one
        </button>
        {label}
      </div>
    ),
    count,
  };
});
"#,
        "P",
    );
    let text = source(&code);
    assert!(
        text.contains(
            "$rt.h(\"div\", { \"class\": \"row\" }, [$rt.h(\"button\", { \"onClick\": $h.stream(0) }, [\"add  one\"]), "
        ),
        "{text}"
    );
}

#[test]
fn a_pattern_compiled_in_is_a_setup_function_given_its_constants() {
    let (_, code) = emitted(
        r#"import { computed, pattern, UI } from "commonfabric";
const Row = pattern<{ title: string; mark: string }>(({ title, mark }) => {
  const shown = computed(() => title + mark);
  return { [UI]: <li>{shown}</li> };
});
export const P = pattern<{ title: string }>(({ title }) => {
  return { [UI]: <ul><Row title={title} mark="!" /></ul> };
});
"#,
        "P",
    );
    let text = source(&code);
    // The constant of the argument is given to the setup function, and
    // the slot is not: the callee reads it by its place.
    assert!(
        text.contains("$rt.inline(1, { \"mark\": \"!\" }, $h);"),
        "{text}"
    );
    assert!(
        text.contains("const mark = $rt.at($arg, [\"mark\"], $h);"),
        "{text}"
    );
    // At a child position the tag is the callee's tree (PL §1.1).
    assert!(text.contains(", [\"$UI\"])"), "{text}");
}

#[test]
fn a_use_of_a_body_lists_where_each_slot_sits_in_its_argument() {
    let (plan, code) = emitted(
        r#"import { lift, pattern } from "commonfabric";
const label = lift((x: { title: string; count: number }) => x.title + x.count);
export const P = pattern<{ title: string; items: string[] }>(({ title, items }) => {
  const shown = label({ title, count: items.length });
  return { shown };
});
"#,
        "P",
    );
    let text = source(&code);
    assert!(text.contains("$h.invoke(0, "), "{text}");
    let title = slot(&plan, "argument", &["title"], "value");
    // Each entry of `Body.reads` holds the slot and its place in the
    // body's argument (PL §1.1, `ReadInput`): a `lift` has one
    // parameter, and the path starts below it.
    let reads = plan["bodies"][0]["reads"].as_array().expect("reads");
    assert!(
        reads.contains(&json!({ "slot": title, "at": ["title"] })),
        "{reads:?}"
    );
    // The artifact holds no layout beside the plan.
    assert!(code.get("layouts").is_none());
}

#[test]
fn a_slot_of_a_computed_sits_below_the_name_the_body_captures() {
    let (plan, _) = emitted(
        r#"import { computed, pattern } from "commonfabric";
export const P = pattern<{ profile: { name: string } }>(({ profile }) => {
  const shown = computed(() => {
    let out = "";
    for (const letter of profile.name) out += letter;
    return out;
  });
  return { shown };
});
"#,
        "P",
    );
    let name = slot(&plan, "argument", &["profile", "name"], "value");
    assert_eq!(
        plan["bodies"][0]["reads"],
        json!([{ "slot": name, "at": ["profile", "name"] }])
    );
}

#[test]
fn a_slot_of_a_handler_sits_below_event_or_binding() {
    let (plan, _) = emitted(
        r#"import { handler, pattern, Writable } from "commonfabric";
const add = handler<{ text: string }, { log: Writable<string[]> }>((event, { log }) => {
  log.push(event.text);
});
export const P = pattern<{ tag: string }>(({ tag }) => {
  const log = Writable.of<string[]>([]);
  return { tag, log, add: add({ log }) };
});
"#,
        "P",
    );
    let text = slot(&plan, "event", &["text"], "value");
    let log = slot(&plan, "binding", &["log"], "identity");
    assert_eq!(
        plan["bodies"][0]["reads"],
        json!([
            { "slot": text, "at": ["event", "text"] },
            // The handler declares a handle at `log` (provisional
            // decision P40).
            { "slot": log, "at": ["binding", "log"], "handle": true },
        ])
    );
}

#[test]
fn a_handler_written_in_place_is_registered_where_it_is_written() {
    let (_, code) = emitted(
        r#"import { pattern, UI, Writable } from "commonfabric";
const Row = pattern<{ step: number }>(({ step }) => {
  const count = Writable.of(0);
  return { [UI]: <button onClick={() => count.set(count.get() + step)}>add</button> };
});
export const P = pattern<{ title: string }>(({ title }) => {
  return { [UI]: <div>{title}<Row step={2} /></div> };
});
"#,
        "P",
    );
    let text = source(&code);
    // The constant `step` is a name of the setup function the handler is
    // registered in, and the cell is taken from the handler's state.
    let setup = text
        .split("$rt.setup(1,")
        .nth(1)
        .expect("the setup function of the pattern compiled in");
    assert!(
        setup.contains("const step = $rt.at($arg, [\"step\"], $h);"),
        "{text}"
    );
    assert!(
        setup.contains(
            "$rt.handler(0, ($e, $s) => { const { count } = $s; return (() => count.set(count.get() + step))($e); });"
        ),
        "{text}"
    );
}

#[test]
fn a_path_the_call_leaves_out_reads_as_the_default_of_the_callee() {
    let (_, code) = emitted(
        r#"import { computed, type Default, pattern, UI } from "commonfabric";
const Price = pattern<{ amount: number; symbol: Default<string, "$"> }>(({ amount, symbol }) => {
  const shown = computed(() => symbol + amount);
  return { [UI]: <span>{shown}</span> };
});
export const P = pattern<{ amount: number }>(({ amount }) => {
  return { [UI]: <div><Price amount={amount} /></div> };
});
"#,
        "P",
    );
    let text = source(&code);
    assert!(
        text.contains("const symbol = $rt.or($rt.at($arg, [\"symbol\"], $h), () => (\"$\"));"),
        "{text}"
    );
}

#[test]
fn the_children_of_a_tag_that_names_a_pattern_are_a_value_of_their_own() {
    let (_, code) = emitted(
        r#"import { pattern, UI } from "commonfabric";
const Card = pattern<{ children: unknown }>(({ children }) => {
  return { [UI]: <section>{children}</section> };
});
export const P = pattern<{ title: string }>(({ title }) => {
  return { [UI]: <Card><b>{title}</b></Card> };
});
"#,
        "P",
    );
    let text = source(&code);
    // The callee reads the children as the output of the value the
    // caller's code computes.
    assert!(
        text.contains("($h) => ([$rt.h(\"b\", {  }, [$h.slot("),
        "{text}"
    );
    assert_eq!(code["valuesWithoutOutput"], json!([]));
}

#[test]
fn a_body_is_handed_a_name_it_captures_and_reads_nothing_of() {
    let (plan, code) = emitted(
        r#"import { computed, pattern } from "commonfabric";
export const P = pattern<{ flag: boolean; note: string }>(({ flag, note }) => {
  const seen = computed(() => {
    void flag;
    for (const letter of note) {
      if (letter === "x") return true;
    }
    return false;
  });
  return { seen };
});
"#,
        "P",
    );
    let text = source(&code);
    // The record of the body has no entry for `flag`, and its code names
    // it.
    assert_eq!(plan["bodies"][0]["kind"], json!("computed"));
    assert!(
        text.contains("$rt.body(0, ($a) => { const { flag, note } = $a;"),
        "{text}"
    );
}

#[test]
fn a_path_the_call_leaves_out_is_a_constant_of_the_plan_with_the_default() {
    // Ruling Z4: the path is bound as if the call had written, as a
    // constant, the default the callee's argument type declares. The one
    // record that holds a constant of a compiled-in argument is the state
    // of a binding (PL §1.1, `Binding.state.place`).
    let (plan, _) = emitted(
        r#"import { type Default, pattern, UI, Writable } from "commonfabric";
const Row = pattern<{ label: string; step: Default<number, 5> }>(({ label, step }) => {
  const count = Writable.of(0);
  return { [UI]: <button onClick={() => count.set(count.get() + step)}>{label}</button> };
});
export const P = pattern<{ title: string }>(({ title }) => {
  return { [UI]: <div><Row label={title} /></div> };
});
"#,
        "P",
    );
    let state = plan["bindings"][0]["state"].as_array().expect("state");
    let step = state
        .iter()
        .find(|entry| entry["path"] == json!(["step"]))
        .expect("the entry of `step`");
    assert_eq!(step["place"], json!({ "constant": 5 }));
}

#[test]
fn a_path_bound_to_a_slot_of_the_caller_reads_the_default_of_the_callee() {
    // Rulings Z4 and Z16: where nothing is stored at the caller's slot,
    // the cones of the callee that read the path take the callee's
    // default. Expression code has it as a constant. For a sandboxed body
    // the entry of `Body.reads` holds it, and value code passes
    // `host.invoke` nothing for it.
    let (plan, code) = emitted(
        r#"import { computed, type Default, lift, pattern, UI } from "commonfabric";
const spell = lift((x: { symbol: string }) => x.symbol.split("").join("-"));
const Price = pattern<{ amount: number; symbol: Default<string, "$"> }>(({ amount, symbol }) => {
  const shown = computed(() => symbol + amount);
  const spelled = spell({ symbol });
  return { [UI]: <span>{shown}{spelled}</span> };
});
export const P = pattern<{ amount: number; sign?: string }>(({ amount, sign }) => {
  return { [UI]: <div><Price amount={amount} symbol={sign} /></div> };
});
"#,
        "P",
    );
    let text = source(&code);
    let sign = slot(&plan, "argument", &["sign"], "value");
    // Expression code reads the slot, and the default where it is empty.
    assert!(
        text.contains(&format!("$rt.or($h.v($h.slot({sign})), () => (\"$\"))")),
        "{text}"
    );
    // The use of the body passes the computed inputs alone.
    assert!(
        text.contains(&format!("$h.invoke(0, ({{ symbol: $h.slot({sign}) }}))")),
        "{text}"
    );
    // `ReadInput.default` (PL §1.1): the entry of the slot the call bound
    // has the default the callee declares for the path.
    assert_eq!(
        plan["bodies"][0]["reads"],
        json!([{ "slot": sign, "at": ["symbol"], "default": "$" }])
    );
}

/// Ruling Z16, second half: where the callee passes a path of its
/// argument on by reference, the stored reference carries the default
/// the callee declares for the path. Value code gives the reference the
/// default, and the state entry of a binding of the callee whose place is
/// the caller's slot holds it (PL §8, question 110, assumed). The same
/// inside an element body, over an array of references, over an array of
/// plain values in place, and over the result of another per-element
/// construct: the callee's cones name the caller's slot in each.
#[test]
fn a_path_the_callee_passes_on_carries_the_default_of_the_callee() {
    let (plan, code) = emitted(
        r#"import { type Default, handler, pattern, Writable } from "commonfabric";
const mark = handler<unknown, { symbol: Writable<string> }>((_, { symbol }) => {
  symbol.set(symbol.get() + "!");
});
const Price = pattern<{ symbol: Default<string, "$"> }>(({ symbol }) => {
  return { symbol, mark: mark({ symbol }) };
});
export const P = pattern<{ sign?: string }>(({ sign }) => {
  const price = Price({ symbol: sign });
  return { symbol: price.symbol, mark: price.mark };
});
"#,
        "P",
    );
    let text = source(&code);
    let sign = slot(&plan, "argument", &["sign"], "identity");
    assert!(
        text.contains(&format!("$h.withDefault($h.slot({sign}), \"$\")")),
        "{text}"
    );
    let state = &plan["bindings"][0]["state"][0];
    assert_eq!(state["path"], json!(["symbol"]));
    assert_eq!(state["place"], json!({ "slot": sign }));
    assert_eq!(state["default"], json!("$"));
    // The handler is one body for all its bindings, and its entries of
    // root `binding` hold no default.
    assert!(plan["bodies"][0]["reads"]
        .as_array()
        .expect("reads")
        .iter()
        .all(|entry| entry.get("default").is_none()));
}

#[test]
fn the_name_bound_to_self_is_a_reference_to_the_result() {
    let (_, code) = emitted(
        r#"import { computed, equals, pattern, SELF, Writable } from "commonfabric";
type Piece = Writable<{ title: string }>;
export const P = pattern<{ pieces: Piece[] }>(({ pieces, [SELF]: self }) => {
  const others = computed(() => pieces.filter((piece: Piece) => !equals(piece, self)));
  return { others };
});
"#,
        "P",
    );
    assert!(source(&code).contains("const self = $rt.self;"));
}

#[test]
fn a_cone_with_side_writes_records_its_kind_from_the_footprint() {
    // Ruling Z7, with the tiers of `footprint-analysis.md` §6.3: a cone
    // whose bodies write named targets alone is `static`, and one with a
    // body that writes a target reached through data is `materializer`.
    let (plan, _) = emitted(
        r#"import { computed, lift, pattern, Writable } from "commonfabric";
const tally = lift((x: { counts: Writable<Record<string, number>>; flavor: string }) => {
  x.counts.key(x.flavor).set(1);
  return x.flavor;
});
export const P = pattern<{ value: string; flavor: string }>(({ value, flavor }) => {
  const log = Writable.of<string[]>([]);
  const counts = Writable.of<Record<string, number>>({});
  computed(() => {
    log.set([...log.get(), value]);
  });
  const tallied = tally({ counts, flavor });
  const plain = computed(() => value.split("").reverse().join(""));
  return { log, counts, tallied, plain };
});
"#,
        "P",
    );
    let kinds: Vec<(String, Value)> = plan["cones"]
        .as_array()
        .expect("cones")
        .iter()
        .filter(|cone| !cone["bodies"].as_array().expect("bodies").is_empty())
        .map(|cone| {
            (
                cone["entry"].as_str().expect("an entry").to_string(),
                cone.get("sideWrites").cloned().unwrap_or(Value::Null),
            )
        })
        .collect();
    assert_eq!(
        kinds,
        [
            ("statement".to_string(), json!("static")),
            ("tallied".to_string(), json!("materializer")),
            ("plain".to_string(), Value::Null),
        ]
    );
}

#[test]
fn a_reduce_registers_the_function_of_its_initial_value_and_of_its_step() {
    // PL §3.13: the step of a `reduce` is a cone the runtime evaluates
    // once per element, in order, "with the accumulator as a slot of root
    // `operation`". The plan is the same whether the elements of `items`
    // are references or plain values in place, and `doubled` is over the
    // result of another per-element construct.
    let (plan, code) = emitted(
        r#"import { pattern } from "commonfabric";
interface Item { amount: number }
export const P = pattern<{ items: Item[]; amounts: number[]; bonus: number }>(
  ({ items, amounts, bonus }) => {
    const total = items.reduce((sum, item, index) => sum + item.amount * index, bonus);
    const doubled = amounts.map((amount) => amount * 2).reduce((sum, amount) => sum + amount, 0);
    return { total, doubled };
  },
);
"#,
        "P",
    );
    let text = source(&code);
    let accumulator = plan["slots"]
        .as_array()
        .expect("slots")
        .iter()
        .position(|slot| {
            slot["root"] == json!({ "kind": "operation", "operation": 0 })
                && slot["observes"] == "value"
        })
        .expect("the accumulator");
    let amount = slot(&plan, "element", &["amount"], "value");
    let index = slot(&plan, "index", &[], "value");
    let bonus = slot(&plan, "argument", &["bonus"], "identity");
    let step = plan["operations"][0]["implementation"]["cone"]
        .as_u64()
        .expect("the cone of the step");
    // The cone the `reduce` is written in computes the initial value.
    let initial = plan["cones"]
        .as_array()
        .expect("cones")
        .iter()
        .position(|cone| {
            cone["writes"].as_array().is_some_and(|writes| {
                writes
                    .iter()
                    .any(|write| write["target"]["of"] == json!({ "operation": 0 }))
            })
        })
        .expect("the cone of the initial value");
    assert!(
        text.contains(&format!(
            "$rt.reduce(0, {initial}, ($h) => ($h.v($h.slot({bonus}))), {step}, ($h) => (($h.v($h.slot({accumulator})) + ($h.v($h.slot({amount})) * $h.slot({index})))));"
        )),
        "{text}"
    );
    // The second `reduce` is over the assembled result of the `map`, whose
    // body is registered as that of any element construct.
    assert!(text.contains("$rt.element("), "{text}");
    assert!(text.contains("$rt.reduce(1, "), "{text}");
    assert_eq!(code["reduces"], json!([0, 1]));
}

/// `equals` compares what its operands name (PL §3.16; §1.3, "A plain
/// value in place has an identity"), so value code passes each operand
/// as the reference it is and reads the value of neither. The code is
/// the same over an array of references and over an array of plain
/// values in place: the plan does not say which `items` holds.
#[test]
fn equals_is_given_its_operands_as_references() {
    let (plan, code) = emitted(
        r#"import { equals, pattern, Writable } from "commonfabric";
interface Item { title: string }
export const P = pattern<{ items: Item[]; selected: Writable<Item | null> }>(
  ({ items, selected }) => {
    return {
      rows: items.map((item) => ({ title: item.title, isSelected: equals(selected, item) })),
    };
  },
);
"#,
        "P",
    );
    let text = source(&code);
    let selected = slot(&plan, "argument", &["selected"], "identity");
    let item = slot(&plan, "element", &[], "identity");
    assert!(
        text.contains(&format!("$h.equals($h.slot({selected}), $h.slot({item}))")),
        "{text}"
    );
}

/// An array literal with a spread is an array literal in value code,
/// with the members of each spread operand read through `$h.spread`,
/// which is given the operand as the reference it is, so that a position
/// that holds a link gives the link, and which gives none for an operand
/// that holds nothing. The runtime is told nothing about which entry a
/// position came from (ruling Z43). The spread operand is the result of
/// a `map` over records in the first array, the result of a `map` over
/// plain values in the second, and an input array in the third.
#[test]
fn an_array_with_a_spread_is_an_array_literal() {
    let (_, code) = emitted(
        r#"import { pattern } from "commonfabric";
interface Item { title: string }
export const P = pattern<{ items: Item[]; tags: string[]; note: string }>(({ items, tags, note }) => {
  return {
    rows: [note, ...items.map((item) => item.title), note],
    labels: [...tags.map((tag) => tag + "!"), note],
    all: [...items, note],
    plain: [note, note],
  };
});
"#,
        "P",
    );
    let text = source(&code);
    assert!(
        text.contains("rows: [$h.slot(") && text.contains("...$h.spread($h.output("),
        "{text}"
    );
    assert!(text.contains("labels: [...$h.spread($h.output("), "{text}");
    assert!(text.contains("all: [...$h.spread($h.slot("), "{text}");
    assert!(!text.contains("$rt.spread("), "{text}");
    assert!(text.contains("plain: [$h.slot("), "{text}");
    assert!(!text.contains("$rt.list("), "{text}");
}

/// A pattern that a function body instantiates is named, in value code,
/// by the identity of the callee: the marker of each `pattern(...)` of a
/// module holds the entry of `Plan.patterns` that the callee's own plan
/// begins with, so the factory value a body calls carries it, whichever
/// module the callee is written in.
#[test]
fn a_pattern_is_written_with_the_identity_its_plan_begins_with() {
    let text = r#"import { handler, pattern, Writable } from "commonfabric";
const Row = pattern<{ title: string }>(({ title }) => {
  return { title };
});
const add = handler<{ title: string }, { rows: Writable<unknown[]> }>((event, { rows }) => {
  rows.push(Row({ title: event.title }));
});
export default pattern<{ note: string }>(({ note }) => {
  const rows = Writable.of<unknown[]>([]);
  return { note, rows, add: add({ rows }) };
});
"#;
    let (plan, code) = emitted(text, "default");
    let (row, _) = emitted(text, "Row");
    let written = source(&code);
    assert_ne!(row["patterns"][0], plan["patterns"][0]);
    assert!(
        written.contains(&format!(
            "const Row = $rt.data(pattern({}));",
            row["patterns"][0]
        )),
        "{written}"
    );
    assert!(
        written.contains(&format!("pattern({})", plan["patterns"][0])),
        "{written}"
    );
    // The body calls the factory value by its name.
    assert!(
        written.contains("rows.push(Row({ title: event.title }));"),
        "{written}"
    );
}

/// Ruling Z31: in the reactive tier a collection among the children of a
/// view node is written as one child, with no spread, and the members of
/// an array literal that the author writes among the children are
/// written as children of their own. A view node that a function body
/// builds is written with the factory that flattens the arrays it is
/// handed, as the JSX factory of today does. The collection is over an
/// array of records, which value code writes alike for references and
/// for plain values in place.
#[test]
fn a_collection_among_the_children_is_written_as_one_child() {
    let (plan, code) = emitted(
        r#"import { lift, pattern, UI } from "commonfabric";
const build = lift((rows: { title: string }[]) => <p>{rows.map((row) => <i>{row.title}</i>)}</p>);
export const P = pattern<{ a: string; b: string; rows: { title: string }[] }>(({ a, b, rows }) => {
  const built = build(rows);
  return {
    [UI]: (
      <div>
        {[a, b]}
        {rows.map((row) => <li>{row.title}</li>)}
        <hr />
        {built}
      </div>
    ),
  };
});
"#,
        "P",
    );
    let text = source(&code);
    assert!(!text.contains("$rt.children("), "{text}");
    assert!(!text.contains("$rt.spread("), "{text}");
    assert!(text.contains("$rt.hf(\"p\""), "{text}");
    assert!(text.contains("$rt.h(\"div\""), "{text}");
    // The two members of the literal are the first two children, the
    // collection the third, and the element after it the fourth.
    let paths: Vec<String> = plan["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .filter(|output| output["kept"] == json!(true))
        .map(|output| {
            output["path"]
                .as_array()
                .expect("a path")
                .iter()
                .map(|segment| segment.as_str().expect("a segment"))
                .collect::<Vec<_>>()
                .join("/")
        })
        .collect();
    assert!(paths.contains(&"$UI/children/0".to_string()), "{paths:?}");
    assert!(paths.contains(&"$UI/children/1".to_string()), "{paths:?}");
    assert!(paths.contains(&"$UI/children/4".to_string()), "{paths:?}");
}

#[test]
fn a_data_file_is_a_constant_that_the_artifact_names_by_its_path() {
    pattern_compiler::emit::request(true);
    let analysis = analyze(&[SourceFile {
        path: "/words/speller.tsx".to_string(),
        text: r#"import { dataFile, pattern } from "commonfabric";
const WORDS = JSON.parse(dataFile("./data/words.json")) as string[];
const NOTE = dataFile("../note.txt");
export const P = pattern<{ index: number }>(({ index }) => {
  return { word: WORDS[0], note: NOTE, index };
});
"#
        .to_string(),
    }]);
    pattern_compiler::emit::request(false);
    let found = analysis
        .modules
        .iter()
        .flat_map(|module| &module.plans)
        .find(|plan| plan.name.as_deref() == Some("P"))
        .expect("the pattern");
    let code = found.code.clone().expect("the value code");
    let text = source(&code);
    // The file is resolved against the module, as an import is (BI,
    // "Pure API functions", `dataFile`).
    assert_eq!(
        code["dataFiles"],
        json!([
            { "file": "/words/data/words.json" },
            { "file": "/note.txt" },
        ])
    );
    assert!(text.contains("JSON.parse($rt.dataFile(0))"), "{text}");
    assert!(
        text.contains("const NOTE = $rt.data($rt.dataFile(1));"),
        "{text}"
    );
}

/// The outputs that the code reads through `$h.output` and that no value
/// function, no element construct and no path below a value computes.
fn outputs_without_a_function(code: &Value) -> Vec<u64> {
    let text = source(code);
    let computed: Vec<u64> = code["values"]
        .as_array()
        .expect("values")
        .iter()
        .filter(|value| value["function"] == json!(true) || !value["collection"].is_null())
        .filter_map(|value| value["output"].as_u64())
        .chain(
            code["outputsBelow"]
                .as_array()
                .expect("outputs below")
                .iter()
                .filter_map(|below| below["output"].as_u64()),
        )
        .collect();
    let mut missing: Vec<u64> = text
        .split("$h.output(")
        .skip(1)
        .filter_map(|rest| rest.split([')', ',']).next()?.parse().ok())
        .filter(|output| !computed.contains(output))
        .collect();
    missing.sort_unstable();
    missing.dedup();
    missing
}

#[test]
fn a_const_of_a_promoted_block_that_another_cone_reads_has_a_value_function() {
    let (_, code) = emitted(
        r#"import { computed, pattern, Writable } from "commonfabric";
interface Item { text: string; done: boolean }
interface Fleet { ships?: Item[] }
export const P = pattern<{
  items: Writable<Item[]>; fleet: Fleet; spare: Fleet; second: boolean; skip: string;
}>(({ items, fleet, spare, second, skip }) => {
  const summary = computed(() => {
    const list = items.get() || [];
    const total = list.length;
    if (total === 0) return "Empty";
    const done = list.filter((item) => item.done).length;
    return `${done}/${total}`;
  });
  const others = computed(() => {
    const hidden = skip.trim();
    if (hidden === "") return [];
    return (items.get() || []).filter((item) => item.text !== hidden);
  });
  const afloat = computed(() => {
    const mine = second ? spare : fleet;
    if (!mine) return 0;
    const ships = (mine.ships || []).filter((ship) => !ship.done);
    return ships.length;
  });
  return { summary, others, afloat };
});
"#,
        "P",
    );
    let text = source(&code);
    // The receiver `list`, and `hidden`, which the callback reads, are
    // read as outputs by the cones of the constructs.
    assert_eq!(
        outputs_without_a_function(&code),
        Vec::<u64>::new(),
        "{text}"
    );
    // A function that is registered outside the block names no `const`
    // of the block: the receiver `mine.ships || []` reads `mine` as the
    // output it is.
    let hoisted: Vec<&str> = text
        .lines()
        .filter(|line| line.starts_with("$rt.value(") && !line.contains("(() => {"))
        .collect();
    assert!(
        hoisted.iter().all(|line| !line.contains("(mine,")),
        "{hoisted:?}"
    );
}

/// PL §3.5: the result of `??`, `||` and `&&` is the selected operand
/// itself. The left operand is read by value for the test, whose
/// selection `$h.select` reports, and each operand is handed to
/// `$h.operand` as the reference it is, in a function that runs where the
/// operand is selected.
#[test]
fn a_logical_operator_passes_both_operands_on_by_reference() {
    let (plan, code) = emitted(
        r#"import { pattern } from "commonfabric";
interface Profile { name: string }
export const P = pattern<{ primary?: Profile; backup: Profile; enabled: boolean }>(
  ({ primary, backup, enabled }) => {
    return {
      coalesced: primary ?? backup,
      either: primary || backup,
      both: enabled && backup,
    };
  },
);
"#,
        "P",
    );
    let text = source(&code);
    // The cone of each output lists `primary` as an `identity` slot
    // alone, so the test reads its value through that slot.
    let primary = slot(&plan, "argument", &["primary"], "identity");
    let backup = slot(&plan, "argument", &["backup"], "identity");
    let enabled = slot(&plan, "argument", &["enabled"], "value");
    for (operator, test) in [
        (
            "??",
            format!("$h.select(0, $h.v($h.slot({primary})), true)"),
        ),
        ("||", format!("$h.select(1, $h.v($h.slot({primary})))")),
    ] {
        let call = format!(
            "$h.operand(\"{operator}\", {test}, () => $h.slot({primary}), () => $h.slot({backup}))"
        );
        assert!(text.contains(&call), "{text}");
    }
    let call = format!(
        "$h.operand(\"&&\", $h.select(2, $h.v($h.slot({enabled}))), () => $h.slot({enabled}), () => $h.slot({backup}))"
    );
    assert!(text.contains(&call), "{text}");
}

#[test]
fn a_debug_renderer_is_given_each_operand_as_its_value() {
    let (_, code) = emitted(
        r#"import { pattern, toIndentedDebugString, Writable } from "commonfabric";
export const P = pattern<{ title: Writable<string>; count: number }>(({ title, count }) => {
  return { text: toIndentedDebugString({ title: title.get(), count }, { limit: 5 }) };
});
"#,
        "P",
    );
    let text = source(&code);
    // A record that the code builds holds references, and the renderer
    // reads every operand by value over its whole subtree (BI, "Debug
    // strings").
    assert!(
        text.contains("toIndentedDebugString($h.v(({ title: "),
        "{text}"
    );
}

#[test]
fn a_handler_written_in_place_takes_a_constant_of_handle_type_from_its_state() {
    let (_, code) = emitted(
        r#"import { action, Default, Writable, pattern, UI } from "commonfabric";
const Counter = pattern<{
  value: Writable<number | Default<0>>;
  step?: Writable<number | Default<1>>;
  min?: Writable<number | null | Default<null>>;
  label: string;
}>(({ value, step, min, label }) => {
  const increment = action(() => {
    value.set(Math.max(min.get() ?? 0, value.get() + step.get()) + label.length);
  });
  return { [UI]: <button onClick={increment}>{label}</button> };
});
export const P = pattern<{ score: Writable<number> }>(({ score }) => {
  return { [UI]: <div><Counter value={score} step={5} label="Score" /></div> };
});
"#,
        "P",
    );
    let text = source(&code);
    // `step` and `min` are constants of the call that the callee declares
    // as handles: the runtime hands the body a handle that reads the
    // constant (ES §2.4). `label` is a constant of plain type, which the
    // function reads from the scope it is written in.
    assert!(
        text.contains("$rt.handler(0, ($e, $s) => { const { min, step, value } = $s;"),
        "{text}"
    );
}

#[test]
fn a_body_is_given_a_constant_at_a_position_of_handle_type_as_a_handle() {
    let (_, code) = emitted(
        r#"import { computed, Default, Writable, pattern } from "commonfabric";
const Callee = pattern<{
  show?: Writable<boolean | Default<false>>;
  mark: string;
  words: string[];
}>(({ show, mark, words }) => {
  const cells = computed(() => {
    let text = mark;
    if (show.get()) text = words.join(",");
    return text;
  });
  return { cells };
});
export const P = pattern<{ words: string[] }>(({ words }) => {
  const inner = Callee({ words, mark: "?" });
  return { cells: inner.cells };
});
"#,
        "P",
    );
    let text = source(&code);
    // The call leaves `show` out, so it is the callee's default, a
    // constant, at a position the callee declares as a handle: the body
    // is handed a handle that reads the constant (ES §2.4). `mark` is a
    // constant of plain type.
    assert!(text.contains("\"show\": $h.constant(show)"), "{text}");
    assert!(text.contains("\"mark\": mark"), "{text}");
}

#[test]
fn a_computed_key_that_is_a_string_literal_names_a_path_of_the_argument_of_a_pattern_compiled_in() {
    // "A key that is static ... is the name it evaluates to" (PL §3.4).
    let (_, code) = emitted(
        r#"import { pattern } from "commonfabric";
const Inner = pattern<{ jam: string; plain: string }>(({ jam, plain }) => {
  return { both: jam + plain };
});
export const P = pattern<{ note: string }>(({ note }) => {
  const inner = Inner({ ["jam"]: "j", plain: note });
  return { both: inner.both };
});
"#,
        "P",
    );
    let text = source(&code);
    assert!(text.contains("{ \"jam\": (\"j\") }"), "{text}");
}

#[test]
fn a_pattern_compiled_in_that_reads_its_argument_whole_is_given_every_path_the_call_binds() {
    let (_, code) = emitted(
        r#"import { pattern, Writable } from "commonfabric";
const Context = pattern<{ input: string; state: Writable<number>; label: string }>(
  (context) => context,
);
export const P = pattern<{ note: string; state: Writable<number> }>(({ note, state }) => {
  const input = note + "!";
  const context = Context({ input, state, label: "l" });
  return { context };
});
"#,
        "P",
    );
    let text = source(&code);
    // A path bound to a slot or to a value of another cone is given as
    // what value code reads there, for a callee that passes its whole
    // argument on.
    assert!(
        text.contains("\"input\": $rt.thunk(($h) => ($h.output(0)))"),
        "{text}"
    );
    assert!(
        text.contains("\"state\": $rt.thunk(($h) => ($h.slot("),
        "{text}"
    );
    assert!(text.contains("\"label\": (\"l\")"), "{text}");
}

#[test]
fn the_method_form_of_equals_compares_what_its_operands_name() {
    let (_, code) = emitted(
        r#"import { pattern, Writable } from "commonfabric";
interface Room { name: string }
export const P = pattern<{ selected: Writable<{ room: Room }>; rooms: Room[] }>(
  ({ selected, rooms }) => {
    const chosen = selected.key("room");
    return { marks: rooms.map((room) => ({ on: chosen.equals(room) })) };
  },
);
"#,
        "P",
    );
    let text = source(&code);
    // `h.equals(x)` is the comparison that `equals(h, x)` is (LS §6.1):
    // each operand is passed as the reference it is.
    assert!(text.contains("on: $h.equals($h.slot("), "{text}");
    assert!(!text.contains(".equals($h.v("), "{text}");
}

#[test]
fn an_effect_and_a_wish_register_the_function_of_their_request() {
    let (plan, code) = emitted(
        r##"import { fetchJson, pattern, wish, Writable } from "commonfabric";
export const P = pattern<{ id: string }>(({ id }) => {
  const url = Writable.of("https://example.test/a");
  const fetched = fetchJson<{ title: string }>({ url });
  const profile = wish<{ name: string }>({ query: "#profile" });
  const unread = fetchJson<{ title: string }>({ url, options: { method: id } });
  return { title: fetched.result, pending: fetched.pending, who: profile.result };
});
"##,
        "P",
    );
    let text = source(&code);
    assert_eq!(plan["operations"][0]["kind"], json!("effect"));
    assert_eq!(plan["operations"][1]["kind"], json!("wish"));
    // The request is the arguments of the call, each passed on as the
    // call binds it: the cell `url` stays a reference (PL §3.14).
    assert!(
        text.contains("$rt.request(0, ($h) => ([({ url: $h.slot("),
        "{text}"
    );
    assert!(
        text.contains("$rt.request(1, ($h) => ([({ query: (\"#profile\") })]));"),
        "{text}"
    );
    // The function of an effect whose result nothing reads is registered
    // as well. Whether the request is made is the runtime's: it is made
    // when something demands a path of the result (SS §6.2, "When an
    // operation of a plan is demanded").
    assert!(
        text.contains("$rt.request(2, ($h) => ([({ url: $h.slot("),
        "{text}"
    );
}

#[test]
fn module_data_is_frozen_and_each_function_of_module_scope_is_hardened() {
    let (_, code) = emitted(
        r#"import { lift, pattern } from "commonfabric";
const GLAZES = ["plain", "sugar"] as const;
const PRICES: ReadonlyMap<string, number> = new Map([["plain", 2]]);
const { first } = { first: GLAZES[0] };
function labelOf(glaze: string): string {
  return `${glaze} donut`;
}
export const priceOf = (glaze: string): number => PRICES.get(glaze) ?? 0;
const describe = lift(({ glaze }: { glaze: string }) => {
  const local = [labelOf(glaze), priceOf(glaze), first];
  return local.join();
});
export const P = pattern<{ glaze: string }>(({ glaze }) => {
  return { shown: describe({ glaze }) };
});
"#,
        "P",
    );
    let text = source(&code);
    // A declared function is hardened before the first statement.
    assert!(text.starts_with("$rt.fn(labelOf);\n"), "{text}");
    assert!(
        text.contains("const GLAZES = $rt.data([\"plain\", \"sugar\"]);"),
        "{text}"
    );
    assert!(
        text.contains("const PRICES = $rt.data(new Map([[\"plain\", 2]]));"),
        "{text}"
    );
    assert!(
        text.contains("const { first } = $rt.data({ first: GLAZES[0] });"),
        "{text}"
    );
    assert!(
        text.contains("const priceOf = $rt.fn((glaze) => PRICES.get(glaze) ?? 0);"),
        "{text}"
    );
    // The result of a builder is a function of the executor.
    assert!(text.contains("const describe = $rt.data(lift("), "{text}");
    // A constant of a function body is no module data.
    assert!(
        text.contains("const local = [labelOf(glaze), priceOf(glaze), first];"),
        "{text}"
    );
}

/// A conditional written in the state of a handler binding is a value the
/// instance computes, so it has a value function as one bound to a name
/// has: the binding reads the output, and nothing else renders the
/// expression.
#[test]
fn a_conditional_in_the_state_of_a_binding_has_a_value_function() {
    let (plan, code) = emitted(
        r#"import { type Cell, handler, pattern, type Stream } from "commonfabric";
const bump = handler<unknown, { target?: Cell<{ n: number }> }>(
  (_event, { target }) => {
    if (target === undefined) return;
    target.set({ n: target.get().n + 1 });
  },
);
export const Bound = pattern<
  { own: boolean; counter: Cell<{ n: number }> },
  { go: Stream<unknown> }
>(({ own, counter }) => ({
  go: bump({ target: own ? undefined : counter }),
}));
"#,
        "Bound",
    );
    assert_eq!(
        plan["bindings"][0]["state"][0]["place"],
        json!({ "output": 0 })
    );
    assert_eq!(code["values"][0]["output"], json!(0));
    assert_eq!(code["values"][0]["function"], json!(true), "{code}");
    assert!(source(&code).contains("$rt.value(0, "), "{}", source(&code));
}

/// A built-in that reads what its operand names, its label or the access
/// list of its space, is given the operand as the reference it is: the
/// runtime's function takes a cell, and a copy of the value names nothing.
/// The operands behind the first are values.
#[test]
fn a_context_read_is_given_its_first_operand_as_a_reference() {
    let (_, code) = emitted(
        r#"import { type Cell, computed, pattern, principalOf, spaceAccess } from "commonfabric";
export const Asked = pattern<
  { notes: Cell<string[]> },
  { level: string; author: string }
>(({ notes }) => ({
  level: computed(() => spaceAccess(notes) ?? "unknown"),
  author: computed(() => principalOf(notes, "authored-by") ?? ""),
}));
"#,
        "Asked",
    );
    let text = source(&code);
    assert!(text.contains("spaceAccess($h.slot("), "{text}");
    assert!(
        text.contains("principalOf($h.slot(") && text.contains("\"authored-by\""),
        "{text}"
    );
    assert!(!text.contains("spaceAccess($h.v("), "{text}");
}
