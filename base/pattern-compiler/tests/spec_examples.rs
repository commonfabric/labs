//! The examples of `language-subset.md` as tests.
//!
//! The document's code blocks are fragments: most refer to names they do
//! not declare. The first test parses every block as it stands. The others
//! give an example the declarations it leaves out and check what the front
//! end reports for it.

use pattern_compiler::diagnostics::Severity;
use pattern_compiler::program::{analyze, SourceFile};

const SPECIFICATION: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/specs/compiled-pattern-language/language-subset.md"
);

const PRELUDE: &str =
    "import { computed, fetchJson, handler, pattern, Writable } from \"commonfabric\";\n\
interface Donut { name: string; flavor: string; glaze: string; basePrice: number }\n\
interface Order { id: string; paid: boolean }\n";

/// The identifiers of the errors the front end reports for a module.
fn errors(source: &str) -> Vec<&'static str> {
    let analysis = analyze(&[SourceFile {
        path: "example.tsx".to_string(),
        text: format!("{PRELUDE}{source}"),
    }]);
    assert!(analysis.failures.is_empty(), "{:?}", analysis.failures);
    analysis.modules[0]
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.severity == Severity::Error)
        .map(|diagnostic| diagnostic.id)
        .collect()
}

/// The code blocks of the document, each cut where a comment starts an
/// alternative that declares the same names again.
fn blocks() -> Vec<String> {
    let text = std::fs::read_to_string(SPECIFICATION).expect("the specification is readable");
    let mut blocks = Vec::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            match current.take() {
                Some(block) => blocks.push(block),
                None if trimmed.starts_with("```ts") => current = Some(String::new()),
                None => {}
            }
            continue;
        }
        if let Some(block) = &mut current {
            let alternative = ["// After", "// Accepted", "// Correction", "// Refused"]
                .iter()
                .any(|start| trimmed.starts_with(start));
            if alternative && !block.trim().is_empty() {
                blocks.push(std::mem::take(block));
            }
            block.push_str(line);
            block.push('\n');
        }
    }
    blocks
}

#[test]
fn every_code_block_of_the_specification_parses() {
    let blocks = blocks();
    assert!(blocks.len() > 30, "found {} blocks", blocks.len());
    for block in blocks {
        // A block that shows JSX children alone is wrapped in a fragment.
        let children = block
            .lines()
            .find(|line| !line.trim_start().starts_with("//") && !line.trim().is_empty())
            .is_some_and(|line| line.trim_start().starts_with('<'));
        let text = if children {
            format!("const view = <>\n{block}</>;\n")
        } else {
            block.clone()
        };
        let analysis = analyze(&[SourceFile {
            path: "block.tsx".to_string(),
            text,
        }]);
        assert!(
            analysis.failures.is_empty(),
            "a block does not parse:\n{block}\n{:?}",
            analysis.failures
        );
    }
}

#[test]
fn module_scope_initializer_kinds_are_accepted() {
    let source = "const buildMenu = (glazes: readonly string[]) => glazes.map((glaze) => glaze);\n\
        const GLAZES = [\"plain\", \"sugar\", \"chocolate\"] as const;\n\
        const PRICE_BY_GLAZE = new Map([[\"plain\", 2], [\"sugar\", 3]]);\n\
        const MENU = buildMenu(GLAZES);\n\
        const buildLabel = (name: string) => `${name} donut`;\n\
        const DonutCard = pattern<{ donut: Donut }>(({ donut }) => ({ donut }));\n";
    assert_eq!(errors(source), Vec::<&str>::new());
}

#[test]
fn overview_example_is_accepted() {
    let source = "const sum = (prices: number[]) => prices.length;\n\
        export default pattern<{ donuts: Donut[]; taxRate: number }>(({ donuts, taxRate }) => {\n\
          const glazed = donuts.filter((d) => d.glaze !== \"none\");\n\
          const prices = glazed.map((d) => ({ name: d.name, price: d.basePrice * (1 + taxRate) }));\n\
          const total = computed(() => sum(prices.map((p) => p.price)));\n\
          return { prices, total };\n\
        });\n";
    assert_eq!(errors(source), Vec::<&str>::new());
}

#[test]
fn pattern_closure_is_accepted_in_the_reactive_tier() {
    let source = "const DonutSearch = pattern<{ donuts: Donut[] }>(({ donuts }) => {\n\
          const search = pattern<{ flavor: string }>(({ flavor }) =>\n\
            donuts.filter((donut) => donut.flavor === flavor)\n\
          );\n\
          return { search };\n\
        });\n";
    assert_eq!(errors(source), Vec::<&str>::new());
}

#[test]
fn handler_binding_in_a_collection_callback_is_accepted() {
    let source = "const Box = pattern<{ donuts: Donut[]; favorites: Writable<Donut[]> }>(({ donuts, favorites }) => {\n\
          const rows = donuts.map((donut) => (\n\
            <li>{donut.name}<button onClick={() => favorites.push(donut)}>favorite</button></li>\n\
          ));\n\
          return { rows };\n\
        });\n";
    assert_eq!(errors(source), Vec::<&str>::new());
}

#[test]
fn computed_that_instantiates_a_pattern_with_a_cause_is_accepted() {
    let source = "const priceUrl = (order: Order) => `https://donuts.example/${order.id}`;\n\
        const PriceQuote = pattern<{ url: string }>(({ url }) => fetchJson({ url }));\n\
        const Quotes = pattern<{ orders: Order[] }>(({ orders }) => {\n\
          const quotes = computed(() => {\n\
            const open = orders.filter((order) => !order.paid);\n\
            return open.map((order) => PriceQuote({ url: priceUrl(order) }).for(order.id));\n\
          });\n\
          return { quotes };\n\
        });\n";
    assert_eq!(errors(source), Vec::<&str>::new());
}

#[test]
fn handler_bindings_in_authored_functions_are_accepted() {
    let source = "interface RemoveState { chosen: Writable<string[]>; name: string }\n\
        const removeTopping = handler<unknown, RemoveState>((_, { chosen, name }) => chosen.removeByValue(name));\n\
        const toppingButtons = (toppings: string[], chosen: Writable<string[]>) =>\n\
          toppings.map((name) => (\n\
            <span>\n\
              <button onClick={() => chosen.addUnique(name)}>{name}</button>\n\
              <button onClick={removeTopping({ chosen, name })}>remove</button>\n\
            </span>\n\
          ));\n\
        const favoriteButtons = (box: Writable<Donut[]>, favorites: Writable<Donut[]>) =>\n\
          box.get().map((donut) => (\n\
            <button onClick={() => favorites.push(donut)}>{donut.name}</button>\n\
          ));\n";
    assert_eq!(errors(source), Vec::<&str>::new());
}

#[test]
fn collection_method_on_a_handle_in_a_function_body_has_two_corrections() {
    let refused =
        "const list = handler<unknown, { donuts: Writable<Donut[]> }>((_, { donuts }) => {\n\
          const names = donuts.map((donut) => donut.name);\n\
          console.log(names);\n\
        });\n";
    assert_eq!(errors(refused), ["cell:collection-method-in-function"]);
    let inline =
        "const list = handler<unknown, { donuts: Writable<Donut[]> }>((_, { donuts }) => {\n\
          const names = pattern(() => donuts.map((donut) => donut.name))({});\n\
          console.log(names);\n\
        });\n";
    assert_eq!(errors(inline), Vec::<&str>::new());
    let read_first =
        "const list = handler<unknown, { donuts: Writable<Donut[]> }>((_, { donuts }) => {\n\
          const names = donuts.get().map((donut) => donut.name);\n\
          console.log(names);\n\
        });\n";
    assert_eq!(errors(read_first), Vec::<&str>::new());
}

#[test]
fn default_in_the_pattern_parameter_is_refused_and_in_the_type_accepted() {
    let before = "import type { Default } from \"commonfabric\";\n\
        const Box = pattern<{ glaze?: string }>(({ glaze = \"plain\" }) => ({ glaze }));\n";
    assert_eq!(errors(before), ["pattern-context:parameter-form"]);
    let after = "import type { Default } from \"commonfabric\";\n\
        const Box = pattern<{ glaze: Default<string, \"plain\"> }>(({ glaze }) => ({ glaze }));\n";
    assert_eq!(errors(after), Vec::<&str>::new());
}

#[test]
fn imported_typescript_module_is_not_checked_against_the_subset() {
    let analysis = analyze(&[SourceFile {
        path: "math.ts".to_string(),
        text: "\"use typescript\";\n\
            type Shape<T> = T extends readonly (infer E)[] ? E : never;\n\
            export function unitPrice(basePrice: number, glaze: string): number {\n\
              return basePrice + glaze.length;\n\
            }\n"
        .to_string(),
    }]);
    assert!(analysis.modules[0].diagnostics.is_empty());
}
