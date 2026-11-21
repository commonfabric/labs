//! Constant references in label arguments (`language-subset.md` §8.5):
//! `typeof NAME` outside a writer or a rule-set position stands for the
//! value of a module-scope constant with a static initializer.

use pattern_compiler::program::{analyze, SourceFile};

const PRELUDE: &str = "import { handler, Writable, type AnyOf, type Confidential, type Integrity, \
type TrustedActionUiContract, type TrustedActionWrite } from \"commonfabric\";\n";

fn errors(files: &[(&str, String)]) -> Vec<&'static str> {
    let files: Vec<SourceFile> = files
        .iter()
        .map(|(path, text)| SourceFile {
            path: path.to_string(),
            text: text.clone(),
        })
        .collect();
    let analysis = analyze(&files);
    assert!(analysis.failures.is_empty(), "{:?}", analysis.failures);
    analysis
        .modules
        .iter()
        .flat_map(|module| &module.diagnostics)
        .filter(|diagnostic| diagnostic.is_error())
        .map(|diagnostic| diagnostic.id)
        .collect()
}

fn check(snippet: &str) -> Vec<&'static str> {
    errors(&[("case.tsx", format!("{PRELUDE}{snippet}"))])
}

#[test]
fn constant_with_a_static_initializer_is_an_atom() {
    assert_eq!(
        check(
            "const LOBBY_ADMIN = \"lobby-admin\";\n\
             const LEVEL = 3 as const;\n\
             const ROLE = { kind: \"role\", names: [\"a\", \"b\"] } as const;\n\
             const ALIAS = LOBBY_ADMIN;\n\
             type A = Confidential<string, readonly [typeof LOBBY_ADMIN, typeof LEVEL, typeof ROLE, typeof ALIAS]>;\n\
             type B = Integrity<string, [{ role: typeof LOBBY_ADMIN }, AnyOf<[typeof LOBBY_ADMIN, \"other\"]>]>;\n"
        ),
        Vec::<&str>::new()
    );
}

#[test]
fn constant_imported_from_another_module_is_an_atom() {
    assert_eq!(
        errors(&[
            ("labels.ts", "export const HOME = \"home\";\n".to_string()),
            (
                "case.tsx",
                format!(
                    "{PRELUDE}import {{ HOME }} from \"./labels.ts\";\n\
                     type A = Confidential<string, readonly [typeof HOME]>;\n"
                )
            ),
        ]),
        Vec::<&str>::new()
    );
}

#[test]
fn constant_whose_initializer_is_not_static_is_refused() {
    for declaration in [
        "const NAME = makeName();",
        "const NAME = \"a\" + \"b\";",
        "const NAME = `x${1}`;",
        "const NAME = [\"a\"];",
        "const NAME = { run: [[\"a\"]] };",
        "const NAME = { when: new Date(0) };",
    ] {
        assert_eq!(
            check(&format!(
                "function makeName() {{ return \"a\"; }}\n{declaration}\n\
                 type A = Confidential<string, readonly [typeof NAME]>;\n"
            )),
            ["cfc-label:not-static"],
            "{declaration}"
        );
    }
    assert_eq!(
        check(
            "const NAMES = { home: \"home\" } as const;\n\
             type A = Confidential<string, readonly [typeof NAMES.home]>;\n"
        ),
        ["cfc-label:not-static"]
    );
    assert_eq!(
        check(
            "function run() { const LOCAL = \"a\"; type A = Confidential<string, readonly [typeof LOCAL]>; return LOCAL; }\n"
        ),
        ["cfc-label:not-static"]
    );
}

#[test]
fn constant_is_the_action_and_the_pattern_of_a_trusted_action_alias() {
    let write = "const save = handler<unknown, { name: Writable<string> }>((_, { name }) => name.set(\"plain\"));\n\
                 const ACTION = \"save-name\";\nconst PATTERN = \"donut-shop\";\nconst COUNT = 3;\n";
    assert_eq!(
        check(&format!(
            "{write}type A = TrustedActionWrite<string, typeof save, typeof ACTION, typeof PATTERN>;\n\
             type B = TrustedActionUiContract<string, typeof ACTION, typeof PATTERN>;\n"
        )),
        Vec::<&str>::new()
    );
    assert_eq!(
        check(&format!(
            "{write}type A = TrustedActionWrite<string, typeof save, typeof COUNT, typeof PATTERN>;\n"
        )),
        ["cfc-label:not-static"]
    );
}
