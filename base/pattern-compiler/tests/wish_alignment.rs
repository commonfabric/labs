//! `wish` and constants, as `plan-and-label-templates.md` §3.19 (cited as
//! PL) and `language-subset.md` §10.2 (cited as LS) have them.

use pattern_compiler::program::{analyze, ProgramAnalysis, SourceFile};
use serde_json::{json, Value};

fn analysis(text: &str) -> ProgramAnalysis {
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: text.to_string(),
    }]);
    assert!(analysis.failures.is_empty(), "{:?}", analysis.failures);
    analysis
}

fn ids(analysis: &ProgramAnalysis) -> Vec<&'static str> {
    analysis
        .modules
        .iter()
        .flat_map(|module| &module.diagnostics)
        .filter(|diagnostic| diagnostic.is_error() || diagnostic.id.starts_with("wish:"))
        .map(|diagnostic| diagnostic.id)
        .collect()
}

#[test]
fn a_wish_with_a_string_argument_is_a_type_mismatch() {
    // The API declares `wish` with one parameter, the record of its
    // operands (`WishFunction` in `base/api/index.ts`), so a string is
    // not assignable to it.
    let refused = analysis(
        "import { pattern, wish } from \"commonfabric\";
export const P = pattern<{ n: number }>(({ n }) => ({ found: wish<{ name: string }>(\"#note\") }));
",
    );
    assert_eq!(ids(&refused), ["subset-type:mismatch"]);
    let accepted = analysis(
        "import { pattern, wish } from \"commonfabric\";
export const P = pattern<{ n: number }>(({ n }) => ({ found: wish<{ name: string }>({ query: \"#note\" }) }));
",
    );
    assert!(ids(&accepted).is_empty(), "{:?}", ids(&accepted));
}

const QUERIES: &str = "import { pattern, wish } from \"commonfabric\";
const FAVORITES = \"#favorites\";
export const Named = pattern<{ tag: string }>(({ tag }) => ({ found: wish<{ title: string }>({ query: FAVORITES }) }));
export const Computed = pattern<{ tag: string }>(({ tag }) => ({ found: wish<{ title: string }>({ query: tag }) }));
export const Clock = pattern<{ steps: string[] }>(({ steps }) => ({ now: wish<number>({ query: \"#now\", path: steps }) }));
";

fn plan<'a>(analysis: &'a ProgramAnalysis, name: &str) -> &'a Value {
    &analysis.modules[0]
        .plans
        .iter()
        .find(|plan| plan.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("no plan {name}"))
        .plan
}

#[test]
fn a_query_written_as_the_name_of_a_module_constant_is_a_constant() {
    // PL §3.19, "What counts as a constant": "a literal written at the
    // call, or a name that resolves to a module-scope constant with a
    // static initializer ... whose value the compiler reads." The row
    // of `#favorites`: "`Operation.scope` is `user`", and nothing else.
    let analysis = analysis(QUERIES);
    let named = plan(&analysis, "Named");
    assert_eq!(named["operations"][0]["scope"], json!("user"));
    assert_eq!(named["stateCells"], json!([]));
    assert_eq!(named["children"], json!([]));
    // "A query that is not a constant": "the plan has the `StateCell` of
    // the one-shot clock and a `Child` for each of the three sidecars."
    let computed = plan(&analysis, "Computed");
    assert_eq!(computed["stateCells"].as_array().map(Vec::len), Some(1));
    assert_eq!(computed["children"].as_array().map(Vec::len), Some(3));
}

#[test]
fn a_computed_query_and_a_computed_path_of_a_clock_are_a_hint() {
    // LS §10.2: "`wish:computed-query` | hint | A `wish` whose `query`,
    // or whose `path` with the key `#now` or `#profile`, is not a
    // constant."
    let analysis = analysis(QUERIES);
    let hints: Vec<(u32, bool)> = analysis.modules[0]
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.id == "wish:computed-query")
        .map(|diagnostic| (diagnostic.line, diagnostic.is_error()))
        .collect();
    assert_eq!(hints, [(4, false), (5, false)]);
}

#[test]
fn a_binding_to_a_named_module_constant_holds_its_value() {
    // PL §1.1, `Binding.state`: a path bound to a constant has
    // `place: { constant }`, and a module-scope constant with a static
    // initializer is a constant whose value the compiler reads.
    let analysis = analysis(
        "import { Cell, handler, pattern } from \"commonfabric\";
const MODE = \"fast\";
const LIMITS = { low: 1, high: 2 };
const set = handler<{ n: number }, { mode: string; limits: { low: number; high: number }; count: Cell<number> }>((event, state) => {
  state.count.set(event.n + state.limits.low + state.mode.length);
});
export const P = pattern<{ count: Cell<number> }>(({ count }) => ({ set: set({ mode: MODE, limits: LIMITS, count }) }));
",
    );
    assert!(ids(&analysis).is_empty(), "{:?}", ids(&analysis));
    let state = analysis.modules[0].plans[0].plan["bindings"][0]["state"].clone();
    let at = |path: &str| {
        state
            .as_array()
            .expect("state")
            .iter()
            .find(|entry| entry["path"] == json!([path]))
            .unwrap_or_else(|| panic!("no entry at {path}"))["place"]
            .clone()
    };
    assert_eq!(at("mode"), json!({ "constant": "fast" }));
    assert_eq!(at("limits"), json!({ "constant": { "low": 1, "high": 2 } }));
}

#[test]
fn a_write_through_a_created_cell_has_the_path_below_the_cell() {
    // PL §3.11, `createCell`: "A `WriteEdge` with target `created` ...
    // The target's `path` is the path of the write below the cell: empty
    // for a `set` of the whole".
    let analysis = analysis(
        "import { Cell, Writable, handler, pattern } from \"commonfabric\";
const make = handler<{ n: number }, { list: Cell<Cell<{ a: number; tags: string[] }>[]> }>((event, state) => {
  const made = Writable.of<{ a: number; tags: string[] }>({ a: 0, tags: [] });
  made.key(\"a\").set(event.n);
  made.key(\"tags\").push(\"new\");
  state.list.push(made);
});
export const P = pattern<{ list: Cell<Cell<{ a: number; tags: string[] }>[]> }>(({ list }) => ({ make: make({ list }) }));
",
    );
    assert!(ids(&analysis).is_empty(), "{:?}", ids(&analysis));
    let writes = analysis.modules[0].plans[0].plan["bodies"][0]["writes"].clone();
    let mut created: Vec<Value> = writes
        .as_array()
        .expect("writes")
        .iter()
        .filter(|write| write["target"]["kind"] == "created")
        .map(|write| write["target"]["path"].clone())
        .collect();
    created.sort_by_key(|path| path.as_array().map_or(0, Vec::len));
    assert_eq!(created, [json!([]), json!(["a"]), json!(["tags", "*"])]);
}
