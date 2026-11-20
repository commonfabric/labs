//! The interim acceptance of `patternTool` (`src/tool_rewrite.rs`): the
//! call is rewritten, before any other stage reads the module, to an inline
//! pattern closure that calls the pattern with the bound values
//! (`language-subset.md` §4.4.2 and §4.4.3).

use std::collections::HashMap;

use pattern_compiler::diagnostics::{Diagnostic, Severity};
use pattern_compiler::program::{analyze, closure_inputs_at_markers, SourceFile, TYPE_MARKER};
use serde_json::{json, Value};

const ACCEPTED: &str = "removed-form:pattern-tool-interim";
const REFUSED: &str = "removed-form:pattern-tool";

const IMPORTS: &str = "import { computed, generateText, pattern, patternTool, Writable, \
type Default } from \"commonfabric\";\n";
const SEARCH: &str = "const Search = pattern<{ flavor: string; donuts: string[] }>(\
({ flavor, donuts }) => ({ found: donuts.filter((donut) => donut === flavor) }));\n";

type Modules = Vec<(&'static str, String)>;

fn files(modules: &[(&'static str, String)]) -> Vec<SourceFile> {
    modules
        .iter()
        .map(|(path, text)| SourceFile {
            path: (*path).to_string(),
            text: text.clone(),
        })
        .collect()
}

/// A module that gives `tool` to a language-model built-in, in the body of
/// a pattern whose input has the members `input` declares.
fn host_with(input: &str, names: &str, tool: &str) -> String {
    format!(
        "{IMPORTS}{SEARCH}export default pattern<{{ {input}; prompt: string }}>(\
({{ {names}, prompt }}) => {{\n  const reply = generateText({{ prompt, tools: {{ search: {tool} }} }});\n  \
return {{ reply: reply.result }};\n}});\n"
    )
}

fn host(tool: &str) -> String {
    host_with("donuts: string[]", "donuts", tool)
}

/// What the compiler emits for a program, with every source position set
/// to zero and every content hash replaced by its ordinal among the hashes
/// of the output. A hash is formed over the text of a module, and the text
/// differs between the two forms that a test compares.
fn emitted(modules: &[(&'static str, String)]) -> Value {
    pattern_compiler::emit::request(true);
    let analysis = analyze(&files(modules));
    pattern_compiler::emit::request(false);
    assert!(analysis.failures.is_empty(), "{:?}", analysis.failures);
    let mut out: Vec<Value> = Vec::new();
    for module in &analysis.modules {
        for plan in &module.plans {
            let unsupported: Vec<&str> = plan
                .unsupported
                .iter()
                .map(|(kind, _)| kind.as_str())
                .collect();
            out.push(json!({
                "module": module.path,
                "name": plan.name,
                "plan": plan.plan,
                "schemas": plan.schemas,
                "code": plan.code,
                "unsupported": unsupported,
            }));
        }
    }
    let mut value = Value::Array(out);
    normalize(&mut value, &mut HashMap::new());
    value
}

fn normalize(value: &mut Value, hashes: &mut HashMap<String, usize>) {
    match value {
        Value::Object(members) => {
            for (key, member) in members.iter_mut() {
                if matches!(key.as_str(), "start" | "end" | "line") && member.is_number() {
                    *member = json!(0);
                } else {
                    normalize(member, hashes);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                normalize(item, hashes);
            }
        }
        Value::String(text) => {
            const PREFIX: &str = "sha256:";
            let mut rest = text.as_str();
            let mut replaced = String::new();
            while let Some(at) = rest.find(PREFIX) {
                let end = at + PREFIX.len() + 64;
                if end > rest.len() {
                    break;
                }
                let next = hashes.len();
                let ordinal = *hashes.entry(rest[at..end].to_string()).or_insert(next);
                replaced.push_str(&rest[..at]);
                replaced.push_str(&format!("hash#{ordinal}"));
                rest = &rest[end..];
            }
            replaced.push_str(rest);
            *text = replaced;
        }
        _ => {}
    }
}

fn diagnostics(modules: &[(&'static str, String)]) -> Vec<Diagnostic> {
    let analysis = analyze(&files(modules));
    assert!(analysis.failures.is_empty(), "{:?}", analysis.failures);
    analysis
        .modules
        .into_iter()
        .flat_map(|module| module.diagnostics)
        .filter(|diagnostic| diagnostic.severity != Severity::Hint)
        .collect()
}

fn summary(diagnostics: &[Diagnostic]) -> Vec<(&'static str, u32, u32)> {
    diagnostics
        .iter()
        .map(|diagnostic| (diagnostic.id, diagnostic.line, diagnostic.column))
        .collect()
}

/// The line and column of the first `needle` in `text`.
fn position(text: &str, needle: &str) -> (u32, u32) {
    let offset = text.find(needle).expect("the text holds the needle");
    let before = &text[..offset];
    let line = before.matches('\n').count() as u32 + 1;
    let column = before.rsplit('\n').next().unwrap().encode_utf16().count() as u32 + 1;
    (line, column)
}

/// Asserts that the program written with `patternTool` is compiled as the
/// program written with the closure is, and that the one diagnostic it has
/// beside that program's is the interim warning at the call.
fn assert_compiled_as(tool: Modules, closure: Modules) {
    assert_eq!(emitted(&tool), emitted(&closure));
    let found = diagnostics(&tool);
    let (path, text) = tool
        .iter()
        .find(|(_, text)| text.contains("patternTool("))
        .expect("a module with a call");
    let at = position(text, "patternTool(");
    let warnings: Vec<&Diagnostic> = found
        .iter()
        .filter(|diagnostic| diagnostic.id == ACCEPTED)
        .collect();
    assert_eq!(warnings.len(), 1, "{:#?}", summary(&found));
    assert_eq!(warnings[0].severity, Severity::Warning);
    assert_eq!(warnings[0].file, *path);
    assert_eq!((warnings[0].line, warnings[0].column), at);
    assert!(
        warnings[0].message.contains("pattern<"),
        "the warning names the replacement: {}",
        warnings[0].message
    );
    let lines = |found: &[Diagnostic]| -> Vec<(&'static str, u32)> {
        found
            .iter()
            .filter(|diagnostic| diagnostic.id != ACCEPTED)
            .map(|diagnostic| (diagnostic.id, diagnostic.line))
            .collect()
    };
    assert_eq!(lines(&found), lines(&diagnostics(&closure)));
}

#[test]
fn a_shorthand_property_is_a_capture_of_the_closure() {
    assert_compiled_as(
        vec![("case.tsx", host("patternTool(Search, { donuts })"))],
        vec![(
            "case.tsx",
            host("pattern<{ flavor: string }>((rest) => Search({ ...rest, donuts }))"),
        )],
    );
}

#[test]
fn a_plain_property_binds_the_value_it_is_written_with() {
    let body = |tool: &str| host_with("stock: { all: string[] }", "stock", tool);
    assert_compiled_as(
        vec![(
            "case.tsx",
            body("patternTool(Search, { donuts: stock.all })"),
        )],
        vec![(
            "case.tsx",
            body("pattern<{ flavor: string }>((rest) => Search({ ...rest, donuts: stock.all }))"),
        )],
    );
}

#[test]
fn a_call_without_bound_values_passes_the_input_through() {
    assert_compiled_as(
        vec![("case.tsx", host("patternTool(Search)"))],
        vec![(
            "case.tsx",
            host("pattern<{ flavor: string; donuts: string[] }>((rest) => Search(rest))"),
        )],
    );
    assert_compiled_as(
        vec![("case.tsx", host("patternTool(Search, {})"))],
        vec![(
            "case.tsx",
            host("pattern<{ flavor: string; donuts: string[] }>((rest) => Search({ ...rest,}))"),
        )],
    );
}

#[test]
fn an_imported_pattern_is_called_by_its_imported_name() {
    let library = format!("{IMPORTS}export {SEARCH}");
    let body =
        |tool: &str| host(tool).replace(SEARCH, "import { Search } from \"./search.tsx\";\n");
    assert_compiled_as(
        vec![
            ("search.tsx", library.clone()),
            ("case.tsx", body("patternTool(Search, { donuts })")),
        ],
        vec![
            ("search.tsx", library),
            (
                "case.tsx",
                body("pattern<{ flavor: string }>((rest) => Search({ ...rest, donuts }))"),
            ),
        ],
    );
}

#[test]
fn an_inline_pattern_is_the_callee_of_the_closure() {
    let inline = "pattern<{ flavor: string; donuts: string[] }>(({ flavor, donuts }) => \
({ found: donuts.filter((donut) => donut === flavor) }))";
    assert_compiled_as(
        vec![(
            "case.tsx",
            host(&format!("patternTool({inline}, {{ donuts }})")),
        )],
        vec![(
            "case.tsx",
            host(&format!(
                "pattern<{{ flavor: string }}>((rest) => {inline}({{ ...rest, donuts }}))"
            )),
        )],
    );
}

#[test]
fn a_call_over_several_lines_keeps_the_lines_of_the_module() {
    let tool = host("patternTool(\n      Search,\n      {\n        donuts,\n      },\n    )");
    let closure = host(
        "pattern<{ flavor: string }>((rest) => \nSearch({ ...rest,\n\n        donuts,\n      }\n))",
    );
    assert_eq!(tool.matches('\n').count(), closure.matches('\n').count());
    assert_compiled_as(vec![("case.tsx", tool)], vec![("case.tsx", closure)]);
}

#[test]
fn a_module_that_does_not_import_pattern_is_given_the_import() {
    let library = format!("{IMPORTS}export {SEARCH}");
    let text = "import { pattern as define, patternTool } from \"commonfabric\";\n\
import { Search } from \"./search.tsx\";\n\
export default define<{ donuts: string[] }>(({ donuts }) => \
({ search: patternTool(Search, { donuts }) }));\n";
    let found = diagnostics(&[("search.tsx", library), ("case.tsx", text.to_string())]);
    assert_eq!(
        summary(&found),
        [(ACCEPTED, 3, position(text, "patternTool(Search").1)]
    );
}

#[test]
fn a_name_the_call_already_uses_is_not_the_parameter_of_the_closure() {
    let body = |tool: &str| host_with("rest: string[]", "rest", tool);
    assert_compiled_as(
        vec![("case.tsx", body("patternTool(Search, { donuts: rest })"))],
        vec![(
            "case.tsx",
            body("pattern<{ flavor: string }>((rest2) => Search({ ...rest2, donuts: rest }))"),
        )],
    );
}

/// A module whose pattern body holds `expression`, with `/*!*/` just
/// before the node that the refusal is reported at. `before` is written at
/// module scope.
fn refused(before: &str, expression: &str) -> String {
    format!(
        "{IMPORTS}{SEARCH}{before}\nexport default pattern<{{ donuts: string[]; \
more: {{ donuts: string[] }}; key: string; glaze: string }}>(\
({{ donuts, more, key, glaze }}) => ({{ search: {expression}, more, key, glaze, donuts }}));\n"
    )
}

fn assert_refused(marked: String) {
    const MARKER: &str = "/*!*/";
    let at = position(&marked, MARKER);
    let text = marked.replace(MARKER, "");
    let found = diagnostics(&[("case.tsx", text.clone())]);
    assert!(
        found.iter().any(|diagnostic| diagnostic.id == REFUSED
            && diagnostic.severity == Severity::Error
            && (diagnostic.line, diagnostic.column) == at),
        "{REFUSED} is not reported at {at:?} for:\n{text}\ngot: {:#?}",
        summary(&found)
    );
    assert!(
        !found.iter().any(|diagnostic| diagnostic.id == ACCEPTED),
        "the interim warning is reported for:\n{text}"
    );
}

#[test]
fn a_spread_in_the_bound_values_is_refused() {
    assert_refused(refused("", "/*!*/patternTool(Search, { ...more })"));
}

#[test]
fn a_computed_key_in_the_bound_values_is_refused() {
    assert_refused(refused("", "/*!*/patternTool(Search, { [key]: donuts })"));
}

#[test]
fn bound_values_that_are_not_an_object_literal_are_refused() {
    assert_refused(refused("", "/*!*/patternTool(Search, more)"));
}

#[test]
fn a_bound_key_that_the_input_of_the_pattern_does_not_declare_is_refused() {
    assert_refused(refused("", "/*!*/patternTool(Search, { glaze })"));
}

#[test]
fn a_bound_key_written_twice_is_refused() {
    assert_refused(refused(
        "",
        "/*!*/patternTool(Search, { donuts, donuts: more.donuts })",
    ));
}

#[test]
fn a_third_argument_and_a_spread_argument_are_refused() {
    assert_refused(refused("", "/*!*/patternTool(Search, { donuts }, 1)"));
    assert_refused(refused(
        "const ARGUMENTS = [Search] as const;",
        "/*!*/patternTool(...ARGUMENTS)",
    ));
}

#[test]
fn a_first_argument_that_is_not_a_pattern_is_refused() {
    assert_refused(refused(
        "const twice = (n: number) => n * 2;",
        "/*!*/patternTool(twice, { donuts })",
    ));
    assert_refused(refused(
        "const Either = { search: Search };",
        "/*!*/patternTool(Either.search, { donuts })",
    ));
}

#[test]
fn an_inline_pattern_without_a_written_input_type_is_refused() {
    assert_refused(refused(
        "",
        "/*!*/patternTool(pattern(({ flavor, donuts }: { flavor: string; donuts: string[] }) => \
({ found: donuts, flavor })), { donuts })",
    ));
}

#[test]
fn pattern_tool_passed_as_a_value_is_refused() {
    assert_refused(refused("", "[/*!*/patternTool].length"));
}

#[test]
fn pattern_tool_reached_through_an_alias_is_refused() {
    let text = refused("", "/*!*/tool(Search, { donuts })")
        .replace("patternTool,", "patternTool as tool,");
    assert_refused(text);
}

#[test]
fn a_call_in_a_function_body_is_refused() {
    assert_refused(refused(
        "",
        "computed(() => /*!*/patternTool(Search, { donuts }))",
    ));
}

#[test]
fn a_call_at_module_scope_is_refused() {
    assert_refused(refused(
        "export const TOOL = /*!*/patternTool(Search);",
        "donuts",
    ));
}

#[test]
fn a_call_whose_result_is_spread_or_read_as_a_record_is_refused() {
    assert_refused(refused(
        "",
        "{ .../*!*/patternTool(Search, { donuts }), description: glaze }",
    ));
    assert_refused(refused(
        "",
        "/*!*/patternTool(Search, { donuts }).extraParams",
    ));
}

#[test]
fn one_refused_call_leaves_the_other_calls_of_the_module_accepted() {
    let text = format!(
        "{IMPORTS}{SEARCH}export default pattern<{{ donuts: string[]; more: {{ donuts: string[] }} }}>(\
({{ donuts, more }}) => ({{\n  first: patternTool(Search, {{ donuts }}),\n  \
second: patternTool(Search, {{ ...more }}),\n  third: patternTool(Search),\n}}));\n"
    );
    let found = diagnostics(&[("case.tsx", text.clone())]);
    let tools: Vec<_> = summary(&found)
        .into_iter()
        .filter(|(id, ..)| id.starts_with("removed-form:"))
        .collect();
    assert_eq!(
        tools,
        [(ACCEPTED, 4, 10), (REFUSED, 5, 11), (ACCEPTED, 6, 10),]
    );
}

/// The schema of the input of the factory value at the one marker of
/// `text`.
fn input_schema(text: &str) -> Value {
    assert!(text.contains(TYPE_MARKER));
    let found = closure_inputs_at_markers(&files(&[("case.tsx", text.to_string())]));
    assert_eq!(
        found.len(),
        1,
        "{:?}",
        pattern_compiler::program::types_at_markers(&files(&[("case.tsx", text.to_string())]))
    );
    found.into_iter().next().unwrap()
}

#[test]
fn the_input_of_the_closure_is_the_input_of_the_pattern_without_the_bound_keys() {
    let module = |tool: &str| {
        format!(
            "{IMPORTS}{SEARCH}export default pattern<{{ donuts: string[] }}>(\
({{ donuts }}) => ({{ search: /*?*/({tool}) }}));\n"
        )
    };
    let schema = input_schema(&module("patternTool(Search, { donuts })"));
    assert_eq!(
        schema,
        json!({
            "type": "object",
            "properties": { "flavor": { "type": "string" } },
            "required": ["flavor"],
        })
    );
    assert_eq!(
        schema,
        input_schema(&module(
            "pattern<{ flavor: string }>((rest) => Search({ ...rest, donuts }))"
        ))
    );
    assert_eq!(
        input_schema(&module("patternTool(Search)")),
        input_schema(&module(
            "pattern<{ flavor: string; donuts: string[] }>((rest) => Search(rest))"
        ))
    );
}

#[test]
fn the_input_of_the_closure_keeps_optional_members_and_omits_a_bound_cell_handle() {
    let module = |tool: &str| {
        format!(
            "{IMPORTS}interface Wanted {{ flavor?: string; limit: Default<number, 5>; \
shelf?: {{ row: number }}; donuts: Writable<string[]> }}\n\
const Choose = pattern<Wanted>(({{ flavor, limit, donuts }}) => ({{ flavor, limit, donuts }}));\n\
export default pattern<{{ donuts: Writable<string[]> }}>(\
({{ donuts }}) => ({{ search: /*?*/({tool}) }}));\n"
        )
    };
    let schema = input_schema(&module("patternTool(Choose, { donuts })"));
    assert_eq!(
        schema,
        input_schema(&module(
            "pattern<{ flavor?: string; limit: Default<number, 5>; shelf?: { row: number } }>(\
(rest) => Choose({ ...rest, donuts }))"
        ))
    );
    let properties = schema["properties"].as_object().expect("properties");
    assert_eq!(
        properties.keys().collect::<Vec<_>>(),
        ["flavor", "limit", "shelf"]
    );
    assert_eq!(properties["limit"]["default"], json!(5));
    assert!(!schema.to_string().contains("donuts"));
}

#[test]
fn the_report_counts_a_rewritten_call_as_a_call_of_pattern_tool() {
    let analysis = analyze(&files(&[(
        "case.tsx",
        host("patternTool(Search, { donuts })"),
    )]));
    assert_eq!(analysis.modules[0].counts.get("form:patternTool"), Some(&1));
}

const FIXTURE: &str = "compare/fixtures/pattern-tool";

fn fixture(extension: &str) -> String {
    let path = format!("{}/{FIXTURE}.{extension}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"))
}

/// The plan of the default pattern of the fixture, as the crate emits it.
fn fixture_plan() -> (Value, Vec<String>) {
    let analysis = analyze(&[SourceFile {
        path: format!("{FIXTURE}.tsx"),
        text: fixture("tsx"),
    }]);
    let module = &analysis.modules[0];
    assert!(module.accepted(), "{:#?}", summary(&module.diagnostics));
    let found = module
        .plans
        .iter()
        .find(|plan| plan.name.as_deref() == Some("default"))
        .expect("the default pattern");
    let unsupported = found
        .unsupported
        .iter()
        .map(|(kind, _)| kind.clone())
        .collect();
    (found.plan.clone(), unsupported)
}

#[test]
fn the_fixture_is_accepted_with_the_warning_and_its_files_hold_the_plan() {
    let (plan, _) = fixture_plan();
    for extension in ["plan.json", "emit.json"] {
        let emitted: Value = serde_json::from_str(&fixture(extension)).expect("JSON");
        let stored = emitted[0]["patterns"]
            .as_array()
            .expect("patterns")
            .iter()
            .find(|pattern| pattern["name"] == json!("default"))
            .expect("the default pattern");
        assert_eq!(stored["plan"], plan, "{FIXTURE}.{extension} is out of date");
    }
    let found = diagnostics(&[("pattern-tool.tsx", fixture("tsx"))]);
    assert_eq!(
        summary(&found)
            .into_iter()
            .map(|(id, ..)| id)
            .collect::<Vec<_>>(),
        [ACCEPTED]
    );
}

/// What the plan holds for a pattern closure that a language-model
/// built-in is given as a tool (`plan-and-label-templates.md` §3.15, "A
/// pattern closure given to a language model as a tool"). The request is an
/// effect operation, and the tool is a path of the request with a write
/// edge. The crate does not translate a pattern closure used as a value:
/// the edge has no template, `Plan.closures` is empty, the inline pattern
/// has no plan with slots of root `params`, and the plan lists the closure
/// as a construct it does not support. This test states that, and fails
/// when the translation is built.
#[test]
fn the_plan_of_the_fixture_has_the_request_and_no_record_of_the_closure() {
    let (plan, unsupported) = fixture_plan();
    assert_eq!(
        plan["operations"],
        json!([{
            "implementation": { "builtin": "generateText" },
            "kind": "effect",
            "name": "reply",
            "within": [],
        }])
    );
    let writes: Vec<&Value> = plan["cones"]
        .as_array()
        .expect("cones")
        .iter()
        .flat_map(|cone| cone["writes"].as_array().expect("writes"))
        .collect();
    let at = |path: Value| {
        *writes
            .iter()
            .find(|write| write["target"]["path"] == path)
            .unwrap_or_else(|| panic!("no write edge at {path}"))
    };
    let prompt = at(json!(["prompt"]));
    assert_eq!(prompt["target"]["kind"], json!("request"));
    assert!(prompt.get("template").is_some());
    let tool = at(json!(["tools", "search"]));
    assert_eq!(
        tool["target"],
        json!({ "kind": "request", "of": { "operation": 0 }, "path": ["tools", "search"] })
    );
    assert!(tool.get("template").is_none());
    assert_eq!(plan["closures"], json!([]));
    assert_eq!(unsupported, ["the built-in `pattern` in the reactive tier"]);
}
