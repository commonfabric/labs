//! The report of the front end over a set of modules.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::diagnostics::Severity;
use crate::program::ProgramAnalysis;
use crate::tiers::{BodyKind, CallKind, Promotion, Site, Tier};

/// One row of the per-diagnostic table.
#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticCount {
    pub id: String,
    pub severity: Severity,
    pub occurrences: usize,
    pub files: usize,
}

/// A quantity `language-subset.md` §11 states, beside what the front end
/// counts for it.
#[derive(Debug, Clone, Serialize)]
pub struct Comparison {
    pub quantity: &'static str,
    /// The section of `language-subset.md` that states the figure.
    pub section: &'static str,
    pub predicted: usize,
    pub measured: usize,
}

/// The report over a set of modules.
#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub modules: usize,
    pub lines: usize,
    /// Modules with no diagnostic of severity error.
    pub accepted: usize,
    pub errors: usize,
    pub warnings: usize,
    pub hints: usize,
    pub diagnostics: Vec<DiagnosticCount>,
    /// Errors that depend on a reading recorded in `SPEC-NOTES.md`, by the
    /// key of the note.
    pub errors_by_note: BTreeMap<String, usize>,
    /// The modules with the most errors, most first.
    pub most_errors: Vec<(String, usize)>,
    /// The number of bodies of each kind.
    pub bodies: BTreeMap<String, usize>,
    /// The number of bodies of each kind by where they are written.
    pub bodies_by_site: BTreeMap<String, usize>,
    /// The outcomes of the promotion criterion over the `computed` calls.
    pub promotion: BTreeMap<String, usize>,
    /// The number of calls of each removed or interim form.
    pub forms: BTreeMap<String, usize>,
    /// Other constructs counted for the comparison with §11.
    pub constructs: BTreeMap<String, usize>,
    pub comparisons: Vec<Comparison>,
}

const FORMS: [&str; 11] = [
    "ifElse",
    "when",
    "unless",
    "str",
    "patternTool",
    "llm",
    "streamData",
    "cell",
    "byRef",
    "nameInstance",
    "withPattern",
];

impl Report {
    /// Builds the report. `lines` is the number of lines of the modules.
    pub fn build(analysis: &ProgramAnalysis, lines: usize) -> Self {
        let mut by_id: BTreeMap<&str, (Severity, usize, usize)> = BTreeMap::new();
        let mut errors_by_note = BTreeMap::new();
        let mut most_errors = Vec::new();
        let mut bodies = BTreeMap::new();
        let mut bodies_by_site = BTreeMap::new();
        let mut promotion = BTreeMap::new();
        let mut constructs: BTreeMap<String, usize> = BTreeMap::new();
        let (mut errors, mut warnings, mut hints) = (0, 0, 0);
        for kind in BodyKind::ALL {
            bodies.insert(kind.label().to_string(), 0);
        }
        for module in &analysis.modules {
            let mut seen: Vec<&str> = Vec::new();
            let mut module_errors = 0;
            for diagnostic in &module.diagnostics {
                let entry = by_id
                    .entry(diagnostic.id)
                    .or_insert((diagnostic.severity, 0, 0));
                entry.1 += 1;
                if !seen.contains(&diagnostic.id) {
                    seen.push(diagnostic.id);
                    entry.2 += 1;
                }
                match diagnostic.severity {
                    Severity::Error => {
                        errors += 1;
                        module_errors += 1;
                        if let Some(note) = diagnostic.note {
                            *errors_by_note.entry(note.to_string()).or_insert(0) += 1;
                        }
                    }
                    Severity::Warning => warnings += 1,
                    Severity::Hint => hints += 1,
                }
            }
            if module_errors > 0 {
                most_errors.push((module.path.clone(), module_errors));
            }
            for (key, count) in &module.counts {
                *constructs.entry(key.clone()).or_insert(0) += count;
            }
            for body in &module.bodies {
                *bodies.entry(body.kind.label().to_string()).or_insert(0) += 1;
                let site = match body.site {
                    Site::Module => "at module scope",
                    Site::Reactive => "in the reactive tier",
                    Site::Function => "in a function body",
                };
                *bodies_by_site
                    .entry(format!("{}, {site}", body.kind.label()))
                    .or_insert(0) += 1;
                let in_pattern = body
                    .parent
                    .is_some_and(|parent| module.bodies[parent].tier == Tier::Reactive)
                    && body.site == Site::Reactive;
                if body.kind == BodyKind::ElementCallback
                    && in_pattern
                    && body.method.as_deref() == Some("map")
                {
                    *constructs
                        .entry("map callback in the reactive tier".into())
                        .or_insert(0) += 1;
                    if body.uses_index {
                        *constructs
                            .entry("map callback in the reactive tier that uses its index".into())
                            .or_insert(0) += 1;
                    }
                }
                if body.kind == BodyKind::Computed {
                    let binds = body
                        .calls
                        .iter()
                        .filter(|call| call.kind == CallKind::BindHandler && call.name != "action")
                        .filter(|call| !call.name.starts_with("on"))
                        .count();
                    *constructs
                        .entry("handler applied to its state in a computed".into())
                        .or_insert(0) += binds;
                }
                let key = match &body.promotion {
                    None => continue,
                    Some(Promotion::Statement) => "in statement position",
                    Some(Promotion::Promoted { guard: true, .. }) => {
                        "promoted through the guard form"
                    }
                    Some(Promotion::Promoted {
                        calls_function: true,
                        ..
                    }) => "promoted, with a call of an authored function",
                    Some(Promotion::Promoted { .. }) => "promoted, structural operations only",
                    Some(Promotion::NotPromoted {
                        statement_body: true,
                        ..
                    }) => "not promoted: a statement body",
                    Some(Promotion::NotPromoted { .. }) => {
                        "not promoted: a disqualifying expression"
                    }
                };
                *promotion.entry(key.to_string()).or_insert(0) += 1;
            }
        }
        most_errors.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        most_errors.truncate(20);
        let mut diagnostics: Vec<DiagnosticCount> = by_id
            .into_iter()
            .map(|(id, (severity, occurrences, files))| DiagnosticCount {
                id: id.to_string(),
                severity,
                occurrences,
                files,
            })
            .collect();
        diagnostics.sort_by(|a, b| {
            (a.severity, std::cmp::Reverse(a.occurrences), &a.id).cmp(&(
                b.severity,
                std::cmp::Reverse(b.occurrences),
                &b.id,
            ))
        });
        let forms: BTreeMap<String, usize> = FORMS
            .iter()
            .map(|form| {
                let count = constructs.remove(&format!("form:{form}")).unwrap_or(0);
                (form.to_string(), count)
            })
            .collect();
        let mut report = Report {
            modules: analysis.modules.len(),
            lines,
            accepted: analysis
                .modules
                .iter()
                .filter(|module| module.accepted())
                .count(),
            errors,
            warnings,
            hints,
            diagnostics,
            errors_by_note,
            most_errors,
            bodies,
            bodies_by_site,
            promotion,
            forms,
            constructs,
            comparisons: Vec::new(),
        };
        report.comparisons = report.compare();
        report
    }

    fn construct(&self, key: &str) -> usize {
        self.constructs.get(key).copied().unwrap_or(0)
    }

    fn diagnostic(&self, id: &str) -> usize {
        self.diagnostics
            .iter()
            .find(|row| row.id == id)
            .map_or(0, |row| row.occurrences)
    }

    fn site(&self, key: &str) -> usize {
        self.bodies_by_site.get(key).copied().unwrap_or(0)
    }

    fn body(&self, kind: BodyKind) -> usize {
        self.bodies.get(kind.label()).copied().unwrap_or(0)
    }

    fn promoted(&self, key: &str) -> usize {
        self.promotion.get(key).copied().unwrap_or(0)
    }

    /// The figures of `language-subset.md` §11 beside the front end's count
    /// of the same construct.
    fn compare(&self) -> Vec<Comparison> {
        let row = |quantity, section, predicted, measured| Comparison {
            quantity,
            section,
            predicted,
            measured,
        };
        let any = self.construct("any");
        let as_any = self.construct("as-any");
        vec![
            row("modules", "11.1", 425, self.modules),
            row(
                "`pattern` definitions",
                "11.1",
                507,
                self.body(BodyKind::Pattern),
            ),
            row(
                "`handler` definitions at module scope",
                "11.1",
                621,
                self.site("handler, at module scope"),
            ),
            row(
                "`lift` definitions at module scope",
                "11.1",
                73,
                self.site("lift, at module scope"),
            ),
            row(
                "`computed` calls",
                "11.1",
                1493,
                self.body(BodyKind::Computed),
            ),
            row("`action` calls", "11.1", 249, self.body(BodyKind::Action)),
            row(
                "inline JSX event handlers",
                "11.1",
                188,
                self.body(BodyKind::InlineHandler),
            ),
            row(
                "block-bodied pattern callbacks",
                "11.2",
                472,
                self.construct("pattern-block"),
            ),
            row(
                "`const` statements in pattern callbacks",
                "11.2",
                2919,
                self.construct("pattern-block:const"),
            ),
            row(
                "expression statements in pattern callbacks",
                "11.2",
                20,
                self.construct("pattern-block:expression"),
            ),
            row(
                "local type declarations in pattern callbacks",
                "11.2",
                2,
                self.construct("pattern-block:type"),
            ),
            row(
                "function overload signatures",
                "11.3",
                5,
                self.construct("overload-signature"),
            ),
            row(
                "mapped types",
                "11.3",
                1,
                self.diagnostic("subset-type:mapped"),
            ),
            row("`ifElse` calls", "11.3", 156, self.forms["ifElse"]),
            row("`when` calls", "11.3", 1, self.forms["when"]),
            row("`unless` calls", "11.3", 0, self.forms["unless"]),
            row("`str` tagged templates", "11.3", 1, self.forms["str"]),
            row("`patternTool` calls", "11.3", 31, self.forms["patternTool"]),
            row(
                "collection methods on a cell handle in a function body",
                "11.3",
                2,
                self.construct("handle-collection-in-function"),
            ),
            row(
                "per-element bodies over plain values that bind a handler without the index",
                "11.3",
                7,
                self.diagnostic("collection:shared-element-state"),
            ),
            row("`any` in a type", "11.3", 132, any.saturating_sub(as_any)),
            row("`as any`", "11.3", 52, as_any),
            row(
                "`new` of a non-cell constructor in the reactive tier",
                "11.3",
                4,
                self.construct("reactive:new-non-cell"),
            ),
            row(
                "`void` in the reactive tier",
                "11.3",
                2,
                self.construct("reactive:void"),
            ),
            row(
                "inline event handlers in a function body",
                "11.4",
                8,
                self.site("inline event handler, in a function body"),
            ),
            row(
                "`action` created in a function body",
                "11.4",
                1,
                self.site("action, in a function body"),
            ),
            row(
                "handler applied to its state in a computed",
                "11.4",
                16,
                self.construct("handler applied to its state in a computed"),
            ),
            row(
                "`map` callbacks in the reactive tier",
                "11.4",
                326,
                self.construct("map callback in the reactive tier"),
            ),
            row(
                "`map` callbacks in the reactive tier that use the index",
                "11.4",
                44,
                self.construct("map callback in the reactive tier that uses its index"),
            ),
            row(
                "`.get()` in the reactive tier",
                "11.4",
                68,
                self.construct("reactive:get-call"),
            ),
            row(
                "builder callbacks passed by local name",
                "11.4",
                6,
                self.construct("builder-callback-by-name"),
            ),
            row(
                "conditional expressions in the reactive tier",
                "12.1",
                466,
                self.construct("reactive:conditional"),
            ),
            row(
                "`computed` in statement position",
                "11.5",
                15,
                self.promoted("in statement position"),
            ),
            row(
                "`computed` promoted, structural operations only",
                "11.5",
                1039,
                self.promoted("promoted, structural operations only"),
            ),
            row(
                "`computed` promoted, with a call of an authored function",
                "11.5",
                222,
                self.promoted("promoted, with a call of an authored function"),
            ),
            row(
                "`computed` promoted through the guard form",
                "11.5",
                108,
                self.promoted("promoted through the guard form"),
            ),
            row(
                "`computed` not promoted: a statement body",
                "11.5",
                62,
                self.promoted("not promoted: a statement body"),
            ),
            row(
                "`computed` not promoted: a disqualifying expression",
                "11.5",
                47,
                self.promoted("not promoted: a disqualifying expression"),
            ),
        ]
    }

    /// The report as text.
    pub fn render(&self) -> String {
        let mut out = String::new();
        let mut line = |text: String| {
            out.push_str(&text);
            out.push('\n');
        };
        line(format!("modules                 {:6}", self.modules));
        line(format!("lines                   {:6}", self.lines));
        line(format!("accepted with no error  {:6}", self.accepted));
        line(format!(
            "refused                 {:6}",
            self.modules - self.accepted
        ));
        line(format!("errors                  {:6}", self.errors));
        line(format!("warnings                {:6}", self.warnings));
        line(format!("hints                   {:6}", self.hints));
        line(String::new());
        line("diagnostics (occurrences, files)".to_string());
        for row in &self.diagnostics {
            line(format!(
                "  {:7}  {:44} {:6} {:5}",
                row.severity.as_str(),
                row.id,
                row.occurrences,
                row.files
            ));
        }
        line(String::new());
        line("errors that depend on a reading recorded in SPEC-NOTES.md".to_string());
        for (note, count) in &self.errors_by_note {
            line(format!("  {note:44} {count:6}"));
        }
        line(String::new());
        line("modules with the most errors".to_string());
        for (path, count) in &self.most_errors {
            line(format!("  {count:5}  {path}"));
        }
        for (title, table) in [
            ("bodies by kind", &self.bodies),
            ("bodies by kind and site", &self.bodies_by_site),
            ("promotion of `computed`", &self.promotion),
            ("removed and interim forms", &self.forms),
            ("other constructs", &self.constructs),
        ] {
            line(String::new());
            line(title.to_string());
            for (key, count) in table {
                line(format!("  {count:6}  {key}"));
            }
        }
        line(String::new());
        line(
            "comparison with language-subset.md §11 (predicted, measured, difference)".to_string(),
        );
        for row in &self.comparisons {
            let difference = row.measured as i64 - row.predicted as i64;
            line(format!(
                "  §{:5} {:6} {:6} {:+6}  {}",
                row.section, row.predicted, row.measured, difference, row.quantity
            ));
        }
        out
    }
}
