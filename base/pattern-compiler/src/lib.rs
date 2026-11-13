//! A prototype front end for the compiled pattern language.
//!
//! The language is specified in `docs/specs/compiled-pattern-language/` of
//! this repository. This crate parses the modules of a program, models each
//! module, classifies its code into the tiers of `language-subset.md` §1,
//! checks the rules of the subset that need no type checker, and reports the
//! diagnostics of that document's §10.

pub mod api;
pub mod assign;
pub mod catalog;
pub mod check;
pub mod corpus;
pub mod declared;
pub mod diagnostics;
pub mod infer;
pub mod messages;
pub mod module;
pub mod narrow;
pub mod parse;
pub mod program;
pub mod report;
pub mod source;
pub mod syntax;
pub mod tiers;
pub mod types;
