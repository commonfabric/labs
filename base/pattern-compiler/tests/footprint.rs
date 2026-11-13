//! Footprint analysis (`footprint-analysis.md`): what a function body
//! reads and writes of its inputs. Each test takes its input and its
//! expected record from an example the document states, and names the
//! section.

use pattern_compiler::footprint::{footprints, Record};
use pattern_compiler::program::SourceFile;

const PRELUDE: &str = "import { Cell, equals, handler, lift, pattern, Stream, Writable, type ReadonlyCell } from \"commonfabric\";\n\
interface Donut { name: string; price: number; glaze?: string }\n";

/// The record of the body named `name`.
fn record(snippet: &str, name: &str) -> Record {
    let found = footprints(&[SourceFile {
        path: "case.tsx".to_string(),
        text: format!("{PRELUDE}{snippet}"),
    }]);
    found
        .into_iter()
        .find(|body| body.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("no body named {name}"))
        .record
}

fn reads(snippet: &str) -> Vec<String> {
    record(snippet, "f").reads
}

// ----- §3.1: access -----

#[test]
fn index_into_an_array_reads_every_element_at_the_path_and_consumes_the_index() {
    // "`rows[i].price` is `rows/*/price`", and the index is consumed.
    assert_eq!(
        reads("function f(rows: Donut[], i: number) { return rows[i].price + 1; }\n"),
        ["i : value", "rows : enumeration", "rows/*/price : value"]
    );
    let record = record(
        "function f(rows: Donut[], event: { position: number }) { return rows[event.position].price + 1; }\n",
        "f",
    );
    assert!(record.reads.contains(&"event.position : value".to_string()));
    assert!(record.widenings.is_empty(), "{:?}", record.widenings);
}

#[test]
fn navigation_observes_nothing_and_destructuring_extends_the_path() {
    assert_eq!(
        reads("function f(box: { donut: Donut; count: number }) { const { donut: { name }, count } = box; return name.length + count; }\n"),
        ["box.count : value", "box.donut/name : value"]
    );
}

#[test]
fn default_in_a_destructuring_records_shape() {
    // §3.1: "A default in a destructuring, `{ a = d }`": `shape` at `v.a`.
    assert_eq!(
        reads("function f(donut: Donut) { const { glaze = \"plain\" } = donut; return 1; }\n"),
        ["donut.glaze : shape"]
    );
}

// ----- §2.2: observations -----

#[test]
fn truthiness_of_a_union_takes_the_row_of_each_member() {
    // "a test of truthiness on `string | Donut` records `value` and
    // `shape`". In the normal form of §2.3 the `value` entry removes the
    // `shape` entry at its path, so the record shows the first alone. The
    // second case shows the `shape` the container member records.
    assert_eq!(
        reads("function f(x: string | Donut) { if (x) return 1; return 0; }\n"),
        ["x : value"]
    );
    assert_eq!(
        reads("function f(x: Donut | undefined) { if (x) return 1; return 0; }\n"),
        ["x : shape"]
    );
}

#[test]
fn test_the_type_decides_needs_no_entry_where_another_entry_is_at_the_path() {
    assert_eq!(
        reads(
            "function f(name: string) { return typeof name === \"string\" ? name.length : 0; }\n"
        ),
        ["name : value"]
    );
    // With no other entry at or below the path, the test records `shape`.
    assert_eq!(
        reads("function f(name: string) { return typeof name === \"string\" ? 1 : 0; }\n"),
        ["name : shape"]
    );
}

// ----- §2.3: the normal form -----

#[test]
fn value_entry_removes_the_shape_and_enumeration_entries_at_or_below_it() {
    assert_eq!(
        reads("function f(donut: Donut) { if (donut.glaze === undefined) return \"\"; return JSON.stringify(donut); }\n"),
        ["donut : value"]
    );
}

// ----- §3.4, §11.3: JSON.stringify -----

#[test]
fn stringify_of_a_built_array_reads_the_members_it_names_and_does_not_widen() {
    // "`JSON.stringify([space, requestId])` reads the members it names,
    // each by its own type."
    let record = record(
        "function f(input: { space: string; requestId: string; rest: Donut }) { return JSON.stringify([input.space, input.requestId]); }\n",
        "f",
    );
    assert_eq!(
        record.reads,
        ["input.requestId : value", "input.space : value"]
    );
    assert!(record.widenings.is_empty());
}

#[test]
fn stringify_of_an_input_container_is_widening_w2() {
    let record = record(
        "function f(donut: Donut) { return JSON.stringify(donut); }\n",
        "f",
    );
    assert_eq!(record.reads, ["donut : value"]);
    assert_eq!(record.widenings, ["W2"]);
}

// ----- §5.2: W1 -----

#[test]
fn key_that_is_not_static_on_a_record_widens_to_every_child_at_the_paths_read() {
    // "`prices[flavor].amount` reads `prices/*/amount` and the key set of
    // `prices`."
    let record = record(
        "function f(prices: Record<string, { amount: number; note: string }>, flavor: string) { return prices[flavor].amount * 2; }\n",
        "f",
    );
    assert_eq!(
        record.reads,
        [
            "flavor : value",
            "prices : enumeration",
            "prices/*/amount : value"
        ]
    );
    assert_eq!(record.widenings, ["W1"]);
}

// ----- §3.6: summaries -----

#[test]
fn helper_that_returns_a_part_of_its_argument_does_not_end_the_tracking() {
    assert_eq!(
        reads(
            "function donutOf(box: { donut: Donut; count: number }) { return box.donut; }\n\
             function f(input: { box: { donut: Donut; count: number } }) { return donutOf(input.box).name.length; }\n"
        ),
        ["input.box/donut/name : value"]
    );
}

#[test]
fn value_stored_in_a_local_container_and_read_back_does_not_widen() {
    // §5.2, "The following do not widen".
    let record = record(
        "function f(rows: Donut[]) { const kept = []; for (const row of rows) { kept.push(row); } return kept.map((row) => row.name.length); }\n",
        "f",
    );
    assert_eq!(record.reads, ["rows : enumeration", "rows/*/name : value"]);
    assert!(record.widenings.is_empty());
}

// ----- §3.8: what leaves the body -----

#[test]
fn record_moved_from_one_list_to_another_is_not_read() {
    // "a body that moves a record from one list to another does not read
    // the record".
    let record = record(
        "function f(from: Cell<Donut[]>, to: Cell<Donut[]>, i: number) { to.push(from.get()[i]); }\n",
        "f",
    );
    assert_eq!(
        record.reads,
        [
            "from : identity",
            "from-> : enumeration",
            "from->/* : identity",
            "i : value",
            "to : identity"
        ]
    );
    assert_eq!(record.writes, ["to"]);
}

// ----- §7.1: handles -----

#[test]
fn read_through_a_handle_is_a_hop_followed_by_ordinary_accesses() {
    // "`box.get()?.label` is the projection `box->label`, with `shape` at
    // `box->` when the cell may hold no value".
    assert_eq!(
        reads("function f(box: Cell<{ label: string } | undefined>) { return (box.get()?.label ?? \"\").length; }\n"),
        ["box : identity", "box-> : shape", "box->label : value"]
    );
}

#[test]
fn get_on_a_handle_that_holds_a_handle_returns_the_inner_handle() {
    // "`outer.get().get()` is the projection `outer->->` and records
    // `identity` at `outer->` as well."
    assert_eq!(
        reads("function f(outer: Cell<Cell<number>>) { return outer.get().get() + 1; }\n"),
        [
            "outer : identity",
            "outer-> : identity",
            "outer->-> : value"
        ]
    );
}

#[test]
fn key_flattens_and_the_identity_entries_are_recorded_where_the_handle_is_used() {
    // "`h.key(\"a\").get()`: `identity` at `h` and at `h->a`. The result
    // is the projection `h->a->`".
    assert_eq!(
        reads("function f(h: Cell<{ a: Cell<number> }>) { return h.key(\"a\").get() + 1; }\n"),
        ["h : identity", "h->a : identity", "h->a-> : value"]
    );
    // `key` alone records nothing.
    assert_eq!(
        reads(
            "function f(h: Cell<{ a: Cell<number> }>) { const inner = h.key(\"a\"); return 1; }\n"
        ),
        [] as [&str; 0]
    );
}

// ----- §7.2: static and dynamic reads -----

#[test]
fn read_is_static_when_anchored_and_unconditional() {
    let record = record(
        "function f(count: Cell<number>) { return count.get() + 1; }\n",
        "f",
    );
    assert_eq!(record.static_reads, 1);
    assert!(record.dynamic_reads.is_empty());
}

#[test]
fn read_in_a_branch_stays_dynamic() {
    // "A body that reads `secret.get()` in one branch".
    let record = record(
        "function f(flag: boolean, secret: Cell<string>) { if (flag) { return secret.get().length; } return 0; }\n",
        "f",
    );
    assert_eq!(record.dynamic_reads, ["secret: conditional"]);
    assert_eq!(record.envelope, ["secret-> : value"]);
    assert_eq!(record.reads, ["flag : value", "secret : identity"]);
}

#[test]
fn read_through_alternatives_is_dynamic() {
    // "`(event.donut ?? state.donut).get()`".
    let record = record(
        "const f = handler<{ donut?: Cell<Donut> }, { donut: Cell<Donut> }>((event, state) => { const d = (event.donut ?? state.donut).get(); state.donut.set(d); });\n",
        "f",
    );
    assert_eq!(
        record.dynamic_reads,
        ["event.donut, state.donut: alternatives"]
    );
}

#[test]
fn read_conditional_only_on_the_handle_being_present_counts_as_unconditional() {
    // "`profile?.get()` where `profile` may be `undefined`".
    let record = record(
        "function f(profile: Cell<{ name: string }> | undefined) { return profile?.get().name.length; }\n",
        "f",
    );
    assert_eq!(record.static_reads, 1);
    assert_eq!(
        record.reads,
        ["profile : identity, shape", "profile->name : value"]
    );
}

#[test]
fn read_through_an_element_of_a_list_of_handles_is_dynamic() {
    let record = record(
        "function f(rooms: Cell<number>[], i: number) { return rooms[i].get() + 1; }\n",
        "f",
    );
    assert_eq!(record.dynamic_reads, ["rooms/*: not anchored"]);
}

// ----- §12.2, step 7, and §12.3 -----

#[test]
fn composer_step_of_the_worked_example() {
    let record = record(
        "interface Composer { editing?: Cell<Donut>; text: string }\n\
         const f = handler<unknown, { composer: Cell<Composer>; target: Cell<Donut> }>((_, { composer, target }) => {\n\
           const editing = composer.get()?.editing;\n\
           if (editing !== undefined && equals(editing, target)) {\n\
             composer.key(\"editing\").set(undefined);\n\
           }\n\
         });\n",
        "f",
    );
    assert_eq!(
        record.reads,
        [
            "state.composer : identity",
            "state.composer->editing : identity, shape",
            "state.target : identity"
        ]
    );
    assert_eq!(record.writes, ["state.composer->editing"]);
    assert_eq!(record.static_reads, 1);
    assert!(record.widenings.is_empty());
}

// ----- §6.2: write targets -----

#[test]
fn write_under_a_key_that_is_not_static_has_no_static_target() {
    let record = record(
        "const f = handler<{ id: string }, { rows: Cell<Record<string, Donut>> }>((event, state) => { state.rows.key(event.id).set({ name: \"a\", price: 1 }); });\n",
        "f",
    );
    assert_eq!(record.writes, ["state.rows->/* (dynamic)"]);
    assert_eq!(record.reads, ["event.id : value", "state.rows : identity"]);
}

// ----- §3.4, §3.5: local containers and library callbacks -----

#[test]
fn record_kept_in_a_local_map_is_updated_without_a_widening() {
    // §3.4: `set` puts the value in, and compares the key. §3.5: a member
    // assignment on a record the body built is not an update of an input.
    let record = record(
        "function f(rows: Donut[]) {\n\
           const by = new Map<string, { n: number }>();\n\
           for (const row of rows) {\n\
             let stat = by.get(row.name);\n\
             if (!stat) { stat = { n: 0 }; by.set(row.name, stat); }\n\
             stat.n += 1;\n\
           }\n\
           return by.size;\n\
         }\n",
        "f",
    );
    assert_eq!(record.widenings, [] as [&str; 0]);
    assert_eq!(record.reads, ["rows : enumeration", "rows/*/name : value"]);
}

#[test]
fn library_function_given_as_a_callback_is_a_resolved_call() {
    let record = record(
        "function f(rows: (string | undefined)[]) { return rows.filter(Boolean).length; }\n",
        "f",
    );
    assert_eq!(record.widenings, [] as [&str; 0]);
}
