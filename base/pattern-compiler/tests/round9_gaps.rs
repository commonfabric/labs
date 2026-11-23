//! The gaps of the checker that FabriChat and Home showed (notes 720 to 722
//! of `SPEC-NOTES.md`): the type of a name whose initializer is nested
//! deeply, and two forms of narrowing (`language-subset.md` §7.3, §7.6).
//!
//! In a snippet, `/*?*/` stands just before the expression whose type the
//! test names.

use pattern_compiler::program::{types_at_markers, SourceFile};

fn types(snippet: &str) -> Vec<String> {
    types_at_markers(&[SourceFile {
        path: "case.tsx".to_string(),
        text: format!("import {{ handler }} from \"commonfabric\";\n{snippet}"),
    }])
}

/// `commitAttach` of `patterns/system/fabrichat/room-records.tsx`: the
/// argument of the generic call is a name whose initializer is two optional
/// accesses under `??`, and the result is read two steps further on.
#[test]
fn a_type_parameter_is_bound_from_a_name_with_a_nested_initializer() {
    assert_eq!(
        types(
            "interface Up { name: string }\n\
             interface Ev { detail?: { files?: Up[] } }\n\
             const wrap = <T,>(files: readonly T[]): { file: T }[] =>\n\
               files.map((file) => ({ file }));\n\
             export const h = handler<Ev, { n: number }>((event, _s) => {\n\
               const files = event?.detail?.files ?? [];\n\
               const first = wrap(files)[0];\n\
               /*?*/first;\n\
               const names = wrap(files).map(({ file }) => /*?*/file);\n\
             });\n"
        ),
        ["{ file: { name: string } }", "{ name: string }"]
    );
}

/// `changeSharedSpaceMembershipIn` of
/// `patterns/system/shared-space/shared-space-catalog.ts`: after an early
/// return under `a && (!p(x) || b)`, the value is `undefined` or what the
/// predicate says.
#[test]
fn an_early_return_under_a_conjunction_with_a_negated_predicate_narrows() {
    assert_eq!(
        types(
            "interface Act { id: string; state: string }\n\
             function isAct(v: unknown): v is Act { return typeof v === \"object\"; }\n\
             export function f(cur: { state: string }, last: unknown, id: string) {\n\
               if (last !== undefined && (!isAct(last) || last.state !== cur.state)) {\n\
                 return false;\n\
               }\n\
               return /*?*/last;\n\
             }\n"
        ),
        ["undefined | { id: string; state: string }"]
    );
}

/// `sharedSpaceProfileViewOf` of
/// `patterns/system/shared-space/shared-space-interface.ts`: an optional
/// read of the discriminant, compared with a literal, keeps the members
/// that have it and removes `undefined`.
#[test]
fn an_optional_read_of_a_discriminant_narrows_the_union() {
    assert_eq!(
        types(
            "type V = { status: \"unavailable\"; reason: string } | { status: \"ready\"; n: number };\n\
             export function g(c: V | undefined) {\n\
               if (c?.status === \"unavailable\") return /*?*/c;\n\
               return /*?*/c;\n\
             }\n"
        ),
        [
            "{ status: \"unavailable\"; reason: string }",
            "{ status: \"ready\"; n: number } | undefined"
        ]
    );
}

/// `newStepGroups` of `patterns/apps/food-recipe/recipe-logic.ts`: the
/// left operand of `&&` gives the result its falsy part, and the left
/// operand of `||` its truthy part.
#[test]
fn a_logical_operator_keeps_the_part_of_its_left_operand_that_decides() {
    assert_eq!(
        types(
            "export function f(name: unknown, donut: { glaze: string } | undefined, i: number) {\n\
               const text = /*?*/(typeof name === \"string\" && name.trim());\n\
               const shown = /*?*/(text || `Group ${i}`);\n\
               const glaze = /*?*/(donut && donut.glaze);\n\
               return [shown, glaze];\n\
             }\n"
        ),
        ["false | string", "string", "undefined | string"]
    );
}

/// `authorTallies` of `patterns/showcase/iframe-ring-loops/model.ts`: the
/// spread of a `Map` gives its entries as pairs, and `sort` keeps them.
#[test]
fn the_spread_of_a_map_is_an_array_of_its_entries() {
    assert_eq!(
        types(
            "export function f(colors: Map<string, number>) {\n\
               const entries = /*?*/([...colors]);\n\
               const ranked = /*?*/(entries.sort((a, b) => b[1] - a[1]));\n\
               return /*?*/(ranked[0][0]);\n\
             }\n"
        ),
        ["[string, number][]", "[string, number][]", "string"]
    );
}
