//! Value-code emission: the JavaScript an executor calls to compute what a
//! plan describes (`execution-and-storage.md` §2, cited as ES).
//!
//! `crate::plan` walks the reactive tier of a pattern and fills in the
//! records of the plan. While it walks, it records in [`Facts`] what each
//! name and each expression denotes. This module walks the same source
//! again and rewrites it: a name of the reactive tier becomes a read of a
//! slot or of another cone's output through the host object of ES §2.2, a
//! type annotation is removed, and a JSX element becomes a call that
//! builds a view node.
//!
//! The artifact has one JavaScript text per module of the program. A text
//! holds the module's own code of module scope, and after it one
//! registration for each function the plan needs from that module: the
//! value function of each value a cone computes, the per-element function
//! of each element construct, the function that gives a state cell its
//! first value, and one function per sandboxed body. `SPEC-NOTES.md`
//! (notes 281 on) lists what the documents do not say about these.

use std::cell::Cell;
use std::collections::{BTreeMap, HashMap, HashSet};

use oxc_ast::ast::*;
use oxc_ast::AstKind;
use oxc_ast_visit::{walk, Visit};
use oxc_span::{GetSpan, Span};
use oxc_syntax::scope::ScopeFlags;
use serde_json::{json, Value};

use crate::plan::{Place, Root, SlotKey};
use crate::program::Resolver;
use crate::syntax::{static_key_name, unwrap, FunctionLike};

thread_local! {
    static REQUESTED: Cell<bool> = const { Cell::new(false) };
}

/// Asks the plan emitter to emit value code beside each plan.
pub fn request(on: bool) {
    REQUESTED.set(on);
}

pub(crate) fn requested() -> bool {
    REQUESTED.get()
}

/// What the evaluation of one expression of the reactive tier gave.
#[derive(Debug, Clone)]
pub(crate) struct ExprFact {
    pub place: Place,
    /// The values and the state cells the plan emitter made while it
    /// evaluated the expression: the first index and the index after the
    /// last.
    pub values: (usize, usize),
    pub states: (usize, usize),
}

/// One use of a sandboxed body in the reactive tier.
#[derive(Debug, Clone)]
pub(crate) struct UseFact {
    pub body: usize,
    pub home: usize,
    pub start: u32,
    pub kind: &'static str,
    /// The formal-input name of each parameter.
    pub formals: Vec<String>,
    /// What each formal input and each captured name is bound to.
    pub inputs: Vec<(String, Place)>,
    /// The captured names that are declared with a handle type.
    pub handles: Vec<String>,
}

/// The function of a handler body.
#[derive(Debug, Clone)]
pub(crate) struct HandlerFact {
    pub home: usize,
    pub start: u32,
    /// Declared with `handler`, with the state as its second parameter.
    /// Otherwise what the function captures is its state.
    pub named: bool,
    pub captures: Vec<String>,
}

/// One body of the reactive tier the plan emitter evaluated: the pattern
/// the plan is compiled from, and each evaluation of a pattern compiled
/// in.
#[derive(Debug, Clone)]
pub(crate) struct Context {
    pub module: usize,
    pub start: u32,
    /// The cone the call was evaluated in, where it was in one.
    pub cone: Option<usize>,
    /// The schema of the argument the pattern declares, for a pattern
    /// compiled in.
    pub argument_schema: Option<Value>,
    /// For a pattern compiled in: each slot of the caller that the call
    /// bound a path of the callee's argument to, with the default the
    /// callee declares for that path (rulings Z4 and Z16).
    pub bound_defaults: Vec<(Root, Vec<String>, Value)>,
}

/// What the value-code emitter reads of the plan emitter's walk.
#[derive(Debug, Default)]
pub(crate) struct Facts {
    contexts: Vec<Context>,
    current: usize,
    expressions: HashMap<(usize, u32, u32), ExprFact>,
    bound: HashMap<(usize, u32), Place>,
    inlines: HashMap<(usize, u32), usize>,
    inline_bindings: HashMap<(usize, u32), usize>,
    /// The values the plan emitter made for a part of the argument of a
    /// tag that names a pattern: the children written between the tags,
    /// by the start of the tag, and an attribute written as an element,
    /// by the start of that element.
    built: HashMap<(usize, u32), usize>,
    pub uses: HashMap<usize, UseFact>,
    pub handlers: HashMap<usize, HandlerFact>,
}

impl Facts {
    pub fn new(module: usize, start: u32) -> Self {
        Self {
            contexts: vec![Context {
                module,
                start,
                cone: None,
                argument_schema: None,
                bound_defaults: Vec::new(),
            }],
            ..Self::default()
        }
    }

    pub fn expression(&mut self, span: (u32, u32), fact: ExprFact) {
        self.expressions
            .insert((self.current, span.0, span.1), fact);
    }

    pub fn bound(&mut self, start: u32, place: Place) {
        self.bound.insert((self.current, start), place);
    }

    /// A pattern compiled in at `at`: the context of its body. Returns
    /// the context to go back to.
    pub fn enter(
        &mut self,
        at: u32,
        module: usize,
        start: u32,
        _argument: Place,
        cone: Option<usize>,
    ) -> usize {
        let saved = self.current;
        self.contexts.push(Context {
            module,
            start,
            cone,
            argument_schema: None,
            bound_defaults: Vec::new(),
        });
        let made = self.contexts.len() - 1;
        self.inlines.insert((saved, at), made);
        self.current = made;
        saved
    }

    pub fn argument_schema(&mut self, schema: Value) {
        self.contexts[self.current].argument_schema = Some(schema);
    }

    pub fn bound_defaults(&mut self, defaults: Vec<(Root, Vec<String>, Value)>) {
        self.contexts[self.current].bound_defaults = defaults;
    }

    pub fn leave(&mut self, saved: usize, _result: Option<Place>) {
        self.current = saved;
    }

    pub fn built(&mut self, at: u32, place: &Place) {
        if let Place::Value(value, _) = place {
            self.built.insert((self.current, at), *value);
        }
    }

    pub fn inline_binding(&mut self, start: u32, binding: usize) {
        self.inline_bindings.insert((self.current, start), binding);
    }
}

/// What the plan emitter hands over when a plan is finished.
pub(crate) struct Finished {
    pub facts: Facts,
    /// The index of each cone in `Plan.cones`, by the order the cones
    /// were made.
    pub position: Vec<usize>,
    /// The entry of `Plan.outputs` of a value, by the value and a path
    /// below it.
    pub output_of: HashMap<(usize, Vec<String>), usize>,
    /// For each value: its cone in the order the cones were made, the
    /// collection it is the assembled result of, and whether it is the
    /// result of a scan.
    pub values: Vec<(usize, Option<usize>, bool)>,
    pub slots: Vec<SlotKey>,
    /// The identity of each pattern of the program, by its module and
    /// the start of its function: the entry that the pattern's own
    /// `Plan.patterns` begins with.
    pub identities: HashMap<(usize, u32), String>,
}

/// Whether a reader wants the value at a place, or passes on what is
/// there, a reference included.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Want {
    Use,
    Pass,
}

fn root_json(root: &Root) -> Value {
    match root {
        Root::Argument => json!({ "kind": "argument" }),
        Root::State(cell) => json!({ "kind": "state", "cell": cell }),
        Root::Event(handler) => json!({ "kind": "event", "handler": handler }),
        Root::Element(collection) => json!({ "kind": "element", "collection": collection }),
        Root::Index(collection) => json!({ "kind": "index", "collection": collection }),
        Root::Operation(operation) => json!({ "kind": "operation", "operation": operation }),
        Root::Binding(handler) => json!({ "kind": "binding", "handler": handler }),
        Root::Cause => json!({ "kind": "cause" }),
        Root::Child(child) => json!({ "kind": "child", "child": child }),
    }
}

fn path_json(path: &[String]) -> String {
    json!(path).to_string()
}

/// The text of a JSX text child as the JSX transform of TypeScript gives
/// it: each line trimmed, the first not at its start and the last not at
/// its end, empty lines dropped, and the rest joined by one space.
fn jsx_text(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len() - 1;
    let mut kept: Vec<String> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let mut line = line.replace('\t', " ");
        if index != 0 {
            line = line.trim_start_matches(' ').to_string();
        }
        if index != last {
            line = line.trim_end_matches([' ', '\r']).to_string();
        }
        if !line.is_empty() {
            kept.push(line);
        }
    }
    (!kept.is_empty()).then(|| entities(&kept.join(" ")))
}

/// The character references of JSX text replaced by their characters: a
/// numeric reference, and the named ones of this table.
fn entities(text: &str) -> String {
    const NAMED: &[(&str, &str)] = &[
        ("amp", "&"),
        ("lt", "<"),
        ("gt", ">"),
        ("quot", "\""),
        ("apos", "'"),
        ("nbsp", "\u{a0}"),
        ("copy", "\u{a9}"),
        ("middot", "\u{b7}"),
        ("times", "\u{d7}"),
        ("ndash", "\u{2013}"),
        ("mdash", "\u{2014}"),
        ("lsquo", "\u{2018}"),
        ("rsquo", "\u{2019}"),
        ("ldquo", "\u{201c}"),
        ("rdquo", "\u{201d}"),
        ("bull", "\u{2022}"),
        ("hellip", "\u{2026}"),
        ("larr", "\u{2190}"),
        ("uarr", "\u{2191}"),
        ("rarr", "\u{2192}"),
        ("darr", "\u{2193}"),
        ("check", "\u{2713}"),
    ];
    let mut decoded = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        decoded.push_str(&rest[..start]);
        rest = &rest[start..];
        let reference = rest[1..]
            .find(';')
            .filter(|end| *end <= 10)
            .map(|end| &rest[1..=end]);
        let character = reference.and_then(|name| {
            if let Some(code) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                u32::from_str_radix(code, 16)
                    .ok()
                    .and_then(char::from_u32)
                    .map(String::from)
            } else if let Some(code) = name.strip_prefix('#') {
                code.parse().ok().and_then(char::from_u32).map(String::from)
            } else {
                NAMED
                    .iter()
                    .find(|(known, _)| *known == name)
                    .map(|(_, character)| (*character).to_string())
            }
        });
        match (reference, character) {
            (Some(reference), Some(character)) => {
                decoded.push_str(&character);
                rest = &rest[reference.len() + 2..];
            }
            _ => {
                decoded.push('&');
                rest = &rest[1..];
            }
        }
    }
    decoded.push_str(rest);
    decoded
}

/// The initializer of a `const` of a block body of the reactive tier, and
/// where it is written.
#[derive(Clone, Copy)]
struct Local<'a> {
    init: &'a Expression<'a>,
    module: usize,
    context: Option<usize>,
}

struct Generator<'r, 'm, 'a> {
    resolver: &'r Resolver<'m, 'a>,
    plan: &'r Value,
    /// The schema documents that the plan names, each with its
    /// identifier.
    schemas: &'r [(String, Value)],
    finished: &'r Finished,
    /// The registrations of each module, in the order they were made.
    registrations: BTreeMap<usize, Vec<String>>,
    /// The statements of the setup functions being written, innermost
    /// last.
    buffers: Vec<Vec<String>>,
    /// The setup function of each context that has one.
    setups: HashSet<usize>,
    functions: HashMap<usize, HashMap<u32, FunctionLike<'a, 'a>>>,
    /// The variable declarators of each module, by where they begin.
    declarators: HashMap<usize, HashMap<u32, &'a VariableDeclarator<'a>>>,
    unsupported: Vec<(String, usize, u32)>,
    /// The reads the code makes of a place no slot of its cone names:
    /// the cone in `Plan.cones`, the root, and the path.
    unlisted: Vec<Value>,
    /// The values the code refers to that have no entry of
    /// `Plan.outputs`.
    interim: Vec<usize>,
    /// The values that have a value function, and the collections that
    /// have a per-element function.
    registered_values: Vec<usize>,
    registered_elements: Vec<usize>,
    registered_states: Vec<usize>,
    /// The `reduce` operations whose functions are registered.
    registered_reduces: Vec<usize>,
    /// The children whose argument function is registered.
    registered_children: Vec<usize>,
    /// The effects and the `wish` operations whose request function is
    /// registered.
    registered_requests: Vec<usize>,
    /// The `const` declarations of the block bodies of promoted
    /// `computed` calls, by the value each initializer computes: a cone
    /// other than the block's reads such a value as an output, which
    /// needs a value function of its own.
    locals: HashMap<usize, Local<'a>>,
    /// The path of each file that a `dataFile` call of the program names,
    /// in the order the calls are written.
    data_files: Vec<String>,
    counter: usize,
}

struct Rewriter<'g, 'r, 'm, 'a> {
    generator: &'g mut Generator<'r, 'm, 'a>,
    module: usize,
    /// The context of the reactive tier being rewritten. `None` in a
    /// function body, where no name is a place.
    context: Option<usize>,
    /// The cone the code being written belongs to, by the order the
    /// cones were made.
    cone: Option<usize>,
    /// Whether the code being written is a computed input of a use of a
    /// body: the runtime places the callee's default from `Body.reads`,
    /// and value code passes nothing for it (ruling Z16).
    to_body: bool,
    /// Whether the code being written is registered outside the block
    /// it is written in, where no `const` of that block is in scope.
    outside_block: bool,
    edits: Vec<(u32, u32, String)>,
}

impl<'r, 'm, 'a> Generator<'r, 'm, 'a> {
    fn source(&self, module: usize) -> &'a str {
        self.resolver
            .parsed(module)
            .map_or("", |parsed| parsed.source)
    }

    fn unsupported(&mut self, kind: impl Into<String>, module: usize, at: u32) {
        self.unsupported.push((kind.into(), module, at));
    }

    fn function_at(&mut self, module: usize, start: u32) -> Option<FunctionLike<'a, 'a>> {
        if let std::collections::hash_map::Entry::Vacant(entry) = self.functions.entry(module) {
            let mut found = HashMap::new();
            if let Some(parsed) = self.resolver.parsed(module) {
                for node in parsed.semantic.nodes().iter() {
                    match node.kind() {
                        AstKind::ArrowFunctionExpression(arrow) => {
                            found.insert(arrow.span.start, FunctionLike::Arrow(arrow));
                        }
                        AstKind::Function(function) => {
                            found.insert(function.span.start, FunctionLike::Function(function));
                        }
                        _ => {}
                    }
                }
            }
            entry.insert(found);
        }
        self.functions.get(&module)?.get(&start).copied()
    }

    /// The initializer of the variable declarator that begins at `start`.
    fn initializer_at(&mut self, module: usize, start: u32) -> Option<&'a Expression<'a>> {
        if let std::collections::hash_map::Entry::Vacant(entry) = self.declarators.entry(module) {
            let mut found = HashMap::new();
            if let Some(parsed) = self.resolver.parsed(module) {
                for node in parsed.semantic.nodes().iter() {
                    if let AstKind::VariableDeclarator(declarator) = node.kind() {
                        found.insert(declarator.span.start, declarator);
                    }
                }
            }
            entry.insert(found);
        }
        self.declarators.get(&module)?.get(&start)?.init.as_ref()
    }

    /// Whether the body of a binding declares a handle at the state path
    /// `name`: the schema of its slot of root `binding` there has
    /// `asCell`.
    fn declares_handle(&self, binding: usize, name: &str) -> bool {
        let body = &self.plan["bindings"][binding]["handler"]["body"];
        self.plan["slots"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|slot| {
                slot["root"]["kind"] == json!("binding")
                    && slot["root"]["handler"] == *body
                    && slot["path"] == json!([name])
            })
            .filter_map(|slot| slot["schema"].as_str())
            .any(|id| {
                self.schemas
                    .iter()
                    .any(|(known, document)| known == id && document.get("asCell").is_some())
            })
    }

    fn hoist(&mut self, statement: String) {
        if let Some(buffer) = self.buffers.last_mut() {
            buffer.push(statement);
        }
    }

    fn register(&mut self, module: usize, statement: String) {
        self.registrations
            .entry(module)
            .or_default()
            .push(statement);
    }

    fn fresh(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("${prefix}{}", self.counter)
    }

    fn cone_of(&self, value: usize) -> usize {
        self.finished.values[value].0
    }

    /// The slots `Plan.cones` lists for a cone, or every slot of the plan
    /// for code that belongs to no cone.
    fn listed(&self, cone: Option<usize>) -> Vec<usize> {
        match cone {
            Some(cone) => self.plan["cones"][self.finished.position[cone]]["slots"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|slot| slot.as_u64().map(|slot| slot as usize))
                .collect(),
            None => (0..self.finished.slots.len()).collect(),
        }
    }
}

impl<'g, 'r, 'm, 'a> Rewriter<'g, 'r, 'm, 'a> {
    fn source(&self) -> &'a str {
        self.generator.source(self.module)
    }

    fn text(&self, span: Span) -> &'a str {
        &self.source()[span.start as usize..span.end as usize]
    }

    fn edit(&mut self, start: u32, end: u32, text: impl Into<String>) {
        self.edits.push((start, end, text.into()));
    }

    /// The text of a span with the edits made inside it applied. An edit
    /// inside another one is left out: the outer one holds its text.
    fn apply(&self, span: Span, mut edits: Vec<(u32, u32, String)>) -> String {
        edits.sort_by_key(|(start, end, _)| (*start, std::cmp::Reverse(*end)));
        let source = self.source();
        let mut text = String::new();
        let mut at = span.start;
        for (start, end, replacement) in edits {
            if start < at || end > span.end {
                continue;
            }
            text.push_str(&source[at as usize..start as usize]);
            text.push_str(&replacement);
            at = end;
        }
        text.push_str(&source[at as usize..span.end as usize]);
        text
    }

    /// Rewrites one node: `visit` makes the edits, and the text of `span`
    /// is returned with them applied.
    fn rewritten(&mut self, span: Span, visit: impl FnOnce(&mut Self)) -> String {
        let saved = std::mem::take(&mut self.edits);
        visit(self);
        let edits = std::mem::replace(&mut self.edits, saved);
        self.apply(span, edits)
    }

    fn fact(&self, span: Span) -> Option<ExprFact> {
        let context = self.context?;
        self.generator
            .finished
            .facts
            .expressions
            .get(&(context, span.start, span.end))
            .cloned()
    }

    fn place_of(&self, expression: &Expression<'a>) -> Option<Place> {
        self.fact(unwrap(expression).span()).map(|fact| fact.place)
    }

    fn wanted(want: Want, code: String) -> String {
        match want {
            Want::Use => format!("$h.v({code})"),
            Want::Pass => code,
        }
    }

    /// The code that reads a path of an input: a slot the cone lists
    /// where it lists one, and otherwise a read by root and path, which
    /// the executor counts.
    fn slot_code(&mut self, root: &Root, path: &[String], want: Want) -> String {
        let listed = self.generator.listed(self.cone);
        let slots = &self.generator.finished.slots;
        let order: &[&str] = match want {
            Want::Pass => &["identity", "value", "enumeration", "shape"],
            Want::Use => &["value", "enumeration", "identity", "shape"],
        };
        for class in order {
            let found = listed.iter().find(|slot| {
                let (other, at, observes, ..) = &slots[**slot];
                other == root && at == path && observes == class
            });
            if let Some(slot) = found {
                return format!("$h.slot({slot})");
            }
        }
        // A path below a slot that is read whole.
        let above = listed
            .iter()
            .filter(|slot| {
                let (other, at, observes, ..) = &slots[**slot];
                other == root && *observes == "value" && path.starts_with(at)
            })
            .max_by_key(|slot| slots[**slot].1.len());
        if let Some(slot) = above {
            let rest = &path[slots[*slot].1.len()..];
            return format!("$h.slot({slot}, {})", path_json(rest));
        }
        // The container of a `pick`: the cone lists the slot of the
        // chosen child, at `*`, and "`host.slot` of such a slot returns
        // every child of the container" (ES §2.2).
        let children = listed.iter().find(|slot| {
            let (other, at, ..) = &slots[**slot];
            other == root
                && at.len() == path.len() + 1
                && at.starts_with(path)
                && at.last().is_some_and(|last| last == "*")
        });
        if let Some(slot) = children {
            return format!("$h.slot({slot})");
        }
        let cone = self.cone.map(|cone| self.generator.finished.position[cone]);
        let entry = json!({ "cone": cone, "root": root_json(root), "path": path });
        if !self.generator.unlisted.contains(&entry) {
            self.generator.unlisted.push(entry);
        }
        format!("$h.read({}, {})", root_json(root), path_json(path))
    }

    fn output_code(&mut self, value: usize, path: &[String]) -> String {
        let base = match self.generator.finished.output_of.get(&(value, Vec::new())) {
            Some(output) => format!("$h.output({output})"),
            None => {
                if !self.generator.interim.contains(&value) {
                    self.generator.interim.push(value);
                }
                format!("$h.value({value})")
            }
        };
        if path.is_empty() {
            base
        } else {
            format!("$h.at({base}, {})", path_json(path))
        }
    }

    /// The default the callee's argument type declares for the path of
    /// its argument that is bound to `place`, in the context being
    /// written.
    fn callee_default(&self, place: &Place) -> Option<Value> {
        let Place::Slot(root, path) = place else {
            return None;
        };
        let context = &self.generator.finished.facts.contexts[self.context?];
        crate::plan::default_for(&context.bound_defaults, root, path)
    }

    /// The code of a place that has one without its expression.
    fn place_code(&mut self, place: &Place, want: Want) -> Option<String> {
        Some(match place {
            Place::Slot(root, path) => {
                let code = self.slot_code(root, path, want);
                let code = Self::wanted(want, code);
                // A path of the argument of a pattern compiled in that is
                // bound to a slot of the caller: where nothing is stored
                // there, a read gives the callee's default (ruling Z4).
                match (want, self.callee_default(place)) {
                    (Want::Use, Some(default)) => format!("$rt.or({code}, () => ({default}))"),
                    // Passed on, the reference carries the callee's
                    // declared default (ruling Z16).
                    (Want::Pass, Some(default)) if !self.to_body => {
                        format!("$h.withDefault({code}, {default})")
                    }
                    _ => code,
                }
            }
            Place::Read(root, path, class) => {
                let code = self.slot_code(root, path, Want::Use);
                match root {
                    Root::Index(_) => code,
                    _ if *class == "identity" => Self::wanted(want, code),
                    _ => format!("$h.v({code}).length"),
                }
            }
            Place::Value(value, path) => {
                let code = self.output_code(*value, path);
                Self::wanted(want, code)
            }
            Place::Stream(binding) => format!("$h.stream({binding})"),
            // The accumulator of a `reduce`: the slot of root `operation`
            // that the cone of the step lists (PL §3.13).
            Place::Accumulator(operation, path) => {
                let code = self.slot_code(&Root::Operation(*operation), path, want);
                Self::wanted(want, code)
            }
            _ => return None,
        })
    }

    /// Writes code that is registered outside the block it is written
    /// in: a `const` of the block is read there as the output it is.
    fn outside_block<T>(&mut self, write: impl FnOnce(&mut Self) -> T) -> T {
        let saved = std::mem::replace(&mut self.outside_block, true);
        let written = write(self);
        self.outside_block = saved;
        written
    }

    /// The value that an initializer denotes or reads a member of, with
    /// the expression that computes the value: the initializer itself, or
    /// the object of its member reads, as `(a ?? {})` is of
    /// `(a ?? {}).name`.
    fn value_written_in(&self, init: &'a Expression<'a>) -> Option<(usize, &'a Expression<'a>)> {
        let Some(Place::Value(value, _)) = self.place_of(init) else {
            return None;
        };
        let mut written = unwrap(init);
        loop {
            match self.place_of(written) {
                Some(Place::Value(of, path)) if of == value && path.is_empty() => {
                    return Some((value, written));
                }
                Some(Place::Value(of, _)) if of == value => {}
                _ => return None,
            }
            written = match written {
                Expression::StaticMemberExpression(member) => unwrap(&member.object),
                Expression::ComputedMemberExpression(member) => unwrap(&member.object),
                _ => return None,
            };
        }
    }

    /// Registers the value function of a `const` of a block body, where
    /// `value` is one and has no function: the initializer, which reads
    /// the other names of the block as outputs.
    fn register_local(&mut self, value: usize) {
        if self.generator.registered_values.contains(&value) {
            return;
        }
        let Some(local) = self.generator.locals.get(&value).copied() else {
            return;
        };
        self.generator.registered_values.push(value);
        let cone = Some(self.generator.cone_of(value));
        let code = self.in_module(local.module, local.context, |rewriter| {
            rewriter.in_cone(cone, |rewriter| {
                rewriter.outside_block(|rewriter| rewriter.render(local.init, Want::Pass))
            })
        });
        self.generator
            .hoist(format!("$rt.value({value}, ($h) => ({code}));"));
    }

    fn in_cone<T>(&mut self, cone: Option<usize>, write: impl FnOnce(&mut Self) -> T) -> T {
        let saved = std::mem::replace(&mut self.cone, cone);
        let written = write(self);
        self.cone = saved;
        written
    }

    fn in_module<T>(
        &mut self,
        module: usize,
        context: Option<usize>,
        write: impl FnOnce(&mut Self) -> T,
    ) -> T {
        let saved = (
            std::mem::replace(&mut self.module, module),
            std::mem::replace(&mut self.context, context),
            std::mem::take(&mut self.edits),
        );
        let written = write(self);
        self.module = saved.0;
        self.context = saved.1;
        self.edits = saved.2;
        written
    }

    /// The code of an expression.
    fn render(&mut self, expression: &Expression<'a>, want: Want) -> String {
        if self.context.is_some() {
            if let Some(code) = self.reactive(expression, want) {
                return code;
            }
        }
        let inner = unwrap(expression);
        let code = self.rewritten(inner.span(), |rewriter| match inner {
            Expression::JSXElement(element) => {
                let code = rewriter.jsx_element(element, false);
                rewriter.edit(element.span.start, element.span.end, code);
            }
            Expression::JSXFragment(fragment) => {
                let code =
                    rewriter.jsx_node("\"cf-fragment\"".to_string(), None, &fragment.children);
                rewriter.edit(fragment.span.start, fragment.span.end, code);
            }
            _ => walk::walk_expression(rewriter, inner),
        });
        let code = format!("({code})");
        // A literal and the result of an operator hold no reference.
        let plain = matches!(
            inner,
            Expression::StringLiteral(_)
                | Expression::NumericLiteral(_)
                | Expression::BooleanLiteral(_)
                | Expression::NullLiteral(_)
                | Expression::TemplateLiteral(_)
                | Expression::BinaryExpression(_)
                | Expression::UnaryExpression(_)
                // A name no place stands for: a global, a constant of the
                // module, or a local constant.
                | Expression::Identifier(_)
        );
        if self.context.is_some() && want == Want::Use && !plain {
            Self::wanted(want, code)
        } else {
            code
        }
    }

    /// The code of an expression of the reactive tier, where it is not
    /// its source text with its parts rewritten.
    fn reactive(&mut self, expression: &Expression<'a>, want: Want) -> Option<String> {
        let inner = unwrap(expression);
        let span = inner.span();
        let fact = self.fact(span);
        if let Expression::Identifier(identifier) = inner {
            let fact = fact?;
            return match &fact.place {
                Place::Value(value, path)
                    if self.cone.is_some() && Some(self.generator.cone_of(*value)) == self.cone =>
                {
                    if self.outside_block && self.generator.locals.contains_key(value) {
                        self.register_local(*value);
                        let code = self.output_code(*value, path);
                        return Some(Self::wanted(want, code));
                    }
                    // A value of this cone is held in a local variable.
                    Some(Self::wanted(want, identifier.name.to_string()))
                }
                Place::Value(value, _) => {
                    self.register_local(*value);
                    self.place_code(&fact.place, want)
                }
                Place::Record(_) => Some(Self::wanted(
                    want,
                    format!("$rt.force({}, $h)", identifier.name),
                )),
                place => self.place_code(place, want),
            };
        }
        let fact = fact?;
        match &fact.place {
            Place::Slot(Root::State(cell), path)
                if path.is_empty() && fact.states.0 <= *cell && *cell < fact.states.1 =>
            {
                self.state_cell(inner, *cell);
                self.place_code(&fact.place, want)
            }
            Place::Stream(binding) => {
                // An `action` is a handler written in place.
                if let Expression::CallExpression(call) = inner {
                    let action = self
                        .generator
                        .resolver
                        .api_callee(self.module, call)
                        .as_deref()
                        == Some("action");
                    let function = call.arguments.first().and_then(FunctionLike::of_argument);
                    if let (true, Some(function)) = (action, function) {
                        self.inline_handler(*binding, function);
                    }
                }
                self.place_code(&fact.place, want)
            }
            Place::Slot(Root::Operation(operation), path) => {
                // A `reduce` registers the functions of its initial value
                // and of its step where it is written, and an effect and
                // a `wish` the function of the request.
                if let (true, Expression::CallExpression(call)) = (path.is_empty(), inner) {
                    self.reduce_construct(call, *operation);
                    self.request_function(call, *operation);
                }
                self.place_code(&fact.place, want)
            }
            Place::Slot(Root::Child(child), path) => {
                // A call through `asInstance()` registers the function of
                // its argument where it is written.
                if let (true, Expression::CallExpression(call)) = (path.is_empty(), inner) {
                    self.child_instance(call, *child);
                }
                self.place_code(&fact.place, want)
            }
            Place::Accumulator(..) => self.place_code(&fact.place, want),
            Place::Slot(..) | Place::Read(..) => self.place_code(&fact.place, want),
            Place::Value(value, path) => {
                let value = *value;
                let created = fact.values.0 <= value && value < fact.values.1;
                let cone = self.generator.cone_of(value);
                if created && path.is_empty() {
                    // The runtime assembles the value of an element
                    // construct, and the construct registers the function
                    // of its body.
                    if let (Some(collection), Expression::CallExpression(call)) =
                        (self.generator.finished.values[value].1, inner)
                    {
                        self.element_construct(call, collection);
                        let code = self.output_code(value, &[]);
                        return Some(Self::wanted(want, code));
                    }
                    if Some(cone) == self.cone {
                        return self.compute(inner, value, want);
                    }
                    if !self.generator.registered_values.contains(&value) {
                        self.generator.registered_values.push(value);
                        let code = self.in_cone(Some(cone), |rewriter| {
                            rewriter.outside_block(|rewriter| {
                                rewriter
                                    .compute(inner, value, Want::Pass)
                                    .unwrap_or_else(|| rewriter.generic(inner))
                            })
                        });
                        self.generator
                            .hoist(format!("$rt.value({value}, ($h) => ({code}));"));
                    }
                    let code = self.output_code(value, &[]);
                    return Some(Self::wanted(want, code));
                }
                if !created && Some(cone) != self.cone {
                    let code = self.output_code(value, path);
                    return Some(Self::wanted(want, code));
                }
                self.compute(inner, value, want)
            }
            Place::Record(_) | Place::Const | Place::Unknown => self.structure(inner, want),
        }
    }

    /// The source text of an expression with its parts rewritten.
    fn generic(&mut self, inner: &Expression<'a>) -> String {
        let code = self.rewritten(inner.span(), |rewriter| {
            walk::walk_expression(rewriter, inner);
        });
        format!("({code})")
    }

    /// The first value of a state cell where it is not a constant (PL
    /// §1.3, "The first value of a state cell"): the function of the
    /// cone `StateCell.first` names, whose value the runtime writes once,
    /// when the cell is first created. A first value that is a constant
    /// is the default of the cell's schema and has no code.
    fn state_cell(&mut self, inner: &Expression<'a>, cell: usize) {
        let Some(first) = self.generator.plan["stateCells"][cell]["first"]["cone"].as_u64() else {
            return;
        };
        let cone = self
            .generator
            .finished
            .position
            .iter()
            .position(|index| *index == first as usize);
        // The call that makes the cell is the receiver of a method such
        // as `.for(cause)` written after it.
        let mut inner = inner;
        while let Expression::CallExpression(call) = inner {
            let Expression::StaticMemberExpression(member) = unwrap(&call.callee) else {
                break;
            };
            if member.property.name == "of" {
                break;
            }
            match unwrap(&member.object) {
                receiver @ (Expression::CallExpression(_) | Expression::NewExpression(_)) => {
                    inner = receiver;
                }
                _ => break,
            }
        }
        let argument = match inner {
            Expression::CallExpression(call) => {
                call.arguments.first().and_then(Argument::as_expression)
            }
            Expression::NewExpression(new) => {
                new.arguments.first().and_then(Argument::as_expression)
            }
            _ => None,
        };
        let code = match argument {
            Some(argument) => self.in_cone(cone, |rewriter| rewriter.render(argument, Want::Use)),
            None => "undefined".to_string(),
        };
        self.generator
            .hoist(format!("$rt.state({cell}, ($h) => ({code}));"));
        self.generator.registered_states.push(cell);
    }

    /// The code of an expression that computes the value `value` in the
    /// cone being written. `None` where it is the source text with its
    /// parts rewritten.
    fn compute(&mut self, inner: &Expression<'a>, value: usize, want: Want) -> Option<String> {
        // A use of a sandboxed body.
        let used = match inner {
            Expression::CallExpression(_) => {
                self.generator.finished.facts.uses.get(&value).cloned()
            }
            _ => None,
        };
        if let (Some(used), Expression::CallExpression(call)) = (used, inner) {
            let arguments: Vec<&Expression<'a>> = call
                .arguments
                .iter()
                .filter_map(Argument::as_expression)
                .collect();
            self.body_function(&used);
            let mut members: Vec<String> = Vec::new();
            let mut whole: Option<String> = None;
            let saved_to_body = std::mem::replace(&mut self.to_body, true);
            for (name, place) in &used.inputs {
                let formal = used.formals.iter().position(|formal| formal == name);
                let written = formal.and_then(|index| arguments.get(index).copied());
                // A `reduce` written as an input registers its functions.
                // The body reads its result through the slot.
                if let (Some(written), Place::Slot(Root::Operation(operation), path)) =
                    (written, place)
                {
                    if let (true, Expression::CallExpression(call)) =
                        (path.is_empty(), unwrap(written))
                    {
                        self.reduce_construct(call, *operation);
                    }
                }
                let code = match (written, place) {
                    (_, Place::Slot(..) | Place::Read(..)) => None,
                    (Some(written), _) => Some(self.render(written, Want::Pass)),
                    (None, Place::Value(other, _))
                        if self.cone.is_some()
                            && Some(self.generator.cone_of(*other)) == self.cone =>
                    {
                        Some(name.clone())
                    }
                    // A constant at a position of handle type: the body is
                    // handed a handle that reads it (ES §2.4).
                    (None, Place::Const) if used.handles.contains(name) => {
                        Some(format!("$h.constant({name})"))
                    }
                    (None, Place::Const | Place::Unknown) => Some(name.clone()),
                    (None, Place::Record(_)) => Some(format!("$rt.force({name}, $h)")),
                    (None, place) => self.place_code(place, Want::Pass),
                };
                if let Some(code) = code {
                    if used.kind == "lift" {
                        whole = Some(code);
                    } else {
                        members.push(format!("{}: {code}", json!(name)));
                    }
                }
            }
            self.to_body = saved_to_body;
            let computed = match (used.kind, whole) {
                ("lift", Some(whole)) => whole,
                ("lift", None) => "undefined".to_string(),
                _ => format!("{{ {} }}", members.join(", ")),
            };
            return Some(Self::wanted(
                want,
                format!("$h.invoke({}, {computed})", used.body),
            ));
        }
        self.structure(inner, want)
    }

    /// The functions of a `reduce` in the reactive tier, registered where
    /// it is written: the initial value, which the cone the `reduce` is
    /// written in computes, and the step, a cone the runtime evaluates
    /// once per element, in order, with the accumulator as a slot of root
    /// `operation` (PL §3.13).
    /// The function of the argument of a child instance that a call
    /// through `asInstance()` makes (PL §3.15): the runtime evaluates it
    /// for the element keys of the site, writes what it returns to the
    /// argument document of the instance, and gives a reader of the
    /// child's result the reference to its result document. The function
    /// passes on what the call binds, so a reference stays one.
    fn child_instance(&mut self, call: &CallExpression<'a>, child: usize) {
        if !matches!(unwrap(&call.callee), Expression::CallExpression(_))
            || self.generator.registered_children.contains(&child)
        {
            return;
        }
        self.generator.registered_children.push(child);
        // The cone that holds the write edges of the argument, in the
        // order the plan emitter made the cones.
        let cone = self.generator.plan["cones"]
            .as_array()
            .into_iter()
            .flatten()
            .position(|cone| {
                cone["writes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|write| {
                        write["target"]["kind"] == json!("argument")
                            && write["target"]["child"] == json!(child)
                    })
            })
            .and_then(|cone| {
                self.generator
                    .finished
                    .position
                    .iter()
                    .position(|index| *index == cone)
            });
        let code = match call.arguments.first().and_then(Argument::as_expression) {
            Some(argument) => self.in_cone(cone, |rewriter| rewriter.render(argument, Want::Pass)),
            None => "undefined".to_string(),
        };
        self.generator
            .hoist(format!("$rt.child({child}, ($h) => ({code}));"));
    }

    /// The function of the request of an effect, and of the operands of
    /// a `wish`, written in the reactive tier (PL §3.14, §3.19): the
    /// runtime evaluates it in the cone that holds the write edges with
    /// target `request` and stores what it returns in the state document
    /// of the operation. The function returns the arguments of the call
    /// in the order they are written, each passed on as the call binds
    /// it, so a reference stays one.
    fn request_function(&mut self, call: &CallExpression<'a>, operation: usize) {
        let kind = self.generator.plan["operations"][operation]["kind"].clone();
        if (kind != json!("effect") && kind != json!("wish"))
            || self.generator.registered_requests.contains(&operation)
        {
            return;
        }
        self.generator.registered_requests.push(operation);
        let cone = self.generator.plan["cones"]
            .as_array()
            .into_iter()
            .flatten()
            .position(|cone| {
                cone["writes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|write| {
                        write["target"]["kind"] == json!("request")
                            && write["target"]["of"] == json!({ "operation": operation })
                    })
            })
            .and_then(|cone| {
                self.generator
                    .finished
                    .position
                    .iter()
                    .position(|index| *index == cone)
            });
        let arguments: Vec<String> = call
            .arguments
            .iter()
            .filter_map(Argument::as_expression)
            .map(|argument| self.in_cone(cone, |rewriter| rewriter.render(argument, Want::Pass)))
            .collect();
        self.generator.hoist(format!(
            "$rt.request({operation}, ($h) => ([{}]));",
            arguments.join(", ")
        ));
    }

    fn reduce_construct(&mut self, call: &CallExpression<'a>, operation: usize) {
        let record = &self.generator.plan["operations"][operation];
        if record["kind"] != json!("reduce")
            || self.generator.registered_reduces.contains(&operation)
        {
            return;
        }
        let Expression::StaticMemberExpression(member) = unwrap(&call.callee) else {
            return;
        };
        if member.property.name != "reduce" {
            return;
        }
        let Some(function) = call.arguments.first().and_then(FunctionLike::of_argument) else {
            return;
        };
        let Some(step) = function.expression_body() else {
            return;
        };
        // The collection of the `reduce` is the one whose element body the
        // step is written in: the last `element` step of the `within` of
        // the step's cone (ruling Z10).
        let Some(step_cone) = record["implementation"]["cone"].as_u64() else {
            return;
        };
        let collection = self.generator.plan["cones"][step_cone as usize]["within"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|step| step["element"].as_u64())
            .next_back();
        let Some(collection) = collection else {
            return;
        };
        self.generator.registered_reduces.push(operation);
        // The cones in the order the plan emitter made them, which the
        // rewriter names a cone by.
        let made = |generator: &Generator, cone: usize| {
            generator
                .finished
                .position
                .iter()
                .position(|index| *index == cone)
        };
        let initial_cone = self.generator.plan["cones"]
            .as_array()
            .into_iter()
            .flatten()
            .position(|cone| {
                cone["writes"].as_array().is_some_and(|writes| {
                    writes.iter().any(|write| {
                        write["target"]["kind"] == json!("request")
                            && write["target"]["of"] == json!({ "operation": operation })
                    })
                })
            });
        self.source_of_construct(&member.object, collection as usize);
        let initial = match (
            call.arguments.get(1).and_then(Argument::as_expression),
            initial_cone,
        ) {
            (Some(initial), Some(cone)) => {
                let cone = made(self.generator, cone);
                let code = self.in_cone(cone, |rewriter| rewriter.render(initial, Want::Use));
                format!("{}, ($h) => ({code})", initial_cone.unwrap_or(0))
            }
            _ => "undefined, undefined".to_string(),
        };
        let cone = made(self.generator, step_cone as usize);
        let code = self.in_cone(cone, |rewriter| rewriter.render(step, Want::Use));
        self.generator.hoist(format!(
            "$rt.reduce({operation}, {initial}, {step_cone}, ($h) => ({code}));"
        ));
    }

    /// The receiver of an element construct or of a `reduce`, evaluated
    /// for the cones it registers. Where it is an array written in place
    /// or a constant, the plan has an interim output for it
    /// (`Collection.source`), which this code computes.
    fn source_of_construct(&mut self, object: &Expression<'a>, collection: usize) {
        let source = self.generator.plan["collections"][collection]["source"]["output"]
            .as_u64()
            .and_then(|output| {
                self.generator
                    .finished
                    .output_of
                    .iter()
                    .find(|((_, below), index)| below.is_empty() && **index == output as usize)
                    .map(|((value, _), _)| *value)
            })
            .filter(|value| !self.generator.registered_values.contains(value));
        let written = matches!(
            self.place_of(object),
            None | Some(Place::Record(_) | Place::Const | Place::Unknown)
        );
        match source {
            Some(value) if written => {
                let cone = Some(self.generator.cone_of(value));
                let code = self.in_cone(cone, |rewriter| {
                    rewriter.outside_block(|rewriter| rewriter.render(object, Want::Pass))
                });
                self.generator
                    .hoist(format!("$rt.value({value}, ($h) => ({code}));"));
                self.generator.registered_values.push(value);
            }
            _ => {
                // A receiver that is a `const` of a block body is read
                // as the output it is.
                if let Some(Place::Value(value, _)) = self.place_of(object) {
                    self.register_local(value);
                }
                self.in_cone(None, |rewriter| rewriter.render(object, Want::Pass));
            }
        }
    }

    /// The per-element function of an element construct, registered
    /// where the construct is written.
    fn element_construct(&mut self, call: &CallExpression<'a>, collection: usize) {
        let Expression::StaticMemberExpression(member) = unwrap(&call.callee) else {
            return;
        };
        let Some(function) = call.arguments.first().and_then(FunctionLike::of_argument) else {
            return;
        };
        if self.generator.registered_elements.contains(&collection) {
            return;
        }
        self.source_of_construct(&member.object, collection);
        let cone = self
            .generator
            .finished
            .values
            .iter()
            .find(|(_, of, _)| *of == Some(collection))
            .map(|(cone, ..)| *cone);
        self.generator.buffers.push(Vec::new());
        let mut returned: Option<String> = None;
        match function.expression_body() {
            Some(expression) => {
                returned =
                    Some(self.in_cone(cone, |rewriter| rewriter.render(expression, Want::Pass)));
            }
            None => {
                for statement in function.block_body().unwrap_or(&[]) {
                    if let Statement::ReturnStatement(statement) = statement {
                        returned = Some(match &statement.argument {
                            Some(argument) => {
                                self.in_cone(cone, |rewriter| rewriter.render(argument, Want::Pass))
                            }
                            None => "undefined".to_string(),
                        });
                        break;
                    }
                    self.in_cone(None, |rewriter| rewriter.setup_statement(statement));
                }
            }
        }
        let returned = returned.unwrap_or_else(|| "undefined".to_string());
        self.generator
            .hoist(format!("$rt.element({collection}, ($h) => ({returned}));"));
        self.generator.registered_elements.push(collection);
        let statements = self.generator.buffers.pop().unwrap_or_default();
        self.generator
            .hoist(format!("{{\n{}\n}}", statements.join("\n")));
    }

    /// The code of an expression whose parts are read in more than one
    /// way: a literal of a record or an array, a selection, a call of a
    /// pattern compiled in, a member read, and the forms of the API that
    /// are expression code.
    fn structure(&mut self, inner: &Expression<'a>, want: Want) -> Option<String> {
        match inner {
            Expression::ObjectExpression(object) => {
                let mut members: Vec<String> = Vec::new();
                for property in &object.properties {
                    match property {
                        ObjectPropertyKind::ObjectProperty(property) => {
                            if property.method || property.kind != PropertyKind::Init {
                                let code = self.rewritten(property.span, |rewriter| {
                                    walk::walk_object_property(rewriter, property);
                                });
                                members.push(code);
                                continue;
                            }
                            let key = if property.computed {
                                match property.key.as_expression() {
                                    Some(key) => format!("[{}]", self.render(key, Want::Use)),
                                    None => self.text(property.key.span()).to_string(),
                                }
                            } else {
                                self.text(property.key.span()).to_string()
                            };
                            let code = self.render(&property.value, Want::Pass);
                            members.push(format!("{key}: {code}"));
                        }
                        ObjectPropertyKind::SpreadProperty(spread) => {
                            let code = self.render(&spread.argument, Want::Use);
                            members.push(format!("...{code}"));
                        }
                    }
                }
                Some(format!("({{ {} }})", members.join(", ")))
            }
            Expression::ArrayExpression(array) => {
                let mut members: Vec<String> = Vec::new();
                for element in &array.elements {
                    match element {
                        ArrayExpressionElement::Elision(_) => members.push(String::new()),
                        // `$rt.spread` gives the members of what the
                        // operand holds, and none for an operand that
                        // holds nothing.
                        ArrayExpressionElement::SpreadElement(spread) => {
                            let code = self.render(&spread.argument, Want::Pass);
                            members.push(format!("...$h.spread({code})"));
                        }
                        element => {
                            if let Some(element) = element.as_expression() {
                                members.push(self.render(element, Want::Pass));
                            }
                        }
                    }
                }
                Some(format!("[{}]", members.join(", ")))
            }
            Expression::ConditionalExpression(conditional) => {
                let test = self.render(&conditional.test, Want::Use);
                let consequent = self.render(&conditional.consequent, Want::Pass);
                let alternate = self.render(&conditional.alternate, Want::Pass);
                Some(Self::wanted(
                    want,
                    format!("({test} ? {consequent} : {alternate})"),
                ))
            }
            // `$h.selected` tests the left operand by the value it
            // resolves to and passes on the operand it selects, the left
            // one as the reference it is (PL §3.5).
            Expression::LogicalExpression(logical) => {
                let left = self.render(&logical.left, Want::Pass);
                let right = self.render(&logical.right, Want::Pass);
                let operator = match logical.operator {
                    LogicalOperator::And => "&&",
                    LogicalOperator::Or => "||",
                    LogicalOperator::Coalesce => "??",
                };
                Some(Self::wanted(
                    want,
                    format!("$h.selected(\"{operator}\", {left}, () => {right})"),
                ))
            }
            Expression::StaticMemberExpression(member) => self.member(
                &member.object,
                json!(member.property.name.as_str()).to_string(),
                want,
            ),
            Expression::ComputedMemberExpression(member) => {
                let key = self.render(&member.expression, Want::Use);
                self.member(&member.object, key, want)
            }
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::StaticMemberExpression(member) => self.member(
                    &member.object,
                    json!(member.property.name.as_str()).to_string(),
                    want,
                ),
                ChainElement::ComputedMemberExpression(member) => {
                    let key = self.render(&member.expression, Want::Use);
                    self.member(&member.object, key, want)
                }
                _ => None,
            },
            Expression::JSXElement(element) => Some(self.jsx_element(element, false)),
            Expression::JSXFragment(fragment) => {
                Some(self.jsx_node("\"cf-fragment\"".to_string(), None, &fragment.children))
            }
            Expression::CallExpression(call) => self.call(call, want),
            _ => None,
        }
    }

    /// A member read of an object that is no constant: a read that
    /// follows a reference and gives nothing where the object holds
    /// nothing.
    fn member(&mut self, object: &Expression<'a>, key: String, want: Want) -> Option<String> {
        match self.place_of(object) {
            None | Some(Place::Const) => None,
            Some(_) => {
                let object = self.render(object, Want::Pass);
                Some(Self::wanted(want, format!("$h.at({object}, [{key}])")))
            }
        }
    }

    fn call(&mut self, call: &CallExpression<'a>, want: Want) -> Option<String> {
        let context = self.context?;
        let arguments: Vec<&Expression<'a>> = call
            .arguments
            .iter()
            .filter_map(Argument::as_expression)
            .collect();
        // A pattern compiled in at a call.
        if matches!(unwrap(&call.callee), Expression::Identifier(_)) {
            let inline = self
                .generator
                .finished
                .facts
                .inlines
                .get(&(context, call.span.start))
                .copied();
            if let Some(inline) = inline {
                let mut members: Vec<(String, &Expression<'a>)> = Vec::new();
                match arguments.first().map(|argument| unwrap(argument)) {
                    None => {}
                    Some(Expression::ObjectExpression(object)) => {
                        for property in &object.properties {
                            match property {
                                ObjectPropertyKind::ObjectProperty(property)
                                    if !property.computed =>
                                {
                                    match static_key_name(&property.key) {
                                        Some(name) => {
                                            members.push((name.to_string(), &property.value));
                                        }
                                        None => self.generator.unsupported(
                                            "an argument of a pattern compiled in with a key that is no name",
                                            self.module,
                                            property.span.start,
                                        ),
                                    }
                                }
                                // "A key that is static ... is the name it
                                // evaluates to" (PL §3.4).
                                ObjectPropertyKind::ObjectProperty(property)
                                    if matches!(
                                        property.key.as_expression().map(unwrap),
                                        Some(Expression::StringLiteral(_))
                                    ) =>
                                {
                                    if let Some(Expression::StringLiteral(key)) =
                                        property.key.as_expression().map(unwrap)
                                    {
                                        members.push((key.value.to_string(), &property.value));
                                    }
                                }
                                other => self.generator.unsupported(
                                    "a spread or a computed key in the argument of a pattern compiled in",
                                    self.module,
                                    other.span().start,
                                ),
                            }
                        }
                    }
                    Some(other) => self.generator.unsupported(
                        "an argument of a pattern compiled in that is not written as a record",
                        self.module,
                        other.span().start,
                    ),
                }
                let members: Vec<(String, String, Option<Place>)> = members
                    .into_iter()
                    .map(|(name, written)| {
                        let place = self.place_of(written);
                        let code = self.passed_on(written, &place);
                        (name, code, place)
                    })
                    .collect();
                let code = self.inline(inline, members);
                return Some(Self::wanted(want, code));
            }
        }
        let api = self.generator.resolver.api_callee(self.module, call);
        match api.as_deref() {
            Some("computed") => {
                let function = arguments
                    .first()
                    .and_then(|first| FunctionLike::of(first))?;
                match function.expression_body() {
                    Some(expression) => Some(self.render(expression, want)),
                    None => {
                        let span = function.span();
                        let code = self.rewritten(span, |rewriter| match function {
                            FunctionLike::Arrow(arrow) => {
                                walk::walk_arrow_function_expression(rewriter, arrow);
                            }
                            FunctionLike::Function(function) => {
                                walk::walk_function(rewriter, function, ScopeFlags::Function);
                            }
                        });
                        Some(Self::wanted(want, format!("(({code})())")))
                    }
                }
            }
            // A debug renderer reads every operand by value over its
            // whole subtree (BI, "Debug strings"), so a record that the
            // code builds is given with its references read.
            Some(name @ ("toCompactDebugString" | "toIndentedDebugString")) => {
                let operands: Vec<String> = arguments
                    .iter()
                    .map(|argument| format!("$h.v({})", self.render(argument, Want::Pass)))
                    .collect();
                Some(format!("{name}({})", operands.join(", ")))
            }
            Some("ifElse") if arguments.len() == 3 => {
                let test = self.render(arguments[0], Want::Use);
                let consequent = self.render(arguments[1], Want::Pass);
                let alternate = self.render(arguments[2], Want::Pass);
                Some(Self::wanted(
                    want,
                    format!("({test} ? {consequent} : {alternate})"),
                ))
            }
            Some("when") if arguments.len() == 2 => {
                let test = self.render(arguments[0], Want::Use);
                let value = self.render(arguments[1], Want::Pass);
                Some(Self::wanted(want, format!("({test} && {value})")))
            }
            // `equals` compares what its operands name, so each is passed
            // as the reference it is, and the host resolves the links
            // (PL §3.16; §1.3, "A plain value in place has an identity").
            Some("equals") if arguments.len() == 2 => {
                let left = self.render(arguments[0], Want::Pass);
                let right = self.render(arguments[1], Want::Pass);
                Some(format!("$h.equals({left}, {right})"))
            }
            Some("unless") if arguments.len() == 2 => {
                let test = self.render(arguments[0], Want::Use);
                let value = self.render(arguments[1], Want::Pass);
                Some(Self::wanted(want, format!("({test} || {value})")))
            }
            _ => {
                let Expression::StaticMemberExpression(member) = unwrap(&call.callee) else {
                    return None;
                };
                match member.property.name.as_str() {
                    "get" | "sample" if arguments.is_empty() => {
                        self.place_of(&member.object)?;
                        Some(self.render(&member.object, want))
                    }
                    "key" if arguments.len() == 1 => {
                        self.place_of(&member.object)?;
                        let key = self.render(arguments[0], Want::Use);
                        self.member(&member.object, key, want)
                    }
                    // `h.equals(x)` is the comparison that `equals(h, x)`
                    // is (LS §6.1): each operand is passed as the
                    // reference it is, and the host resolves the links.
                    "equals" if arguments.len() == 1 => {
                        self.place_of(&member.object)?;
                        let left = self.render(&member.object, Want::Pass);
                        let right = self.render(arguments[0], Want::Pass);
                        Some(format!("$h.equals({left}, {right})"))
                    }
                    _ => None,
                }
            }
        }
    }

    /// A call of a pattern compiled in: its body is a setup function of
    /// its own module, which is given the parts of the argument that no
    /// place stands for.
    fn inline(&mut self, context: usize, members: Vec<(String, String, Option<Place>)>) -> String {
        let info = self.generator.finished.facts.contexts[context].clone();
        let within = info.cone.is_some() && info.cone == self.cone;
        // Whether the callee binds its whole argument to one name.
        let whole = self
            .generator
            .function_at(info.module, info.start)
            .and_then(|function| function.params().items.first())
            .is_some_and(|parameter| {
                matches!(parameter.pattern, BindingPattern::BindingIdentifier(_))
            });
        let mut given: Vec<String> = Vec::new();
        for (name, code, place) in members {
            match place {
                None | Some(Place::Const | Place::Unknown) => {
                    given.push(format!("{}: {code}", json!(name)));
                }
                Some(Place::Record(_)) => {
                    given.push(format!("{}: $rt.thunk(($h) => ({code}))", json!(name)));
                }
                Some(Place::Value(value, _))
                    if within && Some(self.generator.cone_of(value)) == self.cone =>
                {
                    given.push(format!("{}: {code}", json!(name)));
                }
                // A path bound to a slot or to a value of another cone:
                // the callee's code reads the place itself. A callee
                // that names its whole argument reads it here.
                Some(_) if whole => {
                    given.push(format!("{}: $rt.thunk(($h) => ({code}))", json!(name)));
                }
                Some(_) => {}
            }
        }
        if self.generator.setups.insert(context) {
            self.setup(context, if within { self.cone } else { None });
        }
        let argument = format!("{{ {} }}", given.join(", "));
        if within {
            format!("$rt.setups[{context}]({argument}, $h)")
        } else {
            let name = self.generator.fresh("s");
            self.generator.hoist(format!(
                "const {name} = $rt.setups[{context}]({argument}, $h);"
            ));
            format!("$rt.force({name}, $h)")
        }
    }

    /// Writes the setup function of a context: the body of a pattern,
    /// with a registration for each function the plan needs of it. It
    /// returns what the pattern returns, as a function of the host where
    /// the body is evaluated once, and as a value where it is evaluated
    /// in a cone.
    fn setup(&mut self, context: usize, cone: Option<usize>) {
        let info = self.generator.finished.facts.contexts[context].clone();
        let Some(function) = self.generator.function_at(info.module, info.start) else {
            self.generator.unsupported(
                "a pattern whose function was not found",
                info.module,
                info.start,
            );
            return;
        };
        self.generator.buffers.push(Vec::new());
        let result = self.in_module(info.module, Some(context), |rewriter| {
            rewriter.in_cone(cone, |rewriter| {
                if context != 0 {
                    if let Some(parameter) = function.params().items.first() {
                        rewriter.bind_names(&parameter.pattern, "$arg", &mut Vec::new(), None);
                    }
                } else if let Some(BindingPattern::ObjectPattern(object)) = function
                    .params()
                    .items
                    .first()
                    .map(|parameter| &parameter.pattern)
                {
                    // `[SELF]: name` binds a reference to the instance's
                    // own result.
                    for property in &object.properties {
                        let own = property.computed
                            && matches!(
                                property.key.as_expression().map(|key| unwrap(key)),
                                Some(Expression::Identifier(key)) if key.name == "SELF"
                            );
                        if let (true, BindingPattern::BindingIdentifier(identifier)) =
                            (own, &property.value)
                        {
                            rewriter
                                .generator
                                .hoist(format!("const {} = $rt.self;", identifier.name));
                        }
                    }
                }
                match function.expression_body() {
                    Some(expression) => rewriter.render(expression, Want::Pass),
                    None => {
                        let mut result = "undefined".to_string();
                        for statement in function.block_body().unwrap_or(&[]) {
                            if let Statement::ReturnStatement(statement) = statement {
                                if let Some(argument) = &statement.argument {
                                    result = rewriter.render(argument, Want::Pass);
                                }
                                break;
                            }
                            rewriter.setup_statement(statement);
                        }
                        result
                    }
                }
            })
        });
        let statements = self.generator.buffers.pop().unwrap_or_default();
        let returned = match cone {
            Some(_) => format!("return ({result});"),
            None => format!("return $rt.thunk(($h) => ({result}));"),
        };
        self.generator.register(
            info.module,
            format!(
                "$rt.setup({context}, function ($arg, $h) {{\n{}\n{returned}\n}});",
                statements.join("\n")
            ),
        );
    }

    /// A statement of a pattern body or of the callback of an element
    /// construct: its expressions are rewritten for the functions they
    /// register, and a name is declared where no place stands for it.
    fn setup_statement(&mut self, statement: &Statement<'a>) {
        match statement {
            Statement::VariableDeclaration(declaration) => {
                for declarator in &declaration.declarations {
                    let Some(init) = &declarator.init else {
                        continue;
                    };
                    let place = self.place_of(init);
                    let code = self.render(init, Want::Pass);
                    match &declarator.id {
                        BindingPattern::BindingIdentifier(identifier) => {
                            let local = self.cone.is_some()
                                && matches!(&place, Some(Place::Value(value, _))
                                    if Some(self.generator.cone_of(*value)) == self.cone);
                            match place {
                                None | Some(Place::Const | Place::Unknown) => self
                                    .generator
                                    .hoist(format!("const {} = {code};", identifier.name)),
                                Some(Place::Record(_)) => self.generator.hoist(format!(
                                    "const {} = $rt.thunk(($h) => ({code}));",
                                    identifier.name
                                )),
                                Some(_) if local => self
                                    .generator
                                    .hoist(format!("const {} = {code};", identifier.name)),
                                Some(_) => {}
                            }
                        }
                        pattern => {
                            let root = self.generator.fresh("d");
                            self.generator
                                .hoist(format!("const {root} = $rt.thunk(($h) => ({code}));"));
                            self.bind_names(pattern, &root, &mut Vec::new(), None);
                        }
                    }
                }
            }
            Statement::ExpressionStatement(statement) => {
                self.render(&statement.expression, Want::Pass);
            }
            Statement::FunctionDeclaration(function) => {
                let code = self.in_module(self.module, None, |rewriter| {
                    rewriter.rewritten(function.span, |rewriter| {
                        walk::walk_function(rewriter, function, ScopeFlags::Function);
                    })
                });
                self.generator.hoist(code);
            }
            Statement::TSTypeAliasDeclaration(_)
            | Statement::TSInterfaceDeclaration(_)
            | Statement::EmptyStatement(_) => {}
            other => self.generator.unsupported(
                "a statement of the reactive tier",
                self.module,
                other.span().start,
            ),
        }
    }

    /// Declares each name of a binding pattern that no place stands for:
    /// a constant as its value, and a record written in the reactive tier
    /// as a function of the host.
    fn bind_names(
        &mut self,
        pattern: &BindingPattern<'a>,
        root: &str,
        path: &mut Vec<String>,
        default: Option<&Expression<'a>>,
    ) {
        match pattern {
            BindingPattern::BindingIdentifier(identifier) => {
                let Some(context) = self.context else {
                    return;
                };
                let place = self
                    .generator
                    .finished
                    .facts
                    .bound
                    .get(&(context, identifier.span.start))
                    .cloned();
                let read = format!("$rt.at({root}, {}, $h)", path_json(path));
                // A path the call leaves out reads as the default the
                // callee's argument type declares for it.
                let declared = (root == "$arg")
                    .then(|| {
                        let mut schema = self.generator.finished.facts.contexts[context]
                            .argument_schema
                            .as_ref()?;
                        for segment in path.iter() {
                            schema = schema.get("properties")?.get(segment)?;
                        }
                        schema.get("default").cloned()
                    })
                    .flatten();
                let read = match declared {
                    Some(declared) => format!("$rt.or({read}, () => ({declared}))"),
                    None => read,
                };
                let read = match default {
                    Some(default) => {
                        let default =
                            self.in_cone(None, |rewriter| rewriter.render(default, Want::Pass));
                        format!("$rt.or({read}, () => ({default}))")
                    }
                    None => read,
                };
                let local = self.cone.is_some()
                    && matches!(&place, Some(Place::Value(value, _))
                        if Some(self.generator.cone_of(*value)) == self.cone);
                match place {
                    None | Some(Place::Const | Place::Unknown) => self
                        .generator
                        .hoist(format!("const {} = {read};", identifier.name)),
                    Some(Place::Record(_)) => self.generator.hoist(format!(
                        "const {} = $rt.thunk(($h) => ({read}));",
                        identifier.name
                    )),
                    Some(_) if local => self
                        .generator
                        .hoist(format!("const {} = {read};", identifier.name)),
                    Some(_) => {}
                }
            }
            BindingPattern::ObjectPattern(object) => {
                for property in &object.properties {
                    match static_key_name(&property.key).filter(|_| !property.computed) {
                        Some(name) => {
                            path.push(name.to_string());
                            self.bind_names(&property.value, root, path, None);
                            path.pop();
                        }
                        None => self.generator.unsupported(
                            "a computed key in a binding of the reactive tier",
                            self.module,
                            property.span.start,
                        ),
                    }
                }
            }
            BindingPattern::ArrayPattern(array) => {
                for (index, element) in array.elements.iter().enumerate() {
                    if let Some(element) = element {
                        path.push(index.to_string());
                        self.bind_names(element, root, path, None);
                        path.pop();
                    }
                }
            }
            BindingPattern::AssignmentPattern(assignment) => {
                self.bind_names(&assignment.left, root, path, Some(&assignment.right));
            }
        }
    }

    /// Registers the function of a sandboxed body used in the reactive
    /// tier: the body's source in its own module, called with the
    /// argument the runtime builds.
    fn body_function(&mut self, used: &UseFact) {
        let Some(function) = self.generator.function_at(used.home, used.start) else {
            self.generator.unsupported(
                "a body whose function was not found",
                used.home,
                used.start,
            );
            return;
        };
        let source = self.plain_function(used.home, function);
        let call = match used.kind {
            "lift" => format!("($a) => ({source})($a)"),
            "computed" => {
                let names: Vec<&str> = used.inputs.iter().map(|(name, _)| name.as_str()).collect();
                format!(
                    "($a) => {{ const {{ {} }} = $a; return ({source})(); }}",
                    names.join(", ")
                )
            }
            _ => {
                let arguments: Vec<String> = used
                    .formals
                    .iter()
                    .map(|formal| format!("$a[{}]", json!(formal)))
                    .collect();
                format!("($a) => ({source})({})", arguments.join(", "))
            }
        };
        self.generator
            .register(used.home, format!("$rt.body({}, {call});", used.body));
    }

    /// Registers the function of a handler written in place, for one
    /// binding of it: the function where it is written, so that a
    /// constant it captures is the one of its scope, with the names its
    /// state holds taken from the state.
    fn inline_handler(&mut self, binding: usize, function: FunctionLike<'_, 'a>) {
        let mut names: Vec<String> = Vec::new();
        for entry in self.generator.plan["bindings"][binding]["state"]
            .as_array()
            .into_iter()
            .flatten()
        {
            // A constant is read from the scope the function is written
            // in. A constant at a position of handle type is not: the
            // runtime hands the body a handle that reads it (ES §2.4).
            let constant = entry["place"].get("constant").is_some()
                && !entry["path"][0]
                    .as_str()
                    .is_some_and(|name| self.generator.declares_handle(binding, name));
            if let (false, Some(name)) = (constant, entry["path"][0].as_str()) {
                if !names.iter().any(|known| known == name) {
                    names.push(name.to_string());
                }
            }
        }
        let module = self.module;
        let source = self.in_module(module, None, |rewriter| {
            rewriter.in_cone(None, |rewriter| {
                rewriter.rewritten(function.span(), |rewriter| match function {
                    FunctionLike::Arrow(arrow) => {
                        walk::walk_arrow_function_expression(rewriter, arrow);
                    }
                    FunctionLike::Function(function) => {
                        walk::walk_function(rewriter, function, ScopeFlags::Function);
                    }
                })
            })
        });
        self.generator.hoist(format!(
            "$rt.handler({binding}, ($e, $s) => {{ const {{ {} }} = $s; return ({source})($e); }});",
            names.join(", ")
        ));
    }

    /// The source of a function of the function tier: its types removed
    /// and its JSX turned into calls.
    fn plain_function(&mut self, module: usize, function: FunctionLike<'a, 'a>) -> String {
        self.in_module(module, None, |rewriter| {
            rewriter.in_cone(None, |rewriter| {
                rewriter.rewritten(function.span(), |rewriter| match function {
                    FunctionLike::Arrow(arrow) => {
                        walk::walk_arrow_function_expression(rewriter, arrow);
                    }
                    FunctionLike::Function(function) => {
                        walk::walk_function(rewriter, function, ScopeFlags::Function);
                    }
                })
            })
        })
    }

    // ----- JSX -----

    /// The code of a JSX element: a view node for a host element, and
    /// what the pattern returns for a tag that names a pattern compiled
    /// in, its `[UI]` at a child position (PL §1.1).
    fn jsx_element(&mut self, element: &JSXElement<'a>, child: bool) -> String {
        let opening = &element.opening_element;
        if let (Some(context), JSXElementName::IdentifierReference(_)) =
            (self.context, &opening.name)
        {
            let inline = self
                .generator
                .finished
                .facts
                .inlines
                .get(&(context, element.span.start))
                .copied();
            if let Some(inline) = inline {
                let mut members: Vec<(String, String, Option<Place>)> = Vec::new();
                for attribute in &opening.attributes {
                    match attribute {
                        JSXAttributeItem::Attribute(attribute) => {
                            let name = self.text(attribute.name.span()).to_string();
                            // An attribute written as an element is a
                            // value of a cone of its own.
                            if let Some(JSXAttributeValue::Element(written)) = &attribute.value {
                                let built = self
                                    .generator
                                    .finished
                                    .facts
                                    .built
                                    .get(&(context, written.span.start))
                                    .copied();
                                if let Some(value) = built {
                                    let cone = Some(self.generator.cone_of(value));
                                    let code = self.in_cone(cone, |rewriter| {
                                        rewriter.jsx_element(written, false)
                                    });
                                    self.generator
                                        .hoist(format!("$rt.value({value}, ($h) => ({code}));"));
                                    self.generator.registered_values.push(value);
                                    continue;
                                }
                            }
                            let (code, place) = self.attribute_value(attribute);
                            members.push((name, code, place));
                        }
                        JSXAttributeItem::SpreadAttribute(spread) => self.generator.unsupported(
                            "a spread attribute on a tag that names a pattern",
                            self.module,
                            spread.span.start,
                        ),
                    }
                }
                // The children are a value the instance computes, which
                // the callee reads by its place.
                let built = self
                    .generator
                    .finished
                    .facts
                    .built
                    .get(&(context, element.span.start))
                    .copied();
                if let Some(value) = built {
                    let cone = Some(self.generator.cone_of(value));
                    let children =
                        self.in_cone(cone, |rewriter| rewriter.jsx_children(&element.children));
                    self.generator.hoist(format!(
                        "$rt.value({value}, ($h) => ([{}]));",
                        children.join(", ")
                    ));
                    self.generator.registered_values.push(value);
                }
                let code = self.inline(inline, members);
                return if child {
                    format!("$h.at({code}, [\"$UI\"])")
                } else {
                    code
                };
            }
        }
        let name = match &opening.name {
            JSXElementName::Identifier(identifier) => json!(identifier.name.as_str()).to_string(),
            JSXElementName::NamespacedName(name) => json!(self.text(name.span)).to_string(),
            other => self.text(other.span()).to_string(),
        };
        let mut props: Vec<String> = Vec::new();
        for attribute in &opening.attributes {
            match attribute {
                JSXAttributeItem::Attribute(attribute) => {
                    let name = self.text(attribute.name.span()).to_string();
                    let (code, _) = self.attribute_value(attribute);
                    props.push(format!("{}: {code}", json!(name)));
                }
                JSXAttributeItem::SpreadAttribute(spread) => {
                    let code = self.render(&spread.argument, Want::Use);
                    props.push(format!("...{code}"));
                }
            }
        }
        self.jsx_node(name, Some(props), &element.children)
    }

    /// The code of a part of an argument or of an attribute. Where a
    /// place stands for it and a pattern compiled in is given it, the
    /// callee reads the place itself and the cone that writes the call
    /// does not, so its reads are not counted against that cone.
    fn passed_on(&mut self, written: &Expression<'a>, place: &Option<Place>) -> String {
        let before = self.generator.unlisted.len();
        let code = self.render(written, Want::Pass);
        if matches!(
            place,
            Some(Place::Slot(..) | Place::Read(..) | Place::Stream(_))
        ) {
            self.generator.unlisted.truncate(before);
        }
        code
    }

    fn attribute_value(&mut self, attribute: &JSXAttribute<'a>) -> (String, Option<Place>) {
        match &attribute.value {
            None => ("true".to_string(), None),
            Some(JSXAttributeValue::StringLiteral(literal)) => {
                (json!(entities(literal.value.as_str())).to_string(), None)
            }
            Some(JSXAttributeValue::ExpressionContainer(container)) => {
                match container.expression.as_expression() {
                    Some(expression) => {
                        // A function written in place is a handler bound
                        // to what it captures.
                        if let (Some(context), Some(function)) =
                            (self.context, FunctionLike::of(expression))
                        {
                            let binding = self
                                .generator
                                .finished
                                .facts
                                .inline_bindings
                                .get(&(context, function.span().start))
                                .copied();
                            if let Some(binding) = binding {
                                self.inline_handler(binding, function);
                                return (
                                    format!("$h.stream({binding})"),
                                    Some(Place::Stream(binding)),
                                );
                            }
                        }
                        // In a function body, a function written as an
                        // attribute is a handler the body binds
                        // (`BodyCall` of kind `bind`).
                        if self.context.is_none() && FunctionLike::of(expression).is_some() {
                            let code = self.render(expression, Want::Pass);
                            return (format!("$rt.bound({code})"), None);
                        }
                        let place = self.place_of(expression);
                        (self.passed_on(expression, &place), place)
                    }
                    None => ("undefined".to_string(), None),
                }
            }
            Some(JSXAttributeValue::Element(element)) => (
                self.jsx_element(element, false),
                Some(Place::Record(BTreeMap::new())),
            ),
            Some(JSXAttributeValue::Fragment(fragment)) => (
                self.jsx_node("\"cf-fragment\"".to_string(), None, &fragment.children),
                Some(Place::Record(BTreeMap::new())),
            ),
        }
    }

    fn jsx_children(&mut self, children: &[JSXChild<'a>]) -> Vec<String> {
        let mut written: Vec<String> = Vec::new();
        for child in children {
            match child {
                JSXChild::Text(text) => {
                    if let Some(text) = jsx_text(text.value.as_str()) {
                        written.push(json!(text).to_string());
                    }
                }
                JSXChild::Element(element) => written.push(self.jsx_element(element, true)),
                JSXChild::Fragment(fragment) => written.push(self.jsx_node(
                    "\"cf-fragment\"".to_string(),
                    None,
                    &fragment.children,
                )),
                JSXChild::ExpressionContainer(container) => {
                    let Some(expression) = container.expression.as_expression() else {
                        continue;
                    };
                    // In the reactive tier an array literal among the
                    // children is written as its members, one child
                    // each, and any other expression is one child: a
                    // collection is stored as one nested child (ruling
                    // Z31). In a function body the factory flattens the
                    // arrays it is handed, as the JSX factory of today
                    // does.
                    let members = if self.context.is_some() {
                        crate::plan::written_children(expression)
                    } else {
                        vec![expression]
                    };
                    for expression in members {
                        let code = self.render(expression, Want::Pass);
                        // The result of a pattern at a child position is
                        // its tree (PL §1.1).
                        let result = matches!(
                            self.place_of(expression),
                            Some(Place::Record(fields)) if fields.contains_key("$UI")
                        );
                        written.push(if result {
                            format!("$h.at({code}, [\"$UI\"])")
                        } else {
                            code
                        });
                    }
                }
                JSXChild::Spread(spread) => {
                    // In the reactive tier the operand is given as the
                    // reference it is, so that a position of it that
                    // holds a link gives the link.
                    written.push(if self.context.is_some() {
                        let code = self.render(&spread.expression, Want::Pass);
                        format!("$h.spread({code})")
                    } else {
                        let code = self.render(&spread.expression, Want::Use);
                        format!("...{code}")
                    });
                }
            }
        }
        written
    }

    fn jsx_node(
        &mut self,
        name: String,
        props: Option<Vec<String>>,
        children: &[JSXChild<'a>],
    ) -> String {
        let children = self.jsx_children(children);
        let props = match props {
            Some(props) => format!("{{ {} }}", props.join(", ")),
            None => "null".to_string(),
        };
        // `$rt.h` stores each child as written, and `$rt.hf`, for a
        // function body, flattens a child that is an array.
        let factory = if self.context.is_some() {
            "$rt.h"
        } else {
            "$rt.hf"
        };
        format!("{factory}({name}, {props}, [{}])", children.join(", "))
    }
}

impl<'a> Visit<'a> for Rewriter<'_, '_, '_, 'a> {
    fn visit_expression(&mut self, it: &Expression<'a>) {
        match it {
            Expression::JSXElement(_) | Expression::JSXFragment(_) => {
                let code = self.render(it, Want::Use);
                let span = it.span();
                self.edit(span.start, span.end, code);
            }
            _ if self.context.is_some() => {
                let code = self.render(it, Want::Use);
                let span = it.span();
                self.edit(span.start, span.end, code);
            }
            _ => walk::walk_expression(self, it),
        }
    }

    fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
        // `{ a }` is `{ a: a }`: the value is rewritten and the key is
        // not.
        if it.shorthand && self.context.is_some() {
            let code = self.render(&it.value, Want::Pass);
            let key = self.text(it.key.span()).to_string();
            self.edit(it.span.start, it.span.end, format!("{key}: {code}"));
            return;
        }
        walk::walk_object_property(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        // `dataFile(path)` is a constant of the program (BI, "Pure API
        // functions"): the artifact names the file, resolved against the
        // module as an import is, and the code reads it by its index.
        if self
            .generator
            .resolver
            .api_callee(self.module, it)
            .as_deref()
            == Some("dataFile")
        {
            if let Some(Argument::StringLiteral(path)) = it.arguments.first() {
                let file = self
                    .generator
                    .resolver
                    .path_of(self.module, path.value.as_str());
                let index = match self
                    .generator
                    .data_files
                    .iter()
                    .position(|known| *known == file)
                {
                    Some(index) => index,
                    None => {
                        self.generator.data_files.push(file);
                        self.generator.data_files.len() - 1
                    }
                };
                self.edit(it.span.start, it.span.end, format!("$rt.dataFile({index})"));
                return;
            }
        }
        // The function of a pattern is no code of the function tier: the
        // setup function of its context replaces it.
        if self.context.is_none()
            && self
                .generator
                .resolver
                .api_callee(self.module, it)
                .as_deref()
                == Some("pattern")
        {
            // In its place the marker holds the identity of the pattern,
            // so a function body that calls the factory value names the
            // artifact of the callee.
            for argument in &it.arguments {
                if let Some(function) = FunctionLike::of_argument(argument) {
                    let span = function.span();
                    let identity = self
                        .generator
                        .finished
                        .identities
                        .get(&(self.module, span.start))
                        .map_or_else(|| "undefined".to_string(), |id| json!(id).to_string());
                    self.edit(span.start, span.end, identity);
                }
            }
        }
        if self.context.is_some() {
            // The receiver of a method call is rewritten, and the member
            // that names the method is not, so that the call keeps its
            // receiver.
            match unwrap(&it.callee) {
                Expression::StaticMemberExpression(member) => {
                    let code = self.render(&member.object, Want::Use);
                    let span = member.object.span();
                    self.edit(span.start, span.end, code);
                }
                Expression::ComputedMemberExpression(member) => {
                    let code = self.render(&member.object, Want::Use);
                    let span = member.object.span();
                    self.edit(span.start, span.end, code);
                    self.visit_expression(&member.expression);
                }
                Expression::Identifier(_) => {}
                _ => self.visit_expression(&it.callee),
            }
            if let Some(arguments) = &it.type_arguments {
                self.visit_ts_type_parameter_instantiation(arguments);
            }
            for argument in &it.arguments {
                self.visit_argument(argument);
            }
            return;
        }
        walk::walk_call_expression(self, it);
    }

    fn visit_tagged_template_expression(&mut self, it: &TaggedTemplateExpression<'a>) {
        // `str` gives the text of its template.
        let api = match &it.tag {
            Expression::Identifier(_) => {
                self.generator
                    .resolver
                    .parsed(self.module)
                    .and_then(|parsed| {
                        self.generator
                            .resolver
                            .model(self.module)?
                            .api_ref_of_callee(parsed.semantic.scoping(), &it.tag)
                    })
            }
            _ => None,
        };
        if api.is_some_and(|api| api.name == "str") {
            let span = it.tag.span();
            self.edit(span.start, span.end, "");
            self.visit_template_literal(&it.quasi);
            return;
        }
        walk::walk_tagged_template_expression(self, it);
    }

    fn visit_ts_type_annotation(&mut self, it: &TSTypeAnnotation<'a>) {
        self.edit(it.span.start, it.span.end, "");
    }

    fn visit_ts_type_parameter_declaration(&mut self, it: &TSTypeParameterDeclaration<'a>) {
        self.edit(it.span.start, it.span.end, "");
    }

    fn visit_ts_type_parameter_instantiation(&mut self, it: &TSTypeParameterInstantiation<'a>) {
        self.edit(it.span.start, it.span.end, "");
    }

    fn visit_ts_as_expression(&mut self, it: &TSAsExpression<'a>) {
        self.visit_expression(&it.expression);
        self.edit(it.expression.span().end, it.span.end, "");
    }

    fn visit_ts_satisfies_expression(&mut self, it: &TSSatisfiesExpression<'a>) {
        self.visit_expression(&it.expression);
        self.edit(it.expression.span().end, it.span.end, "");
    }

    fn visit_ts_non_null_expression(&mut self, it: &TSNonNullExpression<'a>) {
        self.visit_expression(&it.expression);
        self.edit(it.expression.span().end, it.span.end, "");
    }

    fn visit_formal_parameter(&mut self, it: &FormalParameter<'a>) {
        if it.optional {
            // The `?` of an optional parameter is after its pattern.
            let end = it.pattern.span().end;
            let rest = &self.source()[end as usize..it.span.end as usize];
            if let Some(offset) = rest.find('?') {
                let at = end + offset as u32;
                self.edit(at, at + 1, "");
            }
        }
        walk::walk_formal_parameter(self, it);
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        // A `const` of a block body of the reactive tier: the value its
        // initializer computes, for a cone outside the block that reads
        // it.
        let init = match (self.context, &it.id) {
            (Some(_), BindingPattern::BindingIdentifier(_)) => {
                self.generator.initializer_at(self.module, it.span.start)
            }
            _ => None,
        };
        if let Some(init) = init {
            if let Some((value, written)) = self.value_written_in(init) {
                let local = Local {
                    init: written,
                    module: self.module,
                    context: self.context,
                };
                self.generator.locals.entry(value).or_insert(local);
                if self
                    .generator
                    .finished
                    .output_of
                    .keys()
                    .any(|(of, _)| *of == value)
                {
                    self.register_local(value);
                }
            }
        }
        walk::walk_variable_declarator(self, it);
    }

    fn visit_statement(&mut self, it: &Statement<'a>) {
        match it {
            Statement::TSTypeAliasDeclaration(_)
            | Statement::TSInterfaceDeclaration(_)
            | Statement::TSModuleDeclaration(_)
            | Statement::TSGlobalDeclaration(_) => {
                let span = it.span();
                self.edit(span.start, span.end, "");
            }
            Statement::TSEnumDeclaration(declaration) => {
                self.generator.unsupported(
                    "an enum declaration",
                    self.module,
                    declaration.span.start,
                );
            }
            Statement::FunctionDeclaration(function) if function.body.is_none() => {
                self.edit(function.span.start, function.span.end, "");
            }
            Statement::VariableDeclaration(declaration) if declaration.declare => {
                self.edit(declaration.span.start, declaration.span.end, "");
            }
            _ => walk::walk_statement(self, it),
        }
    }
}

/// The JavaScript of one module's own code of module scope: its imports
/// as reads of other modules, its exports as members of `$exports`, and
/// its declarations with their types removed.
fn module_text(rewriter: &mut Rewriter<'_, '_, '_, '_>, module: usize) -> String {
    let Some(parsed) = rewriter.generator.resolver.parsed(module) else {
        return String::new();
    };
    let program = parsed.program;
    let mut lines: Vec<String> = Vec::new();
    let mut exports: Vec<(String, String)> = Vec::new();
    let name_of = |name: &ModuleExportName<'_>| match name {
        ModuleExportName::IdentifierName(name) => name.name.to_string(),
        ModuleExportName::IdentifierReference(name) => name.name.to_string(),
        ModuleExportName::StringLiteral(name) => name.value.to_string(),
    };
    let target = |rewriter: &Rewriter<'_, '_, '_, '_>, specifier: &str| match rewriter
        .generator
        .resolver
        .module_of(module, specifier)
    {
        Some(other) => format!("$rt.module({other})"),
        None => format!("$rt.external({})", json!(specifier)),
    };
    rewriter.module = module;
    rewriter.context = None;
    rewriter.cone = None;
    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(import) => {
                if import.import_kind.is_type() {
                    continue;
                }
                let from = target(rewriter, import.source.value.as_str());
                let mut named: Vec<String> = Vec::new();
                for specifier in import.specifiers.iter().flatten() {
                    match specifier {
                        ImportDeclarationSpecifier::ImportSpecifier(specifier) => {
                            if specifier.import_kind.is_type() {
                                continue;
                            }
                            named.push(format!(
                                "{}: {}",
                                json!(name_of(&specifier.imported)),
                                specifier.local.name
                            ));
                        }
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                            named.push(format!("default: {}", specifier.local.name));
                        }
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
                            lines.push(format!("const {} = {from};", specifier.local.name));
                        }
                    }
                }
                if !named.is_empty() {
                    lines.push(format!("const {{ {} }} = {from};", named.join(", ")));
                }
            }
            Statement::ExportNamedDeclaration(export) => {
                if export.export_kind.is_type() {
                    continue;
                }
                if let Some(declaration) = &export.declaration {
                    let span = declaration.span();
                    match declaration {
                        Declaration::VariableDeclaration(variable) => {
                            for declarator in &variable.declarations {
                                let mut names = Vec::new();
                                bound_names(&declarator.id, &mut names);
                                exports.extend(names.into_iter().map(|name| (name.clone(), name)));
                            }
                        }
                        Declaration::FunctionDeclaration(function) => {
                            if let Some(id) = &function.id {
                                exports.push((id.name.to_string(), id.name.to_string()));
                            }
                        }
                        Declaration::ClassDeclaration(class) => {
                            if let Some(id) = &class.id {
                                exports.push((id.name.to_string(), id.name.to_string()));
                            }
                        }
                        _ => continue,
                    }
                    let code = rewriter.rewritten(span, |rewriter| {
                        walk::walk_declaration(rewriter, declaration);
                    });
                    lines.push(code);
                    continue;
                }
                match &export.source {
                    Some(source) => {
                        let from = target(rewriter, source.value.as_str());
                        for specifier in &export.specifiers {
                            if specifier.export_kind.is_type() {
                                continue;
                            }
                            lines.push(format!(
                                "Object.defineProperty($exports, {}, {{ enumerable: true, get: () => {from}[{}] }});",
                                json!(name_of(&specifier.exported)),
                                json!(name_of(&specifier.local)),
                            ));
                        }
                    }
                    None => {
                        for specifier in &export.specifiers {
                            if specifier.export_kind.is_type() {
                                continue;
                            }
                            exports.push((name_of(&specifier.exported), name_of(&specifier.local)));
                        }
                    }
                }
            }
            Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                    let code = rewriter.rewritten(function.span, |rewriter| {
                        walk::walk_function(rewriter, function, ScopeFlags::Function);
                    });
                    lines.push(format!("const $default = {code};"));
                    exports.push(("default".to_string(), "$default".to_string()));
                }
                ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                    let code = rewriter.rewritten(class.span, |rewriter| {
                        walk::walk_class(rewriter, class);
                    });
                    lines.push(format!("const $default = {code};"));
                    exports.push(("default".to_string(), "$default".to_string()));
                }
                ExportDefaultDeclarationKind::TSInterfaceDeclaration(_) => {}
                other => {
                    if let Some(expression) = other.as_expression() {
                        let code = rewriter.render(expression, Want::Use);
                        lines.push(format!("const $default = {code};"));
                        exports.push(("default".to_string(), "$default".to_string()));
                    }
                }
            },
            Statement::ExportAllDeclaration(export) => {
                if export.export_kind.is_type() {
                    continue;
                }
                let from = target(rewriter, export.source.value.as_str());
                lines.push(format!("$rt.reexport($exports, {from});"));
            }
            other => {
                let span = other.span();
                let code = rewriter.rewritten(span, |rewriter| {
                    rewriter.visit_statement(other);
                });
                lines.push(code);
            }
        }
    }
    for (exported, local) in exports {
        lines.push(format!(
            "Object.defineProperty($exports, {}, {{ enumerable: true, get: () => {local} }});",
            json!(exported)
        ));
    }
    lines.join("\n")
}

fn bound_names(pattern: &BindingPattern<'_>, names: &mut Vec<String>) {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => names.push(identifier.name.to_string()),
        BindingPattern::ObjectPattern(object) => {
            for property in &object.properties {
                bound_names(&property.value, names);
            }
            if let Some(rest) = &object.rest {
                bound_names(&rest.argument, names);
            }
        }
        BindingPattern::ArrayPattern(array) => {
            for element in array.elements.iter().flatten() {
                bound_names(element, names);
            }
            if let Some(rest) = &array.rest {
                bound_names(&rest.argument, names);
            }
        }
        BindingPattern::AssignmentPattern(assignment) => bound_names(&assignment.left, names),
    }
}

/// The modules a module reaches through its relative imports, itself
/// included.
fn reachable(resolver: &Resolver<'_, '_>, module: usize, found: &mut Vec<usize>) {
    if found.contains(&module) {
        return;
    }
    found.push(module);
    let Some(parsed) = resolver.parsed(module) else {
        return;
    };
    for statement in &parsed.program.body {
        let specifier = match statement {
            Statement::ImportDeclaration(import) if !import.import_kind.is_type() => {
                Some(import.source.value.as_str())
            }
            Statement::ExportNamedDeclaration(export) if !export.export_kind.is_type() => {
                export.source.as_ref().map(|source| source.value.as_str())
            }
            Statement::ExportAllDeclaration(export) => Some(export.source.value.as_str()),
            _ => None,
        };
        if let Some(other) = specifier.and_then(|specifier| resolver.module_of(module, specifier)) {
            reachable(resolver, other, found);
        }
    }
}

/// The value code of a plan, with what the executor needs that the plan
/// does not hold (`SPEC-NOTES.md`, notes 281 on).
pub(crate) fn generate(
    resolver: &Resolver<'_, '_>,
    module: usize,
    plan: &Value,
    schemas: &[(String, Value)],
    finished: &Finished,
) -> Value {
    let mut generator = Generator {
        resolver,
        plan,
        schemas,
        finished,
        registrations: BTreeMap::new(),
        buffers: Vec::new(),
        setups: HashSet::new(),
        functions: HashMap::new(),
        declarators: HashMap::new(),
        unsupported: Vec::new(),
        unlisted: Vec::new(),
        interim: Vec::new(),
        registered_values: Vec::new(),
        registered_elements: Vec::new(),
        registered_states: Vec::new(),
        registered_reduces: Vec::new(),
        registered_children: Vec::new(),
        registered_requests: Vec::new(),
        locals: HashMap::new(),
        data_files: Vec::new(),
        counter: 0,
    };
    let mut rewriter = Rewriter {
        generator: &mut generator,
        module,
        context: None,
        cone: None,
        to_body: false,
        outside_block: false,
        edits: Vec::new(),
    };
    rewriter.generator.setups.insert(0);
    rewriter.setup(0, None);
    // The handler bodies: one function per body, however many bindings
    // name it.
    let mut handlers: Vec<(usize, HandlerFact)> = finished
        .facts
        .handlers
        .iter()
        .map(|(body, fact)| (*body, fact.clone()))
        .collect();
    handlers.sort_by_key(|(body, _)| *body);
    for (body, fact) in handlers {
        let Some(function) = rewriter.generator.function_at(fact.home, fact.start) else {
            rewriter.generator.unsupported(
                "a handler whose function was not found",
                fact.home,
                fact.start,
            );
            continue;
        };
        let source = rewriter.plain_function(fact.home, function);
        let call = if fact.named {
            format!("($e, $s) => ({source})($e, $s)")
        } else {
            format!(
                "($e, $s) => {{ const {{ {} }} = $s; return ({source})($e); }}",
                fact.captures.join(", ")
            )
        };
        rewriter
            .generator
            .register(fact.home, format!("$rt.body({body}, {call});"));
    }
    // The text of each module the plan's code is written in or reads.
    let mut modules: Vec<usize> = Vec::new();
    reachable(resolver, module, &mut modules);
    for other in rewriter
        .generator
        .registrations
        .keys()
        .copied()
        .collect::<Vec<_>>()
    {
        reachable(resolver, other, &mut modules);
    }
    let mut texts: Vec<Value> = Vec::new();
    for other in modules {
        let own = module_text(&mut rewriter, other);
        let registrations = rewriter
            .generator
            .registrations
            .get(&other)
            .cloned()
            .unwrap_or_default();
        let path = resolver
            .parsed(other)
            .map_or("", |parsed| parsed.path.as_str());
        texts.push(json!({
            "module": other,
            "path": path,
            "source": format!("{own}\n{}", registrations.join("\n")),
        }));
    }
    let position = &finished.position;
    let values: Vec<Value> = finished
        .values
        .iter()
        .enumerate()
        .map(|(value, (cone, collection, scan))| {
            let mut entry = serde_json::Map::new();
            entry.insert("cone".to_string(), json!(position[*cone]));
            if let Some(output) = finished.output_of.get(&(value, Vec::new())) {
                entry.insert("output".to_string(), json!(output));
            }
            if let Some(collection) = collection {
                entry.insert("collection".to_string(), json!(collection));
            }
            if *scan {
                entry.insert("scan".to_string(), json!(true));
            }
            if generator.registered_values.contains(&value) {
                entry.insert("function".to_string(), json!(true));
            }
            Value::Object(entry)
        })
        .collect();
    let handlers: BTreeMap<String, Value> = finished
        .facts
        .handlers
        .iter()
        .map(|(body, fact)| {
            (
                body.to_string(),
                json!({ "named": fact.named, "captures": fact.captures }),
            )
        })
        .collect();
    let unsupported: Vec<Value> = generator
        .unsupported
        .iter()
        .map(|(kind, module, at)| {
            let path = resolver
                .parsed(*module)
                .map_or("", |parsed| parsed.path.as_str());
            json!({ "kind": kind, "file": path, "start": at })
        })
        .collect();
    // An interim output at a path below a value: the value, and the path.
    let mut below: Vec<Value> = finished
        .output_of
        .iter()
        .filter(|((_, path), _)| !path.is_empty())
        .map(|((value, path), output)| json!({ "output": output, "value": value, "path": path }))
        .collect();
    below.sort_by_key(|entry| entry["output"].as_u64());
    let data_files: Vec<Value> = generator
        .data_files
        .iter()
        .map(|file| json!({ "file": file }))
        .collect();
    json!({
        "modules": texts,
        "main": module,
        "values": values,
        "outputsBelow": below,
        "handlers": handlers,
        "elements": generator.registered_elements,
        "states": generator.registered_states,
        "reduces": generator.registered_reduces,
        "dataFiles": data_files,
        "unlistedReads": generator.unlisted,
        "valuesWithoutOutput": generator.interim,
        "unsupported": unsupported,
    })
}
