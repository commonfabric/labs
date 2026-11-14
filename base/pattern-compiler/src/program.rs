//! A program: a set of modules, the resolution of imports between them, and
//! the rules that follow a call from one function into another.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use oxc_allocator::Allocator;
use serde::Serialize;

use crate::check::{self, ActKind, Facts, ModuleCheck, Pending};
use crate::declared::OverloadNote;
use crate::diagnostics::Diagnostic;
use crate::messages;
use crate::module::{
    DataForm, DefKind, ExportTarget, Import, ImportedName, ModuleModel, ModuleTier,
};
use crate::parse::{self, ParseFailure, Parsed};
use crate::tiers::Body;
use crate::types::Types;

/// One module's text, with the path it is known under.
#[derive(Debug, Clone)]
pub struct SourceFile {
    /// A path with `/` separators. Relative imports are resolved against it.
    pub path: String,
    pub text: String,
}

/// What the front end found in one module.
#[derive(Debug, Clone, Serialize)]
pub struct ModuleAnalysis {
    pub path: String,
    pub model: ModuleModel,
    pub bodies: Vec<Body>,
    pub diagnostics: Vec<Diagnostic>,
    /// Counts of constructs the corpus report compares with
    /// `language-subset.md` §11, by name.
    pub counts: BTreeMap<String, usize>,
    /// The overload signatures of the module, with what replaces each.
    pub overloads: Vec<OverloadNote>,
    /// The receivers of method calls that have no type: the reason, the
    /// line, and the start of the receiver's text.
    pub untyped: Vec<(&'static str, u32, String)>,
    /// Sites the measurement lists: the category, the line, and the start
    /// of the source text.
    pub sites: Vec<(String, u32, String)>,
    /// The plan of each pattern of the module
    /// (`plan-and-label-templates.md` §1.1).
    #[serde(skip)]
    pub plans: Vec<crate::plan::PatternPlan>,
}

impl ModuleAnalysis {
    /// Whether the module has no diagnostic of severity error.
    pub fn accepted(&self) -> bool {
        !self.diagnostics.iter().any(Diagnostic::is_error)
    }
}

/// What the front end found in a program.
#[derive(Debug, Clone, Default)]
pub struct ProgramAnalysis {
    /// One entry per module that parsed, in the order the files were given.
    pub modules: Vec<ModuleAnalysis>,
    pub failures: Vec<ParseFailure>,
}

/// A definition of some module of the program.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DefRef {
    pub module: usize,
    pub def: usize,
}

/// Resolves an import of one module to a definition of another.
pub struct Resolver<'m, 'a> {
    paths: HashMap<String, usize>,
    models: &'m [Option<ModuleModel>],
    files: &'m [SourceFile],
    parsed: &'m [Option<Parsed<'a>>],
    /// The types resolved so far (`crate::types`).
    pub(crate) types: Types,
    /// The span and kind of each body of each module, once the walk of
    /// `crate::check` has found them.
    bodies: std::cell::RefCell<Vec<Vec<BodySpan>>>,
}

/// The span of a body and its kind.
type BodySpan = ((u32, u32), crate::tiers::BodyKind);

/// Where code is written, for the rules that differ between the reactive
/// tier and a function body (`language-subset.md` §7.5.2, §7.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place {
    Module,
    Reactive,
    Function,
}

impl<'m, 'a> Resolver<'m, 'a> {
    fn new(
        files: &'m [SourceFile],
        models: &'m [Option<ModuleModel>],
        parsed: &'m [Option<Parsed<'a>>],
    ) -> Self {
        let paths = files
            .iter()
            .enumerate()
            .map(|(index, file)| (file.path.clone(), index))
            .collect();
        Self {
            paths,
            models,
            files,
            parsed,
            types: Types::default(),
            bodies: std::cell::RefCell::new(vec![Vec::new(); files.len()]),
        }
    }

    fn set_bodies(&self, module: usize, bodies: &[Body]) {
        self.bodies.borrow_mut()[module] =
            bodies.iter().map(|body| (body.span, body.kind)).collect();
    }

    /// The kind of the innermost body that contains the offset.
    pub(crate) fn body_at(&self, module: usize, offset: u32) -> Option<crate::tiers::BodyKind> {
        self.bodies.borrow()[module]
            .iter()
            .filter(|((start, end), _)| *start <= offset && offset < *end)
            .min_by_key(|((start, end), _)| end - start)
            .map(|(_, kind)| *kind)
    }

    /// The kind of the body whose span is `span`.
    pub(crate) fn body_of_span(
        &self,
        module: usize,
        span: (u32, u32),
    ) -> Option<crate::tiers::BodyKind> {
        self.bodies.borrow()[module]
            .iter()
            .find(|(found, _)| *found == span)
            .map(|(_, kind)| *kind)
    }

    /// Where the code at the offset is written. The body of a pattern and
    /// of a reactive collection callback is the reactive tier. The body of
    /// a `computed` is a function body, whether it is promoted or not
    /// (`language-subset.md` §6.2).
    pub(crate) fn place_at(&self, module: usize, offset: u32) -> Place {
        use crate::tiers::BodyKind;
        match self.body_at(module, offset) {
            None => Place::Module,
            Some(BodyKind::Pattern | BodyKind::ElementCallback) => Place::Reactive,
            Some(_) => Place::Function,
        }
    }

    /// The parsed module at index `module`, if it parsed.
    pub fn parsed(&self, module: usize) -> Option<&'m Parsed<'a>> {
        self.parsed[module].as_ref()
    }

    /// The module a relative specifier written in module `from` names, if
    /// the program holds it.
    pub fn module_of(&self, from: usize, specifier: &str) -> Option<usize> {
        if !specifier.starts_with('.') {
            return None;
        }
        let path = join(&self.files[from].path, specifier);
        self.paths.get(&path).copied()
    }

    /// The definition that the name `name` imported by `import` in module
    /// `from` denotes, following re-exports.
    pub fn resolve_import(
        &self,
        from: usize,
        import: &Import,
        name: &ImportedName,
    ) -> Option<DefRef> {
        let module = self.module_of(from, &import.specifier)?;
        self.resolve_export(module, name, 0)
    }

    /// Whether `import`, written in module `from`, names a module the
    /// program holds that is imported TypeScript.
    pub fn is_imported_tier(&self, from: usize, import: &Import) -> bool {
        self.module_of(from, &import.specifier)
            .and_then(|module| self.models[module].as_ref())
            .is_some_and(|model| model.tier == ModuleTier::Imported)
    }

    pub fn model(&self, module: usize) -> Option<&'m ModuleModel> {
        self.models[module].as_ref()
    }

    pub fn kind(&self, def: DefRef) -> Option<(DefKind, Option<DataForm>)> {
        let def = self.model(def.module)?.defs.get(def.def)?;
        Some((def.kind, def.form))
    }

    fn resolve_export(&self, module: usize, name: &ImportedName, depth: u32) -> Option<DefRef> {
        if depth > 8 {
            return None;
        }
        let model = self.model(module)?;
        let wanted = match name {
            ImportedName::Named(name) => name.as_str(),
            ImportedName::Default => "default",
            ImportedName::Namespace => return None,
        };
        // A name can be exported as a type and as a value. The value is
        // what a call or a reference needs.
        let export = model
            .exports
            .iter()
            .filter(|export| export.name == wanted)
            .min_by_key(|export| export.type_only);
        match export.map(|export| &export.target) {
            Some(ExportTarget::Def(def)) => Some(DefRef { module, def: *def }),
            Some(ExportTarget::Import(import, binding)) => {
                let import = &model.imports[*import];
                self.resolve_from(
                    module,
                    &import.specifier,
                    &import.bindings[*binding].imported,
                    depth,
                )
            }
            Some(ExportTarget::From { specifier, name }) => {
                self.resolve_from(module, specifier, name, depth)
            }
            Some(ExportTarget::Unresolved) => None,
            None => model
                .star_exports
                .iter()
                .find_map(|specifier| self.resolve_from(module, specifier, name, depth)),
        }
    }

    fn resolve_from(
        &self,
        from: usize,
        specifier: &str,
        name: &ImportedName,
        depth: u32,
    ) -> Option<DefRef> {
        let module = self.module_of(from, specifier)?;
        self.resolve_export(module, name, depth + 1)
    }
}

/// The path `specifier` names when it is written in the module at `from`.
fn join(from: &str, specifier: &str) -> String {
    let mut parts: Vec<&str> = from.split('/').collect();
    parts.pop();
    for part in specifier.split('/') {
        match part {
            "." | "" => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") && !parts.is_empty() {
                    parts.pop();
                } else {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// Runs the front end over a set of modules.
pub fn analyze(files: &[SourceFile]) -> ProgramAnalysis {
    let allocators: Vec<Allocator> = files.iter().map(|_| Allocator::default()).collect();
    let mut failures = Vec::new();
    let parsed: Vec<Option<Parsed<'_>>> = files
        .iter()
        .zip(&allocators)
        .map(
            |(file, allocator)| match parse::parse(allocator, &file.path, &file.text) {
                Ok(parsed) => Some(parsed),
                Err(failure) => {
                    failures.push(failure);
                    None
                }
            },
        )
        .collect();
    let models: Vec<Option<ModuleModel>> = parsed
        .iter()
        .map(|parsed| parsed.as_ref().map(ModuleModel::build))
        .collect();
    let resolver = Resolver::new(files, &models, &parsed);

    let mut checks: Vec<Option<ModuleCheck>> = parsed
        .iter()
        .enumerate()
        .map(|(index, parsed)| {
            let parsed = parsed.as_ref()?;
            let model = models[index].as_ref()?;
            Some(check::check_module(parsed, model, index, &resolver))
        })
        .collect();

    link(files, &parsed, &mut checks);
    for (module, check) in checks.iter().enumerate() {
        if let Some(check) = check {
            resolver.set_bodies(module, &check.bodies);
        }
    }

    // The rules that resolving a written type decides.
    for module in 0..files.len() {
        resolver.check_written_types(module);
        resolver.check_assignments(module);
        resolver.check_typed_rules(module);
    }
    // The authored functions that are bodies (`footprint-analysis.md`
    // §1.2): those a call in the reactive tier names. Each is the module
    // and the span of its declaration.
    let mut reactive_functions: BTreeSet<(usize, u32, u32)> = BTreeSet::new();
    for (module, current) in parsed.iter().enumerate() {
        let Some(current) = current else {
            continue;
        };
        for node in current.semantic.nodes().iter() {
            let oxc_ast::AstKind::CallExpression(call) = node.kind() else {
                continue;
            };
            let oxc_ast::ast::Expression::Identifier(identifier) =
                crate::syntax::unwrap(&call.callee)
            else {
                continue;
            };
            if resolver.value_def(module, identifier) != Some(crate::module::DefKind::Function)
                || resolver.place_at(module, call.span.start) != Place::Reactive
            {
                continue;
            }
            let Some(symbol) = crate::module::symbol_of(current.semantic.scoping(), identifier)
            else {
                continue;
            };
            let Some((home, symbol)) = resolver.origin(module, symbol) else {
                continue;
            };
            let Some(home_parsed) = resolver.parsed(home) else {
                continue;
            };
            let declaration = home_parsed.semantic.scoping().symbol_declaration(symbol);
            let span = oxc_span::GetSpan::span(&home_parsed.semantic.nodes().kind(declaration));
            reactive_functions.insert((home, span.start, span.end));
        }
    }
    // The footprint of each body (`footprint-analysis.md`), as counts.
    let mut all_records: Vec<Vec<(usize, crate::footprint::Record)>> = Vec::new();
    for (module, check) in checks.iter_mut().enumerate() {
        let mut found = Vec::new();
        if let Some(check) = check {
            let records = crate::footprint::analyze_module(&resolver, module, &check.bodies);
            footprint_counts(&check.bodies, &records, &mut check.counts);
            if let Some(current) = &parsed[module] {
                // The declarations in this module of the authored
                // functions that are bodies.
                let own: Vec<(u32, u32)> = reactive_functions
                    .iter()
                    .filter(|(home, ..)| *home == module)
                    .map(|(_, start, end)| (*start, *end))
                    .collect();
                footprint_diagnostics(
                    current,
                    &parsed,
                    &check.bodies,
                    &records,
                    &own,
                    &mut check.diagnostics,
                );
            }
            found = records;
        }
        all_records.push(found);
    }
    // The plan of each pattern (`plan-and-label-templates.md` §1.1), and
    // the diagnostic that needs the edges of the plan.
    let all_bodies: Vec<Vec<Body>> = checks
        .iter()
        .map(|check| {
            check
                .as_ref()
                .map(|check| check.bodies.clone())
                .unwrap_or_default()
        })
        .collect();
    let mut all_plans: Vec<Vec<crate::plan::PatternPlan>> = Vec::new();
    for (module, check) in checks.iter_mut().enumerate() {
        let (Some(check), Some(parsed)) = (check, &parsed[module]) else {
            all_plans.push(Vec::new());
            continue;
        };
        let plans = crate::plan::emit_module(&resolver, module, &all_bodies, &all_records);
        for plan in &plans {
            for (id, start, found) in &plan.flows {
                let reported = check
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.id == *id && diagnostic.start == *start);
                if reported {
                    continue;
                }
                let position = parsed.lines.position(parsed.source, *start);
                check.diagnostics.push(Diagnostic::new(
                    id,
                    &parsed.path,
                    (*start, *start),
                    position,
                    format!("{found}. {}", messages::rewrite(id)),
                ));
            }
            for (start, cones) in &plan.cycles {
                let position = parsed.lines.position(parsed.source, *start);
                check.diagnostics.push(Diagnostic::new(
                    "side-write:cycle",
                    &parsed.path,
                    (*start, *start),
                    position,
                    format!(
                        "This side-write is on a cycle of the plan's edges, through the cones {}. {}",
                        cones.join(", "),
                        messages::rewrite("side-write:cycle")
                    ),
                ));
            }
        }
        all_plans.push(plans);
    }
    let reports = std::mem::take(&mut resolver.types.borrow_mut().reports);
    for report in reports {
        let (Some(check), Some(parsed)) = (&mut checks[report.module], &parsed[report.module])
        else {
            continue;
        };
        let position = parsed.lines.position(parsed.source, report.span.start);
        check.diagnostics.push(Diagnostic::new(
            report.id,
            &parsed.path,
            (report.span.start, report.span.end),
            position,
            format!("{}. {}", report.found, messages::rewrite(report.id)),
        ));
    }

    let notes = std::mem::take(&mut resolver.types.borrow_mut().notes);
    let written = std::mem::take(&mut resolver.types.borrow_mut().written);
    let type_counts = std::mem::take(&mut resolver.types.borrow_mut().counts);
    let mut modules = Vec::new();
    for (index, check) in checks.into_iter().enumerate() {
        let (Some(check), Some(model)) = (check, models[index].clone()) else {
            continue;
        };
        let mut diagnostics = check.diagnostics;
        diagnostics.sort_by(|a, b| (a.start, a.id, a.end).cmp(&(b.start, b.id, b.end)));
        diagnostics.dedup();
        modules.push(ModuleAnalysis {
            path: files[index].path.clone(),
            plans: std::mem::take(&mut all_plans[index]),
            model,
            bodies: check.bodies,
            diagnostics,
            counts: {
                let mut counts = check.counts;
                for ((module, label), count) in &written {
                    if *module == index {
                        counts.insert(format!("types:written:{label}"), *count);
                    }
                }
                for ((module, key), count) in &type_counts {
                    if *module == index {
                        counts.insert(key.clone(), *count);
                    }
                }
                // Each listed site once, whatever number of times the
                // rule that lists it ran.
                let mut seen = BTreeSet::new();
                for (module, category, span) in &notes {
                    if *module == index && seen.insert((category.as_str(), span.start, span.end)) {
                        *counts.entry(format!("types:sites:{category}")).or_insert(0) += 1;
                    }
                }
                counts
            },
            overloads: resolver.overloads(index),
            untyped: check.untyped,
            sites: {
                let mut sites: Vec<(String, u32, String)> = notes
                    .iter()
                    .filter(|(module, _, _)| *module == index)
                    .filter_map(|(_, category, span)| {
                        let parsed = parsed[index].as_ref()?;
                        let (line, _) = parsed.lines.position(parsed.source, span.start);
                        let text: String = span
                            .source_text(parsed.source)
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" ")
                            .chars()
                            .take(160)
                            .collect();
                        Some((category.clone(), line, text))
                    })
                    .collect();
                sites.sort();
                sites.dedup();
                sites
            },
        });
    }
    ProgramAnalysis { modules, failures }
}

/// The diagnostics that need only the footprint of a body
/// (`language-subset.md` §10.3): each is reported at a site in the body's
/// own text, once, for the innermost body around it. What a function the
/// body calls brought into it is reported at the call in the body's text,
/// and the message names the position inside the function
/// (`footprint-analysis.md` §3.6).
fn footprint_diagnostics(
    parsed: &Parsed<'_>,
    modules: &[Option<Parsed<'_>>],
    bodies: &[Body],
    records: &[(usize, crate::footprint::Record)],
    reactive_functions: &[(u32, u32)],
    diagnostics: &mut Vec<Diagnostic>,
) {
    // "A function has no record of its own unless it is itself a body of
    // §1.2, as an authored function called from the reactive tier is"
    // (`footprint-analysis.md` §3.6): what is in the text of any other
    // function is reported at the calls in the bodies that call it.
    let is_body = |index: usize| {
        let body = &bodies[index];
        body.kind != crate::tiers::BodyKind::AuthoredFunction
            || reactive_functions.iter().any(|(start, end)| {
                (*start <= body.span.0 && body.span.1 <= *end)
                    || (body.span.0 <= *start && *end <= body.span.1)
            })
    };
    let innermost = |site: u32| {
        records
            .iter()
            .map(|(index, _)| *index)
            .filter(|index| bodies[*index].span.0 <= site && site < bodies[*index].span.1)
            .min_by_key(|index| bodies[*index].span.1 - bodies[*index].span.0)
    };
    let mut seen: BTreeSet<(u32, &'static str)> = BTreeSet::new();
    for (index, record) in records {
        let own = record
            .sites
            .iter()
            .filter(|_| is_body(*index))
            .map(|(site, what)| (site, what, None));
        let brought = record
            .brought
            .iter()
            .map(|(site, what, module, start)| (site, what, Some((*module, *start))));
        for (site, what, inside) in own.chain(brought) {
            if innermost(*site) != Some(*index) {
                continue;
            }
            let (id, found): (&'static str, String) = if let Some(reason) =
                what.strip_prefix("read:dynamic:")
            {
                (
                    "footprint:dynamic-read",
                    format!(
                        "This read through a cell handle is journaled when the body runs: {reason}"
                    ),
                )
            } else if let Some(cause) = what.strip_prefix("widen:") {
                if cause == "W7" {
                    continue;
                }
                (
                    "footprint:widened",
                    format!("Footprint analysis reads this value in full ({cause})"),
                )
            } else if what == "materializer" {
                (
                        "footprint:materializer",
                        "The target of this write is not static, so the body is a materializer for all of its writes".to_string(),
                    )
            } else if let Some(shape) = what.strip_prefix("not-idempotent:") {
                let shape = match shape {
                    "append" => "it adds to what is stored",
                    "send" => "it delivers one event per run",
                    _ => "the body reads the path it writes",
                };
                (
                    "side-write:not-idempotent",
                    format!("A second run of this computation may write something else: {shape}"),
                )
            } else if what == "read-then-push" {
                (
                    "mergeable-push:read-then-push",
                    "The handler reads this collection and then pushes to it".to_string(),
                )
            } else {
                continue;
            };
            if !seen.insert((*site, id)) {
                continue;
            }
            let position = parsed.lines.position(parsed.source, *site);
            let found = match inside.and_then(|(module, start)| {
                let other = modules.get(module)?.as_ref()?;
                let at = other.lines.position(other.source, start);
                Some(format!("{}:{}:{}", other.path, at.0, at.1))
            }) {
                Some(at) => format!("{found}, in the function called here, at {at}"),
                None => found,
            };
            diagnostics.push(Diagnostic::new(
                id,
                &parsed.path,
                (*site, *site + 1),
                position,
                format!("{found}. {}", messages::rewrite(id)),
            ));
        }
    }
}

/// Adds the counts the measurement of `footprint-analysis.md` §11 compares:
/// the bodies analyzed, where the analysis widens, the reads and the writes
/// through handles. A site is counted once, for the innermost body around
/// it.
fn footprint_counts(
    bodies: &[Body],
    records: &[(usize, crate::footprint::Record)],
    counts: &mut BTreeMap<String, usize>,
) {
    let mut add = |key: String, by: usize| {
        if by > 0 {
            *counts.entry(key).or_insert(0) += by;
        }
    };
    // The innermost analyzed body around a site.
    let innermost = |site: u32| {
        records
            .iter()
            .map(|(index, _)| *index)
            .filter(|index| bodies[*index].span.0 <= site && site < bodies[*index].span.1)
            .min_by_key(|index| bodies[*index].span.1 - bodies[*index].span.0)
    };
    for (index, record) in records {
        let kind = bodies[*index].kind.label();
        add(format!("footprint:bodies:{kind}"), 1);
        add("footprint:bodies".to_string(), 1);
        let own: Vec<&str> = record
            .sites
            .iter()
            .filter(|(site, _)| innermost(*site) == Some(*index))
            .map(|(_, what)| what.as_str())
            .collect();
        let count = |prefix: &str| own.iter().filter(|what| what.starts_with(prefix)).count();
        // The write side, the runtime calls, and the resolutions.
        if let Some(tier) = record.tier {
            add(format!("footprint:tier:{tier}"), 1);
        }
        for call in &record.calls {
            add(format!("footprint:calls:{call}"), 1);
        }
        if !record.outputs.is_empty() {
            add("footprint:outputs:bodies with a reference".to_string(), 1);
            add("footprint:outputs:paths".to_string(), record.outputs.len());
        }
        add(
            "footprint:resolutions:resolved entries".to_string(),
            record
                .reads
                .iter()
                .filter(|line| line.contains("identity (resolved)"))
                .count(),
        );
        add(
            "footprint:label metadata:static entries".to_string(),
            record
                .reads
                .iter()
                .filter(|line| line.contains("labelMetadata"))
                .count(),
        );
        for line in &record.other_dynamic {
            let kind = line.split(':').next().unwrap_or("");
            add(format!("footprint:other dynamic reads:{kind}"), 1);
        }
        // Widenings: directly, and with the helpers the body calls.
        let direct: BTreeSet<&str> = own
            .iter()
            .filter_map(|what| what.strip_prefix("widen:"))
            .collect();
        let all: BTreeSet<&str> = record.widenings.iter().map(String::as_str).collect();
        for cause in &direct {
            add(format!("footprint:widen:{cause}:bodies, directly"), 1);
            add(
                format!("footprint:widen:{cause}:sites"),
                count(&format!("widen:{cause}")),
            );
        }
        for cause in &all {
            add(
                format!("footprint:widen:{cause}:bodies, through helpers"),
                1,
            );
        }
        if !direct.is_empty() {
            add("footprint:widen:any:bodies, directly".to_string(), 1);
        }
        if !all.is_empty() {
            add("footprint:widen:any:bodies, through helpers".to_string(), 1);
            add(format!("footprint:widen:any:through helpers:{kind}"), 1);
        }
        // Reads through handles.
        let reads = count("read:");
        add("footprint:reads:sites".to_string(), reads);
        add("footprint:reads:static".to_string(), count("read:static"));
        for reason in ["conditional", "alternatives", "not anchored"] {
            add(
                format!("footprint:reads:dynamic, {reason}"),
                count(&format!("read:dynamic:{reason}")),
            );
        }
        if reads > 0 {
            add("footprint:reads:bodies".to_string(), 1);
            if count("read:static") == reads {
                add(
                    "footprint:reads:bodies with static reads alone".to_string(),
                    1,
                );
            }
        }
        // With the helpers applied: whether the body has a dynamic read.
        if record.static_reads + record.dynamic_reads.len() > 0 {
            add("footprint:reads:bodies, helpers applied".to_string(), 1);
            if record.dynamic_reads.is_empty() {
                add(
                    "footprint:reads:bodies with no dynamic read, helpers applied".to_string(),
                    1,
                );
            }
        }
        // Writes through handles.
        let writes = count("write:");
        if writes > 0 {
            add(format!("footprint:writes:{kind}:bodies"), 1);
            if count("write:dynamic") == 0 {
                add(
                    format!("footprint:writes:{kind}:bodies, every target static"),
                    1,
                );
            }
            add(format!("footprint:writes:{kind}:sites"), writes);
            add(
                format!("footprint:writes:{kind}:sites, static"),
                count("write:static"),
            );
        }
        let keys = count("key:dynamic");
        add("footprint:dynamic keys:sites".to_string(), keys);
        add(
            "footprint:dynamic keys:bodies".to_string(),
            usize::from(keys > 0),
        );
        add(
            "footprint:observations of an expression with no type".to_string(),
            record.untyped,
        );
    }
}

/// The footprint of every body of the program `files` that the analysis of
/// `footprint-analysis.md` runs on.
pub fn footprints(files: &[SourceFile]) -> Vec<crate::footprint::BodyFootprint> {
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
    let mut bodies: Vec<Vec<Body>> = Vec::new();
    for (module, parsed) in parsed.iter().enumerate() {
        match (parsed, &models[module]) {
            (Some(parsed), Some(model)) => {
                let check = check::check_module(parsed, model, module, &resolver);
                resolver.set_bodies(module, &check.bodies);
                bodies.push(check.bodies);
            }
            _ => bodies.push(Vec::new()),
        }
    }
    let mut found = Vec::new();
    for (module, file) in files.iter().enumerate() {
        for (index, record) in crate::footprint::analyze_module(&resolver, module, &bodies[module])
        {
            let body = &bodies[module][index];
            found.push(crate::footprint::BodyFootprint {
                module: file.path.clone(),
                name: body.name.clone(),
                kind: body.kind,
                line: body.line,
                record,
            });
        }
    }
    found
}

/// The marker [`types_at_markers`] looks for.
pub const TYPE_MARKER: &str = "/*?*/";

/// The types of the expressions of a program that are marked with
/// [`TYPE_MARKER`], in the order of the files and of the source. A marker
/// stands just before the expression, and where several expressions start
/// at that offset it names the innermost, so that a larger expression is
/// marked by writing it in parentheses. An expression with no type is given
/// as the label the measurement counts it under.
pub fn types_at_markers(files: &[SourceFile]) -> Vec<String> {
    use oxc_ast::ast::Expression;
    use oxc_ast_visit::{walk, Visit};
    use oxc_span::GetSpan;

    struct Find<'r, 'm, 'a> {
        resolver: &'r Resolver<'m, 'a>,
        module: usize,
        start: u32,
        found: Option<String>,
    }
    impl<'a> Visit<'a> for Find<'_, '_, 'a> {
        fn visit_expression(&mut self, it: &Expression<'a>) {
            if it.span().start == self.start {
                self.found = Some(match self.resolver.declared(self.module, it) {
                    Ok(ty) => self.resolver.display(ty),
                    Err(origin) => origin.label().to_string(),
                });
            }
            walk::walk_expression(self, it);
        }
    }

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
    for (module, parsed) in parsed.iter().enumerate() {
        if let (Some(parsed), Some(model)) = (parsed, &models[module]) {
            let check = check::check_module(parsed, model, module, &resolver);
            resolver.set_bodies(module, &check.bodies);
        }
    }
    resolver.types.borrow_mut().reports.clear();
    let mut types = Vec::new();
    for (module, file) in files.iter().enumerate() {
        let Some(parsed) = &parsed[module] else {
            continue;
        };
        for (offset, _) in file.text.match_indices(TYPE_MARKER) {
            let after = &file.text[offset + TYPE_MARKER.len()..];
            let blank = after.len() - after.trim_start().len();
            let mut find = Find {
                resolver: &resolver,
                module,
                start: (offset + TYPE_MARKER.len() + blank) as u32,
                found: None,
            };
            find.visit_program(parsed.program);
            types.push(
                find.found
                    .unwrap_or_else(|| "no expression at the marker".to_string()),
            );
        }
    }
    types
}

/// Reports what a computation or the reactive tier may not do when it does
/// it through an authored function it calls (`language-subset.md` §5.2: an
/// authored function is held to the rules of the bodies that call it).
fn link(files: &[SourceFile], parsed: &[Option<Parsed<'_>>], checks: &mut [Option<ModuleCheck>]) {
    let mut facts: HashMap<DefRef, &Facts> = HashMap::new();
    for (module, check) in checks.iter().enumerate() {
        for (def, fact) in check.iter().flat_map(|check| &check.facts) {
            facts.insert(DefRef { module, def: *def }, fact);
        }
    }
    let mut reports: Vec<(usize, Diagnostic)> = Vec::new();
    for (module, check) in checks.iter().enumerate() {
        let (Some(check), Some(parsed)) = (check, &parsed[module]) else {
            continue;
        };
        for pending in &check.pending {
            for (kind, origin) in reachable(&facts, pending.target) {
                let Some(id) = id_for(kind, pending) else {
                    continue;
                };
                let (path, line) = (&files[origin.module].path, origin.line);
                let found = format!(
                    "`{}` is called here and {} ({}:{})",
                    pending.name,
                    kind.describe(),
                    path,
                    line
                );
                let position = parsed.lines.position(parsed.source, pending.span.0);
                reports.push((
                    module,
                    Diagnostic::new(
                        id,
                        &parsed.path,
                        pending.span,
                        position,
                        format!("{found}. {}", messages::rewrite(id)),
                    ),
                ));
            }
        }
    }
    for (module, diagnostic) in reports {
        if let Some(check) = &mut checks[module] {
            check.diagnostics.push(diagnostic);
        }
    }
}

/// Where an act was found.
#[derive(Debug, Clone, Copy)]
struct Origin {
    module: usize,
    line: u32,
}

/// The acts a call of `target` can perform, itself or through the authored
/// functions it calls, each with one place it was found.
fn reachable(facts: &HashMap<DefRef, &Facts>, target: DefRef) -> BTreeMap<ActKind, Origin> {
    let mut found = BTreeMap::new();
    let mut seen = BTreeSet::new();
    let mut stack = vec![target];
    while let Some(def) = stack.pop() {
        if !seen.insert(def) {
            continue;
        }
        let Some(fact) = facts.get(&def) else {
            continue;
        };
        for act in &fact.acts {
            found.entry(act.kind).or_insert(Origin {
                module: def.module,
                line: act.line,
            });
        }
        stack.extend(fact.calls.iter().copied());
    }
    found
}

/// The diagnostic for an act of `kind` reached from the call `pending`.
fn id_for(kind: ActKind, pending: &Pending) -> Option<&'static str> {
    if pending.module_init {
        return match kind {
            ActKind::Ambient => Some("function-body:ambient-read"),
            ActKind::Uncaused => None,
            _ => Some("module-scope:runtime-call"),
        };
    }
    Some(match kind {
        ActKind::Ambient => "function-body:ambient-read",
        ActKind::Effect => "function-body:effect-in-computation",
        ActKind::EventContext => "function-body:event-context-in-computation",
        ActKind::CellWithoutCause => "function-body:cell-needs-cause",
        ActKind::Runtime => return None,
        ActKind::Uncaused => "function-body:instantiation-without-cause",
    })
}
