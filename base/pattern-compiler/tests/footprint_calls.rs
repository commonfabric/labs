//! Footprint analysis (`footprint-analysis.md`), the parts beyond reads
//! and write targets: the runtime calls and context reads of §8, the
//! resolutions of §7.1, `Body.outputs` (§3.8), the write side of §6.3 and
//! §6.6, and the cause W6 of §5.2.

use pattern_compiler::footprint::{footprints, Record};
use pattern_compiler::program::SourceFile;

const PRELUDE: &str = "import { Cell, Stream, Writable, currentPrincipal, eventKey, equals, handler, lift, linksOf, navigateTo, pattern, principalOf, resultOwnerOf, spaceAccess, spaceOf } from \"commonfabric\";\n\
interface Donut { name: string; price: number; glaze?: string }\n\
interface Message { body: string; editedAt: number }\n\
interface Box { label: string; children: Box[] }\n\
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

// ----- §8.1: instantiating a pattern -----

#[test]
fn an_instantiation_is_a_site_and_its_argument_leaves_by_reference() {
    let record = analyze(
        "const f = handler<{ donut: Donut; n: number }, { out: Cell<unknown> }>((event, state) => { state.out.set(Child({ donut: event.donut, n: event.n })); });\n",
    );
    assert_eq!(record.calls, ["instantiate:order"]);
    assert!(
        has(&record.reads, "event.donut : identity"),
        "{:?}",
        record.reads
    );
    assert!(has(&record.reads, "event.n : value"), "{:?}", record.reads);
}

#[test]
fn for_on_an_instantiation_identifies_the_site_by_tag_and_the_tag_leaves_the_body() {
    // "`.for(tag)`: The tag by the reference rule. The site is
    // `identifiedBy: \"tag\"`."
    let record = analyze(
        "const f = handler<{ donut: Donut; n: number; id: string }, { out: Cell<unknown> }>((event, state) => { state.out.set(Child({ donut: event.donut, n: 1 }).for(event.id)); });\n",
    );
    assert_eq!(record.calls, ["instantiate:tag"]);
    assert!(has(&record.reads, "event.id : value"), "{:?}", record.reads);
}

// ----- §8.2: creating a cell -----

#[test]
fn a_cell_created_in_a_handler_is_identified_by_order_or_by_its_cause() {
    let order = analyze(
        "const f = handler<{ n: number }, { out: Cell<unknown> }>((event, state) => { state.out.set(Cell.of(event.n)); });\n",
    );
    assert_eq!(order.calls, ["createCell:order"]);
    assert!(has(&order.reads, "event.n : value"), "{:?}", order.reads);
    let cause = analyze(
        "const f = handler<{ id: string }, { out: Cell<unknown> }>((event, state) => { state.out.set(Cell.for(event.id)); });\n",
    );
    assert_eq!(cause.calls, ["createCell:cause"]);
    assert!(has(&cause.reads, "event.id : value"), "{:?}", cause.reads);
}

#[test]
fn a_cell_a_computation_creates_is_a_state_cell_under_a_constant_cause_and_makes_a_materializer_under_data(
) {
    let constant = analyze(
        "const f = lift((x: { n: number }) => { const c = Cell.for(\"total\"); return x.n; });\n",
    );
    assert_eq!(constant.calls, ["createCell:cause (state)"]);
    assert_eq!(constant.tier, Some("static side-write"));
    let data = analyze(
        "const f = lift((x: { id: string }) => { const c = Cell.for(x.id); return 1; });\n",
    );
    assert_eq!(data.calls, ["createCell:cause (data)"]);
    assert_eq!(data.tier, Some("materializer"));
    assert!(has(&data.reads, "x.id : value"), "{:?}", data.reads);
}

// ----- §8.3: requesting an effect -----

#[test]
fn navigate_to_records_identity_at_its_target() {
    // "`navigateTo(target)` is `identity` at `target`".
    let record = analyze(
        "const f = handler<{ donut: Donut }, {}>((event) => { navigateTo(event.donut); });\n",
    );
    assert_eq!(record.calls, ["effect:navigateTo"]);
    assert_eq!(record.reads, ["event.donut : identity"]);
}

// ----- §8.4: reading context -----

#[test]
fn the_event_key_and_the_principal_are_cause_entries() {
    // §12.3: "cause   principal : value".
    let record = analyze(
        "const f = handler<{ n: number }, { out: Cell<string> }>((event, state) => { state.out.set(currentPrincipal() + eventKey()); });\n",
    );
    assert!(
        has(&record.reads, "cause.principal : value"),
        "{:?}",
        record.reads
    );
    assert!(
        has(&record.reads, "cause.eventKey : value"),
        "{:?}",
        record.reads
    );
}

#[test]
fn an_unconditional_resolution_of_one_anchored_operand_is_a_resolved_entry() {
    let record = analyze(
        "const f = handler<{ n: number }, { room: Cell<unknown>; out: Cell<unknown> }>((event, state) => { state.out.set(spaceOf(state.room)); });\n",
    );
    assert!(
        has(&record.reads, "state.room : identity (resolved)"),
        "{:?}",
        record.reads
    );
    assert!(
        record.other_dynamic.is_empty(),
        "{:?}",
        record.other_dynamic
    );
}

#[test]
fn a_conditional_resolution_is_journaled_through_a_plain_entry() {
    // §12.2 step 2: "both calls of `spaceOf` are in the right operand of
    // `||`. Each records a plain `identity` entry".
    let record = analyze(
        "const f = handler<{ ok: boolean }, { room: Cell<unknown>; out: Cell<unknown> }>((event, state) => { if (event.ok) { state.out.set(spaceOf(state.room)); } });\n",
    );
    assert!(
        has(&record.reads, "state.room : identity"),
        "{:?}",
        record.reads
    );
    assert_eq!(record.other_dynamic, ["link: state.room"]);
}

#[test]
fn a_resolution_of_alternatives_is_journaled_at_each() {
    let record = analyze(
        "const f = handler<{ message?: Cell<Message> }, { message: Cell<Message>; out: Cell<unknown> }>((event, state) => { state.out.set(spaceOf(event.message ?? state.message)); });\n",
    );
    assert!(
        has(&record.reads, "event.message : identity, shape"),
        "{:?}",
        record.reads
    );
    assert!(
        has(&record.reads, "state.message : identity"),
        "{:?}",
        record.reads
    );
    assert_eq!(record.other_dynamic, ["link: event.message, state.message"]);
}

#[test]
fn principal_of_resolves_its_operand_and_observes_its_label_metadata() {
    let fixed = analyze(
        "const f = handler<{ n: number }, { message: Cell<Message>; out: Cell<unknown> }>((event, state) => { state.out.set(principalOf(state.message)); });\n",
    );
    assert!(
        has(
            &fixed.reads,
            "state.message : identity (resolved), labelMetadata"
        ),
        "{:?}",
        fixed.reads
    );
    let journaled = analyze(
        "const f = handler<{ ok: boolean }, { message: Cell<Message>; out: Cell<unknown> }>((event, state) => { if (event.ok) { state.out.set(principalOf(state.message)); } });\n",
    );
    assert!(
        has(&journaled.reads, "state.message : identity"),
        "{:?}",
        journaled.reads
    );
    assert_eq!(
        journaled.other_dynamic,
        ["labelMetadata", "link: state.message"]
    );
}

#[test]
fn equals_decides_the_resolution_of_each_operand_on_its_own() {
    // "`equals(a, b)`: A resolution of `a` and one of `b`, each decided on
    // its own."
    let record = analyze(
        "const f = handler<{ a?: Cell<Message>; b?: Cell<Message> }, { message: Cell<Message>; out: Cell<boolean> }>((event, state) => { state.out.set(equals(state.message, event.a ?? event.b)); });\n",
    );
    assert!(
        has(&record.reads, "state.message : identity (resolved)"),
        "{:?}",
        record.reads
    );
    assert_eq!(record.other_dynamic, ["link: event.a, event.b"]);
}

#[test]
fn an_access_list_read_is_a_resolution_and_a_dynamic_read_of_kind_space() {
    let record = analyze(
        "const f = handler<{ n: number }, { room: Cell<unknown>; out: Cell<unknown> }>((event, state) => { state.out.set(spaceAccess(state.room)); });\n",
    );
    assert!(
        has(&record.reads, "state.room : identity (resolved)"),
        "{:?}",
        record.reads
    );
    assert_eq!(record.other_dynamic, ["space: state.room"]);
}

#[test]
fn result_owner_of_never_records_a_resolved_entry() {
    let record = analyze(
        "const f = handler<{ n: number }, { room: Cell<unknown>; out: Cell<unknown> }>((event, state) => { state.out.set(resultOwnerOf(state.room)); });\n",
    );
    assert!(
        has(&record.reads, "state.room : identity"),
        "{:?}",
        record.reads
    );
    assert_eq!(record.other_dynamic, ["link: state.room"]);
}

#[test]
fn links_of_enumerates_the_list_and_records_identity_at_each_element() {
    let record = analyze(
        "const f = handler<{ rows: Donut[] }, { out: Cell<unknown> }>((event, state) => { state.out.set(linksOf(event.rows)); });\n",
    );
    assert!(
        has(&record.reads, "event.rows : enumeration"),
        "{:?}",
        record.reads
    );
    assert!(
        has(&record.reads, "event.rows/* : identity"),
        "{:?}",
        record.reads
    );
}

// ----- §7.1: resolutions; §6.2: a write through a resolved handle -----

#[test]
fn resolve_as_cell_records_a_resolved_entry_and_a_write_through_it_has_the_flag() {
    let record = analyze(
        "const f = handler<{ text: string }, { message: Cell<Message> }>((event, state) => { const target = state.message.resolveAsCell(); target.key(\"body\").set(event.text); });\n",
    );
    assert!(
        has(&record.reads, "state.message : identity (resolved)"),
        "{:?}",
        record.reads
    );
    assert_eq!(record.writes, ["state.message (resolved)->body"]);
}

#[test]
fn a_conditional_resolve_as_cell_is_journaled_and_the_write_names_the_plain_entry_with_the_flag() {
    // §12.2 step 6: "Each target has `resolved` ... and names the plain
    // `identity` slot the body has at the handle, since the resolution is
    // journaled."
    let record = analyze(
        "const f = handler<{ text: string; message?: Cell<Message> }, { message: Cell<Message> }>((event, state) => { const target = (event.message ?? state.message).resolveAsCell(); target.key(\"body\").set(event.text); });\n",
    );
    assert!(
        has(&record.reads, "state.message : identity"),
        "{:?}",
        record.reads
    );
    assert_eq!(record.other_dynamic, ["link: event.message, state.message"]);
    assert_eq!(
        record.writes,
        [
            "event.message (resolved)->body",
            "state.message (resolved)->body"
        ]
    );
}

// ----- §3.8: `Body.outputs` -----

#[test]
fn a_container_returned_whole_is_a_reference_the_body_passes() {
    let record = analyze(
        "function f(box: { donut: Donut; count: number }) { return { d: box.donut, n: box.count + 1 }; }\n",
    );
    assert_eq!(record.outputs, ["d : passes box.donut"]);
}

#[test]
fn an_element_the_body_picked_is_one_of_the_references_at_the_star_path() {
    // "An element the body picked out of a list with `filter`, `find`, or
    // `rows[i]` ... are this case."
    let record = analyze("function f(rows: Donut[], i: number) { return rows[i]; }\n");
    assert_eq!(record.outputs, ["(root) : oneOf rows/*"]);
}

#[test]
fn alternatives_that_are_all_references_are_one_of_them() {
    let record = analyze("function f(a: Donut, b: Donut, c: boolean) { return c ? a : b; }\n");
    assert_eq!(record.outputs, ["(root) : oneOf a, b"]);
}

#[test]
fn a_reference_found_below_a_dynamic_hop_and_a_computed_value_give_no_entry() {
    let found = analyze(
        "function f(box: Cell<{ donut: Donut }>, c: boolean) { if (c) { return undefined; } return box.get().donut; }\n",
    );
    assert!(found.outputs.is_empty(), "{:?}", found.outputs);
    let computed = analyze("function f(donut: Donut) { return donut.price + 1; }\n");
    assert!(computed.outputs.is_empty(), "{:?}", computed.outputs);
}

// ----- §6.3: the tier of a computation; §6.4: a handler has none -----

#[test]
fn a_computation_is_primary_output_static_side_write_or_materializer() {
    let primary = analyze("const f = lift((x: { n: number }) => x.n + 1);\n");
    assert_eq!(primary.tier, Some("primary output"));
    let fixed = analyze(
        "const f = lift((x: { count: Cell<number>; n: number }) => { x.count.set(x.n); return 1; });\n",
    );
    assert_eq!(fixed.tier, Some("static side-write"));
    // "`counts.key(flavor).set(n)` ... the analysis can name `counts` and
    // the write changes one child of it."
    let broad = analyze(
        "const f = lift((x: { counts: Cell<Record<string, number>>; flavor: string; n: number }) => { x.counts.key(x.flavor).set(x.n); return 1; });\n",
    );
    assert_eq!(broad.tier, Some("materializer"));
    let handler = analyze(
        "const f = handler<{ flavor: string }, { counts: Cell<Record<string, number>> }>((event, state) => { state.counts.key(event.flavor).set(1); });\n",
    );
    assert_eq!(handler.tier, None);
}

#[test]
fn an_instantiation_does_not_make_a_materializer() {
    let record = analyze(
        "const f = lift((x: { donut: Donut; n: number }) => Child({ donut: x.donut, n: x.n }));\n",
    );
    assert_eq!(record.calls, ["instantiate:order"]);
    assert_eq!(record.tier, Some("primary output"));
}

// ----- §6.6: idempotency -----

#[test]
fn an_append_a_send_and_a_read_of_its_own_target_are_reported_in_a_computation() {
    let append = analyze(
        "const f = lift((x: { rows: Cell<number[]>; n: number }) => { x.rows.push(x.n); return 1; });\n",
    );
    assert_eq!(append.not_idempotent, ["append"]);
    let send = analyze(
        "const f = lift((x: { out: Stream<number>; n: number }) => { x.out.send(x.n); return 1; });\n",
    );
    assert_eq!(send.not_idempotent, ["send"]);
    // "`count.set(count.get() + 1)` writes something else on every run."
    let own = analyze(
        "const f = lift((x: { count: Cell<number> }) => { x.count.set(x.count.get() + 1); return 1; });\n",
    );
    assert_eq!(own.not_idempotent, ["reads its own target"]);
    let other = analyze(
        "const f = lift((x: { count: Cell<number>; from: Cell<number> }) => { x.count.set(x.from.get() + 1); return 1; });\n",
    );
    assert!(
        other.not_idempotent.is_empty(),
        "{:?}",
        other.not_idempotent
    );
}

#[test]
fn a_handler_is_held_to_no_idempotency_contract_and_a_read_then_push_is_counted() {
    let record = analyze(
        "const f = handler<{ n: number }, { rows: Cell<number[]> }>((event, state) => { if (state.rows.get().length < 3) { state.rows.push(event.n); } });\n",
    );
    assert!(
        record.not_idempotent.is_empty(),
        "{:?}",
        record.not_idempotent
    );
    assert_eq!(record.read_then_push, 1);
    let blind = analyze(
        "const f = handler<{ n: number }, { rows: Cell<number[]> }>((event, state) => { state.rows.push(event.n); });\n",
    );
    assert_eq!(blind.read_then_push, 0);
}

// ----- §5.2: W6 -----

#[test]
fn a_path_that_enters_a_recursive_type_again_widens_at_the_second_entry() {
    // "A body that walks a tree of donut boxes reads `box.label` and
    // `box/children/*/label` as separate paths, and everything below the
    // second level through `box/children/*/children` as one subtree."
    let record = analyze(
        "function f(box: Box) { let n = box.label.length; for (const c of box.children) { n += c.label.length; for (const g of c.children) { n += g.label.length; } } return n; }\n",
    );
    assert_eq!(
        record.reads,
        [
            "box.children : enumeration",
            "box.children/*/children : value",
            "box.children/*/label : value",
            "box.label : value",
        ]
    );
    assert_eq!(record.widenings, ["W6"]);
}
