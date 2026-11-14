//! Plan emission, first slice (`plan-and-label-templates.md`, cited as PL):
//! the data plan of each pattern of a module, as JSON.
//!
//! The emitter walks the reactive tier of a pattern body and fills in the
//! records of PL §1.1 as far as they are determined without label
//! templates: slots, state cells, collections, the bodies with their
//! footprint for each use, bindings, operations, cones, outputs, and the
//! edges between cones. A member that holds a `Template`, a `Hash`, or a
//! `Constraint` is left out, and `SPEC-NOTES.md` lists the readings this
//! module chose.
//!
//! A construct the emitter does not translate is listed in
//! [`PatternPlan::unsupported`] by kind, and the plan is emitted without
//! it.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use oxc_ast::ast::*;
use oxc_ast::AstKind;
use oxc_span::GetSpan;
use serde_json::{json, Map, Value};

use crate::footprint::{
    bind_use, body_functions, parameter_names, BindRec, Class, HandleAt, Record, RefName, Seg,
    UseRecord, WriteRec, WriteTarget,
};
use crate::module::{symbol_of, Binding, DefKind};
use crate::program::Resolver;
use crate::syntax::{static_key_name, unwrap, FunctionLike};
use crate::tiers::{Body, BodyKind};
use crate::types::{Shape, TypeId};
use oxc_syntax::symbol::SymbolId;

/// The plan of one pattern.
#[derive(Debug, Clone)]
pub struct PatternPlan {
    /// The name the pattern is defined under, when it has one.
    pub name: Option<String>,
    pub line: u32,
    /// The `Plan` record of PL §1.1.
    pub plan: Value,
    /// The constructs the emitter did not translate: the kind, and the
    /// offset of the construct in the module's text.
    pub unsupported: Vec<(String, u32)>,
    /// The static side-writes that are on a cycle of `Plan.edges`: the
    /// offset of the side-write, and the names of the cones on the cycle.
    pub cycles: Vec<(u32, Vec<String>)>,
}

/// Where the data of a slot lives (`SlotRoot`).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum Root {
    Argument,
    State(usize),
    Event(usize),
    Element(usize),
    Operation(usize),
    Binding(usize),
    Cause,
}

/// What a name or an expression of the reactive tier denotes.
#[derive(Debug, Clone)]
enum Place {
    /// A path of an input.
    Slot(Root, Vec<String>),
    /// A path of a value the instance computed.
    Value(usize, Vec<String>),
    /// A record written in the reactive tier.
    Record(BTreeMap<String, Place>),
    /// The stream of a binding.
    Stream(usize),
    /// The index of the element of a collection.
    Index(usize),
    /// A literal, a constant of the module, or a definition.
    Const,
    /// Something the emitter does not follow.
    Unknown,
}

/// A value the instance computed.
struct Computed {
    name: String,
    cone: usize,
    /// The result paths the value is kept at.
    kept: Vec<Vec<String>>,
    /// The collection the value is the assembled result of.
    collection: Option<usize>,
    /// The value is the result of a scan of the collection (PL §3.13),
    /// and not an array of its elements.
    scan: bool,
    /// Whether a record of the plan refers to the value.
    referred: bool,
    /// The label of the value in symbolic form (PL §1.1, `Template`),
    /// where this slice builds it: for expression code of an operator, and
    /// for a use of a body.
    template: Option<Value>,
    /// For the assembled result of a `map`, a `filter`, or a `flatMap`:
    /// the template of one element of it, where it has one. The plan has
    /// a per-element output beside the assembled one (PL §1.4).
    element: Option<Option<Value>>,
    /// The paths below the value that a collection has as its source: each
    /// is an interim output of its own (PL §1.1, `Output.path`).
    below: Vec<Vec<String>>,
    order: usize,
}

struct ConeOut {
    entry: String,
    at: u32,
    slots: BTreeSet<usize>,
    bodies: Vec<usize>,
    writes: Vec<Value>,
    selectors: Vec<usize>,
    picks: Vec<usize>,
    /// The values of other cones the cone uses.
    uses: BTreeSet<usize>,
    /// For a `value` slot a body of the cone reads: the type the body
    /// declares at the slot's position, where the emitter has it. It
    /// stands for `Slot.schema` in the rule for which slots read a
    /// `handle` target (PL §3.11).
    views: BTreeMap<usize, Vec<Option<TypeId>>>,
}

type SlotKey = (Root, Vec<String>, &'static str, bool, bool);

/// A static target of a side-write: the slot of the handle, its root and
/// path, the path below the cell, `resolved`, the module and the offset
/// of the write, and whether the body reads its own target there.
struct Target {
    slot: usize,
    root: Root,
    at: Vec<String>,
    below: Vec<String>,
    resolved: bool,
    site: Option<(usize, u32)>,
    reads_own: bool,
}
type Names = HashMap<(String, Vec<Seg>, bool), Value>;

struct Emitter<'r, 'm, 'a> {
    resolver: &'r Resolver<'m, 'a>,
    module: usize,
    bodies: &'r [Vec<Body>],
    records: &'r [Vec<(usize, Record)>],
    functions: HashMap<usize, HashMap<u32, FunctionLike<'a, 'a>>>,
    body_starts: HashMap<usize, HashMap<u32, usize>>,
    env: HashMap<String, Place>,
    within: Vec<Value>,
    cone: Option<usize>,
    slots: Vec<SlotKey>,
    values: Vec<Computed>,
    cones: Vec<ConeOut>,
    /// The number of selection points and of choice points of the plan.
    selectors: Vec<u32>,
    picks: Vec<&'static str>,
    collections: Vec<Value>,
    plan_bodies: Vec<Value>,
    body_facts: Vec<BodyFact>,
    dynamic_reads: Vec<Value>,
    state_cells: Vec<Value>,
    operations: Vec<Value>,
    children: Vec<Value>,
    bindings: Vec<Value>,
    /// The plan body of each handler, by the module and the start of its
    /// function.
    handlers: HashMap<(usize, u32), usize>,
    /// The result paths that hold an input passed through.
    passed: Vec<Vec<String>>,
    unsupported: Vec<(String, u32)>,
    /// The templates of what the expression code being evaluated
    /// observed, and whether it observed something with no template.
    operands: Vec<Value>,
    opaque: bool,
    /// The entries of `Plan.dynamicReads` of each body of the plan.
    body_dynamic: Vec<Vec<usize>>,
    /// The declared type of each formal input of the body whose record
    /// is being written.
    formal_types: HashMap<String, TypeId>,
    /// For each collection, the membership of what it iterates.
    iterated: Vec<Option<Value>>,
}

/// What the edges of the plan need of a body.
#[derive(Default)]
struct BodyFact {
    /// Whether the body is a computation whose side-writes are all static.
    side_writes: bool,
    at: u32,
    targets: Vec<Target>,
}

fn root_json(root: &Root) -> Value {
    match root {
        Root::Argument => json!({ "kind": "argument" }),
        Root::State(cell) => json!({ "kind": "state", "cell": cell }),
        Root::Event(handler) => json!({ "kind": "event", "handler": handler }),
        Root::Element(collection) => json!({ "kind": "element", "collection": collection }),
        Root::Operation(operation) => json!({ "kind": "operation", "operation": operation }),
        Root::Binding(handler) => json!({ "kind": "binding", "handler": handler }),
        Root::Cause => json!({ "kind": "cause" }),
    }
}

/// The path of a slot: the keys and `*`, across the links (PL §2.5).
fn slot_path(base: &[String], path: &[Seg]) -> Vec<String> {
    let mut out = base.to_vec();
    for segment in path {
        match segment {
            Seg::Key(key) => out.push(key.clone()),
            Seg::Star => out.push("*".to_string()),
            Seg::Hop => {}
        }
    }
    out
}

fn class_name(class: Class) -> &'static str {
    match class {
        Class::Enumeration => "enumeration",
        Class::Identity | Class::Resolved => "identity",
        Class::LabelMetadata => "labelMetadata",
        Class::Shape => "shape",
        Class::Value => "value",
    }
}

/// The methods of a string, a number, or an array that compute a value
/// from the receiver and the arguments.
const SCALAR_METHODS: [&str; 24] = [
    "trim",
    "toFixed",
    "join",
    "includes",
    "slice",
    "toUpperCase",
    "toLowerCase",
    "startsWith",
    "endsWith",
    "toString",
    "padStart",
    "padEnd",
    "split",
    "replace",
    "replaceAll",
    "indexOf",
    "at",
    "concat",
    "toLocaleString",
    "toLocaleDateString",
    "toLocaleTimeString",
    "toISOString",
    "substring",
    "charAt",
];

/// The deepest nesting of patterns compiled into a plan.
const MAX_SITES: usize = 8;

const EFFECTS: [&str; 12] = [
    "fetchBinary",
    "fetchText",
    "fetchJson",
    "fetchJsonUnchecked",
    "fetchProgram",
    "generateText",
    "generateObject",
    "llmDialog",
    "agent",
    "sqliteQuery",
    "navigateTo",
    "compileAndRun",
];

fn name_of(names: &Names, input: &str, path: &[Seg], resolved: bool) -> Option<Value> {
    names
        .get(&(input.to_string(), path.to_vec(), resolved))
        .or_else(|| names.get(&(input.to_string(), path.to_vec(), !resolved)))
        .cloned()
}

/// `passes` or `oneOf` over the names of the entries a reference is.
fn reference_json(names: &Names, passes: bool, listed: &[RefName]) -> Option<Value> {
    let found: Vec<Value> = listed
        .iter()
        .filter_map(|name| name_of(names, &name.input, &name.path, name.resolved))
        .collect();
    if found.len() != listed.len() {
        return None;
    }
    Some(if passes && found.len() == 1 {
        json!({ "passes": found[0] })
    } else {
        json!({ "oneOf": found })
    })
}

impl<'a> Emitter<'_, '_, 'a> {
    fn unsupported(&mut self, kind: impl Into<String>, at: u32) {
        self.unsupported.push((kind.into(), at));
    }

    // ----- tables -----

    fn slot(&mut self, root: &Root, path: &[String], class: &'static str) -> usize {
        self.slot_with(root, path, class, false, false)
    }

    fn slot_with(
        &mut self,
        root: &Root,
        path: &[String],
        class: &'static str,
        resolved: bool,
        in_place: bool,
    ) -> usize {
        let key = (root.clone(), path.to_vec(), class, resolved, in_place);
        match self.slots.iter().position(|other| *other == key) {
            Some(index) => index,
            None => {
                self.slots.push(key);
                self.slots.len() - 1
            }
        }
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

    /// The index of the body whose function starts at `start`.
    fn body_at(&mut self, module: usize, start: u32) -> Option<usize> {
        if !self.body_starts.contains_key(&module) {
            let mut found = HashMap::new();
            for (index, at) in body_functions(self.resolver, module, &self.bodies[module]) {
                found.entry(at).or_insert(index);
            }
            self.body_starts.insert(module, found);
        }
        self.body_starts.get(&module)?.get(&start).copied()
    }

    fn record_at(&mut self, module: usize, start: u32) -> Option<(BodyKind, Record)> {
        let index = self.body_at(module, start)?;
        let kind = self.bodies[module][index].kind;
        let record = self.records[module]
            .iter()
            .find(|(other, _)| *other == index)
            .map(|(_, record)| record.clone())?;
        Some((kind, record))
    }

    /// The function a module-scope name is defined as, an import followed:
    /// the module, the start of the function, and the kind of definition.
    fn def_function(
        &mut self,
        identifier: &IdentifierReference<'a>,
    ) -> Option<(usize, u32, DefKind)> {
        let kind = self.resolver.value_def(self.module, identifier)?;
        let parsed = self.resolver.parsed(self.module)?;
        let symbol = symbol_of(parsed.semantic.scoping(), identifier)?;
        if let Some(found) = self.default_export(symbol) {
            return Some((found.0, found.1, kind));
        }
        let (home, symbol) = self.resolver.origin(self.module, symbol)?;
        let parsed = self.resolver.parsed(home)?;
        let declaration = parsed.semantic.scoping().symbol_declaration(symbol);
        let start = match parsed.semantic.nodes().kind(declaration) {
            AstKind::Function(function) => function.span.start,
            AstKind::VariableDeclarator(declarator) => {
                let init = unwrap(declarator.init.as_ref()?);
                match FunctionLike::of(init) {
                    Some(function) => function.span().start,
                    None => {
                        let Expression::CallExpression(call) = init else {
                            return None;
                        };
                        call.arguments
                            .iter()
                            .rev()
                            .find_map(FunctionLike::of_argument)?
                            .span()
                            .start
                    }
                }
            }
            _ => return None,
        };
        Some((home, start, kind))
    }

    /// The function of a definition that is `export default <call>`, which
    /// has no name in its module: the module and the start of the last
    /// function written as an argument of the call.
    fn default_export(&mut self, symbol: SymbolId) -> Option<(usize, u32)> {
        let model = self.resolver.model(self.module)?;
        let Binding::Import(import, binding) = model.binding(symbol)? else {
            return None;
        };
        let import = &model.imports[import];
        let def = self.resolver.resolve_import(
            self.module,
            import,
            &import.bindings[binding].imported,
        )?;
        let found = self.resolver.model(def.module)?.defs.get(def.def)?;
        if found.symbol.is_some() {
            return None;
        }
        let (from, to) = found.span;
        let parsed = self.resolver.parsed(def.module)?;
        // The outermost call of the exported expression.
        let call = parsed
            .semantic
            .nodes()
            .iter()
            .filter_map(|node| match node.kind() {
                AstKind::CallExpression(call) if from <= call.span.start && call.span.end <= to => {
                    Some(call)
                }
                _ => None,
            })
            .max_by_key(|call| call.span.end - call.span.start)?;
        let function = call
            .arguments
            .iter()
            .rev()
            .find_map(FunctionLike::of_argument)?;
        Some((def.module, function.span().start))
    }

    /// An entry of `Plan.dynamicReads`: one entry for one set of reads.
    fn dynamic(&mut self, read: Value) -> usize {
        match self.dynamic_reads.iter().position(|other| *other == read) {
            Some(index) => index,
            None => {
                self.dynamic_reads.push(read);
                self.dynamic_reads.len() - 1
            }
        }
    }

    // ----- types -----

    /// The type one segment below a type: a property, or for `*` an
    /// element of an array or a child of a record.
    fn type_below(&self, ty: TypeId, segment: &str) -> Option<TypeId> {
        let ty = self.resolver.present(ty);
        if segment == "*" {
            return match self.resolver.shape(ty) {
                Shape::Object(_, index) => index,
                _ => self.resolver.element_of(ty),
            };
        }
        self.resolver
            .with_optional_reads_declared(|| self.resolver.property(ty, segment))
    }

    /// The type at a path of a formal input.
    fn entry_type(&self, ty: TypeId, path: &[Seg]) -> Option<TypeId> {
        let mut ty = ty;
        for segment in path {
            ty = match segment {
                Seg::Key(key) => self.type_below(ty, key)?,
                Seg::Star => self.type_below(ty, "*")?,
                Seg::Hop => match self.resolver.shape(self.resolver.present(ty)) {
                    Shape::Handle(_, value) => value,
                    _ => return None,
                },
            };
        }
        Some(ty)
    }

    /// Whether a `value` read under type `view` continues through the
    /// link stored at the position `rest` below it: `Some(false)` where
    /// the type has a handle type or a reference type on the way or
    /// there, and `None` where the emitter cannot tell (PL §3.11).
    fn reaches_cell(&self, view: TypeId, rest: &[String]) -> Option<bool> {
        let mut ty = self.resolver.present(view);
        // The slot's own position: a `value` slot resolves through a link
        // at its last segment (PL §2.5).
        if let Shape::Handle(_, value) = self.resolver.shape(ty) {
            ty = value;
        }
        for segment in rest {
            ty = self.resolver.present(self.type_below(ty, segment)?);
            match self.resolver.shape(ty) {
                Shape::Handle(..) | Shape::Unknown => return Some(false),
                Shape::Unresolved(_) | Shape::Parameter(_) => return None,
                _ => {}
            }
        }
        Some(true)
    }

    // ----- cones and values -----

    /// The cone the expression being evaluated belongs to, made where
    /// there is none.
    fn computing(&mut self, name: &str, at: u32) -> (usize, bool) {
        match self.cone {
            Some(cone) => (cone, false),
            None => {
                self.cones.push(ConeOut {
                    entry: written_at(name).to_string(),
                    at,
                    slots: BTreeSet::new(),
                    bodies: Vec::new(),
                    writes: Vec::new(),
                    selectors: Vec::new(),
                    picks: Vec::new(),
                    uses: BTreeSet::new(),
                    views: BTreeMap::new(),
                });
                let cone = self.cones.len() - 1;
                self.cone = Some(cone);
                (cone, true)
            }
        }
    }

    fn value(&mut self, name: &str, cone: usize) -> usize {
        let order = self.values.len();
        self.values.push(Computed {
            name: written_at(name).to_string(),
            cone,
            kept: Vec::new(),
            collection: None,
            scan: false,
            template: None,
            element: None,
            below: Vec::new(),
            referred: false,
            order,
        });
        order
    }

    /// A selection point of the cone being evaluated: the selector of a
    /// `select` with `arity` branches (PL §3.5).
    fn selector(&mut self, arity: u32) -> usize {
        let selector = self.selectors.len();
        if let Some(cone) = self.cone {
            self.cones[cone].selectors.push(selector);
        }
        self.selectors.push(arity);
        selector
    }

    /// Evaluates expression code that computes one value, which has the
    /// template `evaluate` returns.
    fn build(
        &mut self,
        hint: &str,
        at: u32,
        evaluate: impl FnOnce(&mut Self, usize) -> Option<Value>,
    ) -> Place {
        let saved = (
            std::mem::take(&mut self.operands),
            std::mem::replace(&mut self.opaque, false),
        );
        let mut template = None;
        let place = self.in_cone(hint, at, |emitter, cone| {
            template = evaluate(emitter, cone);
        });
        self.operands = saved.0;
        self.opaque = saved.1;
        if let Place::Value(value, _) = &place {
            self.values[*value].template = template;
        }
        place
    }

    /// The template of one operand of a `select` or a `pick`, with what
    /// `evaluate` observed while it evaluated the operand: the template
    /// of the place, and where the evaluation made a further observation,
    /// as `a?.b` observes whether `a` is present, their join.
    fn one(
        &mut self,
        class: &'static str,
        evaluate: impl FnOnce(&mut Self) -> Place,
    ) -> (Place, Option<Value>) {
        let saved = (
            std::mem::take(&mut self.operands),
            std::mem::replace(&mut self.opaque, false),
        );
        let place = evaluate(self);
        self.observe(&place, class);
        let mut inputs: Vec<Value> = Vec::new();
        for input in std::mem::replace(&mut self.operands, saved.0) {
            if !inputs.contains(&input) {
                inputs.push(input);
            }
        }
        let opaque = std::mem::replace(&mut self.opaque, saved.1);
        let template = if opaque {
            None
        } else if let Place::Record(_) = &place {
            // A record written in place has a template per path (PL
            // §3.4), and one only where every member is a constant.
            inputs
                .iter()
                .all(|input| input["op"] == "const")
                .then(|| json!({ "op": "const" }))
        } else if inputs.len() == 1 {
            inputs.pop()
        } else {
            Some(join(inputs))
        };
        (place, template)
    }

    /// The class a test of truthiness needs (PL §3.5): "`value` at the
    /// root for a scalar condition, `shape` at the root for a record or
    /// array, whose truthiness is its existence".
    fn test_class(&self, expression: &Expression<'a>) -> &'static str {
        let Ok(ty) = self.resolver.typed_at(self.module, expression, 0) else {
            return "value";
        };
        let ty = self.resolver.present(ty);
        match self.resolver.shape(ty) {
            Shape::Object(..)
            | Shape::Array(_)
            | Shape::Tuple(_)
            | Shape::NonPrimitive
            | Shape::Handle(..)
            | Shape::Unknown
            | Shape::Opaque(_)
            | Shape::Code(_) => "shape",
            _ => "value",
        }
    }

    /// A `select` over the condition `test` and two branches (PL §3.5).
    /// `first` and `second` say what each branch is: an expression, or
    /// the condition itself.
    fn select(
        &mut self,
        hint: &str,
        at: u32,
        test: &Expression<'a>,
        class: Option<&'static str>,
        branches: [Option<&Expression<'a>>; 2],
    ) -> Place {
        self.build(hint, at, |emitter, _| {
            let selector = emitter.selector(2);
            let class = class.unwrap_or_else(|| emitter.test_class(test));
            let (tested, condition) = emitter.one(class, |emitter| emitter.eval(test, "condition"));
            let mut templates = Vec::new();
            for branch in branches {
                let template = match branch {
                    Some(branch) => {
                        emitter
                            .one("identity", |emitter| emitter.eval(branch, "branch"))
                            .1
                    }
                    // "When the selected arm of `&&` or `||` is the
                    // condition, the result carries that operand's full
                    // template, not only its truthiness."
                    None => emitter.one("identity", |_| tested.clone()).1,
                };
                templates.push(template);
            }
            select_node(selector, condition, templates)
        })
    }

    /// A dynamic key in the reactive tier: a `pick` whose choice the value
    /// code reports (PL §3.18).
    fn pick(&mut self, object: &Place, key: &Place, hint: &str, at: u32) -> Place {
        let object = object.clone();
        let key = key.clone();
        if let Place::Record(fields) = &object {
            // "When `a` is a constructed object with a static key set,
            // the compiler emits a `select` over its keys in place of a
            // `pick`, and each branch is the template of that member."
            // The last branch is the one for a key that names no member.
            let fields = fields.clone();
            return self.build(hint, at, |emitter, _| {
                let selector = emitter.selector(fields.len() as u32 + 1);
                let condition = emitter.one("value", |_| key).1;
                let mut branches: Vec<Option<Value>> = Vec::new();
                for member in fields.values() {
                    branches.push(emitter.one("identity", |_| member.clone()).1);
                }
                branches.push(Some(json!({ "op": "const" })));
                select_node(selector, condition, branches)
            });
        }
        self.build(hint, at, |emitter, cone| {
            let pick = emitter.picks.len();
            emitter.cones[cone].picks.push(pick);
            emitter.picks.push("valueCode");
            let choice = emitter.one("value", |_| key).1;
            match &object {
                Place::Slot(root, path) => {
                    // The chosen child is one of the container's: its
                    // `shape` slot, which `choice` joins, and the slot of
                    // what is read of it.
                    let mut child = path.clone();
                    child.push("*".to_string());
                    let shape = emitter.slot(root, &child, "shape");
                    let value = emitter.slot(root, &child, "value");
                    emitter.cones[cone].slots.insert(shape);
                    emitter.cones[cone].slots.insert(value);
                    let choice = join(vec![choice?, json!({ "op": "slot", "slot": shape })]);
                    Some(json!({
                        "op": "pick",
                        "pick": pick,
                        "from": { "container": shape },
                        "choice": choice,
                        "body": { "op": "slot", "slot": value },
                    }))
                }
                Place::Value(value, path) => {
                    // A container the instance computed: `from` names its
                    // output, and `body` is the template of the chosen
                    // child, which for one opaque call is the call's.
                    emitter.values[*value].referred = true;
                    if emitter.values[*value].cone != cone {
                        emitter.cones[cone].uses.insert(*value);
                    }
                    let output = if path.is_empty() {
                        json!({ "$value": value })
                    } else {
                        if !emitter.values[*value].below.contains(path) {
                            emitter.values[*value].below.push(path.clone());
                        }
                        json!({ "$value": value, "$path": path })
                    };
                    let body = emitter.values[*value].template.clone()?;
                    Some(json!({
                        "op": "pick",
                        "pick": pick,
                        "from": { "output": output },
                        "choice": choice?,
                        "body": body,
                    }))
                }
                other => {
                    emitter.pass(other);
                    None
                }
            }
        })
    }

    /// The cone being evaluated reads a place in full.
    fn consume(&mut self, place: &Place) {
        self.observe(place, "value");
    }

    /// The cone being evaluated passes a place on by reference.
    fn pass(&mut self, place: &Place) {
        self.observe(place, "identity");
    }

    /// The cone being evaluated observes a reference after resolution: the
    /// `identity` slot, resolved (PL §2.5).
    fn resolve(&mut self, place: &Place) {
        match place {
            Place::Slot(root, path) => {
                let slot = self.slot_with(root, path, "identity", true, false);
                if let Some(cone) = self.cone {
                    self.cones[cone].slots.insert(slot);
                }
                self.operands.push(json!({ "op": "slot", "slot": slot }));
            }
            Place::Record(fields) => {
                for member in fields.values() {
                    self.resolve(member);
                }
            }
            other => self.pass(other),
        }
    }

    /// Whether the checker types an expression as a string.
    fn is_string(&self, expression: &Expression<'a>) -> bool {
        self.resolver
            .typed_at(self.module, expression, 0)
            .is_ok_and(|ty| {
                matches!(
                    self.resolver.shape(ty),
                    crate::types::Shape::String | crate::types::Shape::Literal(_)
                )
            })
    }

    /// An operand of the expression code being evaluated: its template,
    /// or that it has none.
    fn operand(&mut self, template: Option<Value>) {
        match template {
            Some(template) => self.operands.push(template),
            None => self.opaque = true,
        }
    }

    /// Expression code of an operator: a `derive` over the templates of
    /// what it observes (PL §1.1, §3.19).
    fn derived(&mut self, hint: &str, at: u32, evaluate: impl FnOnce(&mut Self, usize)) -> Place {
        self.build(hint, at, |emitter, cone| {
            evaluate(emitter, cone);
            (!emitter.opaque).then(|| join(std::mem::take(&mut emitter.operands)))
        })
    }

    /// The template of a place that is one value: a slot passed through,
    /// a value the instance computed, or a constant.
    fn template_of(&mut self, place: &Place, class: &'static str) -> Option<Value> {
        match place {
            Place::Slot(root, path) => {
                let slot = self.slot(root, path, class);
                Some(json!({ "op": "slot", "slot": slot }))
            }
            // Every path of what one opaque call or one expression
            // computed has its template (PL §3.3).
            Place::Value(value, _) => self.values[*value].template.clone(),
            // The stream of a binding of the reactive tier is named by
            // constants of the plan (PL §3.14).
            Place::Const | Place::Stream(_) => Some(json!({ "op": "const" })),
            // "A body that uses the index adds the collection's
            // `enumeration` to its element template" (PL §3.6): the
            // membership of what the construct iterates.
            Place::Index(collection) => self.iterated.get(*collection).cloned().flatten(),
            _ => None,
        }
    }

    fn observe(&mut self, place: &Place, class: &'static str) {
        if !matches!(place, Place::Record(_)) {
            let template = self.template_of(place, class);
            self.operand(template);
        }
        match place {
            Place::Slot(root, path) => {
                let slot = self.slot(root, path, class);
                if let Some(cone) = self.cone {
                    self.cones[cone].slots.insert(slot);
                }
            }
            Place::Value(value, _) => {
                if let Some(cone) = self.cone {
                    if self.values[*value].cone != cone {
                        self.cones[cone].uses.insert(*value);
                        self.values[*value].referred = true;
                    }
                }
            }
            Place::Record(fields) => {
                for member in fields.values() {
                    self.observe(member, class);
                }
            }
            Place::Stream(_) | Place::Index(_) | Place::Const | Place::Unknown => {}
        }
    }

    fn extend(place: &Place, key: &str) -> Place {
        match place {
            Place::Slot(root, path) => {
                let mut path = path.clone();
                path.push(key.to_string());
                Place::Slot(root.clone(), path)
            }
            Place::Value(value, path) => {
                let mut path = path.clone();
                path.push(key.to_string());
                Place::Value(*value, path)
            }
            Place::Record(fields) => fields.get(key).cloned().unwrap_or(Place::Const),
            Place::Const => Place::Const,
            _ => Place::Unknown,
        }
    }

    // ----- the reactive tier -----

    fn bind_pattern(&mut self, pattern: &BindingPattern<'a>, place: Place) {
        match pattern {
            BindingPattern::BindingIdentifier(identifier) => {
                self.env.insert(identifier.name.to_string(), place);
            }
            BindingPattern::ObjectPattern(object) => {
                for property in &object.properties {
                    match static_key_name(&property.key).filter(|_| !property.computed) {
                        Some(name) => {
                            let member = Self::extend(&place, name);
                            self.bind_pattern(&property.value, member);
                        }
                        None => self.bind_pattern(&property.value, Place::Unknown),
                    }
                }
                if let Some(rest) = &object.rest {
                    self.unsupported("a rest element in the reactive tier", rest.span.start);
                    self.bind_pattern(&rest.argument, Place::Unknown);
                }
            }
            BindingPattern::ArrayPattern(array) => {
                for (index, element) in array.elements.iter().enumerate() {
                    if let Some(element) = element {
                        let member = Self::extend(&place, &index.to_string());
                        self.bind_pattern(element, member);
                    }
                }
            }
            BindingPattern::AssignmentPattern(assignment) => {
                self.bind_pattern(&assignment.left, place);
            }
        }
    }

    fn statements(&mut self, statements: &[Statement<'a>]) -> Option<Place> {
        for statement in statements {
            match statement {
                Statement::VariableDeclaration(declaration) => {
                    for declarator in &declaration.declarations {
                        let hint = match &declarator.id {
                            BindingPattern::BindingIdentifier(identifier) => {
                                identifier.name.to_string()
                            }
                            _ => "value".to_string(),
                        };
                        let place = match &declarator.init {
                            Some(init) => self.eval(init, &hint),
                            None => Place::Const,
                        };
                        self.bind_pattern(&declarator.id, place);
                    }
                }
                Statement::ExpressionStatement(statement) => {
                    self.eval(&statement.expression, "statement");
                }
                Statement::ReturnStatement(statement) => {
                    return statement
                        .argument
                        .as_ref()
                        .map(|argument| self.eval(argument, "result"));
                }
                Statement::FunctionDeclaration(_)
                | Statement::TSTypeAliasDeclaration(_)
                | Statement::TSInterfaceDeclaration(_)
                | Statement::EmptyStatement(_) => {}
                other => {
                    self.unsupported("a statement in the reactive tier", other.span().start);
                }
            }
        }
        None
    }

    /// The statements of expression code: a promoted `computed` with a
    /// statement body (`language-subset.md` §6.1). The result is the
    /// template of what the statements return: `Err` where they do not
    /// return on every path, and `Ok(None)` where the value returned has
    /// no template. An `if` is a `select` over what its two paths return
    /// (PL §3.5).
    fn code_block(&mut self, statements: &[Statement<'a>]) -> Result<Option<Value>, ()> {
        for (index, statement) in statements.iter().enumerate() {
            match statement {
                Statement::VariableDeclaration(declaration) => {
                    for declarator in &declaration.declarations {
                        let place = match &declarator.init {
                            Some(init) => self.eval(init, "value"),
                            None => Place::Const,
                        };
                        self.bind_pattern(&declarator.id, place);
                    }
                }
                Statement::IfStatement(statement) => {
                    let selector = self.selector(2);
                    let class = self.test_class(&statement.test);
                    let (_, condition) =
                        self.one(class, |emitter| emitter.eval(&statement.test, "condition"));
                    let saved = self.env.clone();
                    let consequent = self.code_block(std::slice::from_ref(&statement.consequent));
                    self.env = saved.clone();
                    let alternate = match &statement.alternate {
                        Some(alternate) => self.code_block(std::slice::from_ref(alternate)),
                        None => Err(()),
                    };
                    self.env = saved;
                    if let (Ok(first), Ok(second)) = (&consequent, &alternate) {
                        return Ok(select_node(
                            selector,
                            condition,
                            vec![first.clone(), second.clone()],
                        ));
                    }
                    // A path that does not return goes on with the
                    // statements after the `if`.
                    let rest = self.code_block(&statements[index + 1..]);
                    let branch = |path: Result<Option<Value>, ()>| match path {
                        Ok(template) => Ok(template),
                        Err(()) => rest.clone(),
                    };
                    return match (branch(consequent), branch(alternate)) {
                        (Ok(first), Ok(second)) => {
                            Ok(select_node(selector, condition, vec![first, second]))
                        }
                        // A path that returns nothing returns `undefined`.
                        (Ok(first), Err(())) => Ok(select_node(
                            selector,
                            condition,
                            vec![first, Some(json!({ "op": "const" }))],
                        )),
                        (Err(()), Ok(second)) => Ok(select_node(
                            selector,
                            condition,
                            vec![Some(json!({ "op": "const" })), second],
                        )),
                        (Err(()), Err(())) => Err(()),
                    };
                }
                Statement::BlockStatement(block) => {
                    let saved = self.env.clone();
                    let returned = self.code_block(&block.body);
                    self.env = saved;
                    if returned.is_ok() {
                        return returned;
                    }
                }
                Statement::ReturnStatement(statement) => {
                    return Ok(match &statement.argument {
                        Some(argument) => {
                            self.one("identity", |emitter| emitter.eval(argument, "branch"))
                                .1
                        }
                        None => Some(json!({ "op": "const" })),
                    });
                }
                Statement::EmptyStatement(_) => {}
                other => {
                    self.unsupported("a statement of expression code", other.span().start);
                }
            }
        }
        Err(())
    }

    /// A call, in the reactive tier, of a pattern the compiler can see:
    /// the pattern is compiled into this plan, under a `site` step (PL
    /// §1.1, §1.3).
    fn inline_pattern(
        &mut self,
        home: usize,
        start: u32,
        name: &str,
        arguments: &[&Expression<'a>],
        at: u32,
    ) -> Place {
        let argument = match arguments.first() {
            Some(argument) => self.eval(argument, name),
            None => Place::Const,
        };
        let sites = self
            .within
            .iter()
            .filter(|step| step.get("site").is_some())
            .count();
        let Some(function) = self.function_at(home, start).filter(|_| sites < MAX_SITES) else {
            self.unsupported("a call of a pattern nested too deep to compile in", at);
            return Place::Unknown;
        };
        let saved_env = std::mem::take(&mut self.env);
        let saved_module = std::mem::replace(&mut self.module, home);
        self.within.push(json!({ "site": name }));
        if let Some(parameter) = function.params().items.first() {
            self.bind_pattern(&parameter.pattern, argument);
        }
        let result = match function.expression_body() {
            Some(expression) => Some(self.eval(expression, name)),
            None => function
                .block_body()
                .and_then(|statements| self.statements(statements)),
        };
        self.within.pop();
        self.module = saved_module;
        self.env = saved_env;
        result.unwrap_or(Place::Const)
    }

    /// Evaluates an expression that computes in a cone, which is made
    /// under `hint` where the expression is not inside one already.
    fn in_cone(&mut self, hint: &str, at: u32, evaluate: impl FnOnce(&mut Self, usize)) -> Place {
        let (cone, made) = self.computing(hint, at);
        evaluate(self, cone);
        if made {
            self.cone = None;
        }
        Place::Value(self.value(hint, cone), Vec::new())
    }

    fn eval(&mut self, expression: &Expression<'a>, hint: &str) -> Place {
        let expression = unwrap(expression);
        let at = expression.span().start;
        match expression {
            Expression::Identifier(identifier) => {
                if let Some(place) = self.env.get(identifier.name.as_str()) {
                    return place.clone();
                }
                match identifier.name.as_str() {
                    "undefined" | "NaN" | "Infinity" => Place::Const,
                    name if crate::api::is_global_namespace(name) => Place::Const,
                    _ if self.resolver.value_def(self.module, identifier).is_some() => Place::Const,
                    _ => {
                        let api = self.resolver.parsed(self.module).and_then(|parsed| {
                            self.resolver
                                .model(self.module)?
                                .api_ref_of_callee(parsed.semantic.scoping(), expression)
                        });
                        if api.is_some() {
                            Place::Const
                        } else {
                            Place::Unknown
                        }
                    }
                }
            }
            Expression::StringLiteral(_)
            | Expression::NumericLiteral(_)
            | Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::BigIntLiteral(_)
            | Expression::RegExpLiteral(_) => Place::Const,
            Expression::TemplateLiteral(template) if template.expressions.is_empty() => {
                Place::Const
            }
            Expression::StaticMemberExpression(member) => {
                let object = self.eval(&member.object, hint);
                Self::extend(&object, member.property.name.as_str())
            }
            Expression::ComputedMemberExpression(member) => {
                let object = self.eval(&member.object, hint);
                match unwrap(&member.expression) {
                    Expression::StringLiteral(key) => Self::extend(&object, key.value.as_str()),
                    Expression::NumericLiteral(index) => {
                        Self::extend(&object, &index.value.to_string())
                    }
                    key => {
                        let key = self.eval(key, hint);
                        if matches!(object, Place::Const) && matches!(key, Place::Const) {
                            return Place::Const;
                        }
                        self.pick(&object, &key, hint, at)
                    }
                }
            }
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::ComputedMemberExpression(member) => {
                    let object = self.eval(&member.object, hint);
                    if member.optional {
                        self.observe(&object, "shape");
                    }
                    match unwrap(&member.expression) {
                        Expression::StringLiteral(key) => Self::extend(&object, key.value.as_str()),
                        key => {
                            let key = self.eval(key, hint);
                            self.pick(&object, &key, hint, at)
                        }
                    }
                }
                ChainElement::StaticMemberExpression(member) => {
                    let object = self.eval(&member.object, hint);
                    // `a?.b` observes whether `a` is present.
                    if member.optional {
                        self.observe(&object, "shape");
                    }
                    Self::extend(&object, member.property.name.as_str())
                }
                ChainElement::CallExpression(call) => self.call(call, hint),
                _ => {
                    self.unsupported("an optional chain in the reactive tier", at);
                    Place::Unknown
                }
            },
            Expression::ObjectExpression(object) => {
                let mut fields = BTreeMap::new();
                for property in &object.properties {
                    match property {
                        ObjectPropertyKind::ObjectProperty(property) => {
                            let name = match static_key_name(&property.key) {
                                Some(name) if !property.computed => name.to_string(),
                                _ => match property.key.as_expression().map(unwrap) {
                                    Some(Expression::Identifier(key)) => {
                                        format!("${}", key.name)
                                    }
                                    _ => {
                                        self.unsupported(
                                            "a computed key of a record in the reactive tier",
                                            property.span.start,
                                        );
                                        continue;
                                    }
                                },
                            };
                            let member = self.eval(&property.value, &format!("@{name}"));
                            fields.insert(name, member);
                        }
                        ObjectPropertyKind::SpreadProperty(spread) => {
                            match self.eval(&spread.argument, hint) {
                                Place::Record(members) => fields.extend(members),
                                Place::Const => {}
                                _ => self.unsupported(
                                    "a spread into a record in the reactive tier",
                                    spread.span.start,
                                ),
                            }
                        }
                    }
                }
                Place::Record(fields)
            }
            Expression::ArrayExpression(array) => {
                let mut fields = BTreeMap::new();
                for (index, element) in array.elements.iter().enumerate() {
                    match element.as_expression() {
                        Some(element) => {
                            let member = self.eval(element, hint);
                            fields.insert(index.to_string(), member);
                        }
                        None => self.unsupported(
                            "a spread or a hole in an array of the reactive tier",
                            element.span().start,
                        ),
                    }
                }
                Place::Record(fields)
            }
            Expression::CallExpression(call) => self.call(call, hint),
            Expression::NewExpression(new) => self.construct(new, hint),
            Expression::JSXElement(_) | Expression::JSXFragment(_) => {
                // A rendered tree has a template per path (PL §3.4), and
                // none as one value.
                self.build(hint, at, |emitter, _| {
                    match expression {
                        Expression::JSXElement(element) => emitter.jsx_element(element),
                        Expression::JSXFragment(fragment) => {
                            for child in &fragment.children {
                                emitter.jsx_child(child);
                            }
                        }
                        _ => {}
                    }
                    None
                })
            }
            Expression::ConditionalExpression(conditional) => self.select(
                hint,
                at,
                &conditional.test,
                None,
                [Some(&conditional.consequent), Some(&conditional.alternate)],
            ),
            // "`a && b` is `select(a, [b, a])` ... `a || b` and `??` are
            // analogous" (PL §3.5). `??` tests whether `a` is present.
            Expression::LogicalExpression(logical) => match logical.operator {
                LogicalOperator::And => {
                    self.select(hint, at, &logical.left, None, [Some(&logical.right), None])
                }
                LogicalOperator::Or => {
                    self.select(hint, at, &logical.left, None, [None, Some(&logical.right)])
                }
                LogicalOperator::Coalesce => self.select(
                    hint,
                    at,
                    &logical.left,
                    Some("shape"),
                    [None, Some(&logical.right)],
                ),
            },
            Expression::BinaryExpression(binary) => self.derived(hint, at, |emitter, _| {
                let equality = matches!(
                    binary.operator,
                    BinaryOperator::Equality
                        | BinaryOperator::Inequality
                        | BinaryOperator::StrictEquality
                        | BinaryOperator::StrictInequality
                );
                let absent = |operand: &Expression<'a>| match unwrap(operand) {
                    Expression::Identifier(identifier) => identifier.name == "undefined",
                    Expression::NullLiteral(_) => true,
                    _ => false,
                };
                let kind_test = |operand: &Expression<'a>| match unwrap(operand) {
                    Expression::UnaryExpression(unary) => unary.operator == UnaryOperator::Typeof,
                    _ => false,
                };
                for (operand, other) in
                    [(&binary.left, &binary.right), (&binary.right, &binary.left)]
                {
                    // A test of presence, `x === undefined`, observes
                    // whether `x` holds anything, and a test of kind,
                    // `typeof x === "string"`, observes `x` for `shape`
                    // and nothing of the name it is compared with.
                    if equality && absent(operand) && !absent(other) {
                        continue;
                    }
                    if equality
                        && kind_test(other)
                        && matches!(unwrap(operand), Expression::StringLiteral(_))
                    {
                        continue;
                    }
                    if let (true, Expression::UnaryExpression(unary)) =
                        (equality && kind_test(operand), unwrap(operand))
                    {
                        let place = emitter.eval(&unary.argument, "operand");
                        emitter.observe(&place, "shape");
                        continue;
                    }
                    let place = emitter.eval(operand, "operand");
                    if equality && absent(other) {
                        emitter.observe(&place, "shape");
                    } else {
                        emitter.consume(&place);
                    }
                }
            }),
            Expression::UnaryExpression(unary) => self.derived(hint, at, |emitter, _| {
                let place = emitter.eval(&unary.argument, "operand");
                if unary.operator == UnaryOperator::Typeof {
                    emitter.observe(&place, "shape");
                } else {
                    emitter.consume(&place);
                }
            }),
            Expression::TemplateLiteral(template) => self.derived(hint, at, |emitter, _| {
                for operand in &template.expressions {
                    let place = emitter.eval(operand, "operand");
                    emitter.consume(&place);
                }
            }),
            Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
                self.unsupported("a function written as a value in the reactive tier", at);
                Place::Unknown
            }
            _ => {
                self.unsupported("an expression form in the reactive tier", at);
                Place::Unknown
            }
        }
    }

    fn within_json(&self) -> Value {
        Value::Array(self.within.clone())
    }

    /// A state cell (`Plan.stateCells`), from a cell constructor.
    fn state_cell(&mut self, scope: &str, hint: &str) -> Place {
        self.state_cells.push(json!({
            "name": written_at(hint),
            "scope": scope,
            "within": self.within_json(),
        }));
        Place::Slot(Root::State(self.state_cells.len() - 1), Vec::new())
    }

    /// The scope a cell constructor names: `X`, `X.perUser`, and so on.
    fn constructor_scope(&self, callee: &Expression<'a>) -> Option<&'static str> {
        let (object, scope) = match unwrap(callee) {
            Expression::StaticMemberExpression(member) => {
                let scope = match member.property.name.as_str() {
                    "perSpace" => "space",
                    "perUser" => "user",
                    "perSession" => "session",
                    _ => return None,
                };
                (unwrap(&member.object), scope)
            }
            other => (other, "space"),
        };
        let Expression::Identifier(identifier) = object else {
            return None;
        };
        (crate::api::is_cell_type(identifier.name.as_str()) || identifier.name.as_str() == "Stream")
            .then_some(scope)
            .filter(|_| self.resolver.value_def(self.module, identifier).is_none())
    }

    fn construct(&mut self, new: &NewExpression<'a>, hint: &str) -> Place {
        match self.constructor_scope(&new.callee) {
            Some(scope) => {
                for argument in new.arguments.iter().filter_map(Argument::as_expression) {
                    let saved = self.cone.take();
                    let place = self.eval(argument, hint);
                    self.cone = saved;
                    if !matches!(place, Place::Const | Place::Record(_)) {
                        self.unsupported(
                            "an initial value of a state cell that is not a constant",
                            argument.span().start,
                        );
                    }
                }
                self.state_cell(scope, hint)
            }
            None => {
                self.unsupported("a constructor in the reactive tier", new.span.start);
                Place::Unknown
            }
        }
    }

    fn call(&mut self, call: &CallExpression<'a>, hint: &str) -> Place {
        let at = call.span.start;
        let arguments: Vec<&Expression<'a>> = call
            .arguments
            .iter()
            .filter_map(Argument::as_expression)
            .collect();
        if arguments.len() != call.arguments.len() {
            self.unsupported("a spread argument in the reactive tier", at);
            return Place::Unknown;
        }
        if let Some(api) = self.resolver.api_callee(self.module, call) {
            return self.api_call(call, api.as_str(), &arguments, hint);
        }
        match unwrap(&call.callee) {
            Expression::Identifier(identifier) => {
                if let Some(Place::Value(..) | Place::Slot(..) | Place::Unknown) =
                    self.env.get(identifier.name.as_str())
                {
                    self.unsupported("a call of a factory value in the reactive tier", at);
                    return Place::Unknown;
                }
                match self.def_function(identifier) {
                    Some((home, start, DefKind::Handler)) => {
                        self.bind_handler(home, start, identifier.name.as_str(), &arguments, hint)
                    }
                    Some((home, start, DefKind::Lift | DefKind::Function)) => {
                        let name = identifier.name.to_string();
                        self.use_body(home, start, &name, &arguments, hint, at)
                    }
                    Some((home, start, DefKind::Pattern)) => {
                        let name = base_name(hint, identifier.name.as_str()).to_string();
                        self.inline_pattern(home, start, &name, &arguments, at)
                    }
                    _ => {
                        let global = self.resolver.parsed(self.module).is_some_and(|parsed| {
                            symbol_of(parsed.semantic.scoping(), identifier).is_none()
                        });
                        if global {
                            // A function of the standard library, such as
                            // `String`: expression code over its
                            // arguments.
                            return self.derived(hint, at, |emitter, _| {
                                for argument in &arguments {
                                    let place = emitter.eval(argument, "operand");
                                    emitter.consume(&place);
                                }
                            });
                        }
                        self.unsupported("a call of a name the emitter does not resolve", at);
                        Place::Unknown
                    }
                }
            }
            Expression::StaticMemberExpression(member) => {
                let name = member.property.name.as_str();
                // `X.of(value)` and `X.for(cause)`.
                if matches!(name, "of" | "for") {
                    if let Some(scope) = self.constructor_scope(&member.object) {
                        let cause = match (name, arguments.first().map(|first| unwrap(first))) {
                            ("for", Some(Expression::StringLiteral(cause))) => {
                                cause.value.to_string()
                            }
                            ("for", _) => {
                                self.unsupported(
                                    "a cause that is not a string literal in the reactive tier",
                                    at,
                                );
                                fallback_name(hint, "cell").to_string()
                            }
                            _ => fallback_name(hint, "cell").to_string(),
                        };
                        return self.state_cell(scope, &cause);
                    }
                }
                let receiver = self.eval(&member.object, hint);
                self.method(call, &receiver, name, &arguments, hint)
            }
            Expression::CallExpression(inner) if self.resolver.is_lift_call(self.module, inner) => {
                match inner.arguments.first().and_then(FunctionLike::of_argument) {
                    Some(function) => {
                        let start = function.span().start;
                        let name = fallback_name(hint, "lift");
                        self.use_body(self.module, start, name, &arguments, hint, at)
                    }
                    None => {
                        self.unsupported("a `lift` of a function not written in place", at);
                        Place::Unknown
                    }
                }
            }
            _ => {
                self.unsupported("a call form in the reactive tier", at);
                Place::Unknown
            }
        }
    }

    fn method(
        &mut self,
        call: &CallExpression<'a>,
        receiver: &Place,
        name: &str,
        arguments: &[&Expression<'a>],
        hint: &str,
    ) -> Place {
        let at = call.span.start;
        match name {
            // A read through a handle is a slot whose path crosses the
            // link (PL §2.5).
            "get" | "sample" if arguments.is_empty() => receiver.clone(),
            "key" => match arguments.first().map(|first| unwrap(first)) {
                Some(Expression::StringLiteral(key)) => Self::extend(receiver, key.value.as_str()),
                Some(key) => {
                    let key = self.eval(key, hint);
                    self.pick(receiver, &key, hint, at)
                }
                None => receiver.clone(),
            },
            "map" | "filter" | "flatMap" | "some" | "every" | "findIndex" | "find" => {
                match arguments.first().and_then(|first| FunctionLike::of(first)) {
                    Some(function) => self.collection(receiver, name, function, hint, at),
                    None => {
                        self.unsupported("an element construct with no callback in place", at);
                        Place::Unknown
                    }
                }
            }
            "for" | "asSchema" | "withTx" => receiver.clone(),
            // The method forms of `equals` and `equalLinks` (LS §4.7, PL
            // §3.16): on a handle, or on a cell constructor with both
            // operands as arguments.
            "equals" | "equalLinks" => {
                let receiver = receiver.clone();
                self.derived(hint, at, |emitter, _| {
                    let mut operands = vec![receiver];
                    for argument in arguments {
                        operands.push(emitter.eval(argument, "operand"));
                    }
                    for operand in &operands {
                        if name == "equals" {
                            emitter.resolve(operand);
                        } else {
                            emitter.pass(operand);
                        }
                    }
                })
            }
            // A method of a string, a number, or an array that takes no
            // function, and a function of a global object of the standard
            // library: expression code over the receiver and the
            // arguments.
            _ if arguments
                .iter()
                .all(|argument| FunctionLike::of(argument).is_none())
                && (matches!(receiver, Place::Const) || SCALAR_METHODS.contains(&name)) =>
            {
                let receiver = receiver.clone();
                let mut places = Vec::new();
                for argument in arguments {
                    places.push(self.eval(argument, hint));
                }
                if matches!(receiver, Place::Const)
                    && places.iter().all(|place| matches!(place, Place::Const))
                {
                    return Place::Const;
                }
                self.derived(hint, at, |emitter, _| {
                    emitter.consume(&receiver);
                    for place in &places {
                        emitter.consume(place);
                    }
                })
            }
            _ => {
                if matches!(receiver, Place::Unknown) {
                    // Reported where the receiver was lost.
                    return Place::Unknown;
                }
                self.unsupported(format!("the method `{name}` in the reactive tier"), at);
                for argument in arguments {
                    if FunctionLike::of(argument).is_none() {
                        self.eval(argument, hint);
                    }
                }
                Place::Unknown
            }
        }
    }

    /// An element construct: a collection, and the cone of its body.
    fn collection(
        &mut self,
        receiver: &Place,
        via: &str,
        function: FunctionLike<'_, 'a>,
        hint: &str,
        at: u32,
    ) -> Place {
        let name = base_name(hint, via);
        // A scan (PL §3.13): the predicate is the body, the runtime
        // evaluates it in order, and a selector holds the position the
        // scan stopped at.
        let scan = matches!(via, "some" | "every" | "findIndex" | "find");
        // The membership of what the construct iterates: for an input
        // collection its `enumeration` slot, and for a collection the
        // instance computed the producing template (PL §3.6).
        let mut iterated: Option<Value> = None;
        let source = match receiver {
            Place::Slot(root, path) => {
                let slot = self.slot(root, path, "enumeration");
                iterated = Some(json!({ "op": "slot", "slot": slot }));
                json!({ "slot": slot })
            }
            Place::Value(value, path) => {
                self.values[*value].referred = true;
                iterated = self.values[*value].template.clone();
                match self.values[*value].collection {
                    Some(collection) if !scan && !self.values[*value].scan => {
                        json!({ "collection": collection, "via": via })
                    }
                    _ if path.is_empty() => json!({ "output": { "$value": value } }),
                    _ => {
                        // A path of a value another expression computed,
                        // as `facts.main` is: an interim output at that
                        // path.
                        if !self.values[*value].below.contains(path) {
                            self.values[*value].below.push(path.clone());
                        }
                        json!({ "output": { "$value": value, "$path": path } })
                    }
                }
            }
            Place::Unknown => json!({}),
            Place::Record(_) | Place::Const => {
                // An array written in the reactive tier is an array the
                // instance computed (PL §1.1, `Collection.source`). A cone
                // of its own computes it, so that a cone that uses the
                // assembled result does not come before the body.
                let receiver = receiver.clone();
                let saved = self.cone.take();
                // "For a constant, the membership template ... [is]
                // `const`. For a literal written in place, the
                // membership is the literal's `enumeration`" (PL §3.6),
                // which is `const` for a static set of keys (§3.4).
                let array = self.build(name, at, |emitter, _| {
                    emitter.pass(&receiver);
                    Some(json!({ "op": "const" }))
                });
                self.cone = saved;
                iterated = Some(json!({ "op": "const" }));
                match array {
                    Place::Value(value, _) => {
                        self.values[value].referred = true;
                        json!({ "output": { "$value": value } })
                    }
                    _ => json!({}),
                }
            }
            _ => {
                self.unsupported("an element construct over a stream or an index", at);
                json!({})
            }
        };
        let collection = self.collections.len();
        let uses_index = function.params().items.len() > 1;
        self.collections.push(json!({
            "name": name,
            "within": self.within_json(),
            "source": source,
            "bodyUses": { "index": uses_index },
        }));
        self.iterated.push(iterated.clone());
        // The body: one cone, evaluated once per element key.
        let saved_env = self.env.clone();
        let saved_cone = self.cone.take();
        let saved_operands = (
            std::mem::take(&mut self.operands),
            std::mem::replace(&mut self.opaque, false),
        );
        let bodies_before = self.plan_bodies.len();
        self.within.push(json!({ "element": collection }));
        let parameters = &function.params().items;
        if let Some(element) = parameters.first() {
            self.bind_pattern(
                &element.pattern,
                Place::Slot(Root::Element(collection), Vec::new()),
            );
        }
        if let Some(index) = parameters.get(1) {
            self.bind_pattern(&index.pattern, Place::Index(collection));
        }
        let (cone, _) = self.computing(name, function.span().start);
        // The expression the callback returns, for the class a test of
        // its truthiness needs.
        let returned = function.expression_body().or_else(|| {
            function.block_body().and_then(|statements| {
                statements.iter().find_map(|statement| match statement {
                    Statement::ReturnStatement(statement) => statement.argument.as_ref(),
                    _ => None,
                })
            })
        });
        let tests = scan || via == "filter";
        let class = match (tests, returned) {
            (true, Some(returned)) => self.test_class(returned),
            (true, None) => "value",
            (false, _) => "identity",
        };
        let (result, body) = self.one(class, |emitter| {
            let result = match function.expression_body() {
                Some(expression) => Some(emitter.eval(expression, name)),
                None => function
                    .block_body()
                    .and_then(|statements| emitter.statements(statements)),
            };
            result.unwrap_or(Place::Const)
        });
        // The element as the source has it, passed through.
        let source_element = |emitter: &mut Self| {
            let slot = emitter.slot(&Root::Element(collection), &[], "identity");
            emitter.cones[cone].slots.insert(slot);
            json!({ "op": "slot", "slot": slot })
        };
        let fold = |body: Option<Value>, through: Option<usize>| -> Option<Value> {
            let mut node = Map::new();
            node.insert("op".to_string(), json!("fold"));
            node.insert("collection".to_string(), json!(collection));
            node.insert("body".to_string(), body?);
            if let Some(through) = through {
                node.insert("through".to_string(), json!(through));
            }
            Some(Value::Object(node))
        };
        let joined = |fold: Option<Value>, iterated: &Option<Value>| -> Option<Value> {
            Some(join(vec![fold?, iterated.clone()?]))
        };
        // The membership of the result, the template of an element of
        // it, and for a scan the template of its value.
        let (membership, element, scanned) = match via {
            "map" => (iterated.clone(), body, None),
            // PL §3.7: "`fold` over the source with body the template of
            // `pred`, joined with the source's membership", and "an
            // element of the result is the source element, passed
            // through".
            "filter" => (
                joined(fold(body, None), &iterated),
                Some(source_element(self)),
                None,
            ),
            // "`fold` over the source with body the `enumeration` of the
            // segment `body` returns".
            "flatMap" => {
                let segment = match &result {
                    Place::Slot(root, path) => {
                        let slot = self.slot(root, path, "enumeration");
                        self.cones[cone].slots.insert(slot);
                        Some(json!({ "op": "slot", "slot": slot }))
                    }
                    Place::Value(value, _) => self.values[*value].template.clone(),
                    Place::Record(_) | Place::Const => Some(json!({ "op": "const" })),
                    _ => None,
                };
                (joined(fold(segment, None), &iterated), body, None)
            }
            // A scan (PL §3.13): a `fold` of the predicate's template
            // through the deciding element, joined with the membership.
            // The runtime supplies the `through`, and no value function
            // reports it.
            _ => {
                let through = self.selectors.len();
                self.selectors.push(0);
                let choice = joined(fold(body, Some(through)), &iterated);
                let scanned = if via == "find" {
                    let pick = self.picks.len();
                    self.picks.push("runtime");
                    let element = source_element(self);
                    choice.map(|choice| {
                        json!({
                            "op": "pick",
                            "pick": pick,
                            "from": { "collection": collection },
                            "choice": choice,
                            "body": element,
                        })
                    })
                } else {
                    choice
                };
                (iterated.clone(), None, scanned)
            }
        };
        if let Some(membership) = &membership {
            self.collections[collection]["membership"] = membership.clone();
        }
        // "`child`: the body instantiates a child" (PL §1.1,
        // `Collection.bodyUses`).
        let instantiates = self.plan_bodies[bodies_before..].iter().any(|body| {
            body["calls"]
                .as_array()
                .is_some_and(|calls| calls.iter().any(|call| call["kind"] == "instantiate"))
        });
        if instantiates {
            self.collections[collection]["bodyUses"]["child"] = json!(true);
        }
        self.within.pop();
        self.cone = saved_cone;
        self.env = saved_env;
        self.operands = saved_operands.0;
        self.opaque = saved_operands.1;
        let value = self.value(name, cone);
        self.values[value].collection = Some(collection);
        if scan {
            self.values[value].scan = true;
            self.values[value].template = scanned;
        } else {
            // The assembled result has the membership template (PL §1.4).
            self.values[value].template = membership;
            self.values[value].element = Some(element);
        }
        let place = Place::Value(value, Vec::new());
        // A cone outside the construct that uses the collection reads its
        // assembled result.
        self.pass(&place);
        place
    }

    fn api_call(
        &mut self,
        call: &CallExpression<'a>,
        name: &str,
        arguments: &[&Expression<'a>],
        hint: &str,
    ) -> Place {
        let at = call.span.start;
        match name {
            "computed" => {
                let Some(function) = arguments.first().and_then(|first| FunctionLike::of(first))
                else {
                    self.unsupported("a `computed` of a function not written in place", at);
                    return Place::Unknown;
                };
                let start = function.span().start;
                if self.record_at(self.module, start).is_some() {
                    // Not promoted: a body, with what it captures as its
                    // formal inputs.
                    let name = fallback_name(hint, "computed");
                    return self.use_body(self.module, start, name, &[], hint, at);
                }
                // Promoted: expression code.
                match function.expression_body() {
                    Some(expression) => {
                        // A promoted `computed` is its expression, and
                        // has the expression's template.
                        self.build(hint, at, |emitter, _| {
                            emitter
                                .one("identity", |emitter| emitter.eval(expression, hint))
                                .1
                        })
                    }
                    None => {
                        let statements = function.block_body().unwrap_or(&[]);
                        let saved = self.env.clone();
                        let place = self.build(hint, at, |emitter, _| {
                            match emitter.code_block(statements) {
                                Ok(template) => template,
                                // Statements that return nothing.
                                Err(()) => Some(json!({ "op": "const" })),
                            }
                        });
                        self.env = saved;
                        place
                    }
                }
            }
            "action" => match arguments.first().and_then(|first| FunctionLike::of(first)) {
                Some(function) => {
                    self.bind_inline(function, BodyKind::Action, fallback_name(hint, "action"))
                }
                None => {
                    self.unsupported("an `action` of a function not written in place", at);
                    Place::Unknown
                }
            },
            // The callable forms map to the operation of `?:`, `&&`,
            // `||`, and a template literal (PL §3.5, §3.19).
            "ifElse" | "when" | "unless" if !arguments.is_empty() => {
                let branch = |index: usize| arguments.get(index).copied();
                let branches = match name {
                    "ifElse" => [branch(1), branch(2)],
                    "when" => [branch(1), None],
                    _ => [None, branch(1)],
                };
                if name == "ifElse" && (branches[0].is_none() || branches[1].is_none()) {
                    self.unsupported("an `ifElse` with fewer than three arguments", at);
                    return Place::Unknown;
                }
                self.select(hint, at, arguments[0], None, branches)
            }
            "ifElse" | "when" | "unless" | "str" => self.derived(hint, at, |emitter, _| {
                for argument in arguments {
                    let place = emitter.eval(argument, hint);
                    emitter.consume(&place);
                }
            }),
            _ if EFFECTS.contains(&name) => {
                let operation = self.operations.len();
                self.operations.push(json!({
                    "kind": "effect",
                    "implementation": { "builtin": name },
                    "name": base_name(hint, name),
                    "within": self.within_json(),
                }));
                let (cone, made) = self.computing(hint, at);
                for argument in arguments {
                    let place = self.eval(argument, hint);
                    self.pass(&place);
                    // One write edge per path of the request (PL §3.14).
                    let mut paths = Vec::new();
                    request_paths(&place, &mut Vec::new(), &mut paths);
                    for path in paths {
                        self.cones[cone].writes.push(json!({
                            "target": {
                                "kind": "request",
                                "of": { "operation": operation },
                                "path": path,
                            },
                            "constraints": [],
                        }));
                    }
                }
                if made {
                    self.cone = None;
                }
                Place::Slot(Root::Operation(operation), Vec::new())
            }
            // The context reads (PL §3.16).
            "spaceOf" | "equals" => self.derived(hint, at, |emitter, _| {
                for argument in arguments {
                    let place = emitter.eval(argument, "operand");
                    emitter.resolve(&place);
                }
            }),
            "principalOf" | "principalsOf" | "profileOwnerOf" => {
                self.derived(hint, at, |emitter, _| {
                    if let Some(first) = arguments.first() {
                        let place = emitter.eval(first, "operand");
                        emitter.resolve(&place);
                        emitter.observe(&place, "labelMetadata");
                    }
                    for argument in arguments.iter().skip(1) {
                        let place = emitter.eval(argument, "operand");
                        emitter.consume(&place);
                    }
                })
            }
            "spaceAccess" | "spaceAccessOf" | "spaceMembers" | "spaceDeleted" => {
                self.derived(hint, at, |emitter, _| {
                    let Some(first) = arguments.first() else {
                        return;
                    };
                    let place = emitter.eval(first, "operand");
                    match &place {
                        Place::Slot(root, path) => {
                            // A cell operand by its `identity` slot,
                            // resolved; an operand that names a space by
                            // its `value` slot.
                            let names_space = name == "spaceDeleted" && emitter.is_string(first);
                            let slot = if names_space {
                                emitter.slot(root, path, "value")
                            } else {
                                emitter.slot_with(root, path, "identity", true, false)
                            };
                            if let Some(cone) = emitter.cone {
                                emitter.cones[cone].slots.insert(slot);
                            }
                            emitter.operands.push(json!({ "op": "slot", "slot": slot }));
                            let reads =
                                emitter.dynamic(json!({ "why": { "kind": "space", "of": slot } }));
                            emitter
                                .operands
                                .push(json!({ "op": "dynamic", "reads": reads }));
                        }
                        Place::Const => {}
                        _ => emitter.unsupported(
                            "a dynamic read of kind `space` whose operand the emitter cannot name",
                            at,
                        ),
                    }
                    for argument in arguments.iter().skip(1) {
                        let place = emitter.eval(argument, "operand");
                        emitter.consume(&place);
                    }
                })
            }
            "linksOf" => self.derived(hint, at, |emitter, _| {
                if let Some(first) = arguments.first() {
                    let place = emitter.eval(first, "operand");
                    emitter.observe(&place, "enumeration");
                    emitter.pass(&Self::extend(&place, "*"));
                }
            }),
            // A rendering as text reads every operand by `value`, over its
            // whole subtree (BI, "Debug strings").
            "toIndentedDebugString" | "toCompactDebugString" => {
                self.derived(hint, at, |emitter, _| {
                    for argument in arguments {
                        let place = emitter.eval(argument, "operand");
                        emitter.consume(&place);
                    }
                })
            }
            "getPatternEnvironment" => Place::Const,
            _ => {
                self.unsupported(format!("the built-in `{name}` in the reactive tier"), at);
                for argument in arguments {
                    if FunctionLike::of(argument).is_none() {
                        self.eval(argument, hint);
                    }
                }
                Place::Unknown
            }
        }
    }

    // ----- JSX -----

    fn jsx_element(&mut self, element: &JSXElement<'a>) {
        for attribute in &element.opening_element.attributes {
            match attribute {
                JSXAttributeItem::Attribute(attribute) => {
                    let name = match &attribute.name {
                        JSXAttributeName::Identifier(identifier) => identifier.name.to_string(),
                        JSXAttributeName::NamespacedName(name) => name.name.name.to_string(),
                    };
                    if let Some(JSXAttributeValue::ExpressionContainer(container)) =
                        &attribute.value
                    {
                        if let Some(expression) = container.expression.as_expression() {
                            match FunctionLike::of(expression) {
                                Some(function) => {
                                    self.bind_inline(function, BodyKind::InlineHandler, &name);
                                }
                                None => {
                                    let place = self.eval(expression, &format!("@{name}"));
                                    self.pass(&place);
                                }
                            }
                        }
                    }
                }
                JSXAttributeItem::SpreadAttribute(spread) => {
                    let place = self.eval(&spread.argument, "spread");
                    self.pass(&place);
                }
            }
        }
        for child in &element.children {
            self.jsx_child(child);
        }
    }

    fn jsx_child(&mut self, child: &JSXChild<'a>) {
        match child {
            JSXChild::Element(element) => self.jsx_element(element),
            JSXChild::Fragment(fragment) => {
                for child in &fragment.children {
                    self.jsx_child(child);
                }
            }
            JSXChild::ExpressionContainer(container) => {
                if let Some(expression) = container.expression.as_expression() {
                    let place = self.eval(expression, "child");
                    self.pass(&place);
                }
            }
            JSXChild::Spread(spread) => {
                let place = self.eval(&spread.expression, "child");
                self.pass(&place);
            }
            JSXChild::Text(_) => {}
        }
    }

    // ----- bodies -----

    /// The slot or the computed value an entry of a use of a body is at,
    /// by what the entry's formal input is bound to.
    fn bound(&self, inputs: &HashMap<String, Place>, input: &str, path: &[Seg]) -> Place {
        let Some(mut place) = inputs.get(input).cloned() else {
            return Place::Unknown;
        };
        let mut rest = path;
        // A record written in the reactive tier is followed member by
        // member.
        while let (Place::Record(fields), Some(Seg::Key(key))) = (&place, rest.first()) {
            place = fields.get(key).cloned().unwrap_or(Place::Const);
            rest = &rest[1..];
        }
        match place {
            Place::Slot(root, base) => Place::Slot(root, slot_path(&base, rest)),
            Place::Value(value, base) => Place::Value(value, slot_path(&base, rest)),
            other => other,
        }
    }

    /// The `Body` record of one use of a body, pushed onto `Plan.bodies`.
    #[allow(clippy::too_many_arguments)]
    fn body_record(
        &mut self,
        kind: &str,
        name: &str,
        record: &Record,
        inputs: &HashMap<String, Place>,
        prefix: bool,
        at: u32,
        computation: bool,
    ) -> usize {
        // The inputs bound to a value the instance computed (FA §1.1). A
        // record written in the reactive tier binds each member on its
        // own, so it is decided entry by entry below.
        let computed: BTreeSet<String> = inputs
            .iter()
            .filter(|(_, place)| matches!(place, Place::Value(..) | Place::Unknown))
            .map(|(input, _)| input.clone())
            .collect();
        let index = self.plan_bodies.len();
        let mut dynamic: Vec<usize> = Vec::new();
        let used: UseRecord = bind_use(record, &computed);
        let mut reads: Vec<usize> = Vec::new();
        let mut computed_inputs: Vec<Value> = Vec::new();
        let mut names: Names = HashMap::new();
        // The `value` entries, for an operand that names a space.
        let mut value_names: Names = HashMap::new();

        for entry in used.reads.iter().chain(&used.computed) {
            let place = if entry.input == "cause" && !inputs.contains_key("cause") {
                Place::Slot(Root::Cause, slot_path(&[], &entry.path))
            } else {
                self.bound(inputs, &entry.input, &entry.path)
            };
            let resolved = entry.class == Class::Resolved;
            let key = (entry.input.clone(), entry.path.clone(), resolved);
            match place {
                Place::Slot(root, path) => {
                    // A `shape` entry at the position of a handle or of a
                    // reference is made in place (PL §1.1).
                    let in_place = entry.class == Class::Shape
                        && entry.path.last() != Some(&Seg::Hop)
                        && record
                            .detail
                            .by_reference
                            .iter()
                            .any(|(input, path)| *input == entry.input && *path == entry.path);
                    let slot =
                        self.slot_with(&root, &path, class_name(entry.class), resolved, in_place);
                    if !reads.contains(&slot) {
                        reads.push(slot);
                    }
                    if let (Class::Value, true, Some(cone)) = (entry.class, computation, self.cone)
                    {
                        let view = self
                            .formal_types
                            .get(&entry.input)
                            .and_then(|ty| self.entry_type(*ty, &entry.path));
                        self.cones[cone].views.entry(slot).or_default().push(view);
                    }
                    if matches!(entry.class, Class::Identity | Class::Resolved) {
                        names.insert(key, json!(slot));
                    } else if entry.class == Class::Value {
                        value_names.insert(key, json!(slot));
                    }
                }
                Place::Const | Place::Index(_) | Place::Stream(_) => {}
                place => {
                    // A value of the same cone is no output on account
                    // of the use (PL §1.4): "the result of a body used
                    // inside an initializer ... [is an entry] of
                    // `Plan.outputs` only where another cone, a `pick`,
                    // or a collection refers to [it]".
                    if let Place::Value(value, _) = &place {
                        match self.cone {
                            Some(cone) if self.values[*value].cone == cone => {}
                            Some(cone) => {
                                self.values[*value].referred = true;
                                self.cones[cone].uses.insert(*value);
                            }
                            None => self.values[*value].referred = true,
                        }
                    }
                    let mut at_path: Vec<String> = Vec::new();
                    if prefix {
                        at_path.push(entry.input.clone());
                    }
                    at_path.extend(slot_path(&[], &entry.path));
                    if matches!(entry.class, Class::Identity | Class::Resolved) {
                        names.insert(key, json!({ "computed": computed_inputs.len() }));
                    } else if entry.class == Class::Value {
                        value_names.insert(key, json!({ "computed": computed_inputs.len() }));
                    }
                    let mut input = Map::new();
                    input.insert("at".to_string(), json!(at_path));
                    input.insert("observes".to_string(), json!(class_name(entry.class)));
                    if let Place::Value(value, _) = &place {
                        if let Some(template) = &self.values[*value].template {
                            input.insert("template".to_string(), template.clone());
                        }
                    }
                    computed_inputs.push(Value::Object(input));
                }
            }
        }
        // `Body.handles`, and the dynamic reads of the plan.
        let mut handles: Vec<Value> = Vec::new();
        for handle in &used.handles {
            let named = match &handle.at {
                HandleAt::Entry(input, path) => match name_of(&names, input, path, false) {
                    Some(Value::Number(slot)) => Some(json!({ "slot": slot })),
                    other => other,
                },
                HandleAt::Computed(position) => {
                    let entry = &used.computed[*position];
                    name_of(&names, &entry.input, &entry.path, false)
                }
                HandleAt::Call(call) => Some(json!({ "call": call })),
            };
            match named {
                Some(named) => {
                    dynamic.push(self.dynamic(json!({
                        "why": { "kind": "handle", "body": index, "handle": handles.len() },
                    })));
                    handles.push(json!({ "handle": named }));
                }
                None => self.unsupported("a handle of a body the emitter cannot name", at),
            }
        }
        let mut through: Vec<Value> = Vec::new();
        for starts in &record.detail.links {
            for (input, path) in starts {
                // A resolution that starts below a hop whose read is
                // dynamic has no name: it is journaled with the reads of
                // that handle.
                let link = match name_of(&names, input, path, false) {
                    Some(Value::Number(slot)) => json!(slot),
                    Some(Value::Object(computed)) => {
                        json!({ "body": index, "computed": computed["computed"] })
                    }
                    _ => continue,
                };
                if !through.contains(&link) {
                    through.push(link);
                }
            }
        }
        for line in &used.links {
            if let Some(position) = line.strip_prefix("computed ") {
                if let Ok(position) = position.parse::<usize>() {
                    let entry = &used.computed[position];
                    if let Some(Value::Object(computed)) =
                        name_of(&names, &entry.input, &entry.path, false)
                    {
                        let link = json!({ "body": index, "computed": computed["computed"] });
                        if !through.contains(&link) {
                            through.push(link);
                        }
                    }
                }
            }
        }
        for link in through {
            dynamic.push(self.dynamic(json!({ "why": { "kind": "link", "through": link } })));
        }
        if used.label_metadata {
            dynamic.push(self.dynamic(json!({
                "why": { "kind": "labelMetadata", "body": index },
            })));
        }
        // The reads of the access list of a space (PL §3.16): each names
        // the slot of its operand, or the operand's entry of `computed`.
        let mut spaces: Vec<Value> = Vec::new();
        for starts in &record.detail.spaces {
            for (input, path) in starts {
                let of = match name_of(&names, input, path, false)
                    .or_else(|| name_of(&value_names, input, path, false))
                {
                    Some(Value::Number(slot)) => json!(slot),
                    Some(Value::Object(computed)) => {
                        json!({ "body": index, "computed": computed["computed"] })
                    }
                    _ => {
                        self.unsupported(
                            "a dynamic read of kind `space` whose operand the emitter cannot name",
                            at,
                        );
                        continue;
                    }
                };
                if !spaces.contains(&of) {
                    spaces.push(of);
                }
            }
        }
        for of in spaces {
            dynamic.push(self.dynamic(json!({ "why": { "kind": "space", "of": of } })));
        }
        // `Body.calls`.
        let mut calls: Vec<Value> = Vec::new();
        let mut child_of_call: HashMap<usize, usize> = HashMap::new();
        let mut binds: Vec<(usize, BindRec, String)> = Vec::new();
        for (number, call) in record.calls.iter().enumerate() {
            let call_name = format!("{name}/n{number}");
            calls.push(match call.as_str() {
                "instantiate:order" | "instantiate:tag" => {
                    self.children.push(json!({
                        "name": call_name,
                        "$of": [index, format!("/n{number}")],
                        "within": self.within_json(),
                    }));
                    child_of_call.insert(number, self.children.len() - 1);
                    json!({
                        "kind": "instantiate",
                        "child": self.children.len() - 1,
                        "identifiedBy": call.trim_start_matches("instantiate:"),
                    })
                }
                "createCell:order" => {
                    json!({ "kind": "createCell", "scope": "space", "identifiedBy": "order" })
                }
                "createCell:cause (state)" => {
                    self.state_cells.push(json!({
                        "name": call_name,
                        "$of": [index, format!("/n{number}")],
                        "scope": "space",
                        "within": self.within_json(),
                    }));
                    json!({
                        "kind": "createCell",
                        "scope": "space",
                        "identifiedBy": "cause",
                        "stateCell": self.state_cells.len() - 1,
                    })
                }
                "bind" => {
                    // The binding holds its place among the bindings now,
                    // and is filled in once the handler is a body.
                    self.bindings.push(json!({ "within": self.within_json() }));
                    let binding = self.bindings.len() - 1;
                    match record.detail.binds.iter().find(|bind| bind.call == number) {
                        Some(bind) => binds.push((binding, bind.clone(), call_name.clone())),
                        None => self.unsupported(
                            "a binding made in a function body: its handler and state",
                            at,
                        ),
                    }
                    json!({ "kind": "bind", "binding": binding })
                }
                other => match other.strip_prefix("effect:") {
                    Some(builtin) => json!({ "kind": "effect", "builtin": builtin }),
                    None => {
                        json!({ "kind": "createCell", "scope": "space", "identifiedBy": "cause" })
                    }
                },
            });
        }
        // `Body.writes` and `Body.envelopes`.
        let mut writes: Vec<Value> = Vec::new();
        let mut envelopes: Vec<Value> = Vec::new();
        let mut fact = BodyFact {
            // An authored function has no tier of its own (FA §6.3): used
            // in the reactive tier, it is a computation with static
            // side-writes where every write it makes has a static target.
            side_writes: computation
                && match record.tier {
                    Some(tier) => tier == "static side-write",
                    None => record.detail.edges.iter().all(|edge| edge.fixed),
                },
            at,
            targets: Vec::new(),
        };
        for edge in &record.detail.edges {
            let WriteRec {
                target,
                path,
                fixed,
                reference: named,
            } = edge;
            let below = slot_path(&[], path);
            let target_json = match target {
                WriteTarget::Handle {
                    input,
                    path: position,
                    resolved,
                } => {
                    let handle = name_of(&names, input, position, *resolved);
                    let written = target;
                    let mut target = Map::new();
                    target.insert("kind".to_string(), json!("handle"));
                    let mut state_cell = None;
                    match &handle {
                        Some(Value::Number(slot)) => {
                            target.insert("slot".to_string(), json!(slot));
                            let slot = slot.as_u64().unwrap_or(0) as usize;
                            let (root, slot_at, ..) = self.slots[slot].clone();
                            // A write with a static target through a
                            // state cell of the instance (FA §6.2).
                            if let (Root::State(cell), true) = (&root, *fixed) {
                                let mut path = slot_at.clone();
                                path.extend(below.iter().cloned());
                                state_cell = Some(json!({
                                    "kind": "state",
                                    "cell": cell,
                                    "path": path,
                                }));
                            }
                            if *fixed && named.is_none() {
                                // One target for each site that writes it.
                                let mut sites: Vec<(Option<(usize, u32)>, bool)> = record
                                    .detail
                                    .side_writes
                                    .iter()
                                    .filter(|write| write.target == *written && write.path == *path)
                                    .map(|write| (Some(write.site), write.reads_own))
                                    .collect();
                                if sites.is_empty() {
                                    sites.push((None, false));
                                }
                                for (site, reads_own) in sites {
                                    fact.targets.push(Target {
                                        slot,
                                        root: root.clone(),
                                        at: slot_at.clone(),
                                        below: below.clone(),
                                        resolved: *resolved,
                                        site,
                                        reads_own,
                                    });
                                }
                            }
                        }
                        Some(Value::Object(computed)) => {
                            target.insert("computed".to_string(), computed["computed"].clone());
                        }
                        _ => {
                            self.unsupported(
                                "a write through a handle the emitter cannot name",
                                at,
                            );
                            continue;
                        }
                    }
                    target.insert("path".to_string(), json!(below));
                    if *resolved {
                        target.insert("resolved".to_string(), json!(true));
                    }
                    state_cell.unwrap_or(Value::Object(target))
                }
                WriteTarget::Created(call) => {
                    json!({ "kind": "created", "call": call, "path": below })
                }
                WriteTarget::Argument(call) => match child_of_call.get(call) {
                    Some(child) => json!({ "kind": "argument", "child": child, "path": below }),
                    None => continue,
                },
                WriteTarget::Request(call) => {
                    json!({ "kind": "request", "of": { "call": call }, "path": below })
                }
            };
            if !*fixed {
                envelopes.push(target_json);
                continue;
            }
            let mut write = Map::new();
            write.insert("target".to_string(), target_json);
            if let Some((passes, listed)) = named {
                match reference_json(&names, *passes, listed) {
                    Some(reference) => {
                        write.insert("reference".to_string(), reference);
                    }
                    // A reference whose entry has no name has the body's
                    // template, which the edge of the whole write has.
                    None => continue,
                }
            }
            write.insert("constraints".to_string(), json!([]));
            writes.push(Value::Object(write));
        }
        // `Body.outputs`.
        let mut outputs: Vec<Value> = Vec::new();
        for (path, passes, listed) in &record.detail.outputs {
            if let Some(reference) = reference_json(&names, *passes, listed) {
                outputs.push(json!({ "path": slot_path(&[], path), "reference": reference }));
            }
        }
        self.plan_bodies.push(json!({
            "name": name,
            "within": self.within_json(),
            "kind": kind,
            "reads": reads,
            "computed": computed_inputs,
            "handles": handles,
            "writes": writes,
            "envelopes": envelopes,
            "outputs": outputs,
            "calls": calls,
            "widenings": [],
        }));
        self.body_facts.push(fact);
        self.body_dynamic.push(dynamic);
        // The bindings the body makes (PL §1.1, `Binding`): the handler
        // is a body of the plan, and each path of its state is copied or
        // holds a reference the binding body was given.
        for (binding, bind, call_name) in binds {
            let (home, start) = bind.handler;
            let kind = if bind.action { "action" } else { "handler" };
            let name = self
                .body_starts
                .get(&home)
                .and_then(|starts| starts.get(&start))
                .and_then(|body| self.bodies[home][*body].name.clone())
                .unwrap_or(call_name);
            let Some(handler) = self.handler_body(home, start, &name, kind) else {
                self.unsupported("a handler that has no footprint record", at);
                continue;
            };
            let mut state: Vec<Value> = Vec::new();
            for entry in &bind.state {
                let mut item = Map::new();
                item.insert("path".to_string(), json!(slot_path(&[], &entry.path)));
                let capture = if entry.copy { "copy" } else { "link" };
                item.insert("capture".to_string(), json!(capture));
                if let Some((passes, listed)) = &entry.reference {
                    if let Some(reference) = reference_json(&names, *passes, listed) {
                        item.insert("reference".to_string(), reference);
                    }
                }
                state.push(Value::Object(item));
            }
            let within = self.bindings[binding]["within"].clone();
            self.bindings[binding] = json!({
                "handler": { "body": handler },
                "state": state,
                "within": within,
            });
        }
        if computation && record.tier == Some("materializer") {
            self.operations.push(json!({
                "kind": "materializer",
                "implementation": { "body": index },
                "name": name,
                "within": self.within_json(),
            }));
        }
        if let Some(cone) = self.cone {
            if computation {
                self.cones[cone].bodies.push(index);
                self.cones[cone].slots.extend(reads.iter().copied());
            }
        }
        index
    }

    /// A use of a `lift`, of an authored function, or of a `computed` that
    /// is not promoted, in the reactive tier.
    fn use_body(
        &mut self,
        home: usize,
        start: u32,
        name: &str,
        arguments: &[&Expression<'a>],
        hint: &str,
        at: u32,
    ) -> Place {
        let Some((kind, record)) = self.record_at(home, start) else {
            self.unsupported("a call of a function that has no footprint record", at);
            return Place::Unknown;
        };
        let Some(function) = self.function_at(home, start) else {
            return Place::Unknown;
        };
        let plan_kind = match kind {
            BodyKind::Lift => "lift",
            BodyKind::Computed => "computed",
            BodyKind::Assert => "assert",
            _ => "function",
        };
        let name = name.to_string();
        let hint = hint.to_string();
        let formals = parameter_names(kind, function);
        let (cone, made) = self.computing(&hint, at);
        let mut inputs: HashMap<String, Place> = HashMap::new();
        for (formal, argument) in formals.iter().zip(arguments) {
            let place = self.eval(argument, &hint);
            inputs.insert(formal.clone(), place);
        }
        // What the body captures: the names of the reactive tier around
        // it.
        for entry in record.detail.entries.iter().chain(&record.detail.envelope) {
            if !inputs.contains_key(&entry.input) {
                if let Some(place) = self.env.get(&entry.input) {
                    inputs.insert(entry.input.clone(), place.clone());
                }
            }
        }
        let prefix = kind != BodyKind::Lift;
        // The type each formal input is declared with, where it is one
        // name.
        let mut types: HashMap<String, TypeId> = HashMap::new();
        for (formal, parameter) in formals.iter().zip(&function.params().items) {
            if let BindingPattern::BindingIdentifier(identifier) = &parameter.pattern {
                if let Some(Ok(ty)) = identifier
                    .symbol_id
                    .get()
                    .map(|symbol| self.resolver.declared_symbol_type(home, symbol, 0))
                {
                    types.insert(formal.clone(), ty);
                }
            }
        }
        let saved_types = std::mem::replace(&mut self.formal_types, types);
        let body = self.body_record(plan_kind, &name, &record, &inputs, prefix, start, true);
        self.formal_types = saved_types;
        if made {
            self.cone = None;
        }
        let value = self.value(&hint, cone);
        self.values[value].template = self.body_template(body);
        Place::Value(value, Vec::new())
    }

    /// The template of what a body returned (PL §3.9, and `T_send` of
    /// §6.2): a `derive` by the body over its slots, the templates of its
    /// computed inputs, and its dynamic reads.
    fn body_template(&self, body: usize) -> Option<Value> {
        let record = &self.plan_bodies[body];
        let mut inputs: Vec<Value> = Vec::new();
        for slot in record["reads"].as_array()? {
            inputs.push(json!({ "op": "slot", "slot": slot }));
        }
        for input in record["computed"].as_array()? {
            let template = input.get("template")?;
            if !inputs.contains(template) {
                inputs.push(template.clone());
            }
        }
        for reads in self.body_dynamic.get(body)? {
            let node = json!({ "op": "dynamic", "reads": reads });
            if !inputs.contains(&node) {
                inputs.push(node);
            }
        }
        Some(json!({ "op": "derive", "inputs": inputs, "by": { "body": body } }))
    }

    /// The plan body of a handler: one record however many bindings name
    /// it (PL §1.1).
    fn handler_body(&mut self, home: usize, start: u32, name: &str, kind: &str) -> Option<usize> {
        if let Some(index) = self.handlers.get(&(home, start)) {
            return Some(*index);
        }
        let (body_kind, record) = self.record_at(home, start)?;
        let index = self.plan_bodies.len();
        let mut inputs: HashMap<String, Place> = HashMap::new();
        inputs.insert(
            "event".to_string(),
            Place::Slot(Root::Event(index), Vec::new()),
        );
        if body_kind == BodyKind::Handler {
            inputs.insert(
                "state".to_string(),
                Place::Slot(Root::Binding(index), Vec::new()),
            );
        } else {
            // What an inline handler or an action captures is its state.
            for entry in record.detail.entries.iter().chain(&record.detail.envelope) {
                if entry.input != "event" && entry.input != "cause" {
                    inputs.insert(
                        entry.input.clone(),
                        Place::Slot(Root::Binding(index), vec![entry.input.clone()]),
                    );
                }
            }
        }
        // The handler's record does not depend on where it is bound.
        let saved_within = std::mem::take(&mut self.within);
        let saved_cone = self.cone.take();
        self.body_record(kind, name, &record, &inputs, false, start, false);
        self.within = saved_within;
        self.cone = saved_cone;
        self.handlers.insert((home, start), index);
        Some(index)
    }

    /// What a path of a binding's state is bound to, in the reactive
    /// tier: every path is a link (PL §3.14).
    fn state_entries(
        &mut self,
        path: &mut Vec<String>,
        place: &Place,
        written: Option<&Expression<'a>>,
        state: &mut Vec<Value>,
    ) {
        let mut entry = Map::new();
        entry.insert("path".to_string(), json!(path.clone()));
        entry.insert("capture".to_string(), json!("link"));
        match place {
            Place::Slot(root, at) => {
                let slot = self.slot(root, at, "identity");
                entry.insert("place".to_string(), json!({ "slot": slot }));
                entry.insert(
                    "template".to_string(),
                    json!({ "op": "slot", "slot": slot }),
                );
            }
            Place::Value(value, at) => {
                // The template is the output's, filled in with the
                // outputs (`finish`).
                self.values[*value].referred = true;
                let output = if at.is_empty() {
                    json!({ "$value": value })
                } else {
                    if !self.values[*value].below.contains(at) {
                        self.values[*value].below.push(at.clone());
                    }
                    json!({ "$value": value, "$path": at })
                };
                entry.insert("place".to_string(), json!({ "output": output }));
            }
            Place::Stream(binding) => {
                // The stream of a binding of the reactive tier is named
                // by the binding's `name` and `within` (PL §3.14), which
                // are constants of the plan.
                entry.insert("place".to_string(), json!({ "stream": binding }));
                entry.insert("template".to_string(), json!({ "op": "const" }));
            }
            Place::Record(fields) => {
                for (name, member) in fields {
                    let below = written.and_then(|written| member_written(written, name));
                    path.push(name.clone());
                    self.state_entries(path, member, below, state);
                    path.pop();
                }
                return;
            }
            // The position of an element: PL has no `place` for it.
            Place::Index(_) => {}
            Place::Const => {
                let constant = written.and_then(constant_of).unwrap_or(Value::Null);
                entry.insert("place".to_string(), json!({ "constant": constant }));
                entry.insert("template".to_string(), json!({ "op": "const" }));
            }
            Place::Unknown => {}
        }
        state.push(Value::Object(entry));
    }

    /// A handler applied to its state in the reactive tier.
    fn bind_handler(
        &mut self,
        home: usize,
        start: u32,
        name: &str,
        arguments: &[&Expression<'a>],
        hint: &str,
    ) -> Place {
        let Some(body) = self.handler_body(home, start, name, "handler") else {
            self.unsupported("a handler that has no footprint record", start);
            return Place::Unknown;
        };
        let mut state = Vec::new();
        if let Some(argument) = arguments.first() {
            // The binding is no cone's computation.
            let saved = self.cone.take();
            let place = self.eval(argument, hint);
            self.cone = saved;
            self.state_entries(&mut Vec::new(), &place, Some(argument), &mut state);
        }
        let name = base_name(hint, name);
        self.bindings.push(json!({
            "handler": { "body": body },
            "state": state,
            "name": name,
            "within": self.within_json(),
        }));
        Place::Stream(self.bindings.len() - 1)
    }

    /// An `action`, or an inline event handler in JSX: a binding of the
    /// function to what it captures.
    fn bind_inline(&mut self, function: FunctionLike<'_, 'a>, kind: BodyKind, hint: &str) -> Place {
        let start = function.span().start;
        let plan_kind = if kind == BodyKind::Action {
            "action"
        } else {
            "handler"
        };
        let Some(body) = self.handler_body(self.module, start, hint, plan_kind) else {
            self.unsupported("a handler that has no footprint record", start);
            return Place::Unknown;
        };
        let Some((_, record)) = self.record_at(self.module, start) else {
            return Place::Unknown;
        };
        let mut captured: BTreeSet<String> = BTreeSet::new();
        for entry in record.detail.entries.iter().chain(&record.detail.envelope) {
            if entry.input != "event" && entry.input != "cause" {
                captured.insert(entry.input.clone());
            }
        }
        let mut state = Vec::new();
        for name in captured {
            let place = match self.env.get(&name) {
                Some(place) => place.clone(),
                None => {
                    self.unsupported(
                        "a capture of a handler that the emitter has no place for",
                        start,
                    );
                    Place::Unknown
                }
            };
            self.state_entries(&mut vec![name], &place, None, &mut state);
        }
        self.bindings.push(json!({
            "handler": { "body": body },
            "state": state,
            "name": hint,
            "within": self.within_json(),
        }));
        Place::Stream(self.bindings.len() - 1)
    }

    // ----- the result -----

    fn keep(&mut self, path: &mut Vec<String>, place: &Place) {
        match place {
            Place::Value(value, _) => self.values[*value].kept.push(path.clone()),
            Place::Record(fields) => {
                for (name, member) in fields {
                    path.push(name.clone());
                    self.keep(path, member);
                    path.pop();
                }
            }
            Place::Slot(root, at) => {
                let slot = self.slot(root, at, "identity");
                self.passed.push(path.clone());
                let (cone, made) = self.computing("result", 0);
                self.cones[cone].slots.insert(slot);
                if made {
                    self.cone = None;
                }
            }
            Place::Stream(_) | Place::Index(_) | Place::Const | Place::Unknown => {}
        }
    }

    /// The `Plan` record, with the cones in an order in which every edge
    /// that is not on a cycle goes from a lower index to a higher one (PL
    /// §1.4).
    #[allow(clippy::type_complexity)]
    fn finish(mut self, file: &str) -> (Value, Vec<(String, u32)>, Vec<(u32, Vec<String>)>) {
        let result_cone = self.cones.iter().rposition(|cone| cone.entry == "result");
        // The edges, over the cones as they were made.
        let count = self.cones.len();
        let mut output_edges: Vec<(usize, usize, usize)> = Vec::new();
        for (to, cone) in self.cones.iter().enumerate() {
            for value in &cone.uses {
                output_edges.push((self.values[*value].cone, to, *value));
            }
        }
        // The edges of the static side-writes (PL §3.11, "Which slots read
        // a `handle` target"): the cone, the cone that reads, `via`, where
        // the write is, and whether the writing body reads its own target.
        let mut write_edges: Vec<(usize, usize, Value, u32, bool)> = Vec::new();
        for (from, cone) in self.cones.iter().enumerate() {
            for body in &cone.bodies {
                let fact = &self.body_facts[*body];
                if !fact.side_writes {
                    continue;
                }
                for target in &fact.targets {
                    let Target {
                        slot,
                        root,
                        at,
                        below,
                        resolved,
                        site,
                        reads_own,
                    } = target;
                    let mut cell = at.clone();
                    cell.extend(below.iter().cloned());
                    let state = matches!(root, Root::State(_));
                    for (to, other) in self.cones.iter().enumerate() {
                        let reads = other.slots.iter().any(|index| {
                            let (other_root, path, class, slot_resolved, in_place) =
                                &self.slots[*index];
                            if other_root != root {
                                return false;
                            }
                            let overlaps = path.starts_with(&cell) || cell.starts_with(path);
                            if state {
                                // No slot is excepted.
                                return overlaps;
                            }
                            if path.len() >= at.len() {
                                // At or below the handle's position. The
                                // handle's `identity` slot and a `shape`
                                // slot in place there observe the
                                // reference and not the cell.
                                let excepted = path == at
                                    && (index == slot
                                        || (*class == "identity" && !*slot_resolved)
                                        || (*class == "shape" && *in_place));
                                return overlaps && !excepted;
                            }
                            // Above the handle's position: a `value` slot
                            // whose type has data there.
                            if *class != "value" || !at.starts_with(path) {
                                return false;
                            }
                            let rest = &at[path.len()..];
                            match other.views.get(index) {
                                Some(views) => views.iter().any(|view| {
                                    view.and_then(|view| self.reaches_cell(view, rest))
                                        .unwrap_or(true)
                                }),
                                None => true,
                            }
                        });
                        if !reads {
                            continue;
                        }
                        let via = match root {
                            Root::State(cell_index) => {
                                json!({ "kind": "state", "cell": cell_index, "path": cell })
                            }
                            _ => {
                                let mut via = Map::new();
                                via.insert("kind".to_string(), json!("handle"));
                                via.insert("slot".to_string(), json!(slot));
                                via.insert("path".to_string(), json!(below));
                                if *resolved {
                                    via.insert("resolved".to_string(), json!(true));
                                }
                                Value::Object(via)
                            }
                        };
                        // The report names the side-write where it is in
                        // this module, and else the function.
                        let at = match site {
                            Some((module, start)) if *module == self.module => *start,
                            _ => fact.at,
                        };
                        write_edges.push((from, to, via, at, *reads_own));
                    }
                }
            }
        }
        // The strongly connected components, in an order that follows the
        // edges and otherwise the order of the source.
        let mut successors: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); count];
        for (from, to, _) in &output_edges {
            successors[*from].insert(*to);
        }
        for (from, to, ..) in &write_edges {
            successors[*from].insert(*to);
        }
        let reaches = |from: usize, to: usize| -> bool {
            let mut seen = vec![false; count];
            let mut stack = vec![from];
            while let Some(next) = stack.pop() {
                for other in &successors[next] {
                    if *other == to {
                        return true;
                    }
                    if !seen[*other] {
                        seen[*other] = true;
                        stack.push(*other);
                    }
                }
            }
            false
        };
        let mut component: Vec<usize> = (0..count).collect();
        for a in 0..count {
            for b in 0..a {
                if component[b] == b && reaches(a, b) && reaches(b, a) {
                    component[a] = b;
                    break;
                }
            }
        }
        let mut order: Vec<usize> = Vec::new();
        let mut placed = vec![false; count];
        while order.len() < count {
            let next = (0..count).find(|cone| {
                !placed[*cone]
                    && (0..count).all(|other| {
                        placed[other]
                            || component[other] == component[*cone]
                            || !successors[other].contains(cone)
                    })
            });
            // Every cone of a component follows its first one.
            let next = next.unwrap_or_else(|| (0..count).find(|cone| !placed[*cone]).unwrap_or(0));
            for cone in 0..count {
                if !placed[cone] && component[cone] == component[next] {
                    placed[cone] = true;
                    order.push(cone);
                }
            }
        }
        let mut position = vec![0usize; count];
        for (index, cone) in order.iter().enumerate() {
            position[*cone] = index;
        }
        // The static side-writes on a cycle (`side-write:cycle`): an edge
        // on a cycle through another cone, and an edge from a cone to
        // itself where the writing body does not read its own target
        // (`scheduler-and-serving-loop.md` §8.2).
        let mut cycles: Vec<(u32, Vec<String>)> = Vec::new();
        for (from, to, _, at, reads_own) in &write_edges {
            let reported = if from == to {
                !*reads_own
            } else {
                reaches(*to, *from)
            };
            if reported {
                let mut names: Vec<String> = (0..count)
                    .filter(|cone| component[*cone] == component[*from])
                    .map(|cone| self.cones[cone].entry.clone())
                    .collect();
                names.sort();
                if !cycles.iter().any(|(other, _)| other == at) {
                    cycles.push((*at, names));
                }
            }
        }
        // The outputs, by cone in the order of the plan, and within a
        // cone in source order.
        let mut output_of: HashMap<(usize, Vec<String>), usize> = HashMap::new();
        let mut listed: Vec<(usize, usize, Option<(usize, Vec<String>)>, Value)> = Vec::new();
        for value in &self.values {
            let cone = position[value.cone];
            let mut entry = |path: Value, interim: Option<&str>, kept: bool, below: &[String]| {
                let mut output = Map::new();
                output.insert("path".to_string(), path);
                if let Some(interim) = interim {
                    output.insert("interim".to_string(), json!(interim));
                }
                output.insert("cone".to_string(), json!(cone));
                if let Some(collection) = value.collection {
                    output.insert("collection".to_string(), json!(collection));
                }
                if let Some(template) = &value.template {
                    output.insert("template".to_string(), template.clone());
                }
                output.insert("kept".to_string(), json!(kept));
                output.insert("constraints".to_string(), json!([]));
                let assembled = Value::Object(output.clone());
                listed.push((
                    cone,
                    value.order,
                    Some((value.order, below.to_vec())),
                    assembled,
                ));
                // The per-element entry of an element construct: its
                // path "has `*` at the position of each enclosing
                // collection", and its template is over `element` slots
                // (PL §1.4).
                if let (Some(element), true) = (&value.element, below.is_empty()) {
                    let mut path: Vec<Value> =
                        output["path"].as_array().cloned().unwrap_or_default();
                    path.push(json!("*"));
                    output.insert("path".to_string(), json!(path));
                    output.remove("collection");
                    output.remove("template");
                    if let Some(element) = element {
                        output.insert("template".to_string(), element.clone());
                    }
                    listed.push((cone, value.order, None, Value::Object(output)));
                }
            };
            for path in &value.kept {
                entry(json!(path), None, true, &[]);
            }
            if value.kept.is_empty() && value.referred {
                entry(json!([]), Some(&value.name), false, &[]);
            }
            for path in &value.below {
                entry(json!(path), Some(&value.name), false, path);
            }
        }
        if let Some(result) = result_cone {
            for (index, path) in self.passed.iter().enumerate() {
                listed.push((
                    position[result],
                    usize::MAX - self.passed.len() + index,
                    None,
                    json!({
                        "path": path,
                        "cone": position[result],
                        "kept": true,
                        "constraints": [],
                    }),
                ));
            }
        }
        listed.sort_by_key(|(cone, order, _, _)| (*cone, *order));
        let mut outputs: Vec<Value> = Vec::new();
        for (_, _, value, output) in listed {
            if let Some(value) = value {
                output_of.entry(value).or_insert(outputs.len());
            }
            outputs.push(output);
        }
        let mut sorted_edges: Vec<(usize, usize, Value)> = Vec::new();
        for (from, to, value) in &output_edges {
            if let Some(output) = output_of.get(&(*value, Vec::new())) {
                sorted_edges.push((
                    position[*from],
                    position[*to],
                    json!({ "kind": "output", "output": output }),
                ));
            }
        }
        for (from, to, via, ..) in &write_edges {
            sorted_edges.push((position[*from], position[*to], via.clone()));
        }
        sorted_edges.sort_by_key(|(from, to, via)| (*from, *to, via.to_string()));
        let mut edges: Vec<Value> = Vec::new();
        for (from, to, via) in sorted_edges {
            let edge = json!({ "from": from, "to": to, "via": via });
            if !edges.contains(&edge) {
                edges.push(edge);
            }
        }
        let cones: Vec<Value> = order
            .iter()
            .map(|index| {
                let cone = &self.cones[*index];
                json!({
                    "entry": cone.entry,
                    "at": { "file": file, "start": cone.at },
                    "slots": cone.slots.iter().collect::<Vec<_>>(),
                    "bodies": cone.bodies,
                    "selectors": cone.selectors,
                    "picks": cone.picks,
                    "writes": cone.writes,
                })
            })
            .collect();
        let slots: Vec<Value> = self
            .slots
            .iter()
            .map(|(root, path, class, resolved, in_place)| {
                let mut slot = Map::new();
                slot.insert("root".to_string(), root_json(root));
                slot.insert("path".to_string(), json!(path));
                slot.insert("observes".to_string(), json!(class));
                if *resolved {
                    slot.insert("resolved".to_string(), json!(true));
                }
                if *in_place {
                    slot.insert("inPlace".to_string(), json!(true));
                }
                Value::Object(slot)
            })
            .collect();
        let dynamic_reads = std::mem::take(&mut self.dynamic_reads);
        let mut plan = json!({
            "version": 1,
            "slots": slots,
            "selectors": self.selectors.iter().map(|arity| json!({ "arity": arity })).collect::<Vec<Value>>(),
            "picks": self.picks.iter().map(|by| json!({ "chosenBy": by })).collect::<Vec<Value>>(),
            "collections": self.collections,
            "bodies": self.plan_bodies,
            "dynamicReads": dynamic_reads,
            "constraints": [],
            "outputs": outputs,
            "cones": cones,
            "edges": edges,
            "stateCells": self.state_cells,
            "operations": self.operations,
            "children": self.children,
            "closures": [],
            "bindings": self.bindings,
        });
        // A record that refers to a value names its output.
        let mut missing = false;
        resolve_values(&mut plan, &output_of, &mut missing);
        if missing {
            self.unsupported
                .push(("a reference to a value that has no output".to_string(), 0));
        }
        name_ordinals(&mut plan);
        // A state path that resolves to an output has the output's
        // template (PL §1.1, `Binding.state.place`).
        let outputs = plan["outputs"].clone();
        for binding in plan["bindings"].as_array_mut().into_iter().flatten() {
            for entry in binding["state"].as_array_mut().into_iter().flatten() {
                let template = entry["place"]["output"]
                    .as_u64()
                    .and_then(|output| outputs[output as usize].get("template").cloned());
                if let (Some(template), Some(entry)) = (template, entry.as_object_mut()) {
                    entry.insert("template".to_string(), template);
                }
            }
        }
        (plan, self.unsupported, cycles)
    }
}

/// The join of several templates: expression code over them (PL §3.2).
fn join(inputs: Vec<Value>) -> Value {
    json!({ "op": "derive", "inputs": inputs, "by": { "expression": true } })
}

/// A `select` node, where the condition and every branch have a template.
fn select_node(
    selector: usize,
    condition: Option<Value>,
    branches: Vec<Option<Value>>,
) -> Option<Value> {
    let branches: Option<Vec<Value>> = branches.into_iter().collect();
    Some(json!({
        "op": "select",
        "selector": selector,
        "condition": condition?,
        "branches": branches?,
    }))
}

/// Whether a hint names no declaration: the expression is an operand, a
/// branch, a condition, or a JSX child.
fn anonymous(hint: &str) -> bool {
    matches!(hint, "branch" | "operand" | "condition" | "child")
}

/// A hint that starts with `@` is the property or the JSX attribute an
/// expression is written at, and not a `const` it is assigned to.
fn written_at(hint: &str) -> &str {
    hint.strip_prefix('@').unwrap_or(hint)
}

/// The name of a declaration that has a base name (PL §1.3): the name of
/// the `const` it is assigned to, and else the base name.
fn base_name<'n>(hint: &'n str, base: &'n str) -> &'n str {
    if hint.starts_with('@') || anonymous(hint) {
        base
    } else {
        hint
    }
}

/// The name of a declaration that has no base name (PL §1.3): the name
/// of the `const`, else the property or the attribute it is written at,
/// and else the name of the construct.
fn fallback_name<'n>(hint: &'n str, construct: &'n str) -> &'n str {
    if anonymous(hint) {
        construct
    } else {
        written_at(hint)
    }
}

/// The expression written at a member of an object or an array literal.
fn member_written<'e, 'a>(written: &'e Expression<'a>, name: &str) -> Option<&'e Expression<'a>> {
    match unwrap(written) {
        Expression::ObjectExpression(object) => object.properties.iter().find_map(|property| {
            let ObjectPropertyKind::ObjectProperty(property) = property else {
                return None;
            };
            (!property.computed && static_key_name(&property.key) == Some(name))
                .then_some(&property.value)
        }),
        Expression::ArrayExpression(array) => array
            .elements
            .get(name.parse::<usize>().ok()?)
            .and_then(|element| element.as_expression()),
        _ => None,
    }
}

/// The value of a literal written in place, as the plan holds it.
fn constant_of(written: &Expression<'_>) -> Option<Value> {
    match unwrap(written) {
        Expression::StringLiteral(literal) => Some(json!(literal.value.as_str())),
        Expression::NumericLiteral(literal) => {
            if literal.value.fract() == 0.0 && literal.value.abs() < 9.0e15 {
                Some(json!(literal.value as i64))
            } else {
                Some(json!(literal.value))
            }
        }
        Expression::BooleanLiteral(literal) => Some(json!(literal.value)),
        Expression::NullLiteral(_) => Some(Value::Null),
        Expression::TemplateLiteral(template) if template.expressions.is_empty() => template
            .quasis
            .first()
            .and_then(|quasi| quasi.value.cooked.as_ref())
            .map(|text| json!(text.as_str())),
        _ => None,
    }
}

/// The paths of a request: one per member of a record written at the
/// site, and the root otherwise.
fn request_paths(place: &Place, path: &mut Vec<String>, found: &mut Vec<Vec<String>>) {
    match place {
        Place::Record(fields) if !fields.is_empty() => {
            for (name, member) in fields {
                path.push(name.clone());
                request_paths(member, path, found);
                path.pop();
            }
        }
        _ => found.push(path.clone()),
    }
}

/// Replaces each `{ "$value": n }` by the index of the output of value `n`.
fn resolve_values(
    value: &mut Value,
    output_of: &HashMap<(usize, Vec<String>), usize>,
    missing: &mut bool,
) {
    match value {
        Value::Object(members) => {
            if let Some(Value::Number(number)) = members.get("$value") {
                let index = number.as_u64().unwrap_or(0) as usize;
                let path: Vec<String> = members
                    .get("$path")
                    .and_then(Value::as_array)
                    .map(|path| {
                        path.iter()
                            .filter_map(|segment| segment.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                match output_of.get(&(index, path)) {
                    Some(output) => *value = json!(output),
                    None => {
                        *missing = true;
                        *value = Value::Null;
                    }
                }
                return;
            }
            for member in members.values_mut() {
                resolve_values(member, output_of, missing);
            }
        }
        Value::Array(elements) => {
            for element in elements {
                resolve_values(element, output_of, missing);
            }
        }
        _ => {}
    }
}

/// Where two declarations of one pattern body have the same name, each
/// takes the name and its ordinal among them, in source order (PL §1.3).
fn name_ordinals(plan: &mut Value) {
    let tables = [
        "stateCells",
        "operations",
        "children",
        "collections",
        "bodies",
        "bindings",
    ];
    // A handler is one record however many bindings name it, and is not
    // one more declaration of the name its bindings have: the names of
    // the bodies are counted apart from the others.
    let kind = |table: &str| table == "bodies";
    let mut counts: BTreeMap<(bool, String, String), usize> = BTreeMap::new();
    for table in tables {
        for record in plan[table].as_array().into_iter().flatten() {
            // A thing a site of a body makes is named from the body.
            if record.get("$of").is_some() {
                continue;
            }
            if let Some(name) = record["name"].as_str() {
                *counts
                    .entry((kind(table), record["within"].to_string(), name.to_string()))
                    .or_default() += 1;
            }
        }
    }
    let mut ordinals: BTreeMap<(bool, String, String), usize> = BTreeMap::new();
    for table in tables {
        for record in plan[table].as_array_mut().into_iter().flatten() {
            if record.get("$of").is_some() {
                continue;
            }
            let Some(name) = record["name"].as_str().map(str::to_string) else {
                continue;
            };
            let key = (kind(table), record["within"].to_string(), name.clone());
            if counts.get(&key).copied().unwrap_or(0) > 1 {
                let ordinal = ordinals.entry(key).or_default();
                *ordinal += 1;
                record["name"] = json!(format!("{name}#{ordinal}"));
            }
        }
    }
    // "A `Child` that a site of `Body.calls` instantiates has the body's
    // `name`, `/n`, and the index of the site in `Body.calls`" (PL §1.3).
    let bodies = plan["bodies"].clone();
    for table in ["children", "stateCells"] {
        for record in plan[table].as_array_mut().into_iter().flatten() {
            let Some(record) = record.as_object_mut() else {
                continue;
            };
            if let Some(of) = record.remove("$of") {
                let body = of[0].as_u64().unwrap_or(0) as usize;
                let name = format!(
                    "{}{}",
                    bodies[body]["name"].as_str().unwrap_or(""),
                    of[1].as_str().unwrap_or("")
                );
                record.insert("name".to_string(), json!(name));
            }
        }
    }
}

/// The plan of each pattern of module `module`.
pub fn emit_module<'a>(
    resolver: &Resolver<'_, 'a>,
    module: usize,
    bodies: &[Vec<Body>],
    records: &[Vec<(usize, Record)>],
) -> Vec<PatternPlan> {
    let Some(parsed) = resolver.parsed(module) else {
        return Vec::new();
    };
    let mut plans = Vec::new();
    let starts = body_functions(resolver, module, &bodies[module]);
    for (index, body) in bodies[module].iter().enumerate() {
        // A pattern compiled into another has no plan of its own.
        if body.kind != BodyKind::Pattern || body.parent.is_some() {
            continue;
        }
        let Some((_, start)) = starts.iter().find(|(other, _)| *other == index) else {
            continue;
        };
        let mut emitter = Emitter {
            resolver,
            module,
            bodies,
            records,
            functions: HashMap::new(),
            body_starts: HashMap::new(),
            env: HashMap::new(),
            within: Vec::new(),
            cone: None,
            slots: Vec::new(),
            values: Vec::new(),
            cones: Vec::new(),
            selectors: Vec::new(),
            picks: Vec::new(),
            collections: Vec::new(),
            plan_bodies: Vec::new(),
            body_facts: Vec::new(),
            dynamic_reads: Vec::new(),
            state_cells: Vec::new(),
            operations: Vec::new(),
            children: Vec::new(),
            bindings: Vec::new(),
            handlers: HashMap::new(),
            passed: Vec::new(),
            unsupported: Vec::new(),
            operands: Vec::new(),
            opaque: false,
            body_dynamic: Vec::new(),
            formal_types: HashMap::new(),
            iterated: Vec::new(),
        };
        let Some(function) = emitter.function_at(module, *start) else {
            continue;
        };
        if let Some(parameter) = function.params().items.first() {
            emitter.bind_pattern(&parameter.pattern, Place::Slot(Root::Argument, Vec::new()));
        }
        let result = match function.expression_body() {
            Some(expression) => Some(emitter.eval(expression, "result")),
            None => function
                .block_body()
                .and_then(|statements| emitter.statements(statements)),
        };
        if let Some(result) = result {
            emitter.keep(&mut Vec::new(), &result);
        }
        let (plan, unsupported, cycles) = emitter.finish(&parsed.path);
        plans.push(PatternPlan {
            name: body.name.clone(),
            line: body.line,
            plan,
            unsupported,
            cycles,
        });
    }
    plans
}

/// For how many of the accepted modules of a program a plan is emitted
/// with no unsupported construct, and the unsupported constructs by kind.
pub fn corpus_summary(analysis: &crate::program::ProgramAnalysis) -> String {
    let accepted: Vec<&crate::program::ModuleAnalysis> = analysis
        .modules
        .iter()
        .filter(|module| module.accepted())
        .collect();
    let with_patterns: Vec<&&crate::program::ModuleAnalysis> = accepted
        .iter()
        .filter(|module| !module.plans.is_empty())
        .collect();
    let complete = with_patterns
        .iter()
        .filter(|module| module.plans.iter().all(|plan| plan.unsupported.is_empty()))
        .count();
    let patterns: usize = with_patterns.iter().map(|module| module.plans.len()).sum();
    let complete_patterns = with_patterns
        .iter()
        .flat_map(|module| &module.plans)
        .filter(|plan| plan.unsupported.is_empty())
        .count();
    let mut kinds: BTreeMap<String, (usize, BTreeSet<&str>)> = BTreeMap::new();
    for module in &with_patterns {
        for plan in &module.plans {
            for (kind, _) in &plan.unsupported {
                // A method or a built-in is counted under one kind, and
                // listed by name after it.
                let entry = kinds.entry(kind.clone()).or_default();
                entry.0 += 1;
                entry.1.insert(module.path.as_str());
            }
        }
    }
    let cycles: usize = accepted
        .iter()
        .flat_map(|module| &module.plans)
        .map(|plan| plan.cycles.len())
        .sum();
    let mut out = String::new();
    out.push_str(&format!(
        "modules: {} parsed, {} accepted, {} accepted with a pattern\n",
        analysis.modules.len(),
        accepted.len(),
        with_patterns.len()
    ));
    out.push_str(&format!(
        "plans emitted with no unsupported construct: {complete} of {} modules, {complete_patterns} of {patterns} patterns\n",
        with_patterns.len()
    ));
    out.push_str(&format!("side-write:cycle: {cycles}\n"));
    // The uses of bodies, and how many have an input bound to a value the
    // instance computed (FA §1.1).
    let mut uses = 0;
    let mut with_computed = 0;
    let mut computed_handles = 0;
    let (mut cones, mut edges, mut write_edges) = (0, 0, 0);
    for plan in accepted.iter().flat_map(|module| &module.plans) {
        for body in plan.plan["bodies"].as_array().into_iter().flatten() {
            uses += 1;
            if body["computed"]
                .as_array()
                .is_some_and(|list| !list.is_empty())
            {
                with_computed += 1;
            }
            computed_handles += body["handles"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|handle| handle["handle"].get("computed").is_some())
                .count();
        }
        cones += plan.plan["cones"].as_array().map_or(0, Vec::len);
        for edge in plan.plan["edges"].as_array().into_iter().flatten() {
            edges += 1;
            if edge["via"]["kind"] != "output" {
                write_edges += 1;
            }
        }
    }
    out.push_str(&format!(
        "uses of bodies: {uses}, {with_computed} with an entry of `computed`; handles named by a computed entry: {computed_handles}\n"
    ));
    out.push_str(&format!(
        "cones: {cones}; edges: {edges}, {write_edges} through a side-write\n"
    ));
    out.push_str("unsupported constructs, by kind (sites, modules):\n");
    let mut sorted: Vec<(&String, &(usize, BTreeSet<&str>))> = kinds.iter().collect();
    sorted.sort_by_key(|(kind, (sites, _))| (usize::MAX - *sites, kind.to_string()));
    for (kind, (sites, modules)) in sorted {
        out.push_str(&format!("  {sites:5} {:4}  {kind}\n", modules.len()));
    }
    out
}
