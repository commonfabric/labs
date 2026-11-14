//! The relations a constraint tests (`plan-and-label-templates.md` §4.4,
//! cited as PL), over labels as data, and what the compiler evaluates a
//! template to on declared labels ("What the compiler decides").

use pattern_compiler::flow::{
    atom_entails, atom_satisfies, clause_subsumes, coherent_failure, confidentiality_bound,
    integrity_of, misfit, pattern_matches, run_time_term, Integrity,
};
use serde_json::{json, Value};

const EXPIRES: &str = "https://commonfabric.org/cfc/atom/Expires";
const USER: &str = "https://commonfabric.org/cfc/atom/User";
const PERSONAL: &str = "https://commonfabric.org/cfc/atom/PersonalSpace";
const CONCEPT: &str = "https://commonfabric.org/cfc/atom/Concept";

#[test]
fn an_atom_entails_an_equal_atom_and_an_earlier_expiry_a_later_one() {
    // "An atom `a` entails an atom `b` where the two are structurally
    // equal, or where both are `Expires` atoms with exactly the members
    // `type` and `timestamp`, the timestamps are finite numbers, and the
    // timestamp of `a` is at most that of `b`."
    assert!(atom_entails(&json!("a"), &json!("a")));
    assert!(atom_entails(&json!({ "k": 1, "l": [2] }), &json!({ "l": [2], "k": 1 })));
    assert!(!atom_entails(&json!("a"), &json!("b")));
    let at = |timestamp: i64| json!({ "type": EXPIRES, "timestamp": timestamp });
    assert!(atom_entails(&at(5), &at(9)));
    assert!(!atom_entails(&at(9), &at(5)));
    assert!(!atom_entails(
        &json!({ "type": EXPIRES, "timestamp": 5, "more": 1 }),
        &at(9)
    ));
}

#[test]
fn a_ceiling_clause_subsumes_a_label_clause_by_every_alternative() {
    // "A ceiling clause subsumes a label clause where the ceiling clause
    // has at least one alternative, and every alternative of it entails
    // some alternative of the label clause."
    assert!(clause_subsumes(&json!("a"), &json!("a")));
    assert!(clause_subsumes(&json!("a"), &json!({ "anyOf": ["a", "b"] })));
    assert!(!clause_subsumes(&json!({ "anyOf": ["a", "b"] }), &json!("a")));
    assert!(clause_subsumes(
        &json!({ "anyOf": ["a", "b"] }),
        &json!({ "anyOf": ["b", "a", "c"] })
    ));
    assert!(!clause_subsumes(&json!({ "anyOf": [] }), &json!("a")));
    // "An alternative `{ type: PersonalSpace, owner }`, with those two
    // members alone, also counts as `{ type: User, subject: owner }`."
    assert!(clause_subsumes(
        &json!({ "type": USER, "subject": "did:a" }),
        &json!({ "type": PERSONAL, "owner": "did:a" })
    ));
    assert!(!clause_subsumes(
        &json!({ "type": USER, "subject": "did:a" }),
        &json!({ "type": PERSONAL, "owner": "did:a", "more": 1 })
    ));
}

#[test]
fn a_label_fits_a_ceiling_where_every_clause_is_subsumed() {
    // "The empty label fits every ceiling, and the empty ceiling admits
    // the empty label alone."
    assert_eq!(misfit(&[], &[]), None);
    assert_eq!(misfit(&[], &[json!("a")]), None);
    assert_eq!(misfit(&[json!("a")], &[]), Some(json!("a")));
    assert_eq!(misfit(&[json!("a")], &[json!("b"), json!("a")]), None);
    assert_eq!(
        misfit(&[json!("a"), json!("c")], &[json!("b"), json!("a")]),
        Some(json!("c"))
    );
}

#[test]
fn a_pattern_matches_structurally_with_variables() {
    // "A scalar pattern matches the equal scalar; an array pattern
    // matches an array of the same length member by member; a record
    // pattern matches a record that has every member the pattern names
    // ... whatever other members the record has; ... and a variable
    // matches any value, the same value at each of its occurrences."
    assert!(pattern_matches(&json!("a"), &json!("a")));
    assert!(!pattern_matches(&json!("a"), &json!("b")));
    assert!(pattern_matches(&json!([1, 2]), &json!([1, 2])));
    assert!(!pattern_matches(&json!([1, 2]), &json!([1, 2, 3])));
    assert!(pattern_matches(&json!({ "k": 1 }), &json!({ "k": 1, "l": 2 })));
    assert!(!pattern_matches(&json!({ "k": 1, "m": 3 }), &json!({ "k": 1, "l": 2 })));
    let pattern = json!({ "a": { "var": "x" }, "b": { "var": "x" } });
    assert!(pattern_matches(&pattern, &json!({ "a": 1, "b": 1 })));
    assert!(!pattern_matches(&pattern, &json!({ "a": 1, "b": 2 })));
}

#[test]
fn an_atom_satisfies_a_pattern_it_matches_or_entails() {
    // "An atom satisfies a required pattern where the pattern matches it
    // or the atom entails the pattern."
    assert!(atom_satisfies(&json!({ "k": 1, "l": 2 }), &json!({ "k": 1 })));
    let at = |timestamp: i64| json!({ "type": EXPIRES, "timestamp": timestamp });
    assert!(atom_satisfies(&at(5), &at(9)));
    assert!(!atom_satisfies(&at(9), &at(5)));
}

#[test]
fn several_labels_satisfy_a_requirement_with_one_witness_across_them() {
    // "Several integrity labels satisfy a required integrity coherently
    // where, for every pattern, one atom satisfies it in every one of
    // the labels. ... With no label the requirement holds."
    let patterns = [json!({ "kind": "reviewed" })];
    let by = |who: &str| json!({ "kind": "reviewed", "by": who });
    assert_eq!(coherent_failure(&[], &patterns), None);
    assert_eq!(coherent_failure(&[vec![by("a")]], &patterns), None);
    assert_eq!(coherent_failure(&[vec![by("a")], vec![by("a"), by("b")]], &patterns), None);
    // Each label satisfies the pattern, by a different atom.
    assert_eq!(
        coherent_failure(&[vec![by("a")], vec![by("b")]], &patterns),
        Some(patterns[0].clone())
    );
    assert_eq!(
        coherent_failure(&[vec![json!("other")]], &patterns),
        Some(patterns[0].clone())
    );
    // "An atom whose `scope` has a `valueRef` is compared without its
    // `scope.projection`."
    let scoped = |projection: &str| {
        json!({ "kind": "reviewed", "scope": { "valueRef": "v", "projection": projection } })
    };
    assert_eq!(
        coherent_failure(&[vec![scoped("/a")], vec![scoped("/b")]], &patterns),
        None
    );
}

#[test]
fn the_terms_bound_at_run_time() {
    // "The terms are the `CurrentPrincipal` marker, the atom of a
    // `PolicyOf` term, and a `Concept` pattern."
    assert!(run_time_term(&json!({ "kind": "user", "subject": { "__ctCurrentPrincipal": true } })));
    assert!(run_time_term(&json!({ "policyOf": { "module": "m", "binding": "rules" } })));
    assert!(run_time_term(&json!({ "type": CONCEPT, "uri": "x" })));
    assert!(run_time_term(&json!({ "anyOf": ["a", { "type": CONCEPT, "uri": "x" }] })));
    assert!(!run_time_term(&json!({ "kind": "user", "subject": "did:a" })));
}

fn slots() -> Vec<Value> {
    vec![
        json!({ "declared": { "confidentiality": ["a", "b"], "integrity": ["i", "j"] } }),
        json!({ "declared": { "confidentiality": ["b", "c"], "integrity": ["j", "k"] } }),
        json!({}),
    ]
}

fn slot(index: usize) -> Value {
    json!({ "op": "slot", "slot": index })
}

#[test]
fn the_lower_bound_of_the_confidentiality_of_a_template() {
    // "`const` is empty, a `slot` is its declared list, a `derive` is the
    // union of its inputs, and a `select` is the union of its condition
    // with the clauses that every branch has."
    let slots = slots();
    assert_eq!(confidentiality_bound(&json!({ "op": "const" }), &slots), Some(vec![]));
    assert_eq!(
        confidentiality_bound(&slot(0), &slots),
        Some(vec![json!("a"), json!("b")])
    );
    let derive = json!({ "op": "derive", "by": { "expression": true }, "inputs": [slot(0), slot(1), { "op": "const" }] });
    assert_eq!(
        confidentiality_bound(&derive, &slots),
        Some(vec![json!("a"), json!("b"), json!("c")])
    );
    let select = json!({ "op": "select", "selector": 0, "condition": { "op": "const" }, "branches": [slot(0), slot(1)] });
    assert_eq!(confidentiality_bound(&select, &slots), Some(vec![json!("b")]));
    // "A template is evaluated only where every `slot` node it reaches,
    // on every selection, has the `declared` member of the dimension
    // tested, and it has no `dynamic`, `fold` or `pick` node."
    let undeclared = json!({ "op": "select", "selector": 0, "condition": { "op": "const" }, "branches": [slot(0), slot(2)] });
    assert_eq!(confidentiality_bound(&undeclared, &slots), None);
    let dynamic = json!({ "op": "derive", "by": { "expression": true }, "inputs": [slot(0), { "op": "dynamic", "read": 0 }] });
    assert_eq!(confidentiality_bound(&dynamic, &slots), None);
}

#[test]
fn the_integrity_of_a_template() {
    // "A `slot` is its declared list, a `derive` is the atoms that every
    // input has, with `const` inputs left out, plus the `TransformedBy`
    // atom of its `by`, and a `select` is decided only where every
    // branch evaluates to the same list."
    let slots = slots();
    assert_eq!(
        integrity_of(&slot(0), &slots),
        Some(Integrity { atoms: vec![json!("i"), json!("j")], minted: false })
    );
    let derive = json!({ "op": "derive", "by": { "body": 0 }, "inputs": [slot(0), slot(1), { "op": "const" }] });
    assert_eq!(
        integrity_of(&derive, &slots),
        Some(Integrity { atoms: vec![json!("j")], minted: true })
    );
    let same = json!({ "op": "select", "selector": 0, "condition": slot(1), "branches": [slot(0), slot(0)] });
    assert_eq!(
        integrity_of(&same, &slots),
        Some(Integrity { atoms: vec![json!("i"), json!("j")], minted: false })
    );
    let differ = json!({ "op": "select", "selector": 0, "condition": slot(1), "branches": [slot(0), slot(1)] });
    assert_eq!(integrity_of(&differ, &slots), None);
    assert_eq!(integrity_of(&slot(2), &slots), None);
}
