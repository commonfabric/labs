//! The promotion criterion of `language-subset.md` §6.1 by syntax and by
//! type, for the forms the two decide differently.

use pattern_compiler::program::{analyze, SourceFile};
use pattern_compiler::tiers::BodyKind;

/// For each `computed` of a snippet: whether the syntactic criterion
/// promotes it, and the outcome of the typed criterion.
fn outcomes(snippet: &str) -> Vec<(bool, String)> {
    let analysis = analyze(&[SourceFile {
        path: "case.tsx".to_string(),
        text: format!("import {{ computed, pattern, Writable }} from \"commonfabric\";\n{snippet}"),
    }]);
    assert!(analysis.failures.is_empty(), "{:?}", analysis.failures);
    analysis.modules[0]
        .bodies
        .iter()
        .filter(|body| body.kind == BodyKind::Computed)
        .filter_map(|body| Some((body.promoted_by_syntax?, body.promotion_by_type.clone()?)))
        .collect()
}

#[test]
fn body_of_typed_structural_operations_is_promoted_by_both() {
    assert_eq!(
        outcomes(
            "const KEY = \"total\";\n\
             const Box = pattern<{ names: string[]; price: number }>(({ names, price }) => ({\n\
               label: computed(() => names.filter((name) => name.length > 1).map((name) => name.trim()).join(\", \")),\n\
               total: computed(() => ({ [KEY]: price * names.length })),\n\
             }));\n"
        ),
        [
            (true, "promoted".to_string()),
            (true, "promoted".to_string())
        ]
    );
}

#[test]
fn collection_method_on_a_cell_is_not_promoted_by_type() {
    assert_eq!(
        outcomes(
            "const Box = pattern<{ names: Writable<string[]> }>(({ names }) => ({\n\
               sizes: computed(() => names.map((name) => name.length)),\n\
               first: computed(() => names.get()[0]),\n\
             }));\n"
        ),
        [
            (true, "not promoted: `.map(...)` on a cell".to_string()),
            (true, "promoted".to_string())
        ]
    );
}

#[test]
fn reduce_with_an_accumulator_of_a_code_type_is_not_promoted_by_type() {
    assert_eq!(
        outcomes(
            "const SEED = new Map<string, number>();\n\
             const Box = pattern<{ names: string[] }>(({ names }) => ({\n\
               counts: computed(() => names.reduce((counts, name) => counts, SEED)),\n\
               total: computed(() => names.reduce((total, name) => total + name.length, 0)),\n\
             }));\n"
        ),
        [
            (
                true,
                "not promoted: a `reduce` whose accumulator has a code type".to_string()
            ),
            (true, "promoted".to_string())
        ]
    );
}

#[test]
fn object_literal_with_a_key_that_is_not_static_is_not_promoted_by_type() {
    assert_eq!(
        outcomes(
            "const Box = pattern<{ name: string; price: number }>(({ name, price }) => ({\n\
               byName: computed(() => ({ [name]: price })),\n\
             }));\n"
        ),
        [(
            true,
            "not promoted: an object literal with a key that is not static".to_string()
        )]
    );
}

#[test]
fn destructuring_with_a_default_of_a_computed_value_is_not_promoted_by_type() {
    assert_eq!(
        outcomes(
            "const Box = pattern<{ order: { size?: number } }>(({ order }) => ({\n\
               size: computed(() => { const { size = 1 } = order; return size * 2; }),\n\
             }));\n"
        ),
        [(
            true,
            "not promoted: a default value or a rest element in a `const` destructuring"
                .to_string()
        )]
    );
}

#[test]
fn method_on_a_receiver_with_no_type_is_not_decided_by_type() {
    assert_eq!(
        outcomes(
            "import { mystery } from \"./mystery.ts\";\n\
             const Box = pattern<{ name: string }>(({ name }) => ({\n\
               label: computed(() => mystery(name).trim()),\n\
             }));\n"
        ),
        [(
            true,
            "not decided: `.trim(...)` on a receiver with no type".to_string()
        )]
    );
}
