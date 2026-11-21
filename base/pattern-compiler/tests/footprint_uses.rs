//! Footprint analysis (`footprint-analysis.md`), the parts that complete
//! the record: the write edges with references of §6.5, the `{ call }`
//! entries of `Body.handles` (§7.2, §8.1, §8.2), a binding made in a body
//! (§8.5), and the split of the entries into `reads` and `computed` for one
//! use of a body (§1.1).

use std::collections::BTreeSet;

use pattern_compiler::footprint::{bind_use, footprints, Record};
use pattern_compiler::program::SourceFile;

const PRELUDE: &str = "import { Cell, Stream, Writable, handler, lift, pattern, spaceOf, principalOf } from \"commonfabric\";\n\
interface Donut { name: string; price: number; glaze?: string }\n\
interface Message { body: string; editedAt: number }\n\
const Child = pattern<{ donut: Donut; n: number }>(({ donut }) => ({ donut }));\n";

fn analyze(snippet: &str) -> Record {
    let found = footprints(&[SourceFile {
        path: "case.tsx".to_string(),
        text: format!("{PRELUDE}{snippet}"),
    }]);
    found
        .into_iter()
        .find(|body| body.name.as_deref() == Some("f"))
        .unwrap_or_else(|| panic!("no body named f"))
        .record
}

fn has(lines: &[String], line: &str) -> bool {
    lines.iter().any(|other| other == line)
}

fn computed(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|name| name.to_string()).collect()
}

// ----- §6.5: the label of a written value -----

#[test]
fn a_write_is_an_edge_at_the_cell_of_its_handle() {
    let record = analyze(
        "const f = handler<{ n: number }, { out: Cell<number>; list: Cell<number[]> }>((event, state) => { state.out.set(event.n); state.list.push(event.n); });\n",
    );
    assert_eq!(
        record.edges,
        ["handle state.list *", "handle state.out"],
        "{:?}",
        record.edges
    );
    assert!(record.envelopes.is_empty(), "{:?}", record.envelopes);
}

#[test]
fn a_path_of_a_written_value_that_holds_one_projection_is_an_edge_that_passes_it() {
    // "A path that holds one projection of container, handle, reference,
    // or factory type, whose path has no `*` segment, is a reference the
    // body passed on ... The plan records a path of the first two kinds
    // as a `WriteEdge` of its own. Its target is the sub-path, and its
    // `reference` member names the entry, as `passes`".
    let record = analyze(
        "const f = handler<{ text: string }, { profile: Cell<Donut>; out: Cell<{ author: Cell<Donut>; text: string }[]> }>((event, state) => { state.out.push({ author: state.profile, text: event.text }); });\n",
    );
    assert_eq!(
        record.edges,
        [
            "handle state.out *",
            "handle state.out */author : passes state.profile"
        ]
    );
}

#[test]
fn alternatives_and_an_entry_at_a_star_are_named_as_one_of() {
    // "A path that holds one such projection whose path has a `*`
    // segment, or alternatives of such projections, is a reference the
    // body chose ... otherwise the entry or the entries the reference is
    // one of, as `oneOf`."
    let alternatives = analyze(
        "const f = handler<{ a?: Cell<Donut> }, { b: Cell<Donut>; out: Cell<Cell<Donut>> }>((event, state) => { state.out.set(event.a ?? state.b); });\n",
    );
    assert_eq!(
        alternatives.edges,
        [
            "handle state.out",
            "handle state.out : oneOf event.a, state.b"
        ]
    );
    let star = analyze(
        "const f = handler<{ files: Cell<Donut>[] }, { out: Cell<{ files: Cell<Donut>[] }[]> }>((event, state) => { state.out.push({ files: [...event.files] }); });\n",
    );
    assert_eq!(
        star.edges,
        [
            "handle state.out *",
            "handle state.out */files/* : oneOf event.files/*"
        ]
    );
}

#[test]
fn a_write_whose_target_is_not_static_is_an_envelope() {
    // FA §6.2: a `*` segment of the path "stands for a child the analysis
    // could not name".
    let record = analyze(
        "const f = handler<{ id: string; n: number }, { table: Cell<Record<string, number>> }>((event, state) => { state.table.key(event.id).set(event.n); });\n",
    );
    assert!(record.edges.is_empty(), "{:?}", record.edges);
    assert_eq!(record.envelopes, ["handle state.table *"]);
}

#[test]
fn the_initial_value_of_a_created_cell_is_an_edge_with_target_created() {
    // §8.2: "The initial value is a `WriteEdge` with target `created`".
    let record = analyze(
        "const f = handler<{ n: number }, { out: Cell<unknown> }>((event, state) => { state.out.set(Cell.of(event.n)); });\n",
    );
    assert_eq!(record.calls, ["createCell:order"]);
    assert!(has(&record.edges, "created n0"), "{:?}", record.edges);
}

#[test]
fn the_argument_of_an_instantiation_is_an_edge_with_its_references() {
    // §6.5: "The same holds for a path of a child's argument and of an
    // effect's request."
    let record = analyze(
        "const f = handler<{ donut: Donut; n: number }, { out: Cell<unknown> }>((event, state) => { state.out.set(Child({ donut: event.donut, n: event.n })); });\n",
    );
    assert!(has(&record.edges, "argument n0"), "{:?}", record.edges);
    assert!(
        has(&record.edges, "argument n0 donut : passes event.donut"),
        "{:?}",
        record.edges
    );
}

// ----- §7.2, §8.2: the `{ call }` entries of `Body.handles` -----

#[test]
fn a_read_through_a_cell_created_under_a_cause_is_a_handle_entry_that_names_the_site() {
    // §8.2: "A read through the handle is dynamic, by the paragraph
    // above, and the site is an entry of `Body.handles` whose `handle` is
    // `{ call }`."
    let record = analyze(
        "const f = handler<{ id: string }, { out: Cell<number> }>((event, state) => { const seen = Cell.for<number>(event.id); state.out.set(seen.get() + 1); });\n",
    );
    assert_eq!(record.calls, ["createCell:cause"]);
    assert_eq!(record.handles, ["call n0"]);
    let order = analyze(
        "const f = handler<{ n: number }, { out: Cell<number> }>((event, state) => { const made = Cell.of<number>(event.n); state.out.set(made.get() + 1); });\n",
    );
    assert!(order.handles.is_empty(), "{:?}", order.handles);
}

#[test]
fn a_handle_read_on_some_runs_only_is_an_entry_with_its_envelope() {
    let record = analyze(
        "const f = handler<{ ok: boolean }, { message: Cell<Message>; out: Cell<string> }>((event, state) => { if (event.ok) { state.out.set(state.message.get().body); } });\n",
    );
    assert_eq!(record.handles, ["state.message"]);
    let detail = &record.detail.handles[0];
    let envelope: Vec<String> = detail
        .envelope
        .iter()
        .map(|entry| entry.to_string())
        .collect();
    assert_eq!(envelope, ["state.message->body : value"]);
}

// ----- §8.5: binding a handler -----

#[test]
fn an_inline_event_handler_in_jsx_a_body_builds_is_a_bind_site() {
    // "A binding is made by `action(...)`, by an inline event handler in
    // JSX the body builds, or by applying a handler to its state."
    let record = analyze(
        "const f = lift((x: { count: Cell<number> }) => <button onClick={() => x.count.set(1)}>+</button>);\n",
    );
    assert_eq!(record.calls, ["bind"]);
}

#[test]
fn a_copied_scalar_is_recorded_in_the_class_the_handler_observes_it_in() {
    // The table of §8.5: a scalar the handler has `value` at records
    // `value`, one it has `shape` at records `shape`, and one it has no
    // entry at records nothing.
    let record = analyze(
        "const h = handler<{ k: string }, { n: number; seen?: number; unused: string; out: Cell<number> }>((event, state) => { if (state.seen !== undefined) { state.out.set(state.n); } });\n\
         const f = lift((x: { n: number; seen?: number; unused: string; out: Cell<number> }) => h({ n: x.n, seen: x.seen, unused: x.unused, out: x.out }));\n",
    );
    assert_eq!(record.calls, ["bind"]);
    assert_eq!(
        record.reads,
        ["x.n : value", "x.out : identity", "x.seen : shape"]
    );
}

#[test]
fn a_scalar_an_inline_handler_captures_is_recorded_as_the_handler_observes_it() {
    let record = analyze(
        "const f = lift(({ n, m, out }: { n: number; m: number; out: Cell<number> }) => <button onClick={() => out.set(n)}>+</button>);\n",
    );
    assert_eq!(record.reads, ["arg0.n : value", "arg0.out : identity"]);
}

// ----- §1.1: `reads` and `computed` for one use of a body -----

#[test]
fn an_entry_on_an_input_bound_to_a_computed_value_is_an_entry_of_computed() {
    // "An input bound to a slot root ... gives entries of `Body.reads` ...
    // An input bound to a value the instance computed ... gives entries
    // of `Body.computed`".
    let record =
        analyze("const f = lift((x: { a: { n: number }; b: { m: number } }) => x.a.n + x.b.m);\n");
    let whole = bind_use(&record, &computed(&["x"]));
    assert!(whole.reads.is_empty(), "{:?}", whole.reads);
    assert_eq!(whole.computed_lines(), ["x.a/n : value", "x.b/m : value"]);
    let none = bind_use(&record, &computed(&[]));
    assert_eq!(none.read_lines(), ["x.a/n : value", "x.b/m : value"]);
    assert!(none.computed.is_empty());
}

#[test]
fn a_static_read_through_a_handle_from_a_computed_input_is_dynamic() {
    // §7.2: "Where the body is used with the handle's formal input bound
    // to a value the instance computed, the plan cannot name the path,
    // and the read is dynamic there whatever the conditions say: the
    // handle's entry of `Body.handles` names its `identity` entry of
    // `Body.computed`".
    let record =
        analyze("const f = lift((x: { message: Cell<Message> }) => x.message.get().body);\n");
    assert_eq!(
        record.reads,
        ["x.message : identity", "x.message->body : value"]
    );
    assert!(record.handles.is_empty());
    let used = bind_use(&record, &computed(&["x"]));
    assert_eq!(used.computed_lines(), ["x.message : identity"]);
    assert!(used.reads.is_empty());
    assert_eq!(used.handle_lines(), ["computed 0"]);
    let envelope: Vec<String> = used.handles[0]
        .envelope
        .iter()
        .map(|entry| entry.to_string())
        .collect();
    assert_eq!(envelope, ["x.message->body : value"]);
}

#[test]
fn a_resolution_and_a_label_metadata_observation_of_a_computed_input_are_journaled() {
    // §8.4, "An operand from a computed input": "the resolution and the
    // observation of label metadata are journaled whatever the
    // conditions say ... a dynamic read of kind `link` or of kind
    // `space` names it by the body and the entry's index there".
    let record =
        analyze("const f = lift((x: { message: Cell<Message> }) => principalOf(x.message));\n");
    assert!(
        has(
            &record.reads,
            "x.message : identity (resolved), labelMetadata"
        ),
        "{:?}",
        record.reads
    );
    let used = bind_use(&record, &computed(&["x"]));
    assert_eq!(used.computed_lines(), ["x.message : identity"]);
    assert_eq!(used.links, ["computed 0"]);
    assert!(used.label_metadata);
    let slot = bind_use(&record, &computed(&[]));
    assert!(slot.links.is_empty());
    assert!(!slot.label_metadata);
}

// ----- PL §6.2: the send handler of the worked example -----

#[test]
fn commit_send_has_the_handles_calls_writes_and_envelopes_of_pl_section_6_2() {
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
    let record = footprints(&files)
        .into_iter()
        .find(|body| body.name.as_deref() == Some("commitSend"))
        .expect("commitSend")
        .record;
    // "handles h0 slot e3 each attachment, h1 slot e5 the reply's thread
    // root, h2 slot e6 the quoted message, h3 slot b3 threadInfo".
    assert_eq!(
        record.handles,
        [
            "event.attachments/*",
            "event.replyTo/quotes",
            "event.replyTo/thread",
            "state.threadInfo"
        ]
    );
    // "calls n0 createCell, identified by order".
    assert_eq!(record.calls, ["createCell:order"]);
    // w0 to w5, and the "two further reference edges, at
    // `*/replyTo/thread` and `*/replyTo/quotes` of the pushed value" the
    // listing leaves out. w4 is `addUnique`, which appends, so its path
    // is `*` where the listing shows none (SPEC-NOTES 88).
    assert_eq!(
        record.edges,
        [
            "created n0",
            "handle state.joined",
            "handle state.messages *",
            "handle state.messages */attachments/* : oneOf event.attachments/*",
            "handle state.messages */authorProfile : passes state.myProfile (resolved)",
            "handle state.messages */replyTo/quotes : passes event.replyTo/quotes",
            "handle state.messages */replyTo/thread : passes event.replyTo/thread",
            "handle state.threadInfo *",
        ]
    );
    // "envelopes handle b3 *".
    assert_eq!(record.envelopes, ["handle state.threadInfo *"]);
}
