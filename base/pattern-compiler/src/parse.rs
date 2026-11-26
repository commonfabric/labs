//! Parsing a module's text into a syntax tree with resolved names.
//!
//! The parser and the scope analysis are the `oxc` crates. Nothing in this
//! crate tokenizes or parses TypeScript itself.

use oxc_allocator::Allocator;
use oxc_ast::ast::Program;
use oxc_parser::Parser;
use oxc_semantic::{Semantic, SemanticBuilder};
use oxc_span::SourceType;

use crate::source::LineIndex;

/// A parsed module: its syntax tree, and the scopes, symbols, and references
/// the scope analysis found in it.
pub struct Parsed<'a> {
    /// The path the module was given under, with `/` separators.
    pub path: String,
    pub source: &'a str,
    pub program: &'a Program<'a>,
    pub semantic: Semantic<'a>,
    pub lines: LineIndex,
}

/// A module the parser could not turn into a syntax tree.
#[derive(Debug, Clone)]
pub struct ParseFailure {
    pub path: String,
    pub errors: Vec<String>,
}

/// Parses `source` as TypeScript, or as TSX when `path` ends in `.tsx`.
///
/// The tree and the text live in `allocator`, so they stay valid for as long
/// as it does.
pub fn parse<'a>(
    allocator: &'a Allocator,
    path: &str,
    source: &str,
) -> Result<Parsed<'a>, ParseFailure> {
    let failure = |errors: Vec<String>| ParseFailure {
        path: path.to_string(),
        errors,
    };
    let source: &'a str = allocator.alloc_str(source);
    let source_type = SourceType::from_path(path)
        .map_err(|_| failure(vec![format!("`{path}` is not a `.ts` or `.tsx` file")]))?
        .with_module(true);
    let parsed = Parser::new(allocator, source, source_type).parse();
    if parsed.panicked || !parsed.errors.is_empty() {
        return Err(failure(
            parsed
                .errors
                .iter()
                .map(|error| error.to_string())
                .collect(),
        ));
    }
    let program: &'a Program<'a> = allocator.alloc(parsed.program);
    let built = SemanticBuilder::new().build(program);
    if !built.errors.is_empty() {
        return Err(failure(
            built.errors.iter().map(|error| error.to_string()).collect(),
        ));
    }
    Ok(Parsed {
        path: path.to_string(),
        source,
        program,
        semantic: built.semantic,
        lines: LineIndex::new(source),
    })
}
