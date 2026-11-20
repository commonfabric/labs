//! The interim acceptance of `patternTool` (`language-subset.md` §4.4.3,
//! by the ruling of 2026-11-19).
//!
//! A call `patternTool(P, { a, b })` in the reactive tier is replaced in
//! the module's text, before any other stage reads the module, by an
//! inline pattern closure that calls `P` with the bound values
//! (`language-subset.md` §4.4.2):
//!
//! ```text
//! patternTool(Search, { donuts })
//! pattern<Omit<Parameters<typeof Search>[0], "donuts">>((rest) => Search({ ...rest, donuts }))
//! ```
//!
//! The input type of the closure is the input type of `P` without the
//! bound keys. A call the rewrite does not cover stays in the text, and
//! `crate::check` refuses it (`removed-form:pattern-tool`).
//!
//! The rewrite is made on the text and not on the syntax tree, because the
//! later stages read the text at the spans of the tree (`crate::emit`
//! writes value code from it, and the identity of a module is a hash of
//! it). A replacement holds as many line breaks as the text it replaces,
//! so every line of the module keeps its number, and a diagnostic of a
//! rewritten module is given the position it has in the text as written
//! ([`Rewritten::finish`]).

use std::borrow::Cow;
use std::collections::HashSet;

use oxc_allocator::Allocator;
use oxc_ast::ast::{CallExpression, Expression, ObjectPropertyKind, PropertyKey, PropertyKind};
use oxc_ast::AstKind;
use oxc_span::GetSpan;

use crate::api::{ApiValue, Builder};
use crate::check;
use crate::diagnostics::Diagnostic;
use crate::messages;
use crate::module::{DefKind, ModuleModel};
use crate::parse::{self, Parsed};
use crate::program::{Place, ProgramAnalysis, Resolver, SourceFile};
use crate::source::LineIndex;
use crate::types::Shape;

/// The identifier of the warning an accepted call is reported with.
pub const INTERIM: &str = "removed-form:pattern-tool-interim";

const TOOL: &str = "patternTool";
const PATTERN: &str = "pattern";

/// The text between two offsets of a module replaced by another text.
#[derive(Debug, Clone)]
struct Edit {
    start: u32,
    end: u32,
    text: String,
}

/// An accepted call: its span in the text as written, and the closure it
/// is replaced by, on one line.
#[derive(Debug, Clone)]
struct Accepted {
    span: (u32, u32),
    replacement: String,
}

/// What the rewrite did to one module.
#[derive(Debug, Clone, Default)]
struct ModuleRewrite {
    /// In the order of the text, and disjoint.
    edits: Vec<Edit>,
    accepted: Vec<Accepted>,
}

impl ModuleRewrite {
    fn apply(&self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut at = 0;
        for edit in &self.edits {
            out.push_str(&text[at..edit.start as usize]);
            out.push_str(&edit.text);
            at = edit.end as usize;
        }
        out.push_str(&text[at..]);
        out
    }

    /// The offset in the text as written of an offset in the rewritten
    /// text. An offset inside a replacement is the start of what it
    /// replaces.
    fn written(&self, offset: u32) -> u32 {
        let mut shift: i64 = 0;
        for edit in &self.edits {
            let start = i64::from(edit.start) + shift;
            let end = start + edit.text.len() as i64;
            if i64::from(offset) < start {
                break;
            }
            if i64::from(offset) < end {
                return edit.start;
            }
            shift += edit.text.len() as i64 - i64::from(edit.end - edit.start);
        }
        (i64::from(offset) - shift) as u32
    }
}

/// The files of a program with the accepted `patternTool` calls rewritten.
pub(crate) struct Rewritten<'f> {
    written: &'f [SourceFile],
    files: Cow<'f, [SourceFile]>,
    /// One entry per file: `None` for a file the rewrite left as written.
    modules: Vec<Option<ModuleRewrite>>,
}

impl Rewritten<'_> {
    /// The files every later stage reads.
    pub(crate) fn files(&self) -> &[SourceFile] {
        &self.files
    }

    /// Gives the analysis of the rewritten files what it owes to the text
    /// as written: each diagnostic of a rewritten module at its position in
    /// that text, the warning for each accepted call, the call counted as
    /// the removed form it is, and the text that the offsets of the
    /// module's plans are in.
    pub(crate) fn finish(&self, analysis: &mut ProgramAnalysis) {
        for (index, rewrite) in self.modules.iter().enumerate() {
            let Some(rewrite) = rewrite else {
                continue;
            };
            let path = &self.written[index].path;
            let Some(module) = analysis
                .modules
                .iter_mut()
                .find(|module| module.path == *path)
            else {
                continue;
            };
            let text = &self.written[index].text;
            let lines = LineIndex::new(text);
            for diagnostic in &mut module.diagnostics {
                diagnostic.start = rewrite.written(diagnostic.start);
                diagnostic.end = rewrite.written(diagnostic.end);
                (diagnostic.line, diagnostic.column) = lines.position(text, diagnostic.start);
            }
            for accepted in &rewrite.accepted {
                module.diagnostics.push(Diagnostic::new(
                    INTERIM,
                    path,
                    accepted.span,
                    lines.position(text, accepted.span.0),
                    format!(
                        "`{TOOL}(...)` is a removed form, compiled as `{}`. {}",
                        accepted.replacement,
                        messages::rewrite(INTERIM)
                    ),
                ));
            }
            module
                .diagnostics
                .sort_by(|a, b| (a.start, a.id, a.end).cmp(&(b.start, b.id, b.end)));
            *module.counts.entry(format!("form:{TOOL}")).or_insert(0) += rewrite.accepted.len();
            module.rewritten = Some(self.files[index].text.clone());
        }
    }
}

/// Rewrites the accepted `patternTool` calls of a program.
///
/// Deciding a call needs the tier it is written in and the input type of
/// the pattern it names, so the modules are parsed here once, and the
/// modules that name `patternTool` are walked by `crate::check`. A program
/// that does not name `patternTool` is not parsed.
pub(crate) fn rewrite(written: &[SourceFile]) -> Rewritten<'_> {
    let files = written;
    let mut modules: Vec<Option<ModuleRewrite>> = files.iter().map(|_| None).collect();
    if files.iter().any(|file| file.text.contains(TOOL)) {
        let allocators: Vec<Allocator> = files.iter().map(|_| Allocator::default()).collect();
        let parsed: Vec<Option<Parsed<'_>>> = files
            .iter()
            .zip(&allocators)
            .map(|(file, allocator)| parse::parse(allocator, &file.path, &file.text).ok())
            .collect();
        let models: Vec<Option<ModuleModel>> = parsed
            .iter()
            .map(|parsed| parsed.as_ref().map(ModuleModel::build))
            .collect();
        let resolver = Resolver::new(files, &models, &parsed);
        for (module, file) in files.iter().enumerate() {
            let (Some(parsed), Some(model)) = (&parsed[module], &models[module]) else {
                continue;
            };
            if !file.text.contains(TOOL) {
                continue;
            }
            let checked = check::check_module(parsed, model, module, &resolver);
            resolver.set_bodies(module, &checked.bodies);
            modules[module] = rewrite_module(&resolver, module, parsed, model);
        }
    }
    let files = if modules.iter().all(Option::is_none) {
        Cow::Borrowed(files)
    } else {
        Cow::Owned(
            files
                .iter()
                .zip(&modules)
                .map(|(file, rewrite)| SourceFile {
                    path: file.path.clone(),
                    text: match rewrite {
                        Some(rewrite) => rewrite.apply(&file.text),
                        None => file.text.clone(),
                    },
                })
                .collect(),
        )
    };
    Rewritten {
        written,
        files,
        modules,
    }
}

/// The edits of one module, or `None` when no call of it is accepted.
fn rewrite_module<'a>(
    resolver: &Resolver<'_, 'a>,
    module: usize,
    parsed: &Parsed<'a>,
    model: &ModuleModel,
) -> Option<ModuleRewrite> {
    let scoping = parsed.semantic.scoping();
    let nodes = parsed.semantic.nodes();
    let calls: Vec<&CallExpression<'a>> = nodes
        .iter()
        .filter_map(|node| match node.kind() {
            AstKind::CallExpression(call) => Some(call),
            _ => None,
        })
        .filter(|call| {
            model
                .api_ref_of_callee(scoping, &call.callee)
                .is_some_and(|api| api.value() == ApiValue::PatternTool)
        })
        .collect();
    let mut rewrite = ModuleRewrite::default();
    let mut import: Option<Edit> = None;
    for call in &calls {
        // The edits of a call that holds another call would overlap the
        // edits of that call, so the outer one stays as written.
        let holds_another = calls.iter().any(|other| {
            other.span != call.span
                && call.span.start <= other.span.start
                && other.span.end <= call.span.end
        });
        if holds_another {
            continue;
        }
        let Some(closure) = closure_of(resolver, module, parsed, model, call) else {
            continue;
        };
        if closure.imports_pattern && import.is_none() {
            import = import_of_pattern(parsed, call);
            if import.is_none() {
                continue;
            }
        }
        rewrite.edits.extend(closure.edits);
        rewrite.accepted.push(Accepted {
            span: (call.span.start, call.span.end),
            replacement: closure.replacement,
        });
    }
    if rewrite.accepted.is_empty() {
        return None;
    }
    rewrite.edits.extend(import);
    rewrite.edits.sort_by_key(|edit| edit.start);
    Some(rewrite)
}

/// The closure an accepted call is replaced by.
struct Closure {
    edits: Vec<Edit>,
    /// The closure on one line, for the warning.
    replacement: String,
    /// Whether the name `pattern` is not bound where the call is written,
    /// so that the module has to import it.
    imports_pattern: bool,
}

/// The closure for a call of `patternTool`, or `None` for a call the
/// interim acceptance does not cover.
fn closure_of<'a>(
    resolver: &Resolver<'_, 'a>,
    module: usize,
    parsed: &Parsed<'a>,
    model: &ModuleModel,
    call: &CallExpression<'a>,
) -> Option<Closure> {
    let scoping = parsed.semantic.scoping();
    let nodes = parsed.semantic.nodes();
    let source = parsed.source;
    let text = |start: u32, end: u32| &source[start as usize..end as usize];

    // A direct call of the imported name, in the reactive tier.
    let Expression::Identifier(_) = &call.callee else {
        return None;
    };
    let api = model.api_ref_of_callee(scoping, &call.callee)?;
    if !api.direct || call.optional || call.type_arguments.is_some() {
        return None;
    }
    if resolver.place_at(module, call.span.start) != Place::Reactive {
        return None;
    }
    // The closure is a factory value. A site that reads the result as the
    // record `{ pattern, extraParams }` has no reading of it.
    let read_as_a_record = match nodes.parent_kind(call.node_id.get()) {
        AstKind::SpreadElement(_)
        | AstKind::StaticMemberExpression(_)
        | AstKind::ComputedMemberExpression(_) => true,
        AstKind::CallExpression(parent) => parent.callee.span() == call.span,
        _ => false,
    };
    if read_as_a_record || call.arguments.is_empty() || call.arguments.len() > 2 {
        return None;
    }

    // The bound values: an object literal of plain or shorthand properties.
    let bound = match call.arguments.get(1) {
        None => None,
        Some(argument) => match argument.as_expression()? {
            Expression::ObjectExpression(object) => Some(object),
            _ => return None,
        },
    };
    let mut keys: Vec<String> = Vec::new();
    for property in bound.iter().flat_map(|object| &object.properties) {
        let ObjectPropertyKind::ObjectProperty(property) = property else {
            return None;
        };
        if property.kind != PropertyKind::Init || property.method || property.computed {
            return None;
        }
        let key = match &property.key {
            PropertyKey::StaticIdentifier(name) => name.name.to_string(),
            PropertyKey::StringLiteral(name) => name.value.to_string(),
            _ => return None,
        };
        if key.contains(['"', '\\', '\n']) || keys.contains(&key) {
            return None;
        }
        keys.push(key);
    }

    // The pattern, and its input type as the closure's type argument
    // names it.
    let pattern = call.arguments[0].as_expression()?;
    let input = match pattern {
        Expression::Identifier(name) => {
            if resolver.value_def(module, name) != Some(DefKind::Pattern) {
                return None;
            }
            format!("Parameters<typeof {}>[0]", name.name)
        }
        Expression::CallExpression(inline) => {
            let Expression::Identifier(_) = &inline.callee else {
                return None;
            };
            let builder = model.api_ref_of_callee(scoping, &inline.callee)?.value();
            if !matches!(builder, ApiValue::Builder(Builder::Pattern)) {
                return None;
            }
            let written = inline.type_arguments.as_ref()?.params.first()?.span();
            let written = text(written.start, written.end);
            // A line comment would end with the line it is joined to.
            if written.contains("//") {
                return None;
            }
            written.split_whitespace().collect::<Vec<_>>().join(" ")
        }
        _ => return None,
    };
    if !keys.is_empty() {
        let factory = resolver.declared(module, pattern).ok()?;
        let Shape::PatternFactory(declared, _) = resolver.shape(factory) else {
            return None;
        };
        let Shape::Object(properties, index) = resolver.shape(declared) else {
            return None;
        };
        let declares = |key: &String| properties.iter().any(|property| property.name == *key);
        if index.is_none() && !keys.iter().all(declares) {
            return None;
        }
    }
    let input = if keys.is_empty() {
        input
    } else {
        let keys: Vec<String> = keys.iter().map(|key| format!("\"{key}\"")).collect();
        format!("Omit<{input}, {}>", keys.join(" | "))
    };

    // The closure calls the builder by the name `pattern`.
    let scope = nodes.get_node(call.node_id.get()).scope_id();
    let imports_pattern = match scoping.find_binding(scope, PATTERN.into()) {
        Some(symbol) => {
            let api = model.api_ref(symbol)?;
            if api.name != PATTERN || api.subpath.is_some() {
                return None;
            }
            false
        }
        None => true,
    };

    // A parameter name that nothing in the call uses.
    let used: HashSet<&str> = nodes
        .iter()
        .filter_map(|node| match node.kind() {
            AstKind::IdentifierReference(name) => Some((name.span, name.name.as_str())),
            AstKind::BindingIdentifier(name) => Some((name.span, name.name.as_str())),
            _ => None,
        })
        .filter(|(span, _)| call.span.start <= span.start && span.end <= call.span.end)
        .map(|(_, name)| name)
        .collect();
    let parameter = (1..)
        .map(|ordinal| match ordinal {
            1 => "rest".to_string(),
            _ => format!("rest{ordinal}"),
        })
        .find(|name| !used.contains(name.as_str()))
        .expect("an unused name");

    // Each replacement holds the line breaks of the text it replaces.
    let breaks = |start: u32, end: u32| "\n".repeat(text(start, end).matches('\n').count());
    let head = format!("{PATTERN}<{input}>(({parameter}) => ");
    let callee = pattern.span();
    let mut edits = vec![Edit {
        start: call.span.start,
        end: callee.start,
        text: format!("{head}{}", breaks(call.span.start, callee.start)),
    }];
    let argument = match bound {
        Some(object) => {
            let open = object.span.start + 1;
            edits.push(Edit {
                start: callee.end,
                end: open,
                text: format!("({{ ...{parameter},{}", breaks(callee.end, open)),
            });
            edits.push(Edit {
                start: object.span.end,
                end: call.span.end,
                text: format!("{}))", breaks(object.span.end, call.span.end)),
            });
            format!("({{ ...{parameter},{})", text(open, object.span.end))
        }
        None => {
            edits.push(Edit {
                start: callee.end,
                end: call.span.end,
                text: format!("({parameter}{}))", breaks(callee.end, call.span.end)),
            });
            format!("({parameter})")
        }
    };
    let replacement = format!("{head}{}{argument})", text(callee.start, callee.end));
    Some(Closure {
        edits,
        replacement: replacement.split_whitespace().collect::<Vec<_>>().join(" "),
        imports_pattern,
    })
}

/// The edit that adds `pattern` to the import that `call`'s callee is
/// imported by.
fn import_of_pattern(parsed: &Parsed<'_>, call: &CallExpression<'_>) -> Option<Edit> {
    let Expression::Identifier(callee) = &call.callee else {
        return None;
    };
    let symbol = crate::module::symbol_of(parsed.semantic.scoping(), callee)?;
    parsed
        .semantic
        .nodes()
        .iter()
        .find_map(|node| match node.kind() {
            AstKind::ImportSpecifier(specifier)
                if specifier.local.symbol_id.get() == Some(symbol) =>
            {
                Some(Edit {
                    start: specifier.span.start,
                    end: specifier.span.start,
                    text: format!("{PATTERN}, "),
                })
            }
            _ => None,
        })
}

#[cfg(test)]
mod tests {
    use super::{rewrite, SourceFile};

    fn rewritten(text: &str) -> String {
        let files = [SourceFile {
            path: "case.tsx".to_string(),
            text: text.to_string(),
        }];
        let rewritten = rewrite(&files);
        rewritten.files()[0].text.clone()
    }

    const HEAD: &str = "import { pattern, patternTool } from \"commonfabric\";\n\
const Search = pattern<{ flavor: string; donuts: string[] }>(({ donuts }) => ({ donuts }));\n";

    #[test]
    fn an_accepted_call_is_replaced_by_the_closure_in_the_text() {
        let host = |tool: &str| {
            format!(
                "{HEAD}export default pattern<{{ donuts: string[] }}>(({{ donuts }}) => \
({{ a: {tool}, donuts }}));\n"
            )
        };
        assert_eq!(
            rewritten(&host("patternTool(Search, { donuts })")),
            host(
                "pattern<Omit<Parameters<typeof Search>[0], \"donuts\">>((rest) => \
Search({ ...rest, donuts }))"
            )
        );
        assert_eq!(
            rewritten(&host("patternTool(Search)")),
            host("pattern<Parameters<typeof Search>[0]>((rest) => Search(rest))")
        );
    }

    #[test]
    fn a_call_at_module_scope_stays_as_written() {
        let text = format!("{HEAD}export const TOOL = patternTool(Search);\n");
        assert_eq!(rewritten(&text), text);
    }

    #[test]
    fn an_offset_of_the_rewritten_text_maps_to_the_text_as_written() {
        let text = format!(
            "{HEAD}export default pattern<{{ donuts: string[] }}>(({{ donuts }}) => \
({{ a: patternTool(Search, {{ donuts }}), b: donuts }}));\n"
        );
        let files = [SourceFile {
            path: "case.tsx".to_string(),
            text: text.clone(),
        }];
        let result = rewrite(&files);
        let rewrite = result.modules[0].as_ref().expect("a rewritten module");
        let after = &result.files()[0].text;
        let b = |text: &str| text.find("b: donuts").unwrap() as u32;
        assert_eq!(rewrite.written(b(after)), b(&text));
        let call = text.find("patternTool(Search").unwrap() as u32;
        assert_eq!(rewrite.written(call + 3), call);
        assert_eq!(rewrite.written(5), 5);
    }
}
