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
fn types_are_removed_and_the_function_of_a_pattern_is_left_out() {
    let (_, code) = emitted(
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
    assert!(text.contains("pattern(undefined)"), "{text}");
    // The handler's body is one function, called with the event and the
    // state.
    assert!(text.contains("$rt.body(0, ($e, $s) => ("), "{text}");
}

#[test]
fn a_state_cell_has_a_function_for_its_first_value() {
    let (_, code) = emitted(
        r#"import { pattern, Writable } from "commonfabric";
export const P = pattern<{ note: string }>(({ note }) => {
  const count = Writable.of(7);
  return { count, note };
});
"#,
        "P",
    );
    let text = source(&code);
    assert!(text.contains("$rt.state(0, ($h) => ((7)));"), "{text}");
    assert_eq!(code["states"], json!([0]));
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
    // the plan's `Cone` record does not say so.
    let cone = plan["outputs"]
        .as_array()
        .expect("outputs")
        .iter()
        .find(|output| output["collection"] == json!(0))
        .expect("the assembled output")["cone"]
        .as_u64()
        .expect("a cone") as usize;
    assert_eq!(code["coneWithin"][cone], json!([0]));
    assert!(plan["cones"][cone].get("within").is_none());
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
        text.contains("$rt.setups[1]({ \"mark\": \"!\" }, $h);"),
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
    let layout = code["layouts"]["0"].as_array().expect("a layout");
    assert!(
        layout.contains(&json!({ "slot": title, "at": ["title"] })),
        "{layout:?}"
    );
    // `Body.reads` holds the slot, and no member of the plan says where
    // it sits in the argument.
    assert!(plan["bodies"][0]["reads"]
        .as_array()
        .expect("reads")
        .contains(&json!(title)));
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
