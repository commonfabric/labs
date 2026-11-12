//! Diagnostics: a refusal, a warning, or a hint with a catalog identifier.

use serde::Serialize;

use crate::catalog;

/// The severities of `language-subset.md` §10.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// The program is refused.
    Error,
    /// The program is accepted, and the report is shown by default.
    Warning,
    /// The program is accepted, and the report is shown on request.
    Hint,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
            Severity::Hint => "hint",
        }
    }
}

/// One report of the front end, positioned in a module.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Diagnostic {
    /// The identifier of the catalog entry, such as `module-scope:statement`.
    pub id: &'static str,
    pub severity: Severity,
    /// The module's path, as it was given to the front end.
    pub file: String,
    /// Byte offsets of the reported node in the module's text.
    pub start: u32,
    pub end: u32,
    /// 1-based line, and 1-based column in UTF-16 code units, of `start`.
    pub line: u32,
    pub column: u32,
    pub message: String,
}

impl Diagnostic {
    /// A diagnostic with the severity the catalog gives `id`.
    ///
    /// Panics when `id` is not a catalog entry the front end implements,
    /// which would be a defect of the front end and not of the program
    /// compiled.
    pub fn new(
        id: &'static str,
        file: &str,
        (start, end): (u32, u32),
        (line, column): (u32, u32),
        message: String,
    ) -> Self {
        let severity = catalog::implemented_severity(id)
            .unwrap_or_else(|| panic!("`{id}` is not an implemented catalog entry"));
        Self {
            id,
            severity,
            file: file.to_string(),
            start,
            end,
            line,
            column,
            message,
        }
    }

    pub fn is_error(&self) -> bool {
        self.severity == Severity::Error
    }
}

impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}:{}:{}: {} [{}] {}",
            self.file,
            self.line,
            self.column,
            self.severity.as_str(),
            self.id,
            self.message
        )
    }
}
