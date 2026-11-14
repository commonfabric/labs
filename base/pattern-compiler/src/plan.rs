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
    bind_use, body_functions, parameter_names, Class, Entry, HandleAt, Record, RefName, Seg,
    UseRecord, WriteRec, WriteTarget,
};
use crate::module::{symbol_of, Binding, DefKind};
use oxc_syntax::symbol::SymbolId;
use crate::program::Resolver;
use crate::syntax::{static_key_name, unwrap, FunctionLike};
use crate::tiers::{Body, BodyKind};

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
    /// offset of the writing body, and the names of the cones on the
    /// cycle.
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
    /// Whether a record of the plan refers to the value.
    referred: bool,
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
}

type SlotKey = (Root, Vec<String>, &'static str, bool, bool);
type Target = (usize, Root, Vec<String>, Vec<String>, bool);
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
    selectors: usize,
    picks: usize,
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
}

/// What the edges of the plan need of a body.
#[derive(Default)]
struct BodyFact {
    /// Whether the body is a computation whose side-writes are all static.
    side_writes: bool,
    at: u32,
    /// The static targets: the slot of the handle, its root and path, the
    /// path below the cell, and `resolved`.
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
        let def =
            self.resolver
                .resolve_import(self.module, import, &import.bindings[binding].imported)?;
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
                AstKind::CallExpression(call)
                    if from <= call.span.start && call.span.end <= to =>
                {
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

    // ----- cones and values -----

    /// The cone the expression being evaluated belongs to, made where
    /// there is none.
    fn computing(&mut self, name: &str, at: u32) -> (usize, bool) {
        match self.cone {
            Some(cone) => (cone, false),
            None => {
                self.cones.push(ConeOut {
                    entry: name.to_string(),
                    at,
                    slots: BTreeSet::new(),
                    bodies: Vec::new(),
                    writes: Vec::new(),
                    selectors: Vec::new(),
                    picks: Vec::new(),
                    uses: BTreeSet::new(),
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
            name: name.to_string(),
            cone,
            kept: Vec::new(),
            collection: None,
            referred: false,
            order,
        });
        order
    }

    /// A selection point of the cone being evaluated: a `select` with two
    /// branches (PL §3.5).
    fn selector(&mut self) {
        if let Some(cone) = self.cone {
            self.cones[cone].selectors.push(self.selectors);
            self.selectors += 1;
        }
    }

    /// A dynamic key in the reactive tier: a `pick` whose choice the value
    /// code reports (PL §3.18).
    fn pick(&mut self, object: &Place, key: &Place, hint: &str, at: u32) -> Place {
        let object = object.clone();
        let key = key.clone();
        self.in_cone(hint, at, |emitter, cone| {
            emitter.cones[cone].picks.push(emitter.picks);
            emitter.picks += 1;
            emitter.consume(&key);
            match &object {
                Place::Slot(root, path) => {
                    // The chosen child is one of the container's.
                    let mut child = path.clone();
                    child.push("*".to_string());
                    let slot = emitter.slot(root, &child, "value");
                    emitter.cones[cone].slots.insert(slot);
                }
                other => emitter.pass(other),
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

    fn observe(&mut self, place: &Place, class: &'static str) {
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
    /// statement body (`language-subset.md` §6.1).
    fn code_block(&mut self, statements: &[Statement<'a>]) {
        for statement in statements {
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
                    self.selector();
                    let test = self.eval(&statement.test, "condition");
                    self.consume(&test);
                    self.code_block(std::slice::from_ref(&statement.consequent));
                    if let Some(alternate) = &statement.alternate {
                        self.code_block(std::slice::from_ref(alternate));
                    }
                }
                Statement::BlockStatement(block) => self.code_block(&block.body),
                Statement::ReturnStatement(statement) => {
                    if let Some(argument) = &statement.argument {
                        let place = self.eval(argument, "branch");
                        self.pass(&place);
                    }
                }
                Statement::EmptyStatement(_) => {}
                other => {
                    self.unsupported("a statement of expression code", other.span().start);
                }
            }
        }
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
                            let member = self.eval(&property.value, &name);
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
                self.in_cone(hint, at, |emitter, _| match expression {
                    Expression::JSXElement(element) => emitter.jsx_element(element),
                    Expression::JSXFragment(fragment) => {
                        for child in &fragment.children {
                            emitter.jsx_child(child);
                        }
                    }
                    _ => {}
                })
            }
            Expression::ConditionalExpression(conditional) => {
                self.in_cone(hint, at, |emitter, _| {
                    emitter.selector();
                    let test = emitter.eval(&conditional.test, "condition");
                    emitter.consume(&test);
                    for branch in [&conditional.consequent, &conditional.alternate] {
                        let place = emitter.eval(branch, "branch");
                        emitter.pass(&place);
                    }
                })
            }
            Expression::LogicalExpression(logical) => self.in_cone(hint, at, |emitter, _| {
                emitter.selector();
                let left = emitter.eval(&logical.left, "condition");
                emitter.consume(&left);
                let right = emitter.eval(&logical.right, "branch");
                emitter.pass(&right);
            }),
            Expression::BinaryExpression(binary) => self.in_cone(hint, at, |emitter, _| {
                for operand in [&binary.left, &binary.right] {
                    let place = emitter.eval(operand, "operand");
                    emitter.consume(&place);
                }
            }),
            Expression::UnaryExpression(unary) => self.in_cone(hint, at, |emitter, _| {
                let place = emitter.eval(&unary.argument, "operand");
                emitter.consume(&place);
            }),
            Expression::TemplateLiteral(template) => self.in_cone(hint, at, |emitter, _| {
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
            "name": hint,
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
                        let name = if matches!(hint, "branch" | "operand" | "condition" | "child") {
                            identifier.name.to_string()
                        } else {
                            hint.to_string()
                        };
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
                            return self.in_cone(hint, at, |emitter, _| {
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
                                hint.to_string()
                            }
                            _ => hint.to_string(),
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
                        self.use_body(self.module, start, hint, &arguments, hint, at)
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
            "map" | "filter" | "flatMap" => {
                match arguments.first().and_then(|first| FunctionLike::of(first)) {
                    Some(function) => self.collection(receiver, name, function, hint, at),
                    None => {
                        self.unsupported("an element construct with no callback in place", at);
                        Place::Unknown
                    }
                }
            }
            "for" | "asSchema" | "withTx" => receiver.clone(),
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
                self.in_cone(hint, at, |emitter, _| {
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
        let name = if matches!(hint, "branch" | "operand" | "condition" | "child") {
            via
        } else {
            hint
        };
        let source = match receiver {
            Place::Slot(root, path) => {
                let slot = self.slot(root, path, "enumeration");
                json!({ "slot": slot })
            }
            Place::Value(value, _) => {
                self.values[*value].referred = true;
                match self.values[*value].collection {
                    Some(collection) => json!({ "collection": collection, "via": via }),
                    None => json!({ "output": { "$value": value } }),
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
                let array = self.in_cone(name, at, |emitter, _| emitter.pass(&receiver));
                self.cone = saved;
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
        // The body: one cone, evaluated once per element key.
        let saved_env = self.env.clone();
        let saved_cone = self.cone.take();
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
        let result = match function.expression_body() {
            Some(expression) => Some(self.eval(expression, name)),
            None => function
                .block_body()
                .and_then(|statements| self.statements(statements)),
        };
        if let Some(result) = &result {
            self.pass(result);
        }
        self.within.pop();
        self.cone = saved_cone;
        self.env = saved_env;
        let value = self.value(name, cone);
        self.values[value].collection = Some(collection);
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
                    return self.use_body(self.module, start, hint, &[], hint, at);
                }
                // Promoted: expression code.
                match function.expression_body() {
                    Some(expression) => self.in_cone(hint, at, |emitter, _| {
                        let place = emitter.eval(expression, hint);
                        emitter.pass(&place);
                    }),
                    None => {
                        let statements = function.block_body().unwrap_or(&[]);
                        let saved = self.env.clone();
                        let place = self.in_cone(hint, at, |emitter, _| {
                            emitter.code_block(statements);
                        });
                        self.env = saved;
                        place
                    }
                }
            }
            "action" => match arguments.first().and_then(|first| FunctionLike::of(first)) {
                Some(function) => self.bind_inline(function, BodyKind::Action, hint),
                None => {
                    self.unsupported("an `action` of a function not written in place", at);
                    Place::Unknown
                }
            },
            "ifElse" | "when" | "unless" | "str" => self.in_cone(hint, at, |emitter, _| {
                if name != "str" {
                    emitter.selector();
                }
                for (index, argument) in arguments.iter().enumerate() {
                    let place = emitter.eval(argument, hint);
                    if index == 0 || name == "str" {
                        emitter.consume(&place);
                    } else {
                        emitter.pass(&place);
                    }
                }
            }),
            _ if EFFECTS.contains(&name) => {
                let operation = self.operations.len();
                self.operations.push(json!({
                    "kind": "effect",
                    "implementation": { "builtin": name },
                    "name": hint,
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
            "spaceOf" | "equals" => self.in_cone(hint, at, |emitter, _| {
                for argument in arguments {
                    let place = emitter.eval(argument, "operand");
                    emitter.resolve(&place);
                }
            }),
            "principalOf" | "principalsOf" | "profileOwnerOf" => {
                self.in_cone(hint, at, |emitter, _| {
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
                self.in_cone(hint, at, |emitter, _| {
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
                            emitter
                                .dynamic_reads
                                .push(json!({ "why": { "kind": "space", "of": slot } }));
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
            "linksOf" => self.in_cone(hint, at, |emitter, _| {
                if let Some(first) = arguments.first() {
                    let place = emitter.eval(first, "operand");
                    emitter.observe(&place, "enumeration");
                    emitter.pass(&Self::extend(&place, "*"));
                }
            }),
            // A rendering as text reads every operand by `value`, over its
            // whole subtree (BI, "Debug strings").
            "toIndentedDebugString" | "toCompactDebugString" => {
                self.in_cone(hint, at, |emitter, _| {
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
                                    let place = self.eval(expression, &name);
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
        let used: UseRecord = bind_use(record, &computed);
        let mut reads: Vec<usize> = Vec::new();
        let mut computed_inputs: Vec<Value> = Vec::new();
        let mut names: Names = HashMap::new();
        // The `value` entries, for an operand that names a space.
        let mut value_names: Names = HashMap::new();
        let identity_at = |entries: &[Entry], input: &str, path: &[Seg]| {
            entries.iter().any(|entry| {
                entry.input == input
                    && entry.path == path
                    && matches!(entry.class, Class::Identity | Class::Resolved)
            })
        };
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
                        && identity_at(&used.reads, &entry.input, &entry.path);
                    let slot =
                        self.slot_with(&root, &path, class_name(entry.class), resolved, in_place);
                    if !reads.contains(&slot) {
                        reads.push(slot);
                    }
                    if matches!(entry.class, Class::Identity | Class::Resolved) {
                        names.insert(key, json!(slot));
                    } else if entry.class == Class::Value {
                        value_names.insert(key, json!(slot));
                    }
                }
                Place::Const | Place::Index(_) | Place::Stream(_) => {}
                place => {
                    if let Place::Value(value, _) = &place {
                        self.values[*value].referred = true;
                        if let Some(cone) = self.cone {
                            if self.values[*value].cone != cone {
                                self.cones[cone].uses.insert(*value);
                            }
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
                    computed_inputs.push(json!({
                        "at": at_path,
                        "observes": class_name(entry.class),
                    }));
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
                    self.dynamic_reads.push(json!({
                        "why": { "kind": "handle", "body": index, "handle": handles.len() },
                    }));
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
            self.dynamic_reads
                .push(json!({ "why": { "kind": "link", "through": link } }));
        }
        if used.label_metadata {
            self.dynamic_reads.push(json!({
                "why": { "kind": "labelMetadata", "body": index },
            }));
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
            self.dynamic_reads
                .push(json!({ "why": { "kind": "space", "of": of } }));
        }
        // `Body.calls`.
        let mut calls: Vec<Value> = Vec::new();
        let mut child_of_call: HashMap<usize, usize> = HashMap::new();
        for (number, call) in record.calls.iter().enumerate() {
            let call_name = format!("{name}/n{number}");
            calls.push(match call.as_str() {
                "instantiate:order" | "instantiate:tag" => {
                    self.children.push(json!({
                        "name": call_name,
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
                    self.unsupported(
                        "a binding made in a function body: its handler and state",
                        at,
                    );
                    self.bindings.push(json!({ "within": self.within_json() }));
                    json!({ "kind": "bind", "binding": self.bindings.len() - 1 })
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
            side_writes: computation && record.tier == Some("static side-write"),
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
                    let mut target = Map::new();
                    target.insert("kind".to_string(), json!("handle"));
                    match &handle {
                        Some(Value::Number(slot)) => {
                            target.insert("slot".to_string(), json!(slot));
                            let slot = slot.as_u64().unwrap_or(0) as usize;
                            if *fixed && named.is_none() {
                                let (root, slot_at, ..) = self.slots[slot].clone();
                                fact.targets
                                    .push((slot, root, slot_at, below.clone(), *resolved));
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
                    Value::Object(target)
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
        self.body_record(plan_kind, &name, &record, &inputs, prefix, start, true);
        if made {
            self.cone = None;
        }
        Place::Value(self.value(&hint, cone), Vec::new())
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
    fn state_entries(&mut self, path: &mut Vec<String>, place: &Place, state: &mut Vec<Value>) {
        let bound = match place {
            Place::Slot(root, at) => {
                let slot = self.slot(root, at, "identity");
                json!({ "slot": slot })
            }
            Place::Value(value, at) => {
                self.values[*value].referred = true;
                json!({ "output": { "$value": value }, "path": at })
            }
            Place::Stream(binding) => json!({ "binding": binding }),
            Place::Record(fields) => {
                for (name, member) in fields {
                    path.push(name.clone());
                    self.state_entries(path, member, state);
                    path.pop();
                }
                return;
            }
            Place::Index(collection) => json!({ "index": collection }),
            Place::Const => json!({ "constant": true }),
            Place::Unknown => json!({}),
        };
        state.push(json!({ "path": path.clone(), "capture": "link", "bound": bound }));
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
            self.state_entries(&mut Vec::new(), &place, &mut state);
        }
        let name = if matches!(hint, "branch" | "operand" | "condition" | "child") {
            name
        } else {
            hint
        };
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
            self.state_entries(&mut vec![name], &place, &mut state);
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
        let mut write_edges: Vec<(usize, usize, Value, u32)> = Vec::new();
        for (from, cone) in self.cones.iter().enumerate() {
            for body in &cone.bodies {
                let fact = &self.body_facts[*body];
                if !fact.side_writes {
                    continue;
                }
                for (slot, root, at, below, resolved) in &fact.targets {
                    let mut cell = at.clone();
                    cell.extend(below.iter().cloned());
                    for (to, other) in self.cones.iter().enumerate() {
                        let reads = other.slots.iter().any(|index| {
                            let (other_root, path, class, _, in_place) = &self.slots[*index];
                            other_root == root
                                && !*in_place
                                && !(path == at && *class == "identity")
                                && path.len() >= at.len()
                                && (path.starts_with(&cell) || cell.starts_with(path))
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
                        write_edges.push((from, to, via, fact.at));
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
        for (from, to, _, _) in &write_edges {
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
        // The static side-writes on a cycle (`side-write:cycle`).
        let mut cycles: Vec<(u32, Vec<String>)> = Vec::new();
        for (from, to, _, at) in &write_edges {
            if from != to && reaches(*to, *from) {
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
        let mut output_of: HashMap<usize, usize> = HashMap::new();
        let mut listed: Vec<(usize, usize, Option<usize>, Value)> = Vec::new();
        for value in &self.values {
            let cone = position[value.cone];
            let mut entry = |path: Value, interim: Option<&str>, kept: bool| {
                let mut output = Map::new();
                output.insert("path".to_string(), path);
                if let Some(interim) = interim {
                    output.insert("interim".to_string(), json!(interim));
                }
                output.insert("cone".to_string(), json!(cone));
                if let Some(collection) = value.collection {
                    output.insert("collection".to_string(), json!(collection));
                }
                output.insert("kept".to_string(), json!(kept));
                output.insert("constraints".to_string(), json!([]));
                listed.push((cone, value.order, Some(value.order), Value::Object(output)));
            };
            for path in &value.kept {
                entry(json!(path), None, true);
            }
            if value.kept.is_empty() && value.referred {
                entry(json!([]), Some(&value.name), false);
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
            if let Some(output) = output_of.get(value) {
                sorted_edges.push((
                    position[*from],
                    position[*to],
                    json!({ "kind": "output", "output": output }),
                ));
            }
        }
        for (from, to, via, _) in &write_edges {
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
        let mut dynamic_reads: Vec<Value> = Vec::new();
        for read in std::mem::take(&mut self.dynamic_reads) {
            if !dynamic_reads.contains(&read) {
                dynamic_reads.push(read);
            }
        }
        let mut plan = json!({
            "version": 1,
            "slots": slots,
            "selectors": vec![json!({ "arity": 2 }); self.selectors],
            "picks": vec![json!({ "chosenBy": "valueCode" }); self.picks],
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
        (plan, self.unsupported, cycles)
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
fn resolve_values(value: &mut Value, output_of: &HashMap<usize, usize>, missing: &mut bool) {
    match value {
        Value::Object(members) => {
            if let Some(Value::Number(number)) = members.get("$value") {
                let index = number.as_u64().unwrap_or(0) as usize;
                match output_of.get(&index) {
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
    let mut counts: BTreeMap<(String, String), usize> = BTreeMap::new();
    for table in tables {
        for record in plan[table].as_array().into_iter().flatten() {
            if let Some(name) = record["name"].as_str() {
                *counts
                    .entry((record["within"].to_string(), name.to_string()))
                    .or_default() += 1;
            }
        }
    }
    let mut ordinals: BTreeMap<(String, String), usize> = BTreeMap::new();
    for table in tables {
        for record in plan[table].as_array_mut().into_iter().flatten() {
            let Some(name) = record["name"].as_str().map(str::to_string) else {
                continue;
            };
            let key = (record["within"].to_string(), name.clone());
            if counts.get(&key).copied().unwrap_or(0) > 1 {
                let ordinal = ordinals.entry(key).or_default();
                *ordinal += 1;
                record["name"] = json!(format!("{name}#{ordinal}"));
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
            selectors: 0,
            picks: 0,
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
