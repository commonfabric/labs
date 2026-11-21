//! The constraints of a plan and `cfc-flow:write-policy`
//! (`plan-and-label-templates.md` §4.4, cited as PL; `language-subset.md`
//! §8.6 and §10.5, cited as LS).

use pattern_compiler::program::{analyze, ProgramAnalysis, SourceFile};
use serde_json::{json, Value};

const SOURCE: &str = r#"import { Cell, handler, pattern, type Confidential, type MaxConfidentiality, type RequiresIntegrity, type WriteAuthorizedBy } from "commonfabric";
interface Note {
  body: WriteAuthorizedBy<Confidential<string, ["secret"]>, typeof save>;
  stamp: RequiresIntegrity<string, ["checked"]>;
  plain: string;
}
const save = handler<{ text: MaxConfidentiality<string, ["public"]> }, { note: Cell<Note> }>((event, state) => {
  state.note.key("body").set(event.text);
  state.note.key("plain").set(event.text);
});
const other = handler<{ text: string }, { note: Cell<Note> }>((event, state) => {
  state.note.key("body").set(event.text);
});
const stamp = handler<{ text: string }, { note: Cell<Note> }>((event, state) => {
  state.note.key("stamp").set(event.text);
});
export const P = pattern<{ note: Cell<Note> }>(({ note }) => ({
  save: save({ note }),
  other: other({ note }),
  stamp: stamp({ note }),
}));
"#;

fn analysis() -> ProgramAnalysis {
    analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: SOURCE.to_string(),
    }])
}

/// The constraints of the write edge of body `name` whose target path is
/// `path`.
fn constraints_of(plan: &Value, name: &str, path: &[&str]) -> Vec<Value> {
    let body = plan["bodies"]
        .as_array()
        .expect("bodies")
        .iter()
        .find(|body| body["name"] == json!(name))
        .unwrap_or_else(|| panic!("no body {name}"));
    let write = body["writes"]
        .as_array()
        .expect("writes")
        .iter()
        .find(|write| write["target"]["path"] == json!(path))
        .unwrap_or_else(|| panic!("no write at {path:?}"));
    write["constraints"]
        .as_array()
        .expect("constraints")
        .iter()
        .map(|index| plan["constraints"][index.as_u64().expect("an index") as usize].clone())
        .collect()
}

#[test]
fn a_write_to_an_annotated_path_has_the_constraints_of_its_annotations() {
    // PL §4.4, "Where a constraint comes from": "`writeAuthorizedBy` | A
    // `writer` constraint on each write edge to the annotated path, with
    // one `WriterPolicy` whose `body` is the body the binding names";
    // "`confidentiality` | ... On a path a write edge targets, it is the
    // declared confidentiality a `writerFit` constraint tests the edge's
    // template against".
    let analysis = analysis();
    let plan = &analysis.modules[0].plans[0].plan;
    let body = constraints_of(plan, "save", &["body"]);
    assert!(
        body.contains(&json!({ "kind": "writer", "anyOf": [{ "body": { "module": "case.tsx", "binding": "save" } }] })),
        "{body:?}"
    );
    assert!(body.contains(&json!({ "kind": "writerFit" })), "{body:?}");
    // A path with no annotation has no constraint of the target.
    let plain = constraints_of(plan, "save", &["plain"]);
    assert!(!plain
        .iter()
        .any(|constraint| constraint["kind"] == "writer"));
    assert!(!plain
        .iter()
        .any(|constraint| constraint["kind"] == "writerFit"));
    // LS §8.6, assumed: "the floor of a write target is the
    // `requiredIntegrity` annotation ... on a path a body writes".
    assert_eq!(
        constraints_of(plan, "stamp", &["stamp"]),
        [json!({ "kind": "writeFloor", "patterns": ["checked"] })]
    );
}

#[test]
fn an_input_constraint_lists_the_slots_of_the_body_that_overlap_the_annotated_path() {
    // PL §4.4: "`maxConfidentiality` | A `maxConfidentiality` constraint
    // with the annotation's ceiling, over the slots that overlap the
    // annotated path", listed on the writes it guards.
    let analysis = analysis();
    let plan = &analysis.modules[0].plans[0].plan;
    let found: Vec<Value> = constraints_of(plan, "save", &["plain"])
        .into_iter()
        .filter(|constraint| constraint["kind"] == "maxConfidentiality")
        .collect();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["ceiling"], json!(["public"]));
    let slots = found[0]["slots"].as_array().expect("slots");
    assert_eq!(slots.len(), 1);
    let slot = &plan["slots"][slots[0].as_u64().expect("a slot") as usize];
    assert_eq!(slot["root"]["kind"], json!("event"));
    assert_eq!(slot["path"], json!(["text"]));
}

#[test]
fn a_write_by_a_body_the_policy_does_not_name_is_refused() {
    // LS §8.6: "`cfc-flow:write-policy`, for a writer the policy does not
    // name". PL §4.4: "The writer policy is always checkable at compile
    // time for a static write edge, because both the body and the policy
    // are in the source."
    let analysis = analysis();
    let found: Vec<(u32, &str)> = analysis.modules[0]
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.id.starts_with("cfc-flow:"))
        .map(|diagnostic| (diagnostic.line, diagnostic.id))
        .collect();
    // The write in `other`, at the line of the write.
    assert_eq!(found, [(12, "cfc-flow:write-policy")]);
}
