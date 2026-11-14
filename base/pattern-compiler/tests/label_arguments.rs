//! Label arguments as data (`language-subset.md` §8.5, cited as LS): an
//! alias, a constant reference `typeof NAME`, a marker type, and the
//! writer policies of `WritePolicyAnyOf` and the trusted-action aliases,
//! in `Slot.declared` and in the constraints of a plan
//! (`plan-and-label-templates.md` §1.5 and §4.4, cited as PL).

use pattern_compiler::program::{analyze, ProgramAnalysis, SourceFile};
use serde_json::{json, Value};

const SOURCE: &str = r#"import { Cell, handler, pattern, type AnyOf, type Confidential, type CurrentPrincipal, type TrustedActionWrite, type WriteAuthorizedBy, type WritePolicyAnyOf } from "commonfabric";
const TEAM = "team";
const OWNER = { kind: "role", name: "owner" } as const;
const SEND = "send";
const SURFACE = "surface";
type Secret = readonly ["secret"];
type Private<T> = Confidential<T, readonly [{ kind: "user"; subject: CurrentPrincipal }]>;
type Labeled<T, L> = Confidential<T, L>;
type Sendable = WritePolicyAnyOf<string, [
  TrustedActionWrite<unknown, typeof send, typeof SEND, typeof SURFACE>,
  WriteAuthorizedBy<unknown, typeof edit>,
]>;
interface Note { text: Sendable }
interface Input {
  a: Confidential<string, Secret>;
  b: Confidential<string, readonly [typeof TEAM, typeof OWNER]>;
  c: Private<string>;
  d: Labeled<string, readonly ["x", ...Secret]>;
  e: Confidential<string, [AnyOf<["p", "q"]>]>;
  note: Cell<Note>;
}
const send = handler<{ text: string }, { note: Cell<Note> }>((event, state) => {
  state.note.key("text").set(event.text);
});
const edit = handler<{ text: string }, { note: Cell<Note> }>((event, state) => {
  state.note.key("text").set(event.text);
});
const rogue = handler<{ text: string }, { note: Cell<Note> }>((event, state) => {
  state.note.key("text").set(event.text);
});
export const P = pattern<Input>(({ a, b, c, d, e, note }) => ({
  a, b, c, d, e,
  send: send({ note }),
  edit: edit({ note }),
  rogue: rogue({ note }),
}));
"#;

fn analysis() -> ProgramAnalysis {
    analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: SOURCE.to_string(),
    }])
}

fn declared(plan: &Value, name: &str) -> Value {
    plan["slots"]
        .as_array()
        .expect("slots")
        .iter()
        .find(|slot| slot["path"] == json!([name]) && slot.get("declared").is_some())
        .unwrap_or_else(|| panic!("no slot at {name} with a declared label"))["declared"]
        .clone()
}

#[test]
fn an_alias_a_constant_reference_and_a_marker_type_are_replaced_in_a_label_list() {
    let analysis = analysis();
    let plan = &analysis.modules[0].plans[0].plan;
    // "`Confidential<string, RecipeSecret>` with `type RecipeSecret =
    // readonly ["recipe-secret"]` is the list written in place."
    assert_eq!(declared(plan, "a"), json!({ "confidentiality": ["secret"] }));
    // "With `const LOBBY_ADMIN = "lobby-admin"`, the list `readonly
    // [typeof LOBBY_ADMIN]` is `readonly ["lobby-admin"]`", and the
    // value may be "an object whose property values are atoms".
    assert_eq!(
        declared(plan, "b"),
        json!({ "confidentiality": ["team", { "kind": "role", "name": "owner" }] })
    );
    // "`CurrentPrincipal` and the other marker types the API exports for
    // atoms", through a generic alias.
    assert_eq!(
        declared(plan, "c"),
        json!({ "confidentiality": [{ "kind": "user", "subject": { "__ctCurrentPrincipal": true } }] })
    );
    // "With the type arguments substituted", and "a spread of another
    // label list".
    assert_eq!(declared(plan, "d"), json!({ "confidentiality": ["x", "secret"] }));
    assert_eq!(
        declared(plan, "e"),
        json!({ "confidentiality": [{ "anyOf": ["p", "q"] }] })
    );
}

#[test]
fn a_write_policy_names_each_writer_and_the_ui_contract_of_a_trusted_action() {
    // PL §4.4, `WriterPolicy`; PL §1.5: "`WriterPolicy.body` is
    // `Body.code` of the handler the annotation's binding names", the
    // record `{ module, binding }`. SM §11: "`TrustedActionWrite<…>` |
    // same, with `requiredEventIntegrity` defaulting to
    // `[trustedPattern]`".
    let analysis = analysis();
    let plan = &analysis.modules[0].plans[0].plan;
    let writers: Vec<&Value> = plan["constraints"]
        .as_array()
        .expect("constraints")
        .iter()
        .filter(|constraint| constraint["kind"] == "writer")
        .collect();
    assert_eq!(
        writers,
        [&json!({
            "kind": "writer",
            "anyOf": [
                {
                    "body": { "module": "case.tsx", "binding": "send" },
                    "uiContract": {
                        "helper": "UiAction",
                        "action": "send",
                        "trustedPattern": "surface",
                        "requiredEventIntegrity": ["surface"],
                    },
                },
                { "body": { "module": "case.tsx", "binding": "edit" } },
            ],
        })]
    );
    // `cfc-flow:write-policy`: the write in `rogue`, which no
    // alternative names, and neither of the other two.
    let found: Vec<(u32, &str)> = analysis.modules[0]
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.id.starts_with("cfc-flow:"))
        .map(|diagnostic| (diagnostic.line, diagnostic.id))
        .collect();
    assert_eq!(found, [(29, "cfc-flow:write-policy")]);
}
