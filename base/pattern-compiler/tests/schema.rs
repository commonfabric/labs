//! Emitted schemas and declared labels: the JSON schema of the type at a
//! slot (`docs/specs/schema-generator/ts_to_json_schema_mapping.md`, cited
//! as SM), `Slot.declared` (`plan-and-label-templates.md` §1.1, §4.4, cited
//! as PL), and the annotation at a path (`language-subset.md` §8.3, cited
//! as LS).

use pattern_compiler::program::{analyze, SourceFile};
use serde_json::{json, Value};

const SOURCE: &str = r#"import { Cell, Stream, pattern, type Confidential, type Default, type Integrity } from "commonfabric";
interface Item { title: string; done?: boolean; tags: string[] }
type Inner = Integrity<Confidential<string, ["deep", "secret"]>, ["checked"]>;
interface Input {
  items: Item[];
  note: Confidential<string, readonly ["secret", "team"]>;
  box: Confidential<{ inner: Inner }, ["secret"]>;
  count: Cell<number>;
  mode: "a" | "b";
  maybe: string | undefined;
  size: Default<number, 3>;
  atom: Confidential<string, [{ kind: "principal"; subject: "did:key:alice" }]>;
  events: Stream<{ n: number }>;
}
export const S = pattern<Input>(({ items, note, box, count, mode, maybe, size, atom, events }) => {
  // `note`, `box.inner` and `atom` are read for their value: a slot that
  // observes a reference has no declared label (PL §1.5, question 55).
  return { items, note: note + "", inner: box.inner + "", count, mode, maybe, size, atom: atom + "", events };
});
"#;

fn slot(path: &[&str]) -> Value {
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: SOURCE.to_string(),
    }]);
    let emitted = &analysis.modules[0].plans[0];
    let mut slot = emitted.plan["slots"]
        .as_array()
        .expect("slots")
        .iter()
        .find(|slot| slot["path"] == json!(path))
        .unwrap_or_else(|| panic!("no slot at {path:?}"))
        .clone();
    // PL §1.5: "The plan holds the hash and never the document. The
    // compiler emits each schema document a plan names once, beside the
    // plan." The slot is returned with the document its identifier
    // names.
    if let Some(id) = slot["schema"].as_str().map(str::to_string) {
        let (_, document) = emitted
            .schemas
            .iter()
            .find(|(other, _)| *other == id)
            .unwrap_or_else(|| panic!("no schema document {id}"));
        slot["schema"] = document.clone();
    }
    slot
}

#[test]
fn the_plan_names_each_schema_and_the_documents_are_beside_it() {
    // PL §1.1: `Slot.schema`, `Plan.argumentSchema` and
    // `Plan.resultSchema` are of type `Hash`, and `Output` has no schema
    // member. The crate forms no content address (note 153), so the
    // identifier is a marked placeholder.
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: SOURCE.to_string(),
    }]);
    let emitted = &analysis.modules[0].plans[0];
    let mut named: Vec<&str> = Vec::new();
    for slot in emitted.plan["slots"].as_array().expect("slots") {
        if let Some(schema) = slot.get("schema") {
            named.push(schema.as_str().expect("an identifier, not a document"));
        }
    }
    named.push(
        emitted.plan["argumentSchema"]
            .as_str()
            .expect("the argument schema"),
    );
    assert!(!named.is_empty());
    for id in &named {
        assert!(id.starts_with("unhashed:schema/"), "{id}");
        assert_eq!(
            emitted
                .schemas
                .iter()
                .filter(|(other, _)| other == id)
                .count(),
            1
        );
    }
    // Equal documents are one document.
    let mut documents: Vec<&Value> = emitted
        .schemas
        .iter()
        .map(|(_, document)| document)
        .collect();
    let all = documents.len();
    documents.dedup();
    assert_eq!(documents.len(), all);
    for output in emitted.plan["outputs"].as_array().expect("outputs") {
        assert!(output.get("schema").is_none());
    }
}

#[test]
fn an_object_an_array_and_an_optional_property_have_the_schema_of_the_mapping() {
    // SM §4: "`T[]` ... `{ type: "array", items: <T> }`", an object with
    // `properties` and the properties that are not optional in
    // `required`.
    assert_eq!(
        slot(&["items"])["schema"],
        json!({
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "done": { "type": "boolean" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                },
                "required": ["title", "tags"],
            },
        })
    );
}

#[test]
fn a_handle_a_union_a_literal_union_and_a_default_have_the_schema_of_the_mapping() {
    // SM §6.2: "`Cell` ... → `"cell"`", "prepends one entry to a single
    // `asCell` array on the inner schema".
    assert_eq!(
        slot(&["count"])["schema"],
        json!({ "type": "number", "asCell": ["cell"] })
    );
    assert_eq!(
        slot(&["events"])["schema"],
        json!({
            "type": "object",
            "properties": { "n": { "type": "number" } },
            "required": ["n"],
            "asCell": ["stream"],
        })
    );
    // SM §8: "All-literal unions → `{ enum: [...] }` with no `type` key",
    // and "bare primitive types merge into sorted `type` arrays — how
    // `string | undefined` becomes `{ type: ["string","undefined"] }`".
    assert_eq!(slot(&["mode"])["schema"], json!({ "enum": ["a", "b"] }));
    assert_eq!(
        slot(&["maybe"])["schema"],
        json!({ "type": ["string", "undefined"] })
    );
    // SM §7: a `Default<T, V>` is the schema of `T` with `default: V`.
    assert_eq!(
        slot(&["size"])["schema"],
        json!({ "type": "number", "default": 3 })
    );
}

#[test]
fn a_label_annotation_is_the_ifc_metadata_of_its_node_and_the_declared_label_of_the_slot() {
    // LS §8.2: "An annotation on a node of a type that reaches a schema
    // becomes the `ifc` metadata of that schema node". SM §11:
    // "`Confidential<T, C>` | `{ confidentiality: C }`".
    let note = slot(&["note"]);
    assert_eq!(
        note["schema"],
        json!({ "type": "string", "ifc": { "confidentiality": ["secret", "team"] } })
    );
    // PL §4.4: "`confidentiality` | `Slot.declared.confidentiality` of a
    // slot the annotation covers".
    assert_eq!(
        note["declared"],
        json!({ "confidentiality": ["secret", "team"] })
    );
    // An atom that is an object type literal (LS §8.5).
    assert_eq!(
        slot(&["atom"])["declared"],
        json!({ "confidentiality": [{ "kind": "principal", "subject": "did:key:alice" }] })
    );
    // A slot with no annotation on its path declares nothing.
    assert!(slot(&["items"]).get("declared").is_none());
}

#[test]
fn the_annotation_at_a_path_combines_every_node_from_the_root() {
    // LS §8.3: "The annotation at a path of a type is the combination of
    // the annotations on every node from the root to that path.
    // `confidentiality` lists join, outer first, each atom once."
    let inner = slot(&["box", "inner"]);
    assert_eq!(
        inner["declared"],
        json!({
            "confidentiality": ["secret", "deep"],
            "integrity": ["checked"],
        })
    );
    // The schema of the node holds the node's own annotations.
    assert_eq!(
        inner["schema"],
        json!({
            "type": "string",
            "ifc": { "confidentiality": ["deep", "secret"], "integrity": ["checked"] },
        })
    );
}

#[test]
fn a_pattern_has_the_schemas_of_its_argument_and_of_the_result_it_declares() {
    // PL §1.1: a pattern has an argument schema and a result schema
    // (`Child.argumentSchema`, `Child.resultSchema`), and a kept output is
    // a path of the result.
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: r#"import { pattern, type Confidential } from "commonfabric";
export const P = pattern<{ n: number }, { label: Confidential<string, ["secret"]>; n: number }>(({ n }) => {
  return { label: "n=" + n, n };
});
"#
        .to_string(),
    }]);
    let plan = &analysis.modules[0].plans[0];
    assert_eq!(
        plan.argument_schema,
        Some(json!({
            "type": "object",
            "properties": { "n": { "type": "number" } },
            "required": ["n"],
        }))
    );
    assert_eq!(
        plan.result_schema.as_ref().expect("a result schema")["properties"]["label"],
        json!({ "type": "string", "ifc": { "confidentiality": ["secret"] } })
    );
    // `Plan.resultSchema` names that document.
    let id = plan.plan["resultSchema"]
        .as_str()
        .expect("the result schema");
    let (_, document) = plan
        .schemas
        .iter()
        .find(|(other, _)| other == id)
        .expect("the document");
    assert_eq!(Some(document), plan.result_schema.as_ref());
}

#[test]
fn a_property_written_with_a_well_known_key_has_the_name_the_key_stands_for() {
    // A value is stored under `$NAME` where the type writes `[NAME]`, as
    // a path of the plan has it.
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: r#"import { NAME, pattern, UI, VIEWS, type VNode } from "commonfabric";
interface Piece { [NAME]: string; [UI]: VNode; [VIEWS]?: { chat: string }; note: string }
export const S = pattern<{ pieces: Piece[] }>(({ pieces }) => {
  return { pieces };
});
"#
        .to_string(),
    }]);
    let emitted = &analysis.modules[0].plans[0];
    let id = emitted.plan["argumentSchema"]
        .as_str()
        .expect("the schema of the argument");
    let (_, document) = emitted
        .schemas
        .iter()
        .find(|(known, _)| known == id)
        .expect("the document");
    let piece = &document["properties"]["pieces"]["items"];
    let mut names: Vec<&str> = piece["properties"]
        .as_object()
        .expect("properties")
        .keys()
        .map(String::as_str)
        .collect();
    names.sort_unstable();
    assert_eq!(names, ["$NAME", "$UI", "$VIEWS", "note"]);
    assert_eq!(piece["required"], json!(["$NAME", "$UI", "note"]));
}

/// A type declared `depth` deep, each level of which uses the level
/// below it at two positions.
fn nested_aliases(depth: usize) -> String {
    let mut text = String::from(
        "import { pattern } from \"commonfabric\";\ntype T0 = { v: string; n: number };\n",
    );
    for level in 1..=depth {
        text.push_str(&format!(
            "type T{level} = {{ a: T{}; b: T{} }};\n",
            level - 1,
            level - 1
        ));
    }
    text.push_str(&format!(
        "export const P = pattern<{{ x: T{depth} }}>(({{ x }}) => ({{ x }}));\n"
    ));
    text
}

fn schema_bytes(text: &str) -> usize {
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: text.to_string(),
    }]);
    analysis.modules[0].plans[0]
        .schemas
        .iter()
        .map(|(_, document)| document.to_string().len())
        .sum()
}

#[test]
fn a_type_used_at_two_positions_of_a_schema_is_written_once() {
    // PL §1.5 writes a type that is not recursive in place at each
    // occurrence, which is 2^depth copies for aliases that each use the
    // one below twice. The schema names such a type by `$ref` and holds
    // it once under `$defs` (provisional decision P7).
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: nested_aliases(3),
    }]);
    let (_, document) = &analysis.modules[0].plans[0].schemas[0];
    let x = &document["properties"]["x"];
    assert_eq!(x["properties"]["a"], x["properties"]["b"]);
    assert!(x["properties"]["a"]["$ref"].is_string(), "{document}");
    assert!(document["$defs"].is_object(), "{document}");
    let (shallow, deep) = (
        schema_bytes(&nested_aliases(5)),
        schema_bytes(&nested_aliases(10)),
    );
    assert!(deep < 3 * shallow, "5: {shallow} bytes, 10: {deep} bytes");
}
