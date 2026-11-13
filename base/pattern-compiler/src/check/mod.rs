//! The walk over one module that classifies its code into tiers and applies
//! the rules of `language-subset.md` §3, §4, and §5 that syntax and name
//! resolution decide.
//!
//! The walk keeps a stack of contexts. The context says which tier the code
//! being visited is in, and so which rules apply to it:
//!
//! - module scope, for the initializer of a frozen-data constant;
//! - the reactive tier, where every form is refused unless §4.3 lists it;
//! - the function tier, where every form is accepted unless §5.1 refuses it;
//! - code inside a construct that was already refused, which is held to the
//!   grammar of the function tier and to nothing else, so that one mistake
//!   is not reported once per expression it contains.

mod decl;
mod promotion;
mod types;

use std::collections::{BTreeMap, HashMap, HashSet};

use oxc_ast::ast::*;
use oxc_ast::AstKind;
use oxc_ast_visit::{walk, Visit};
use oxc_semantic::Scoping;
use oxc_span::{GetSpan, Span};
use oxc_syntax::operator::{BinaryOperator, UnaryOperator};
use oxc_syntax::scope::{ScopeFlags, ScopeId};
use oxc_syntax::symbol::SymbolId;

use crate::api::{self, ApiValue, Builder, Global, GlobalMember, MethodName};
use crate::diagnostics::Diagnostic;
use crate::messages;
use crate::module::{symbol_of, ApiRef, Binding, DataForm, DefKind, ModuleModel, ModuleTier};
use crate::parse::Parsed;
use crate::program::{DefRef, Resolver};
use crate::syntax::{binding_name, offsets, unwrap, FunctionLike};
use crate::tiers::{Body, BodyKind, CallKind, CallSite, Capture, Promotion, Site, Tier};
use crate::types::Shape;

/// Something a body does that some kinds of body may not do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ActKind {
    /// Reads the ambient clock or entropy.
    Ambient,
    /// Requests an effectful built-in.
    Effect,
    /// Reads `eventKey()` or `currentPrincipal()`.
    EventContext,
    /// Creates a cell without an explicit cause.
    CellWithoutCause,
    /// Makes another runtime call of §5.2: instantiates a pattern, binds a
    /// handler, or reads context.
    Runtime,
}

impl ActKind {
    pub fn describe(self) -> &'static str {
        match self {
            ActKind::Ambient => "reads the clock or entropy",
            ActKind::Effect => "requests an effectful built-in",
            ActKind::EventContext => "reads the event's key or principal",
            ActKind::CellWithoutCause => "creates a cell without an explicit cause",
            ActKind::Runtime => "makes a runtime call",
        }
    }
}

/// One act of an authored function.
#[derive(Debug, Clone)]
pub struct Act {
    pub kind: ActKind,
    pub line: u32,
}

/// What an authored function does itself, and which authored functions it
/// calls.
#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub acts: Vec<Act>,
    pub calls: Vec<DefRef>,
}

/// A call of an authored function from the reactive tier or from a
/// computation, whose target's acts are reported once every module is read.
#[derive(Debug, Clone)]
pub struct Pending {
    /// Whether the call is made while a frozen-data constant is computed.
    pub module_init: bool,
    pub target: DefRef,
    pub name: String,
    pub span: (u32, u32),
}

/// What the walk found in one module.
#[derive(Debug, Clone, Default)]
pub struct ModuleCheck {
    pub bodies: Vec<Body>,
    pub diagnostics: Vec<Diagnostic>,
    pub counts: BTreeMap<String, usize>,
    /// The facts of each authored function, by the index of its definition.
    pub facts: HashMap<usize, Facts>,
    pub pending: Vec<Pending>,
    /// The receivers of method calls that have no type: the reason, the
    /// line, and the start of the receiver's text.
    pub untyped: Vec<(&'static str, u32, String)>,
}

/// The kind of body a function-tier context belongs to, for the rules that
/// differ between bodies (`language-subset.md` §5.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Root {
    /// A `lift`, a `computed`, or an `assert`.
    Computation,
    /// A `handler`, an `action`, or an inline event handler.
    Event,
    /// An authored function, by the index of its definition. It is held to
    /// the rules of the bodies that call it.
    Authored(usize),
    /// A function that runs while a frozen-data constant is computed.
    ModuleInit,
}

#[derive(Debug, Clone, Copy)]
enum Ctx {
    Module,
    Reactive { body: usize },
    Function { body: Option<usize>, root: Root },
    Refused,
}

/// A body whose captures are being collected.
struct Frame {
    body: usize,
    scope: ScopeId,
}

/// What a per-element callback needs for the rule on shared state.
#[derive(Default)]
struct ElementState {
    plain: bool,
    state: Option<Span>,
    /// Whether the body instantiates a child.
    child: bool,
}

/// What a name denotes.
enum Thing {
    Api(ApiRef),
    /// A namespace import of a `commonfabric` module.
    ApiNamespace(Option<String>),
    Def(DefRef, DefKind, Option<DataForm>),
    /// An import the program does not resolve to a definition.
    Import,
    /// A binding of a function scope.
    Local(SymbolId),
    Global,
}

pub struct Checker<'p, 'a> {
    parsed: &'p Parsed<'a>,
    model: &'p ModuleModel,
    module: usize,
    resolver: &'p Resolver<'p, 'a>,
    scoping: &'p Scoping,
    out: ModuleCheck,
    ctx: Vec<Ctx>,
    frames: Vec<Frame>,
    capture_seen: HashSet<(usize, SymbolId)>,
    index_symbols: HashMap<SymbolId, usize>,
    element: HashMap<usize, ElementState>,
    /// The input parameter of each enclosing pattern callback.
    pattern_params: Vec<Option<SymbolId>>,
    /// Whether a `[SELF]` key in the binding pattern being visited is legal.
    self_key_legal: bool,
    /// The start of the call that is the expression of the statement being
    /// visited.
    statement_call: Option<u32>,
    /// The starts of the cell creations that `.for(cause)` is called on.
    cause_given: HashSet<u32>,
    /// The start of an initializer and the name of the `const` it is
    /// assigned to.
    name_hint: Option<(u32, String)>,
    /// The starts of the references to a removed helper that are the callee
    /// of a call or the tag of a template.
    helper_callees: HashSet<u32>,
    /// The start of the builder call that is the whole initializer of the
    /// module-scope `const` being visited.
    direct_builder: Option<u32>,
    /// How many loops and nested functions of the current function body
    /// enclose the code being visited.
    loop_depth: u32,
    /// The starts of the `Object.prototype` reads that are an operand of
    /// `===` or `!==`.
    prototype_operands: HashSet<u32>,
}

/// Walks one module.
pub fn check_module<'a>(
    parsed: &Parsed<'a>,
    model: &ModuleModel,
    module: usize,
    resolver: &Resolver<'_, 'a>,
) -> ModuleCheck {
    let mut checker = Checker {
        parsed,
        model,
        module,
        resolver,
        scoping: parsed.semantic.scoping(),
        out: ModuleCheck::default(),
        ctx: vec![Ctx::Module],
        frames: Vec::new(),
        capture_seen: HashSet::new(),
        index_symbols: HashMap::new(),
        element: HashMap::new(),
        pattern_params: Vec::new(),
        self_key_legal: false,
        statement_call: None,
        cause_given: HashSet::new(),
        name_hint: None,
        helper_callees: HashSet::new(),
        direct_builder: None,
        loop_depth: 0,
        prototype_operands: HashSet::new(),
    };
    if model.tier == ModuleTier::Imported {
        checker.imported_module();
    } else {
        checker.subset_module();
    }
    checker.out
}

impl<'p, 'a> Checker<'p, 'a> {
    // ----- Reporting -----

    fn report(&mut self, id: &'static str, span: Span, found: impl AsRef<str>) {
        let position = self.parsed.lines.position(self.parsed.source, span.start);
        let message = format!("{}. {}", found.as_ref(), messages::rewrite(id));
        self.out.diagnostics.push(Diagnostic::new(
            id,
            &self.parsed.path,
            offsets(span),
            position,
            message.trim_end().to_string(),
        ));
    }

    fn count(&mut self, key: &str) {
        *self.out.counts.entry(key.to_string()).or_insert(0) += 1;
    }

    fn cur(&self) -> Ctx {
        *self.ctx.last().expect("the context stack is never empty")
    }

    fn in_reactive(&self) -> bool {
        matches!(self.cur(), Ctx::Reactive { .. })
    }

    fn with_ctx(&mut self, ctx: Ctx, walk: impl FnOnce(&mut Self)) {
        self.ctx.push(ctx);
        walk(self);
        self.ctx.pop();
    }

    /// The body the code being visited belongs to.
    fn current_body(&self) -> Option<usize> {
        match self.cur() {
            Ctx::Reactive { body } => Some(body),
            Ctx::Function { body, .. } => body,
            Ctx::Module | Ctx::Refused => None,
        }
    }

    fn site(&self) -> Site {
        match self.cur() {
            Ctx::Module => Site::Module,
            Ctx::Reactive { .. } => Site::Reactive,
            Ctx::Function { .. } | Ctx::Refused => Site::Function,
        }
    }

    fn record_call(&mut self, kind: CallKind, name: &str, span: Span) {
        if let Some(body) = self.current_body() {
            self.out.bodies[body].calls.push(CallSite {
                kind,
                name: name.to_string(),
                span: offsets(span),
            });
        }
        if matches!(
            kind,
            CallKind::Instantiate | CallKind::BindHandler | CallKind::ContextRead
        ) {
            self.act(ActKind::Runtime, span, "A runtime call");
        }
    }

    // ----- Names -----

    fn thing(&self, identifier: &IdentifierReference<'a>) -> Thing {
        let Some(symbol) = symbol_of(self.scoping, identifier) else {
            return Thing::Global;
        };
        self.thing_of_symbol(symbol)
    }

    fn thing_of_symbol(&self, symbol: SymbolId) -> Thing {
        match self.model.binding(symbol) {
            Some(Binding::Def(def)) => {
                let def_ref = DefRef {
                    module: self.module,
                    def,
                };
                let def = &self.model.defs[def];
                Thing::Def(def_ref, def.kind, def.form)
            }
            Some(Binding::Import(import, binding)) => {
                if let Some(api) = self.model.api_ref(symbol) {
                    return Thing::Api(api);
                }
                if let Some(subpath) = self.model.api_namespace(symbol) {
                    return Thing::ApiNamespace(subpath);
                }
                let import = &self.model.imports[import];
                let name = &import.bindings[binding].imported;
                match self.resolver.resolve_import(self.module, import, name) {
                    Some(def) => match self.resolver.kind(def) {
                        Some((kind, form)) => Thing::Def(def, kind, form),
                        None => Thing::Import,
                    },
                    None => Thing::Import,
                }
            }
            None => Thing::Local(symbol),
        }
    }

    /// The `commonfabric` value an expression names: an imported name, or a
    /// member of a namespace import.
    fn api_of(&self, expr: &Expression<'a>) -> Option<ApiRef> {
        self.model.api_ref_of_callee(self.scoping, expr)
    }

    fn is_api(&self, expr: &Expression<'a>, name: &str) -> bool {
        self.api_of(expr)
            .is_some_and(|api| api.subpath.is_none() && api.name == name)
    }

    /// The global namespace `expr` names, such as `Math`, when it is a
    /// reference to the global of that name.
    fn global_name(&self, expr: &Expression<'a>) -> Option<&'a str> {
        match unwrap(expr) {
            Expression::Identifier(identifier) if symbol_of(self.scoping, identifier).is_none() => {
                Some(identifier.name.as_str())
            }
            _ => None,
        }
    }

    // ----- Bodies -----

    #[allow(clippy::too_many_arguments)]
    fn enter_body(
        &mut self,
        kind: BodyKind,
        tier: Tier,
        name: Option<String>,
        method: Option<&str>,
        span: Span,
        block: bool,
    ) -> usize {
        let (line, column) = self.parsed.lines.position(self.parsed.source, span.start);
        let index = self.out.bodies.len();
        self.out.bodies.push(Body {
            kind,
            tier,
            site: self.site(),
            name,
            method: method.map(str::to_string),
            parent: self.current_body(),
            span: offsets(span),
            line,
            column,
            block,
            uses_index: false,
            promotion: None,
            captures: Vec::new(),
            calls: Vec::new(),
        });
        index
    }

    fn take_name(&mut self, call: &CallExpression<'a>) -> Option<String> {
        match &self.name_hint {
            Some((start, _)) if *start == call.span.start => {
                self.name_hint.take().map(|(_, name)| name)
            }
            _ => None,
        }
    }

    /// Visits the parts of a function that are not its body.
    fn function_head(&mut self, function: FunctionLike<'_, 'a>) {
        if function.is_async() {
            self.report(
                "function-body:async",
                function.span(),
                "An `async` function",
            );
        }
        if function.is_generator() {
            self.report("function-body:generator", function.span(), "A generator");
        }
        match function {
            FunctionLike::Arrow(arrow) => {
                if let Some(parameters) = &arrow.type_parameters {
                    self.visit_ts_type_parameter_declaration(parameters);
                }
                self.visit_formal_parameters(&arrow.params);
                if let Some(annotation) = &arrow.return_type {
                    self.visit_ts_type_annotation(annotation);
                }
            }
            FunctionLike::Function(function) => {
                if let Some(parameters) = &function.type_parameters {
                    self.visit_ts_type_parameter_declaration(parameters);
                }
                self.visit_formal_parameters(&function.params);
                if let Some(annotation) = &function.return_type {
                    self.visit_ts_type_annotation(annotation);
                }
            }
        }
    }

    /// Visits a function as code of the current context.
    fn function_in_place(&mut self, function: FunctionLike<'_, 'a>) {
        self.function_head(function);
        if let Some(expression) = function.expression_body() {
            self.visit_expression(expression);
        } else if let Some(statements) = function.block_body() {
            for statement in statements {
                self.visit_statement(statement);
            }
        }
    }

    /// Visits a function as a function-tier body.
    fn function_body(&mut self, function: FunctionLike<'_, 'a>, body: Option<usize>, root: Root) {
        let frame = match (body, function.scope_id()) {
            (Some(body), Some(scope)) if self.out.bodies[body].site != Site::Module => {
                self.frames.push(Frame { body, scope });
                true
            }
            _ => false,
        };
        let enclosing = std::mem::take(&mut self.loop_depth);
        self.with_ctx(Ctx::Function { body, root }, |checker| {
            checker.function_in_place(function);
        });
        self.loop_depth = enclosing;
        if frame {
            self.frames.pop();
        }
    }

    /// Visits a function as a reactive-tier body (§4.2).
    fn reactive_body(&mut self, function: FunctionLike<'_, 'a>, body: usize) {
        let frame = match function.scope_id() {
            Some(scope) if self.out.bodies[body].site != Site::Module => {
                self.frames.push(Frame { body, scope });
                true
            }
            _ => false,
        };
        self.with_ctx(Ctx::Reactive { body }, |checker| {
            checker.function_head(function);
            if let Some(expression) = function.expression_body() {
                checker.visit_expression(expression);
            } else if let Some(statements) = function.block_body() {
                checker.reactive_block(statements, checker.out.bodies[body].kind, function.span());
            }
        });
        if frame {
            self.frames.pop();
        }
    }

    fn refused(&mut self, walk: impl FnOnce(&mut Self)) {
        self.with_ctx(Ctx::Refused, walk);
    }

    fn reactive_block(&mut self, statements: &[Statement<'a>], kind: BodyKind, span: Span) {
        let last = statements
            .iter()
            .rposition(|statement| !matches!(statement, Statement::EmptyStatement(_)));
        let mut returned = false;
        let pattern = kind == BodyKind::Pattern;
        if pattern {
            self.count("pattern-block");
        }
        for (index, statement) in statements.iter().enumerate() {
            let tally = match statement {
                Statement::VariableDeclaration(declaration) => {
                    match declaration.kind {
                        VariableDeclarationKind::Const => {}
                        VariableDeclarationKind::Let => self.report(
                            "pattern-context:let-declaration",
                            declaration.span,
                            "`let` in a reactive body",
                        ),
                        VariableDeclarationKind::Var => self.report(
                            "pattern-context:var-declaration",
                            declaration.span,
                            "`var` in a reactive body",
                        ),
                        _ => self.report(
                            "pattern-context:statement",
                            declaration.span,
                            "A `using` declaration in a reactive body",
                        ),
                    }
                    for declarator in &declaration.declarations {
                        self.reactive_declarator(declarator);
                    }
                    "const"
                }
                Statement::ExpressionStatement(statement) => {
                    self.reactive_expression_statement(statement);
                    "expression"
                }
                Statement::TSTypeAliasDeclaration(_) | Statement::TSInterfaceDeclaration(_) => {
                    self.visit_statement(statement);
                    "type"
                }
                Statement::ReturnStatement(statement) => {
                    if returned || Some(index) != last {
                        self.report(
                            "pattern-context:early-return",
                            statement.span,
                            "A `return` that is not the one last statement of a reactive body",
                        );
                    } else if statement.argument.is_none() {
                        self.report(
                            "pattern-context:missing-return",
                            statement.span,
                            "A reactive body that ends in `return;`",
                        );
                    }
                    returned = true;
                    if let Some(argument) = &statement.argument {
                        self.visit_expression(argument);
                    }
                    "return"
                }
                Statement::IfStatement(_)
                | Statement::SwitchStatement(_)
                | Statement::TryStatement(_)
                | Statement::ThrowStatement(_)
                | Statement::LabeledStatement(_) => {
                    self.report(
                        "pattern-context:control-flow",
                        statement.span(),
                        "A control-flow statement in a reactive body",
                    );
                    self.refused(|checker| checker.visit_statement(statement));
                    "other"
                }
                Statement::ForStatement(_)
                | Statement::ForInStatement(_)
                | Statement::ForOfStatement(_)
                | Statement::WhileStatement(_)
                | Statement::DoWhileStatement(_) => {
                    self.report(
                        "pattern-context:loop",
                        statement.span(),
                        "A loop in a reactive body",
                    );
                    self.refused(|checker| checker.visit_statement(statement));
                    "other"
                }
                Statement::FunctionDeclaration(_) | Statement::ClassDeclaration(_) => {
                    self.report(
                        "pattern-context:function-creation",
                        statement.span(),
                        "A function or class declared in a reactive body",
                    );
                    self.refused(|checker| checker.visit_statement(statement));
                    "other"
                }
                Statement::EmptyStatement(_) => continue,
                Statement::DebuggerStatement(_) | Statement::WithStatement(_) => {
                    self.refused(|checker| checker.visit_statement(statement));
                    "other"
                }
                _ => {
                    self.report(
                        "pattern-context:statement",
                        statement.span(),
                        "A statement that a reactive body does not have",
                    );
                    self.refused(|checker| checker.visit_statement(statement));
                    "other"
                }
            };
            if pattern {
                self.count(&format!("pattern-block:{tally}"));
            }
        }
        if !returned {
            self.report(
                "pattern-context:missing-return",
                span,
                "A reactive body with no `return`",
            );
        }
    }

    fn reactive_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        let from_input = declarator.init.as_ref().is_some_and(|init| {
            matches!(unwrap(init), Expression::Identifier(identifier)
            if symbol_of(self.scoping, identifier).is_some_and(|symbol| {
                self.pattern_params.last() == Some(&Some(symbol))
            }))
        });
        let constant = declarator
            .init
            .as_ref()
            .is_some_and(|init| self.is_constant_expression(init, 0));
        if !constant && has_default_or_rest(&declarator.id) {
            self.report(
                "reactive:unsupported-expression",
                declarator.id.span(),
                "A default value or a rest element in a destructuring of a value that is not a constant expression",
            );
        }
        let legal = std::mem::replace(&mut self.self_key_legal, from_input);
        self.visit_binding_pattern(&declarator.id);
        self.self_key_legal = legal;
        if let Some(annotation) = &declarator.type_annotation {
            self.visit_ts_type_annotation(annotation);
        }
        if let Some(init) = &declarator.init {
            if let Some(name) = binding_name(&declarator.id) {
                self.name_hint = Some((unwrap(init).span().start, name.name.as_str().to_string()));
            }
            self.visit_expression(init);
            self.name_hint = None;
        }
    }

    /// An expression statement of a reactive body is a call the plan
    /// records, and nothing else (§4.2).
    fn reactive_expression_statement(&mut self, statement: &ExpressionStatement<'a>) {
        let expression = unwrap(&statement.expression);
        let recorded = match expression {
            Expression::CallExpression(call) => self.is_recorded_call(call),
            _ => false,
        };
        if recorded {
            self.statement_call = Some(expression.span().start);
        } else if !self.is_handle_write(expression) {
            self.report(
                "pattern-context:statement",
                statement.span,
                "An expression statement that is not a recorded call",
            );
            if matches!(expression, Expression::UnaryExpression(unary)
                if unary.operator == UnaryOperator::Void)
            {
                self.count("reactive:void");
            }
            // The statement is reported once: the expression in it is held
            // to the grammar of the function tier alone.
            self.refused(|checker| checker.visit_expression(&statement.expression));
            return;
        }
        self.visit_expression(&statement.expression);
        self.statement_call = None;
    }

    /// Whether the statement is a call that `cell:method-tier` reports in
    /// place of `pattern-context:statement`.
    fn is_handle_write(&self, expression: &Expression<'a>) -> bool {
        let Expression::CallExpression(call) = expression else {
            return false;
        };
        let Expression::StaticMemberExpression(member) = unwrap(&call.callee) else {
            return false;
        };
        is_function_tier_handle_method(member.property.name.as_str())
            && self.is_declared_cell(&member.object)
    }

    fn is_recorded_call(&self, call: &CallExpression<'a>) -> bool {
        match unwrap(&call.callee) {
            Expression::Identifier(identifier) => match self.thing(identifier) {
                Thing::Api(api) => api.value() == ApiValue::Builder(Builder::Computed),
                Thing::Def(_, kind, _) => {
                    matches!(kind, DefKind::Lift | DefKind::Function | DefKind::Pattern)
                }
                Thing::Import | Thing::Local(_) => true,
                Thing::ApiNamespace(_) | Thing::Global => false,
            },
            Expression::CallExpression(inner) => {
                // An inline pattern or a pattern under a modifier, called.
                self.api_of(&inner.callee)
                    .is_some_and(|api| api.value() == ApiValue::Builder(Builder::Pattern))
                    || matches!(unwrap(&inner.callee), Expression::StaticMemberExpression(member)
                        if matches!(member.property.name.as_str(), "asScope" | "inSpace"))
            }
            Expression::StaticMemberExpression(member) => {
                // A member of a namespace import of another module.
                matches!(unwrap(&member.object), Expression::Identifier(object)
                    if matches!(self.thing(object), Thing::Import))
            }
            _ => false,
        }
    }

    // ----- Module scope (§3) -----

    fn subset_module(&mut self) {
        let program = self.parsed.program;
        for statement in &program.body {
            self.module_statement(statement);
        }
        self.imports_of_imported_modules();
    }

    fn module_statement(&mut self, statement: &Statement<'a>) {
        match statement {
            Statement::ImportDeclaration(import) => {
                let specifier = import.source.value.as_str();
                let empty = import
                    .specifiers
                    .as_ref()
                    .is_none_or(|list| list.is_empty());
                if empty {
                    self.report(
                        "module-scope:import-form",
                        import.span,
                        format!("An import of `{specifier}` with no bindings"),
                    );
                } else if crate::module::SpecifierKind::of(specifier)
                    == crate::module::SpecifierKind::Other
                {
                    self.report(
                        "module-scope:import-form",
                        import.span,
                        format!("An import of `{specifier}`"),
                    );
                }
            }
            Statement::ExportNamedDeclaration(export) => {
                if let Some(declaration) = &export.declaration {
                    self.module_declaration(declaration);
                }
            }
            Statement::ExportAllDeclaration(_) => {}
            Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                    self.module_function(function);
                }
                ExportDefaultDeclarationKind::ClassDeclaration(class) => self.visit_class(class),
                ExportDefaultDeclarationKind::TSInterfaceDeclaration(interface) => {
                    self.visit_ts_interface_declaration(interface);
                }
                expression => {
                    let expression = expression.to_expression();
                    let def = self
                        .model
                        .defs
                        .iter()
                        .position(|def| def.name == "default" && def.symbol.is_none());
                    self.module_initializer(expression, "default", def);
                }
            },
            Statement::TSExportAssignment(_) | Statement::TSNamespaceExportDeclaration(_) => {
                self.report(
                    "module-scope:statement",
                    statement.span(),
                    "An `export =` form",
                );
            }
            other => match other.as_declaration() {
                Some(declaration) => self.module_declaration(declaration),
                None => {
                    self.report(
                        "module-scope:statement",
                        other.span(),
                        "A statement at module scope",
                    );
                    self.refused(|checker| checker.visit_statement(other));
                }
            },
        }
    }

    fn module_declaration(&mut self, declaration: &Declaration<'a>) {
        match declaration {
            Declaration::VariableDeclaration(variable) => {
                if !variable.declare {
                    match variable.kind {
                        VariableDeclarationKind::Const => {}
                        VariableDeclarationKind::Let => self.report(
                            "module-scope:let-declaration",
                            variable.span,
                            "`let` at module scope",
                        ),
                        VariableDeclarationKind::Var => self.report(
                            "module-scope:var-declaration",
                            variable.span,
                            "`var` at module scope",
                        ),
                        _ => self.report(
                            "module-scope:statement",
                            variable.span,
                            "A `using` declaration at module scope",
                        ),
                    }
                }
                for declarator in &variable.declarations {
                    self.visit_binding_pattern(&declarator.id);
                    if let Some(annotation) = &declarator.type_annotation {
                        self.visit_ts_type_annotation(annotation);
                    }
                    let Some(init) = &declarator.init else {
                        continue;
                    };
                    let name = binding_name(&declarator.id);
                    let def = name
                        .and_then(|name| name.symbol_id.get())
                        .and_then(|symbol| match self.model.binding(symbol) {
                            Some(Binding::Def(def)) => Some(def),
                            _ => None,
                        });
                    let name = name.map_or("", |name| name.name.as_str());
                    self.module_initializer(init, name, def);
                }
            }
            Declaration::FunctionDeclaration(function) => self.module_function(function),
            Declaration::ClassDeclaration(class) => self.visit_class(class),
            Declaration::TSTypeAliasDeclaration(alias) => {
                self.visit_ts_type_alias_declaration(alias)
            }
            Declaration::TSInterfaceDeclaration(interface) => {
                self.visit_ts_interface_declaration(interface);
            }
            Declaration::TSEnumDeclaration(declaration) => {
                self.visit_ts_enum_declaration(declaration);
            }
            Declaration::TSModuleDeclaration(declaration) => {
                self.visit_ts_module_declaration(declaration);
            }
            Declaration::TSGlobalDeclaration(declaration) => {
                self.visit_ts_global_declaration(declaration);
            }
            Declaration::TSImportEqualsDeclaration(declaration) => {
                self.report(
                    "module-scope:import-form",
                    declaration.span,
                    "An `import =` declaration",
                );
            }
        }
    }

    fn module_function(&mut self, function: &Function<'a>) {
        if function.body.is_none() {
            if !function.declare {
                self.count("overload-signature");
                self.report(
                    "subset-type:overload",
                    function.span,
                    "A function overload signature",
                );
            }
            self.refused(|checker| checker.function_head(FunctionLike::Function(function)));
            return;
        }
        let symbol = function.id.as_ref().and_then(|id| id.symbol_id.get());
        let def = symbol
            .and_then(|symbol| match self.model.binding(symbol) {
                Some(Binding::Def(def)) => Some(def),
                _ => None,
            })
            .or_else(|| {
                self.model
                    .defs
                    .iter()
                    .position(|def| def.name == "default" && def.kind == DefKind::Function)
            });
        let name = function.id.as_ref().map(|id| id.name.as_str().to_string());
        self.authored_function(FunctionLike::Function(function), name, def);
    }

    fn authored_function(
        &mut self,
        function: FunctionLike<'_, 'a>,
        name: Option<String>,
        def: Option<usize>,
    ) {
        let body = self.enter_body(
            BodyKind::AuthoredFunction,
            Tier::Function,
            name,
            None,
            function.span(),
            function.expression_body().is_none(),
        );
        let root = match def {
            Some(def) => {
                self.out.facts.entry(def).or_default();
                Root::Authored(def)
            }
            None => Root::ModuleInit,
        };
        self.function_body(function, Some(body), root);
    }

    /// The initializer of a module-scope `const`, of one of the three kinds
    /// of §3.2.
    fn module_initializer(&mut self, init: &Expression<'a>, name: &str, def: Option<usize>) {
        let inner = unwrap(init);
        if let Some(function) = FunctionLike::of(inner) {
            self.authored_function(function, Some(name.to_string()), def);
            return;
        }
        if let Expression::CallExpression(call) = inner {
            if let Some(ApiValue::Builder(builder)) =
                self.api_of(&call.callee).map(|api| api.value())
            {
                if builder.is_module_scope() {
                    self.name_hint = Some((call.span.start, name.to_string()));
                    self.direct_builder = Some(call.span.start);
                    self.builder_call(call, builder, false);
                    self.name_hint = None;
                    return;
                }
            }
        }
        self.frozen_structure(inner);
        self.visit_expression(init);
    }

    /// Reports what the literal structure of a frozen-data initializer shows
    /// of its type: a function in it, or a stateful regular expression.
    fn frozen_structure(&mut self, expression: &Expression<'a>) {
        match unwrap(expression) {
            Expression::ArrayExpression(array) => {
                for element in &array.elements {
                    if let Some(element) = element.as_expression() {
                        self.frozen_structure(element);
                    }
                }
            }
            Expression::ObjectExpression(object) => {
                for property in &object.properties {
                    let ObjectPropertyKind::ObjectProperty(property) = property else {
                        continue;
                    };
                    if property.method || property.kind != PropertyKind::Init {
                        self.report(
                            "module-scope:frozen-data-type",
                            property.span,
                            "A method or an accessor in a module-scope constant",
                        );
                    } else {
                        self.frozen_structure(&property.value);
                    }
                }
            }
            Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
                self.report(
                    "module-scope:frozen-data-type",
                    expression.span(),
                    "A function held in a module-scope constant",
                );
            }
            Expression::RegExpLiteral(literal) => {
                let flags = literal.regex.flags;
                if flags.contains(RegExpFlags::G) || flags.contains(RegExpFlags::Y) {
                    self.report(
                        "module-scope:stateful-regexp",
                        literal.span,
                        "A regular expression with the `g` or `y` flag held at module scope",
                    );
                }
            }
            Expression::NewExpression(new) if self.global_name(&new.callee) == Some("RegExp") => {
                let stateful = new
                    .arguments
                    .get(1)
                    .and_then(Argument::as_expression)
                    .is_some_and(|flags| {
                        matches!(unwrap(flags), Expression::StringLiteral(flags)
                        if flags.value.contains('g') || flags.value.contains('y'))
                    });
                if stateful {
                    self.report(
                        "module-scope:stateful-regexp",
                        new.span,
                        "A regular expression with the `g` or `y` flag held at module scope",
                    );
                }
            }
            _ => {}
        }
    }

    // ----- Imported TypeScript (§5.5) -----

    fn imported_module(&mut self) {
        let program = self.parsed.program;
        for import in &self.model.imports {
            if !import.kind.is_api() {
                continue;
            }
            for binding in &import.bindings {
                if !binding.type_only {
                    let span = Span::new(binding.span.0, binding.span.1);
                    self.report(
                        "import:commonfabric-value",
                        span,
                        format!(
                            "An imported TypeScript module imports the value `{}` from `{}`",
                            binding.local, import.specifier
                        ),
                    );
                }
            }
        }
        for statement in &program.body {
            let declaration = match statement {
                Statement::ExportNamedDeclaration(export) => export.declaration.as_ref(),
                other => other.as_declaration(),
            };
            match declaration {
                Some(Declaration::VariableDeclaration(variable)) if !variable.declare => {
                    match variable.kind {
                        VariableDeclarationKind::Let => self.report(
                            "module-scope:let-declaration",
                            variable.span,
                            "`let` at module scope",
                        ),
                        VariableDeclarationKind::Var => self.report(
                            "module-scope:var-declaration",
                            variable.span,
                            "`var` at module scope",
                        ),
                        _ => {}
                    }
                }
                Some(Declaration::ClassDeclaration(class)) => self.report(
                    "module-scope:class-declaration",
                    class.span,
                    "A class at module scope",
                ),
                _ => {}
            }
        }
    }

    /// Checks what a subset module imports from an imported TypeScript
    /// module: functions with annotated signatures of data types, and types.
    fn imports_of_imported_modules(&mut self) {
        let model = self.model;
        for import in &model.imports {
            if !self.resolver.is_imported_tier(self.module, import) {
                continue;
            }
            for binding in &import.bindings {
                if binding.type_only {
                    continue;
                }
                let span = Span::new(binding.span.0, binding.span.1);
                let Some(def) =
                    self.resolver
                        .resolve_import(self.module, import, &binding.imported)
                else {
                    continue;
                };
                let Some(target) = self.resolver.model(def.module) else {
                    continue;
                };
                let target = &target.defs[def.def];
                match (target.kind, &target.signature) {
                    (DefKind::Type | DefKind::Ambient, _) => {}
                    (DefKind::Function, Some(signature)) => {
                        if !signature.annotated || signature.refused_type {
                            self.report(
                                "import:signature-not-in-subset",
                                span,
                                format!(
                                    "The signature of `{}` lacks an annotation or uses a type \
                                     the subset refuses",
                                    binding.local
                                ),
                            );
                        }
                        if signature.code_type {
                            self.report(
                                "import:signature-not-data",
                                span,
                                format!(
                                    "The signature of `{}` has a cell handle type or a function type",
                                    binding.local
                                ),
                            );
                        }
                    }
                    _ => self.report(
                        "import:not-a-function",
                        span,
                        format!(
                            "`{}` is imported from an imported TypeScript module and is not a \
                             function or a type",
                            binding.local
                        ),
                    ),
                }
            }
        }
    }

    // ----- Builders -----

    /// The argument of a builder call that is its callback.
    fn callback_argument<'e>(&self, call: &'e CallExpression<'a>) -> Option<&'e Expression<'a>> {
        let functions: Vec<&Expression<'a>> = call
            .arguments
            .iter()
            .filter_map(Argument::as_expression)
            .filter(|argument| FunctionLike::of(argument).is_some())
            .collect();
        match functions.as_slice() {
            [one] => Some(one),
            _ => match call.arguments.len() {
                // A builder called with schemas takes its callback last.
                3 => call.arguments.last().and_then(Argument::as_expression),
                _ => call.arguments.first().and_then(Argument::as_expression),
            },
        }
    }

    /// A call of a builder. `callee` says the call is itself the callee of a
    /// call, as an inline `pattern(...)` that is instantiated is.
    fn builder_call(&mut self, call: &CallExpression<'a>, builder: Builder, callee: bool) {
        let statement = self.statement_call == Some(call.span.start);
        self.statement_call = None;
        let name = self.take_name(call);
        self.visit_expression(&call.callee);
        if let Some(arguments) = &call.type_arguments {
            self.visit_ts_type_parameter_instantiation(arguments);
        }
        let callback = self.callback_argument(call);
        for argument in &call.arguments {
            let is_callback = match (argument.as_expression(), callback) {
                (Some(argument), Some(callback)) => std::ptr::eq(argument, callback),
                _ => false,
            };
            if !is_callback {
                self.visit_argument(argument);
            }
        }
        let direct = self.direct_builder.take() == Some(call.span.start);
        let placement = self.placement(builder, callee, direct);
        if let Some((id, found)) = &placement {
            self.report(id, call.span, found);
        }
        let Some(callback) = callback else {
            self.report(
                "builder-callback:indirect-reference",
                call.span,
                format!("`{}` called without a callback", builder.name()),
            );
            return;
        };
        let Some(function) = FunctionLike::of(callback) else {
            self.named_callback(call, builder, callback);
            return;
        };
        if function.is_generator() {
            self.report(
                "builder-callback:indirect-reference",
                function.span(),
                format!("A generator given to `{}`", builder.name()),
            );
        }
        if placement.is_some() {
            self.refused(|checker| checker.function_in_place(function));
            return;
        }
        let block = function.expression_body().is_none();
        match builder {
            Builder::Pattern => {
                if !callee && self.site() != Site::Module {
                    self.count("pattern-closure");
                }
                self.pattern_parameter(function);
                let captures = self.site() == Site::Function;
                let body = self.enter_body(
                    BodyKind::Pattern,
                    Tier::Reactive,
                    name,
                    None,
                    call.span,
                    block,
                );
                let input = function
                    .params()
                    .items
                    .first()
                    .and_then(|parameter| binding_name(&parameter.pattern))
                    .and_then(|name| name.symbol_id.get());
                self.pattern_params.push(input);
                let legal = std::mem::replace(&mut self.self_key_legal, true);
                self.reactive_body(function, body);
                self.self_key_legal = legal;
                self.pattern_params.pop();
                let _ = captures;
            }
            Builder::Lift => {
                let body =
                    self.enter_body(BodyKind::Lift, Tier::Function, name, None, call.span, block);
                self.function_body(function, Some(body), Root::Computation);
            }
            Builder::Handler => {
                self.verb_result(call, function, 2, "handler");
                let body = self.enter_body(
                    BodyKind::Handler,
                    Tier::Function,
                    name,
                    None,
                    call.span,
                    block,
                );
                self.function_body(function, Some(body), Root::Event);
            }
            Builder::Action => {
                self.verb_result(call, function, 1, "action");
                self.record_call(CallKind::BindHandler, "action", call.span);
                let body = self.enter_body(
                    BodyKind::Action,
                    Tier::Function,
                    name,
                    None,
                    call.span,
                    block,
                );
                self.function_body(function, Some(body), Root::Event);
            }
            Builder::Assert => {
                let body = self.enter_body(
                    BodyKind::Assert,
                    Tier::Function,
                    name,
                    None,
                    call.span,
                    block,
                );
                self.function_body(function, Some(body), Root::Computation);
            }
            Builder::Computed => {
                let promotion = if statement {
                    Promotion::Statement
                } else {
                    self.promotion(function)
                };
                match &promotion {
                    Promotion::Statement => {}
                    Promotion::Promoted { .. } => self.report(
                        "computed:redundant",
                        call.span,
                        "This `computed` meets the promotion criterion, so the wrapper changes nothing",
                    ),
                    Promotion::NotPromoted { reason, .. } => self.report(
                        "computed:not-promoted",
                        call.span,
                        format!("This `computed` is not promoted: {reason}"),
                    ),
                }
                let tier = match promotion {
                    Promotion::Promoted { .. } => Tier::Reactive,
                    _ => Tier::Function,
                };
                let body = self.enter_body(BodyKind::Computed, tier, name, None, call.span, block);
                self.out.bodies[body].promotion = Some(promotion);
                self.function_body(function, Some(body), Root::Computation);
            }
        }
    }

    /// The diagnostic for a builder called where it may not be, if the
    /// current context is such a place.
    fn placement(
        &self,
        builder: Builder,
        callee: bool,
        direct: bool,
    ) -> Option<(&'static str, String)> {
        let name = builder.name();
        match (self.cur(), builder) {
            (Ctx::Reactive { .. }, Builder::Lift | Builder::Handler) => Some((
                "pattern-context:builder-placement",
                format!("`{name}(...)` called in the reactive tier"),
            )),
            (Ctx::Reactive { .. }, _) => None,
            (Ctx::Function { .. } | Ctx::Refused, Builder::Action) => None,
            (Ctx::Function { .. } | Ctx::Refused, Builder::Pattern) if callee => None,
            (Ctx::Function { .. } | Ctx::Refused, _) => Some((
                "function-body:builder-call",
                format!("`{name}(...)` called in a function body"),
            )),
            (Ctx::Module, Builder::Computed | Builder::Action | Builder::Assert) => Some((
                "module-scope:runtime-call",
                format!("`{name}(...)` called at module scope"),
            )),
            (Ctx::Module, Builder::Lift) if !direct => Some((
                "module-scope:frozen-data-type",
                "A `lift(...)` call inside a frozen-data expression yields a function".to_string(),
            )),
            (Ctx::Module, _) => None,
        }
    }

    /// A builder whose callback is not written at the call (§3.2).
    fn named_callback(
        &mut self,
        call: &CallExpression<'a>,
        builder: Builder,
        callback: &Expression<'a>,
    ) {
        let target = match unwrap(callback) {
            Expression::Identifier(identifier) => match self.thing(identifier) {
                Thing::Def(def, DefKind::Function, _) if def.module == self.module => Some(def),
                _ => None,
            },
            _ => None,
        };
        let by_name = matches!(builder, Builder::Lift | Builder::Handler);
        match target {
            Some(def) if by_name => {
                let kind = if builder == Builder::Lift {
                    BodyKind::Lift
                } else {
                    BodyKind::Handler
                };
                let name = self.model.defs[def.def].name.clone();
                self.count("builder-callback-by-name");
                self.enter_body(
                    kind,
                    Tier::Function,
                    Some(name.clone()),
                    None,
                    call.span,
                    true,
                );
                if builder == Builder::Lift {
                    self.out.pending.push(Pending {
                        module_init: false,
                        target: def,
                        name,
                        span: offsets(callback.span()),
                    });
                }
            }
            Some(_) => self.report(
                "builder-callback:indirect-reference",
                callback.span(),
                format!(
                    "The callback of `{}` is a name, and it has to be written at the call",
                    builder.name()
                ),
            ),
            None => self.report(
                "builder-callback:indirect-reference",
                callback.span(),
                format!(
                    "The callback of `{}` is neither a function written at the call nor a \
                     function of this module",
                    builder.name()
                ),
            ),
        }
        self.visit_expression(callback);
    }

    /// The parameter of a pattern callback (§4.1).
    fn pattern_parameter(&mut self, function: FunctionLike<'_, 'a>) {
        let parameters = function.params();
        if function.param_count() > 1 {
            self.report(
                "pattern-context:parameter-form",
                parameters.span,
                "A pattern callback with more than one parameter",
            );
        }
        if let Some(rest) = &parameters.rest {
            self.report(
                "pattern-context:parameter-form",
                rest.span,
                "A rest element in the pattern parameter",
            );
        }
        let Some(parameter) = parameters.items.first() else {
            return;
        };
        if let Some(initializer) = &parameter.initializer {
            self.report(
                "pattern-context:parameter-form",
                initializer.span(),
                "A default value for the pattern parameter",
            );
        }
        match &parameter.pattern {
            BindingPattern::BindingIdentifier(_) => {}
            BindingPattern::ObjectPattern(object) => self.pattern_destructuring(object),
            other => self.report(
                "pattern-context:parameter-form",
                other.span(),
                "A pattern parameter that is neither a name nor an object destructuring",
            ),
        }
    }

    fn pattern_destructuring(&mut self, object: &ObjectPattern<'a>) {
        if let Some(rest) = &object.rest {
            self.report(
                "pattern-context:parameter-form",
                rest.span,
                "A rest element in the pattern parameter",
            );
        }
        for property in &object.properties {
            if property.computed {
                let fixed = match &property.key {
                    PropertyKey::StringLiteral(_) | PropertyKey::NumericLiteral(_) => true,
                    key => key.as_expression().is_some_and(|key| {
                        self.api_of(key)
                            .is_some_and(|api| api.value() == ApiValue::WellKnownKey)
                    }),
                };
                if !fixed {
                    self.report(
                        "pattern-context:parameter-form",
                        property.key.span(),
                        "A dynamic key in the destructuring of the pattern parameter",
                    );
                }
            }
            match &property.value {
                BindingPattern::BindingIdentifier(_) => {}
                BindingPattern::AssignmentPattern(assignment) => self.report(
                    "pattern-context:parameter-form",
                    assignment.span,
                    "A default value in the pattern parameter",
                ),
                BindingPattern::ObjectPattern(nested) => self.pattern_destructuring(nested),
                BindingPattern::ArrayPattern(array) => self.report(
                    "pattern-context:parameter-form",
                    array.span,
                    "An array destructuring in the pattern parameter",
                ),
            }
        }
    }

    /// `verb-result:undeclared-return`: a `handler` or an `action` without a
    /// result type argument returns a plain value from a block body.
    fn verb_result(
        &mut self,
        call: &CallExpression<'a>,
        function: FunctionLike<'_, 'a>,
        slot: usize,
        name: &str,
    ) {
        let declared = call
            .type_arguments
            .as_ref()
            .and_then(|arguments| arguments.params.get(slot))
            .is_some_and(|result| !matches!(result, TSType::TSVoidKeyword(_)));
        let Some(statements) = function.block_body() else {
            return;
        };
        if declared {
            return;
        }
        let mut returns = Vec::new();
        for statement in statements {
            collect_returns(statement, &mut returns);
        }
        for statement in returns {
            let Some(argument) = &statement.argument else {
                continue;
            };
            if is_plain_shaped(argument) {
                self.report(
                    "verb-result:undeclared-return",
                    statement.span,
                    format!("This `{name}` body returns a value and declares no result"),
                );
            }
        }
    }

    // ----- Acts and calls of authored functions -----

    fn act(&mut self, kind: ActKind, span: Span, found: &str) {
        let id = match kind {
            ActKind::Ambient => "function-body:ambient-read",
            ActKind::Effect => "function-body:effect-in-computation",
            ActKind::EventContext => "function-body:event-context-in-computation",
            ActKind::CellWithoutCause => "function-body:cell-needs-cause",
            ActKind::Runtime => "module-scope:runtime-call",
        };
        let module_scope = |checker: &mut Self| {
            if kind == ActKind::Ambient {
                checker.report(id, span, format!("{found} at module scope"));
            } else {
                checker.report(
                    "module-scope:runtime-call",
                    span,
                    "A runtime call while a module-scope constant is computed",
                );
            }
        };
        match self.cur() {
            Ctx::Reactive { .. } => {
                if matches!(kind, ActKind::Ambient | ActKind::EventContext) {
                    self.report(id, span, format!("{found} in the reactive tier"));
                }
            }
            Ctx::Function { root, .. } => match root {
                Root::Computation => {
                    if kind != ActKind::Runtime {
                        self.report(id, span, format!("{found} in a computation"));
                    }
                }
                Root::ModuleInit => module_scope(self),
                Root::Authored(def) => {
                    let (line, _) = self.parsed.lines.position(self.parsed.source, span.start);
                    self.out
                        .facts
                        .entry(def)
                        .or_default()
                        .acts
                        .push(Act { kind, line });
                }
                Root::Event => {}
            },
            Ctx::Module => module_scope(self),
            Ctx::Refused => {}
        }
    }

    fn authored_call(&mut self, target: DefRef, name: &str, span: Span) {
        let module_init = match self.cur() {
            Ctx::Reactive { .. }
            | Ctx::Function {
                root: Root::Computation,
                ..
            } => false,
            Ctx::Module
            | Ctx::Function {
                root: Root::ModuleInit,
                ..
            } => true,
            Ctx::Function {
                root: Root::Authored(def),
                ..
            } => {
                self.out.facts.entry(def).or_default().calls.push(target);
                return;
            }
            _ => return,
        };
        self.out.pending.push(Pending {
            module_init,
            target,
            name: name.to_string(),
            span: offsets(span),
        });
    }

    /// Records an instantiation of a pattern by a call. In a computation, an
    /// instantiation inside a loop or a nested function is named by its
    /// ordinal unless the author gives it a cause.
    fn instantiated(&mut self, name: &str, span: Span) {
        self.record_call(CallKind::Instantiate, name, span);
        let computation = matches!(
            self.cur(),
            Ctx::Function {
                root: Root::Computation,
                ..
            }
        );
        if computation && self.loop_depth > 0 && !self.cause_given.contains(&span.start) {
            self.report(
                "function-body:instantiation-without-cause",
                span,
                "A pattern instantiated in a loop or a callback of a computation without `.for(cause)`",
            );
        }
        if self.in_reactive() {
            let mut body = self.current_body();
            while let Some(index) = body {
                if self.out.bodies[index].tier != Tier::Reactive {
                    break;
                }
                if let Some(state) = self.element.get_mut(&index) {
                    state.child = true;
                }
                body = self.out.bodies[index].parent;
            }
        }
    }

    // ----- Per-element state (§4.4.1) -----

    /// Records that the reactive code being visited declares a state cell or
    /// binds a handler.
    fn mark_state(&mut self, span: Span) {
        let mut body = self.current_body();
        while let Some(index) = body {
            if self.out.bodies[index].tier != Tier::Reactive {
                break;
            }
            if let Some(state) = self.element.get_mut(&index) {
                state.state.get_or_insert(span);
            }
            body = self.out.bodies[index].parent;
        }
    }

    /// Whether an expression is a constant expression in the sense of §4.2:
    /// a literal, a module-scope constant, an object or array literal of
    /// constant expressions, or a `const` initialized by one.
    fn is_constant_expression(&self, expression: &Expression<'a>, depth: u32) -> bool {
        if depth > 4 {
            return false;
        }
        match unwrap(expression) {
            Expression::StringLiteral(_)
            | Expression::NumericLiteral(_)
            | Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::BigIntLiteral(_) => true,
            Expression::TemplateLiteral(template) => template.expressions.is_empty(),
            Expression::ArrayExpression(array) => array.elements.iter().all(|element| {
                element
                    .as_expression()
                    .is_some_and(|element| self.is_constant_expression(element, depth + 1))
            }),
            Expression::ObjectExpression(object) => object.properties.iter().all(|property| {
                matches!(property, ObjectPropertyKind::ObjectProperty(property)
                    if !property.computed
                        && self.is_constant_expression(&property.value, depth + 1))
            }),
            Expression::Identifier(identifier) => match self.thing(identifier) {
                Thing::Def(_, DefKind::FrozenData, _) => true,
                Thing::Local(symbol) => {
                    let nodes = self.parsed.semantic.nodes();
                    match nodes.kind(self.scoping.symbol_declaration(symbol)) {
                        AstKind::VariableDeclarator(declarator)
                            if declarator.kind == VariableDeclarationKind::Const
                                && matches!(
                                    declarator.id,
                                    BindingPattern::BindingIdentifier(_)
                                ) =>
                        {
                            declarator
                                .init
                                .as_ref()
                                .is_some_and(|init| self.is_constant_expression(init, depth + 1))
                        }
                        _ => false,
                    }
                }
                _ => false,
            },
            _ => false,
        }
    }

    /// Whether a computed key is certainly not static (§4.3). A key that
    /// names a module-scope constant is static when the constant has a
    /// literal type, which is left to the type checker.
    fn is_dynamic_key(&self, key: &Expression<'a>) -> bool {
        let mut root = unwrap(key);
        if matches!(
            root,
            Expression::StringLiteral(_) | Expression::NumericLiteral(_)
        ) {
            return false;
        }
        if let Expression::TemplateLiteral(template) = root {
            return !template.expressions.is_empty();
        }
        if self
            .api_of(root)
            .is_some_and(|api| api.value() == ApiValue::WellKnownKey)
        {
            return false;
        }
        while let Expression::StaticMemberExpression(member) = root {
            root = unwrap(&member.object);
        }
        match root {
            Expression::Identifier(identifier) => !matches!(
                self.thing(identifier),
                Thing::Def(..) | Thing::Import | Thing::Api(_) | Thing::ApiNamespace(_)
            ),
            _ => true,
        }
    }

    /// Whether a collection holds plain values, as far as its syntax shows.
    fn is_plain_collection(&self, expression: &Expression<'a>, depth: u32) -> bool {
        if depth > 3 {
            return false;
        }
        if self
            .declared(expression)
            .is_ok_and(|collection| self.resolver.has_plain_elements(collection))
        {
            return true;
        }
        match unwrap(expression) {
            Expression::ArrayExpression(array) => {
                !array.elements.is_empty()
                    && array.elements.iter().all(|element| {
                        element.as_expression().is_some_and(|element| {
                            matches!(
                                unwrap(element),
                                Expression::StringLiteral(_)
                                    | Expression::NumericLiteral(_)
                                    | Expression::BooleanLiteral(_)
                                    | Expression::NullLiteral(_)
                                    | Expression::ObjectExpression(_)
                                    | Expression::ArrayExpression(_)
                            )
                        })
                    })
            }
            Expression::Identifier(identifier) => match self.thing(identifier) {
                Thing::Def(_, DefKind::FrozenData, _) => true,
                Thing::Local(symbol) => {
                    let nodes = self.parsed.semantic.nodes();
                    match nodes.kind(self.scoping.symbol_declaration(symbol)) {
                        AstKind::VariableDeclarator(declarator)
                            if declarator.kind == VariableDeclarationKind::Const
                                && matches!(
                                    declarator.id,
                                    BindingPattern::BindingIdentifier(_)
                                ) =>
                        {
                            declarator
                                .init
                                .as_ref()
                                .is_some_and(|init| self.is_plain_collection(init, depth + 1))
                        }
                        _ => false,
                    }
                }
                _ => false,
            },
            Expression::StaticMemberExpression(member) => {
                let mut object = unwrap(&member.object);
                while let Expression::StaticMemberExpression(inner) = object {
                    object = unwrap(&inner.object);
                }
                matches!(object, Expression::Identifier(root)
                    if matches!(self.thing(root), Thing::Def(_, DefKind::FrozenData, _)))
            }
            Expression::CallExpression(call) => match unwrap(&call.callee) {
                Expression::StaticMemberExpression(member) => {
                    let name = member.property.name.as_str();
                    name == "split"
                        || (matches!(name, "keys" | "entries")
                            && self.global_name(&member.object) == Some("Object"))
                }
                _ => false,
            },
            _ => false,
        }
    }

    // ----- Calls (§4.4, §5.2) -----

    fn call(&mut self, call: &CallExpression<'a>) {
        let callee = unwrap(&call.callee);
        match callee {
            Expression::Identifier(identifier) => self.call_of_name(call, identifier),
            Expression::StaticMemberExpression(member) => self.call_of_member(call, member),
            Expression::CallExpression(inner) => {
                if let Some(ApiValue::Builder(Builder::Pattern)) =
                    self.api_of(&inner.callee).map(|api| api.value())
                {
                    self.statement_call = None;
                    self.instantiated("pattern", call.span);
                    self.builder_call(inner, Builder::Pattern, true);
                    self.arguments(call, false);
                } else {
                    self.statement_call = None;
                    if self.is_modifier_call(inner) {
                        self.instantiated("", call.span);
                    }
                    self.visit_expression(&call.callee);
                    self.arguments(call, false);
                }
            }
            _ => {
                self.statement_call = None;
                self.visit_expression(&call.callee);
                self.arguments(call, false);
            }
        }
    }

    fn is_modifier_call(&self, call: &CallExpression<'a>) -> bool {
        matches!(unwrap(&call.callee), Expression::StaticMemberExpression(member)
            if matches!(member.property.name.as_str(), "asScope" | "inSpace"))
    }

    /// Visits the arguments of a call. In the reactive tier a function among
    /// them is refused unless `functions` says the callee takes one.
    fn arguments(&mut self, call: &CallExpression<'a>, functions: bool) {
        if let Some(arguments) = &call.type_arguments {
            self.visit_ts_type_parameter_instantiation(arguments);
        }
        for argument in &call.arguments {
            self.argument(argument, functions);
        }
    }

    fn argument(&mut self, argument: &Argument<'a>, functions: bool) {
        match FunctionLike::of_argument(argument) {
            Some(function) if self.in_reactive() && !functions => {
                self.report(
                    "pattern-context:callback-container",
                    function.span(),
                    "A function passed to a call that has no callback position",
                );
                self.refused(|checker| checker.function_in_place(function));
            }
            // A function the callee does take is code of the function tier.
            Some(function) if self.in_reactive() => {
                self.refused(|checker| checker.function_in_place(function));
            }
            _ => self.visit_argument(argument),
        }
    }

    fn call_of_name(&mut self, call: &CallExpression<'a>, identifier: &IdentifierReference<'a>) {
        let name = identifier.name.as_str();
        match self.thing(identifier) {
            Thing::Api(api) => self.api_call(call, &api),
            Thing::ApiNamespace(_) | Thing::Import => {
                self.statement_call = None;
                self.visit_identifier_reference(identifier);
                self.arguments(call, true);
            }
            Thing::Def(def, kind, _) => {
                self.statement_call = None;
                match kind {
                    DefKind::Pattern => self.instantiated(name, call.span),
                    DefKind::Handler => {
                        self.record_call(CallKind::BindHandler, name, call.span);
                    }
                    DefKind::Lift => self.record_call(CallKind::Lift, name, call.span),
                    DefKind::Function => {
                        self.record_call(CallKind::Function, name, call.span);
                        self.authored_call(def, name, call.span);
                    }
                    _ => {}
                }
                self.visit_identifier_reference(identifier);
                self.arguments(call, false);
            }
            Thing::Local(_) => {
                self.statement_call = None;
                self.visit_identifier_reference(identifier);
                let table = self.is_cf_table(&call.callee);
                self.arguments(call, table);
            }
            Thing::Global => {
                self.statement_call = None;
                match api::global(name) {
                    Global::DynamicCode => self.report(
                        "function-body:dynamic-code",
                        call.span,
                        format!("A call of `{name}`"),
                    ),
                    Global::Listed if self.in_reactive() => self.report(
                        "reactive:unsupported-call",
                        call.span,
                        format!("A call of `{name}` in the reactive tier"),
                    ),
                    _ => {}
                }
                self.visit_identifier_reference(identifier);
                self.arguments(call, false);
            }
        }
    }

    /// A call of a value `commonfabric` exports.
    fn api_call(&mut self, call: &CallExpression<'a>, api: &ApiRef) {
        let name = api.name.as_str();
        let value = api.value();
        if let ApiValue::Builder(builder) = value {
            self.builder_call(call, builder, false);
            return;
        }
        self.statement_call = None;
        if value == ApiValue::RemovedHelper {
            self.helper_callees
                .insert(unwrap(&call.callee).span().start);
        }
        self.visit_expression(&call.callee);
        let mut functions = false;
        match value {
            ApiValue::RemovedHelper => {
                self.count(&format!("form:{name}"));
                let plain = call.arguments.iter().all(|argument| !argument.is_spread());
                let interim = self.in_reactive()
                    && api.direct
                    && plain
                    && api::removed_helper_arity(name) == Some(call.arguments.len());
                if interim {
                    self.report(
                        "removed-form:helper",
                        call.span,
                        format!("`{name}(...)` is a removed form"),
                    );
                } else {
                    self.report(
                        "removed-form:helper-unsupported",
                        call.span,
                        format!("`{name}` in a form the interim acceptance does not cover"),
                    );
                }
            }
            ApiValue::PatternTool => {
                self.count("form:patternTool");
                self.report(
                    "removed-form:pattern-tool",
                    call.span,
                    "A call of `patternTool`",
                );
            }
            ApiValue::RemovedBuiltin(replacement) => {
                self.count(&format!("form:{name}"));
                self.report(
                    "removed-form:builtin",
                    call.span,
                    format!("`{name}(...)` is a removed form; write {replacement}"),
                );
            }
            ApiValue::Effect | ApiValue::StagedChange => {
                self.record_call(CallKind::Effect, name, call.span);
                if value == ApiValue::StagedChange && self.in_reactive() {
                    self.report(
                        "function-body:effect-in-computation",
                        call.span,
                        format!("`{name}`, which only a handler requests, in the reactive tier"),
                    );
                }
                self.act(ActKind::Effect, call.span, &format!("`{name}` requested"));
            }
            ApiValue::Structural | ApiValue::SplitBuiltin => {
                self.record_call(CallKind::Structural, name, call.span);
            }
            ApiValue::Declaration => {
                self.record_call(CallKind::CreateCell, name, call.span);
                match self.cur() {
                    Ctx::Reactive { .. } => self.sqlite_tables(call),
                    Ctx::Function { .. } => self.report(
                        "cell:method-tier",
                        call.span,
                        "`sqliteDatabase(...)` called in a function body",
                    ),
                    _ => {}
                }
            }
            ApiValue::EventContext => {
                self.record_call(CallKind::ContextRead, name, call.span);
                self.act(
                    ActKind::EventContext,
                    call.span,
                    &format!("`{name}()` read"),
                );
            }
            ApiValue::ContextRead => self.record_call(CallKind::ContextRead, name, call.span),
            ApiValue::Pure => {
                if name == "multiUserTest" && api.subpath.is_none() {
                    match self.cur() {
                        Ctx::Reactive { .. } => self.report(
                            "reactive:unsupported-call",
                            call.span,
                            "`multiUserTest` called in the reactive tier",
                        ),
                        Ctx::Function { .. } => self.report(
                            "function-body:builder-call",
                            call.span,
                            "`multiUserTest` called in a function body",
                        ),
                        _ => {}
                    }
                }
                // The row-label rule of `table` is the one function a pure
                // API function takes in the reactive tier (§4.4.4).
                functions = name == "table";
            }
            ApiValue::CellConstructor | ApiValue::WellKnownKey => {
                if self.in_reactive() {
                    self.report(
                        "reactive:unsupported-call",
                        call.span,
                        format!("`{name}` called as a function"),
                    );
                }
            }
            ApiValue::Builder(_) | ApiValue::Emitted | ApiValue::Unclassified => functions = true,
        }
        self.arguments(call, functions);
    }

    /// The `tables` option of a `sqliteDatabase` declaration is static
    /// (§4.7).
    fn sqlite_tables(&mut self, call: &CallExpression<'a>) {
        let Some(Expression::ObjectExpression(options)) = call
            .arguments
            .first()
            .and_then(Argument::as_expression)
            .map(unwrap)
        else {
            return;
        };
        for property in &options.properties {
            let ObjectPropertyKind::ObjectProperty(property) = property else {
                continue;
            };
            if property.key.static_name().as_deref() != Some("tables") {
                continue;
            }
            let Expression::ObjectExpression(tables) = unwrap(&property.value) else {
                self.report(
                    "sqlite:tables-not-static",
                    property.value.span(),
                    "The `tables` option is not an object literal",
                );
                continue;
            };
            for table in &tables.properties {
                let fixed = match table {
                    ObjectPropertyKind::SpreadProperty(_) => false,
                    ObjectPropertyKind::ObjectProperty(table) => {
                        let value = unwrap(&table.value);
                        !table.computed
                            && matches!(
                                value,
                                Expression::Identifier(_) | Expression::CallExpression(_)
                            )
                    }
                };
                if !fixed {
                    self.report(
                        "sqlite:tables-not-static",
                        table.span(),
                        "An entry of the `tables` option is not a `table(...)` call under a static key",
                    );
                }
            }
        }
    }

    /// Whether a callee is `table` of `commonfabric`: the import, a member
    /// of `cfSqlite`, or a name destructured from `cfSqlite`.
    fn is_cf_table(&self, callee: &Expression<'a>) -> bool {
        let is_sqlite = |expression: &Expression<'a>| self.is_api(expression, "cfSqlite");
        match unwrap(callee) {
            Expression::StaticMemberExpression(member) => {
                member.property.name == "table" && is_sqlite(&member.object)
            }
            Expression::Identifier(identifier) => match self.thing(identifier) {
                Thing::Api(api) => api.name == "table",
                Thing::Local(symbol) => {
                    let nodes = self.parsed.semantic.nodes();
                    match nodes.kind(self.scoping.symbol_declaration(symbol)) {
                        AstKind::VariableDeclarator(declarator) => {
                            self.scoping.symbol_name(symbol) == "table"
                                && matches!(declarator.id, BindingPattern::ObjectPattern(_))
                                && declarator.init.as_ref().is_some_and(is_sqlite)
                        }
                        _ => false,
                    }
                }
                _ => false,
            },
            _ => false,
        }
    }

    fn call_of_member(&mut self, call: &CallExpression<'a>, member: &StaticMemberExpression<'a>) {
        let name = member.property.name.as_str();
        let object = unwrap(&member.object);

        // A member of a namespace: a standard-library namespace, a namespace
        // import of `commonfabric`, or a namespace import of another module.
        if let Expression::Identifier(identifier) = object {
            match self.thing(identifier) {
                Thing::Global if api::is_global_namespace(identifier.name.as_str()) => {
                    self.statement_call = None;
                    let member_class = api::global_member(identifier.name.as_str(), name);
                    if member_class == Some(GlobalMember::FunctionOnly) && self.in_reactive() {
                        self.report(
                            "reactive:unsupported-call",
                            call.span,
                            format!("`{}.{name}` in the reactive tier", identifier.name),
                        );
                    }
                    self.visit_expression(&call.callee);
                    self.arguments(call, false);
                    return;
                }
                Thing::ApiNamespace(subpath) => {
                    let api = ApiRef {
                        name: name.to_string(),
                        subpath,
                        direct: false,
                    };
                    self.api_call(call, &api);
                    return;
                }
                Thing::Import => {
                    self.statement_call = None;
                    self.visit_expression(&call.callee);
                    self.arguments(call, true);
                    return;
                }
                _ => {}
            }
        }
        self.statement_call = None;

        let receiver = self.declared(object);
        let label = self.resolver.outcome_label(&receiver);
        // A cell constructor or a value of `commonfabric` before the dot is
        // not a receiver whose type is in question.
        let named = self.is_cell_constructor(object) || self.api_of(object).is_some();
        if !named {
            self.count(&format!("types:receiver:{label}"));
        }
        if label != "typed" && !named {
            let (line, _) = self
                .parsed
                .lines
                .position(self.parsed.source, object.span().start);
            let text: String = object
                .span()
                .source_text(self.parsed.source)
                .chars()
                .take(60)
                .collect();
            self.out.untyped.push((label, line, text));
        }
        if name == "get" && call.arguments.is_empty() {
            let readable = match self.declared_shape(object) {
                Some(Shape::Handle(kind, _)) => kind.is_readable(),
                Some(Shape::Union(members)) => members.iter().any(|member| {
                    let member = self.resolver.shape(*member);
                    !is_value_shape(&member)
                        || matches!(&member, Shape::Object(properties, _)
                            if properties.iter().any(|property| property.name == "get"))
                }),
                // A value that declares a `get` of its own is read through it.
                Some(Shape::Object(properties, _))
                    if properties.iter().any(|property| property.name == "get") =>
                {
                    true
                }
                Some(shape) => !is_value_shape(&shape),
                None => true,
            };
            if !readable {
                self.report(
                    "opaque-get:invalid-call",
                    call.span,
                    "`.get()` on a value whose type is not `Cell`, `Writable`, or `ReadonlyCell`",
                );
            }
        }

        // A cell constructor: `X.of(value)`, `X.for(cause)`, and the two
        // under a scope.
        if self.is_cell_constructor(object) {
            match name {
                "of" => self.cell_created(
                    call.span,
                    call.arguments.first(),
                    call.type_arguments.is_some(),
                ),
                "for" => {
                    self.record_call(CallKind::CreateCell, "for", call.span);
                    if self.in_reactive() {
                        self.mark_state(call.span);
                        self.mark_state(call.span);
                        self.cause_literal(call);
                    }
                }
                "equals" | "equalLinks" => {
                    self.record_call(CallKind::ContextRead, name, call.span);
                }
                _ => {}
            }
            self.visit_expression(&call.callee);
            self.arguments(call, false);
            return;
        }

        if name == "for" {
            if self.is_cell_creation(object) || self.is_instantiation(object) {
                self.cause_given.insert(object.span().start);
            }
            if self.in_reactive() {
                if self.is_instantiation(object) {
                    self.report(
                        "cell:method-tier",
                        call.span,
                        "`.for(cause)` on an instantiation in the reactive tier",
                    );
                } else {
                    self.cause_literal(call);
                }
            }
        }

        if api::is_with_pattern_method(name) {
            self.count("form:withPattern");
            self.report(
                "removed-form:builtin",
                call.span,
                format!(
                    "`{name}` is a removed form; write the method without the suffix, with a \
                     callback written at the call"
                ),
            );
        }

        let declared_cell = self.is_declared_cell(object);
        if declared_cell && api::is_undeclared_cell_method(name) {
            self.report(
                "cell:unsupported-method",
                call.span,
                format!("`{name}` is not a method the API declares on a cell handle"),
            );
        }

        match self.cur() {
            Ctx::Reactive { .. } => self.reactive_method_call(call, member, declared_cell),
            _ => {
                if declared_cell && api::is_handle_collection_method(name) {
                    self.count("handle-collection-in-function");
                    self.record_call(CallKind::HandleCollection, name, call.span);
                    self.report(
                        "cell:collection-method-in-function",
                        call.span,
                        format!("`{name}` called on a cell handle in a function body"),
                    );
                }
                if name == "query" && declared_cell {
                    self.act(
                        ActKind::Effect,
                        call.span,
                        "`query` on a SQLite handle requested",
                    );
                }
                self.frozen_mutation(call, member);
                self.visit_expression(&call.callee);
                self.arguments(call, false);
            }
        }
    }

    /// In the reactive tier, the argument of `.for(cause)` is a string
    /// literal (§4.7).
    fn cause_literal(&mut self, call: &CallExpression<'a>) {
        let literal = call
            .arguments
            .first()
            .and_then(Argument::as_expression)
            .is_some_and(|cause| matches!(unwrap(cause), Expression::StringLiteral(_)));
        if !literal {
            self.report(
                "cell:cause-not-literal",
                call.span,
                "A cause in the reactive tier that is not a string literal",
            );
        }
    }

    /// Whether `expression` is a call of a pattern the program resolves.
    fn is_instantiation(&self, expression: &Expression<'a>) -> bool {
        let Expression::CallExpression(call) = unwrap(expression) else {
            return false;
        };
        match unwrap(&call.callee) {
            Expression::Identifier(identifier) => {
                matches!(self.thing(identifier), Thing::Def(_, DefKind::Pattern, _))
            }
            Expression::CallExpression(inner) => {
                self.is_modifier_call(inner)
                    || self
                        .api_of(&inner.callee)
                        .is_some_and(|api| api.value() == ApiValue::Builder(Builder::Pattern))
            }
            _ => false,
        }
    }

    fn cell_created(&mut self, span: Span, first: Option<&Argument<'a>>, typed: bool) {
        self.record_call(CallKind::CreateCell, "", span);
        let empty = first
            .and_then(Argument::as_expression)
            .is_some_and(|value| {
                matches!(unwrap(value), Expression::ArrayExpression(array)
                if array.elements.is_empty())
            });
        if empty && !typed {
            self.report(
                "cell-factory:empty-array",
                span,
                "A cell constructor called with `[]` and no type argument",
            );
        }
        if self.in_reactive() {
            self.mark_state(span);
        } else if !self.cause_given.contains(&span.start) {
            self.act(
                ActKind::CellWithoutCause,
                span,
                "A cell created without a cause",
            );
        }
    }

    /// A method call in the reactive tier (§4.4).
    fn reactive_method_call(
        &mut self,
        call: &CallExpression<'a>,
        member: &StaticMemberExpression<'a>,
        declared_cell: bool,
    ) {
        let name = member.property.name.as_str();
        if name == "get" {
            self.count("reactive:get-call");
        }
        if api::is_handle_collection_method(name) {
            self.collection_call(call, member);
            return;
        }
        self.visit_expression(&call.callee);
        if self.is_cf_table(&call.callee) {
            self.arguments(call, true);
            return;
        }
        let function_argument = call
            .arguments
            .iter()
            .any(|argument| FunctionLike::of_argument(argument).is_some());
        if !function_argument {
            let class = api::method_name(name);
            if declared_cell && is_function_tier_handle_method(name) {
                self.report(
                    "cell:method-tier",
                    call.span,
                    format!("`{name}` on a cell handle in the reactive tier"),
                );
            } else if let Some(kind) = self.factory_callee(call) {
                // A value of a factory type held in a property (§4.4.2).
                self.record_call(kind, name, call.span);
            } else if class != MethodName::Reactive
                && (self.declared_shape(&member.object).is_some()
                    || !self.may_be_factory_call(call))
            {
                self.report(
                    "reactive:unsupported-call",
                    call.span,
                    format!("`.{name}(...)` in the reactive tier"),
                );
            }
        }
        self.arguments(call, false);
    }

    /// The kind of call a callee of a factory type makes, when a declaration
    /// gives the callee such a type.
    fn factory_callee(&self, call: &CallExpression<'a>) -> Option<CallKind> {
        match self.declared_shape(&call.callee)? {
            Shape::PatternFactory(..) => Some(CallKind::Instantiate),
            Shape::HandlerFactory(..) => Some(CallKind::BindHandler),
            _ => None,
        }
    }

    /// Whether a method call could be a call of a pattern or handler factory
    /// held in a property, which only the receiver's type decides: it has
    /// one argument, and the argument could be an object.
    fn may_be_factory_call(&self, call: &CallExpression<'a>) -> bool {
        let [argument] = call.arguments.as_slice() else {
            return false;
        };
        let Some(argument) = argument.as_expression() else {
            return false;
        };
        !matches!(
            unwrap(argument),
            Expression::StringLiteral(_)
                | Expression::NumericLiteral(_)
                | Expression::BooleanLiteral(_)
                | Expression::NullLiteral(_)
                | Expression::TemplateLiteral(_)
                | Expression::ArrayExpression(_)
                | Expression::BigIntLiteral(_)
                | Expression::RegExpLiteral(_)
        )
    }

    /// A reactive collection operation (§4.4.1).
    fn collection_call(&mut self, call: &CallExpression<'a>, member: &StaticMemberExpression<'a>) {
        let name = member.property.name.as_str();
        self.record_call(CallKind::Collection, name, call.span);
        let collection = self.declared(&member.object);
        let label = self.resolver.outcome_label(&collection);
        self.count(&format!("types:collection:{label}"));
        self.nested_scan(call, member);
        self.visit_expression(&member.object);
        if let Some(arguments) = &call.type_arguments {
            self.visit_ts_type_parameter_instantiation(arguments);
        }
        let reduce = name == "reduce";
        let selector = api::is_selector_method(name);
        let Some(first) = call.arguments.first() else {
            if !selector {
                self.report(
                    "collection:callback-parameters",
                    call.span,
                    format!("`{name}` called without a callback"),
                );
            }
            return;
        };
        if reduce && call.arguments.len() < 2 {
            self.report(
                "collection:reduce-initial",
                call.span,
                "A `reduce` without an initial value",
            );
        }
        if reduce {
            let code = call
                .arguments
                .get(1)
                .and_then(Argument::as_expression)
                .and_then(|initial| self.declared_shape(initial))
                .is_some_and(|shape| matches!(shape, Shape::Code(_) | Shape::Function));
            if code {
                self.report(
                    "collection:reduce-accumulator",
                    call.span,
                    "A `reduce` whose accumulator has a code type",
                );
            }
        }
        for argument in call.arguments.iter().skip(1) {
            self.argument(argument, false);
        }
        let Some(function) = FunctionLike::of_argument(first) else {
            if !selector {
                self.report(
                    "collection:callback-parameters",
                    first.span(),
                    format!(
                        "The callback of `{name}` is not an arrow function written at the call"
                    ),
                );
            }
            self.visit_argument(first);
            return;
        };
        let limit = if reduce { 3 } else { 2 };
        if !function.is_arrow() {
            self.report(
                "collection:callback-parameters",
                function.span(),
                format!("The callback of `{name}` is not an arrow function"),
            );
        } else if function.param_count() > limit {
            self.report(
                "collection:callback-parameters",
                function.params().span,
                format!("The callback of `{name}` takes the whole array as a parameter"),
            );
        }
        let parameters = function.params();
        if parameters.rest.is_some()
            || parameters.items.iter().any(|parameter| {
                parameter.initializer.is_some() || has_default_or_rest(&parameter.pattern)
            })
        {
            self.report(
                "collection:callback-parameters",
                parameters.span,
                format!("The callback of `{name}` has a default value or a rest element"),
            );
        }
        if reduce && function.expression_body().is_none() {
            self.report(
                "collection:reduce-callback",
                function.span(),
                "A `reduce` callback with a block body",
            );
            self.refused(|checker| checker.function_in_place(function));
            return;
        }
        let block = function.expression_body().is_none();
        let body = self.enter_body(
            BodyKind::ElementCallback,
            Tier::Reactive,
            None,
            Some(name),
            function.span(),
            block,
        );
        let index = function
            .params()
            .items
            .get(limit - 1)
            .and_then(|parameter| binding_name(&parameter.pattern))
            .and_then(|name| name.symbol_id.get());
        if let Some(index) = index {
            self.index_symbols.insert(index, body);
        }
        self.element.insert(
            body,
            ElementState {
                plain: !reduce && self.is_plain_collection(&member.object, 0),
                state: None,
                child: false,
            },
        );
        self.reactive_body(function, body);
        let state = self.element.remove(&body).unwrap_or_default();
        let uses_index = self.out.bodies[body].uses_index;
        if uses_index && !reduce {
            self.report(
                "collection:index-keyed",
                function.span(),
                format!("The callback of `{name}` uses its index, so its elements are keyed by position"),
            );
        }
        if state.plain && state.child && !uses_index {
            self.count("child instantiated per element of plain values");
        }
        if let (true, false, Some(span)) = (state.plain, uses_index, state.state) {
            self.report(
                "collection:shared-element-state",
                span,
                "A state cell declared per element of a collection of plain values, without the index",
            );
        }
    }

    /// `collection:nested-scan`: a collection callback inside another scans
    /// a collection that the enclosing callback captures.
    fn nested_scan(&mut self, call: &CallExpression<'a>, member: &StaticMemberExpression<'a>) {
        let has_callback = call
            .arguments
            .first()
            .is_some_and(|argument| FunctionLike::of_argument(argument).is_some());
        let Expression::Identifier(receiver) = unwrap(&member.object) else {
            return;
        };
        let Thing::Local(symbol) = self.thing(receiver) else {
            return;
        };
        let enclosing = self
            .frames
            .iter()
            .rev()
            .find(|frame| self.out.bodies[frame.body].kind == BodyKind::ElementCallback);
        let Some(enclosing) = enclosing else {
            return;
        };
        if !has_callback || self.current_body() != Some(enclosing.body) {
            return;
        }
        let declared = self.scoping.symbol_scope_id(symbol);
        let inside = self
            .scoping
            .scope_ancestors(declared)
            .any(|scope| scope == enclosing.scope);
        if !inside {
            self.report(
                "collection:nested-scan",
                call.span,
                format!(
                    "This callback scans `{}`, a collection captured from an enclosing body, \
                     once per element",
                    receiver.name
                ),
            );
        }
    }

    /// A mutating method called on a module-scope constant (§3.3).
    fn frozen_mutation(&mut self, call: &CallExpression<'a>, member: &StaticMemberExpression<'a>) {
        let name = member.property.name.as_str();
        let array = api::is_array_mutator(name);
        let keyed = api::is_keyed_collection_mutator(name);
        if !array && !keyed {
            return;
        }
        let mut object = unwrap(&member.object);
        let mut nested = false;
        while let Expression::StaticMemberExpression(inner) = object {
            object = unwrap(&inner.object);
            nested = true;
        }
        let Expression::Identifier(root) = object else {
            return;
        };
        let Thing::Def(def, DefKind::FrozenData, Some(form)) = self.thing(root) else {
            return;
        };
        if def.module != self.module {
            return;
        }
        let written = match (form, nested) {
            (DataForm::Array, false) => array,
            (DataForm::Map | DataForm::Set, false) => keyed,
            (DataForm::Array | DataForm::Object, true) => true,
            _ => false,
        };
        if written {
            self.report(
                "module-scope:frozen-data-write",
                call.span,
                format!(
                    "`{name}` called on the module-scope constant `{}`",
                    root.name
                ),
            );
        }
    }

    // ----- Writes (§3.3, §5.1) -----

    /// Reports a write through a member of a module-scope constant, an
    /// import, or a global.
    fn member_write(&mut self, target: &MemberExpression<'a>, span: Span) {
        if self.in_reactive() {
            return;
        }
        let mut object = unwrap(target.object());
        while let Some(inner) = object.as_member_expression() {
            object = unwrap(inner.object());
        }
        let Expression::Identifier(root) = object else {
            return;
        };
        match self.thing(root) {
            Thing::Global => self.report(
                "function-body:global-write",
                span,
                format!("A write to a member of the global `{}`", root.name),
            ),
            Thing::Def(_, kind, _) if !matches!(kind, DefKind::Mutable | DefKind::Type) => self
                .report(
                    "module-scope:frozen-data-write",
                    span,
                    format!("A write through the module-scope constant `{}`", root.name),
                ),
            Thing::Api(_) | Thing::ApiNamespace(_) | Thing::Import => self.report(
                "module-scope:frozen-data-write",
                span,
                format!("A write through the import `{}`", root.name),
            ),
            _ => {}
        }
    }

    // ----- Captures (§4.6, §5.2) -----

    fn reference(&mut self, symbol: SymbolId) {
        if let Some(&body) = self.index_symbols.get(&symbol) {
            self.out.bodies[body].uses_index = true;
        }
        let declared = self.scoping.symbol_scope_id(symbol);
        if declared == self.scoping.root_scope_id() {
            return;
        }
        for position in (0..self.frames.len()).rev() {
            let (body, scope) = (self.frames[position].body, self.frames[position].scope);
            if self
                .scoping
                .scope_ancestors(declared)
                .any(|ancestor| ancestor == scope)
            {
                break;
            }
            if self.capture_seen.insert((body, symbol)) {
                self.capture(body, symbol);
            }
        }
    }

    fn capture(&mut self, body: usize, symbol: SymbolId) {
        let name = self.scoping.symbol_name(symbol).to_string();
        let declared = self.scoping.symbol_span(symbol);
        self.out.bodies[body].captures.push(Capture {
            name: name.clone(),
            declared: offsets(declared),
        });
        let (kind, site, span) = {
            let body = &self.out.bodies[body];
            (body.kind, body.site, Span::new(body.span.0, body.span.1))
        };
        let binds = match kind {
            BodyKind::Action | BodyKind::InlineHandler => true,
            BodyKind::Pattern => site == Site::Function,
            BodyKind::Computed | BodyKind::Assert => site == Site::Reactive,
            _ => false,
        };
        if !binds {
            return;
        }
        let nodes = self.parsed.semantic.nodes();
        let (callable, reassigned) = match nodes.kind(self.scoping.symbol_declaration(symbol)) {
            AstKind::Function(_) => (true, false),
            AstKind::VariableDeclarator(declarator) => (
                declarator
                    .init
                    .as_ref()
                    .is_some_and(|init| FunctionLike::of(init).is_some())
                    && matches!(declarator.id, BindingPattern::BindingIdentifier(_)),
                declarator.kind == VariableDeclarationKind::Let,
            ),
            _ => (false, false),
        };
        if callable {
            self.report(
                "ses-callback:callable-capture",
                span,
                format!("This body captures the function `{name}` from an enclosing function"),
            );
        }
        if reassigned && site == Site::Function {
            self.report(
                "function-body:handler-capture",
                span,
                format!("This body captures the `let` binding `{name}`"),
            );
        }
    }

    /// The function-tier grammar rule for a form that is refused in every
    /// function body, reported unless the reactive tier reports the form
    /// under its own identifier.
    fn function_tier(&mut self, id: &'static str, span: Span, found: &str) {
        if !self.in_reactive() {
            self.report(id, span, found);
        }
    }

    /// Whether the callee of a `new` is not a global, a cell constructor,
    /// or a Fabric value class (§5.1).
    fn is_authored_constructor(&self, callee: &Expression<'a>) -> bool {
        let mut root = unwrap(callee);
        while let Some(member) = root.as_member_expression() {
            root = unwrap(member.object());
        }
        match root {
            Expression::Identifier(identifier) => match self.thing(identifier) {
                Thing::Global | Thing::ApiNamespace(_) => false,
                Thing::Api(api) => !api.name.starts_with("Fabric"),
                Thing::Def(..) | Thing::Import | Thing::Local(_) => true,
            },
            _ => true,
        }
    }

    fn is_self_key(&self, key: &Expression<'a>) -> bool {
        self.is_api(key, "SELF")
    }
}

/// Whether a shape is a value that is certainly not a cell handle: data the
/// checker evaluated, which `.get()` does not read.
fn is_value_shape(shape: &Shape) -> bool {
    matches!(
        shape,
        Shape::String
            | Shape::Number
            | Shape::Boolean
            | Shape::BigInt
            | Shape::Null
            | Shape::Undefined
            | Shape::Literal(_)
            | Shape::Object(..)
            | Shape::Array(_)
            | Shape::Tuple(_)
            | Shape::PatternFactory(..)
            | Shape::HandlerFactory(..)
    )
}

/// Whether a binding pattern has a default value or a rest element at any
/// depth.
fn has_default_or_rest(pattern: &BindingPattern<'_>) -> bool {
    match pattern {
        BindingPattern::BindingIdentifier(_) => false,
        BindingPattern::AssignmentPattern(_) => true,
        BindingPattern::ObjectPattern(object) => {
            object.rest.is_some()
                || object
                    .properties
                    .iter()
                    .any(|property| has_default_or_rest(&property.value))
        }
        BindingPattern::ArrayPattern(array) => {
            array.rest.is_some() || array.elements.iter().flatten().any(has_default_or_rest)
        }
    }
}

/// The methods of a cell handle that §4.7 lists for the function tier only.
fn is_function_tier_handle_method(name: &str) -> bool {
    matches!(
        name,
        "set"
            | "update"
            | "push"
            | "pushAll"
            | "addUnique"
            | "remove"
            | "removeByValue"
            | "removeAll"
            | "increment"
            | "applyChanges"
            | "send"
            | "exec"
            | "sample"
            | "getArgumentCell"
    )
}

/// Collects the `return` statements of a body, without those of functions
/// nested in it.
fn collect_returns<'e, 'a>(statement: &'e Statement<'a>, out: &mut Vec<&'e ReturnStatement<'a>>) {
    match statement {
        Statement::ReturnStatement(statement) => out.push(statement),
        Statement::BlockStatement(block) => {
            for statement in &block.body {
                collect_returns(statement, out);
            }
        }
        Statement::IfStatement(statement) => {
            collect_returns(&statement.consequent, out);
            if let Some(alternate) = &statement.alternate {
                collect_returns(alternate, out);
            }
        }
        Statement::ForStatement(statement) => collect_returns(&statement.body, out),
        Statement::ForInStatement(statement) => collect_returns(&statement.body, out),
        Statement::ForOfStatement(statement) => collect_returns(&statement.body, out),
        Statement::WhileStatement(statement) => collect_returns(&statement.body, out),
        Statement::DoWhileStatement(statement) => collect_returns(&statement.body, out),
        Statement::LabeledStatement(statement) => collect_returns(&statement.body, out),
        Statement::SwitchStatement(statement) => {
            for case in &statement.cases {
                for statement in &case.consequent {
                    collect_returns(statement, out);
                }
            }
        }
        Statement::TryStatement(statement) => {
            for statement in &statement.block.body {
                collect_returns(statement, out);
            }
            if let Some(handler) = &statement.handler {
                for statement in &handler.body.body {
                    collect_returns(statement, out);
                }
            }
            if let Some(finalizer) = &statement.finalizer {
                for statement in &finalizer.body {
                    collect_returns(statement, out);
                }
            }
        }
        _ => {}
    }
}

/// Whether a returned expression is certainly a plain value: a literal, an
/// object or array literal, a template, or arithmetic over one.
fn is_plain_shaped(expression: &Expression<'_>) -> bool {
    match expression {
        Expression::TSAsExpression(cast) => {
            !matches!(cast.type_annotation, TSType::TSAnyKeyword(_))
                && is_plain_shaped(&cast.expression)
        }
        Expression::TSSatisfiesExpression(cast) => {
            !matches!(cast.type_annotation, TSType::TSAnyKeyword(_))
                && is_plain_shaped(&cast.expression)
        }
        Expression::TSTypeAssertion(cast) => {
            !matches!(cast.type_annotation, TSType::TSAnyKeyword(_))
                && is_plain_shaped(&cast.expression)
        }
        Expression::ParenthesizedExpression(inner) => is_plain_shaped(&inner.expression),
        Expression::TSNonNullExpression(inner) => is_plain_shaped(&inner.expression),
        Expression::ConditionalExpression(conditional) => {
            is_plain_shaped(&conditional.consequent) && is_plain_shaped(&conditional.alternate)
        }
        Expression::UnaryExpression(unary) => {
            matches!(
                unary.operator,
                UnaryOperator::UnaryNegation | UnaryOperator::UnaryPlus
            ) && is_plain_shaped(&unary.argument)
        }
        Expression::BinaryExpression(binary) => {
            matches!(
                binary.operator,
                BinaryOperator::Addition
                    | BinaryOperator::Subtraction
                    | BinaryOperator::Multiplication
                    | BinaryOperator::Division
                    | BinaryOperator::Remainder
            ) && (is_plain_shaped(&binary.left) || is_plain_shaped(&binary.right))
        }
        Expression::ObjectExpression(_)
        | Expression::ArrayExpression(_)
        | Expression::StringLiteral(_)
        | Expression::TemplateLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_) => true,
        _ => false,
    }
}

impl<'a> Visit<'a> for Checker<'_, 'a> {
    fn visit_expression(&mut self, it: &Expression<'a>) {
        if let Some(function) = match it {
            Expression::ArrowFunctionExpression(arrow) => Some(FunctionLike::Arrow(arrow)),
            Expression::FunctionExpression(function) => Some(FunctionLike::Function(function)),
            _ => None,
        } {
            match self.cur() {
                Ctx::Reactive { .. } => {
                    self.report(
                        "pattern-context:function-creation",
                        function.span(),
                        "A function created in the reactive tier outside a callback position",
                    );
                    self.refused(|checker| checker.function_in_place(function));
                }
                Ctx::Module => self.function_body(function, None, Root::ModuleInit),
                Ctx::Function { .. } | Ctx::Refused => {
                    self.loop_depth += 1;
                    self.function_in_place(function);
                    self.loop_depth -= 1;
                }
            }
            return;
        }
        if let Expression::BinaryExpression(binary) = it {
            if matches!(
                binary.operator,
                BinaryOperator::StrictEquality | BinaryOperator::StrictInequality
            ) {
                for operand in [&binary.left, &binary.right] {
                    self.prototype_operands.insert(unwrap(operand).span().start);
                }
            }
        }
        if self.in_reactive() {
            let found = match it {
                Expression::AssignmentExpression(_) | Expression::UpdateExpression(_) => Some((
                    "pattern-context:assignment",
                    "An assignment in the reactive tier",
                )),
                Expression::UnaryExpression(unary) => match unary.operator {
                    UnaryOperator::Delete => Some((
                        "pattern-context:assignment",
                        "`delete` in the reactive tier",
                    )),
                    UnaryOperator::Void => {
                        self.count("reactive:void");
                        Some((
                            "reactive:unsupported-expression",
                            "`void` in the reactive tier",
                        ))
                    }
                    _ => None,
                },
                Expression::AwaitExpression(_) => Some((
                    "reactive:unsupported-expression",
                    "`await` in the reactive tier",
                )),
                Expression::YieldExpression(_) => Some((
                    "reactive:unsupported-expression",
                    "`yield` in the reactive tier",
                )),
                Expression::ThisExpression(_) => Some((
                    "reactive:unsupported-expression",
                    "`this` in the reactive tier",
                )),
                Expression::SequenceExpression(_) => Some((
                    "reactive:unsupported-expression",
                    "The comma operator in the reactive tier",
                )),
                Expression::BinaryExpression(binary)
                    if binary.operator == BinaryOperator::Instanceof =>
                {
                    Some((
                        "reactive:unsupported-expression",
                        "`instanceof` in the reactive tier",
                    ))
                }
                Expression::ConditionalExpression(_) => {
                    self.count("reactive:conditional");
                    None
                }
                _ => None,
            };
            if let Some((id, found)) = found {
                self.report(id, it.span(), found);
            }
        }
        walk::walk_expression(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        self.call(it);
    }

    fn visit_new_expression(&mut self, it: &NewExpression<'a>) {
        if self.is_cell_constructor(&it.callee) {
            self.cell_created(it.span, it.arguments.first(), it.type_arguments.is_some());
        } else {
            let global = self.global_name(&it.callee);
            let ambient = global == Some("Date") && it.arguments.is_empty();
            if ambient {
                self.act(
                    ActKind::Ambient,
                    it.span,
                    "`new Date()` without an argument",
                );
            } else if global == Some("Function") {
                self.report(
                    "function-body:dynamic-code",
                    it.span,
                    "The `Function` constructor",
                );
            }
            if matches!(self.cur(), Ctx::Function { .. })
                && self.is_authored_constructor(&it.callee)
            {
                self.report(
                    "function-body:constructor",
                    it.span,
                    "`new` of a callee that is not a constructor of the standard library, a cell constructor, or a Fabric value class",
                );
            }
            let reported_by_name = global.is_some_and(|name| {
                matches!(api::global(name), Global::Refused(_) | Global::Unlisted)
            });
            if self.in_reactive() {
                self.count("reactive:new-non-cell");
                if !ambient && !reported_by_name {
                    self.report(
                        "reactive:unsupported-expression",
                        it.span,
                        "`new` of a constructor that is not a cell constructor, in the reactive tier",
                    );
                }
            }
        }
        walk::walk_new_expression(self, it);
    }

    fn visit_tagged_template_expression(&mut self, it: &TaggedTemplateExpression<'a>) {
        match self.api_of(&it.tag) {
            Some(api) if api.name == "str" && api.subpath.is_none() => {
                self.helper_callees.insert(unwrap(&it.tag).span().start);
                self.count("form:str");
                if self.in_reactive() && api.direct {
                    self.report(
                        "removed-form:helper",
                        it.span,
                        "The `str` tag is a removed form",
                    );
                } else {
                    self.report(
                        "removed-form:helper-unsupported",
                        it.span,
                        "The `str` tag in a form the interim acceptance does not cover",
                    );
                }
            }
            Some(api) if api.name == "debugStr" => {}
            _ => {
                if self.in_reactive() {
                    self.report(
                        "reactive:unsupported-expression",
                        it.span,
                        "A tagged template in the reactive tier",
                    );
                }
            }
        }
        walk::walk_tagged_template_expression(self, it);
    }

    fn visit_member_expression(&mut self, it: &MemberExpression<'a>) {
        match it {
            MemberExpression::StaticMemberExpression(member) => {
                if let Some(namespace) = self.global_name(&member.object) {
                    if api::is_global_namespace(namespace) {
                        let name = member.property.name.as_str();
                        let compared = namespace == "Object"
                            && name == "prototype"
                            && self.prototype_operands.contains(&member.span.start);
                        match api::global_member(namespace, name) {
                            _ if compared => {}
                            Some(GlobalMember::Ambient) => self.act(
                                ActKind::Ambient,
                                member.span,
                                &format!("`{namespace}.{name}` read"),
                            ),
                            Some(GlobalMember::Reactive | GlobalMember::FunctionOnly) => {}
                            Some(GlobalMember::Reflective) | None => self.report(
                                "stdlib:unsupported-member",
                                member.span,
                                format!(
                                    "`{namespace}.{name}` is not a listed standard-library member"
                                ),
                            ),
                        }
                    }
                }
            }
            MemberExpression::ComputedMemberExpression(member) => {
                if self.is_self_key(&member.expression) {
                    let own = self.in_reactive()
                        && matches!(unwrap(&member.object), Expression::Identifier(object)
                        if symbol_of(self.scoping, object).is_some_and(|symbol| {
                            self.pattern_params.last() == Some(&Some(symbol))
                        }));
                    if !own {
                        self.report(
                            "pattern-context:self-access",
                            member.span,
                            "`[SELF]` read from a value that is not the pattern's own input parameter",
                        );
                    }
                }
            }
            MemberExpression::PrivateFieldExpression(_) => {}
        }
        walk::walk_member_expression(self, it);
    }

    fn visit_binding_property(&mut self, it: &BindingProperty<'a>) {
        if it.computed {
            let is_self = it
                .key
                .as_expression()
                .is_some_and(|key| self.is_self_key(key));
            if is_self && !(self.self_key_legal && self.in_reactive()) {
                self.report(
                    "pattern-context:self-access",
                    it.span,
                    "`[SELF]` destructured from a value that is not the pattern's own input parameter",
                );
            }
        }
        // A nested pattern is not the parameter itself.
        let nested =
            self.self_key_legal && matches!(it.value, BindingPattern::BindingIdentifier(_));
        let legal = std::mem::replace(&mut self.self_key_legal, nested);
        walk::walk_binding_property(self, it);
        self.self_key_legal = legal;
    }

    fn visit_formal_parameters(&mut self, it: &FormalParameters<'a>) {
        // Only the first parameter of a pattern callback may destructure
        // `[SELF]`, and `builder_call` visits it with the flag set.
        let legal = self.self_key_legal;
        for (index, parameter) in it.items.iter().enumerate() {
            self.self_key_legal = legal && index == 0;
            self.visit_formal_parameter(parameter);
        }
        self.self_key_legal = false;
        if let Some(rest) = &it.rest {
            self.visit_formal_parameter_rest(rest);
        }
        self.self_key_legal = false;
    }

    fn visit_assignment_expression(&mut self, it: &AssignmentExpression<'a>) {
        if let Some(target) = it.left.as_member_expression() {
            self.member_write(target, it.span);
        }
        walk::walk_assignment_expression(self, it);
    }

    fn visit_update_expression(&mut self, it: &UpdateExpression<'a>) {
        if let Some(target) = it.argument.as_member_expression() {
            self.member_write(target, it.span);
        }
        walk::walk_update_expression(self, it);
    }

    fn visit_unary_expression(&mut self, it: &UnaryExpression<'a>) {
        if it.operator == UnaryOperator::Delete {
            if let Some(target) = unwrap(&it.argument).as_member_expression() {
                self.member_write(target, it.span);
            }
        }
        walk::walk_unary_expression(self, it);
    }

    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        let Some(reference) = it.reference_id.get() else {
            return;
        };
        let reference = self.scoping.get_reference(reference);
        let flags = reference.flags();
        if flags.is_type() || flags.is_value_as_type() {
            return;
        }
        match reference.symbol_id() {
            Some(symbol) => {
                self.reference(symbol);
                let helper = self
                    .model
                    .api_ref(symbol)
                    .is_some_and(|api| api.value() == ApiValue::RemovedHelper);
                if helper && !self.helper_callees.contains(&it.span.start) {
                    self.report(
                        "removed-form:helper-unsupported",
                        it.span,
                        format!("`{}` passed as a value", it.name),
                    );
                }
                if flags.is_write() && !self.in_reactive() {
                    let module_scope = match self.thing_of_symbol(symbol) {
                        Thing::Def(_, kind, _) => kind != DefKind::Mutable,
                        Thing::Local(_) => false,
                        _ => true,
                    };
                    if module_scope {
                        self.report(
                            "module-scope:frozen-data-write",
                            it.span,
                            format!("An assignment to the module-scope binding `{}`", it.name),
                        );
                    }
                }
            }
            None => {
                let name = it.name.as_str();
                if flags.is_write() {
                    if !self.in_reactive() {
                        self.report(
                            "function-body:global-write",
                            it.span,
                            format!("An assignment to the global `{name}`"),
                        );
                    }
                    return;
                }
                if name == "arguments" {
                    self.report("function-body:this", it.span, "`arguments`");
                    return;
                }
                match api::global(name) {
                    Global::Refused(replacement) => {
                        let found = match replacement {
                            Some(replacement) => {
                                format!("The global `{name}` is not available; use {replacement}")
                            }
                            None => format!("The global `{name}` is not available"),
                        };
                        self.report("function-body:unsupported-global", it.span, found);
                    }
                    Global::Unlisted => self.report(
                        "stdlib:unsupported-member",
                        it.span,
                        format!("`{name}` is not a listed standard-library global"),
                    ),
                    Global::DynamicCode if name == "eval" => {
                        self.report("function-body:dynamic-code", it.span, "`eval`");
                    }
                    _ => {}
                }
            }
        }
    }

    fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
        let function = FunctionLike::of(&it.value);
        let accessor = it.method || it.kind != PropertyKind::Init;
        if it.computed && self.in_reactive() {
            if let Some(key) = it.key.as_expression() {
                if self.is_dynamic_key(key) {
                    self.report(
                        "reactive:unsupported-expression",
                        key.span(),
                        "An object literal key that is not static, in the reactive tier",
                    );
                }
            }
        }
        match self.cur() {
            Ctx::Reactive { .. } if accessor || function.is_some() => {
                self.report(
                    "pattern-context:object-member",
                    it.span,
                    "A method, an accessor, or a function-valued property in an object literal",
                );
                self.visit_property_key(&it.key);
                if let Some(function) = function {
                    self.refused(|checker| checker.function_in_place(function));
                } else {
                    self.visit_expression(&it.value);
                }
                return;
            }
            Ctx::Function { .. } | Ctx::Refused if accessor => {
                self.report(
                    "function-body:accessor",
                    it.span,
                    "A getter, a setter, or a method in an object literal",
                );
            }
            _ => {}
        }
        walk::walk_object_property(self, it);
    }

    fn visit_variable_declaration(&mut self, it: &VariableDeclaration<'a>) {
        if it.kind == VariableDeclarationKind::Var {
            self.function_tier("function-body:var", it.span, "`var`");
        }
        walk::walk_variable_declaration(self, it);
    }

    fn visit_function(&mut self, it: &Function<'a>, _flags: ScopeFlags) {
        let function = FunctionLike::Function(it);
        if self.in_reactive() {
            self.refused(|checker| checker.function_in_place(function));
        } else {
            self.function_in_place(function);
        }
    }

    fn visit_class(&mut self, it: &Class<'a>) {
        match self.cur() {
            Ctx::Module => self.report(
                "module-scope:class-declaration",
                it.span,
                "A class at module scope",
            ),
            Ctx::Reactive { .. } => self.report(
                "pattern-context:function-creation",
                it.span,
                "A class created in the reactive tier",
            ),
            Ctx::Function { .. } => self.report("function-body:class", it.span, "A class"),
            Ctx::Refused => {}
        }
        self.refused(|checker| walk::walk_class(checker, it));
    }

    fn visit_this_expression(&mut self, it: &ThisExpression) {
        self.function_tier("function-body:this", it.span, "`this`");
    }

    fn visit_super(&mut self, it: &Super) {
        self.report("function-body:this", it.span, "`super`");
    }

    fn visit_meta_property(&mut self, it: &MetaProperty<'a>) {
        if it.meta.name == "new" {
            self.report("function-body:this", it.span, "`new.target`");
        } else {
            self.report("function-body:dynamic-code", it.span, "`import.meta`");
        }
    }

    fn visit_import_expression(&mut self, it: &ImportExpression<'a>) {
        self.report(
            "function-body:dynamic-code",
            it.span,
            "A dynamic `import()`",
        );
        walk::walk_import_expression(self, it);
    }

    fn visit_await_expression(&mut self, it: &AwaitExpression<'a>) {
        self.function_tier("function-body:async", it.span, "`await`");
        walk::walk_await_expression(self, it);
    }

    fn visit_yield_expression(&mut self, it: &YieldExpression<'a>) {
        self.function_tier("function-body:generator", it.span, "`yield`");
        walk::walk_yield_expression(self, it);
    }

    fn visit_for_in_statement(&mut self, it: &ForInStatement<'a>) {
        self.report("function-body:for-in", it.span, "`for...in`");
        self.loop_depth += 1;
        walk::walk_for_in_statement(self, it);
        self.loop_depth -= 1;
    }

    fn visit_for_of_statement(&mut self, it: &ForOfStatement<'a>) {
        if it.r#await {
            self.report("function-body:async", it.span, "`for await`");
        }
        self.loop_depth += 1;
        walk::walk_for_of_statement(self, it);
        self.loop_depth -= 1;
    }

    fn visit_for_statement(&mut self, it: &ForStatement<'a>) {
        self.loop_depth += 1;
        walk::walk_for_statement(self, it);
        self.loop_depth -= 1;
    }

    fn visit_while_statement(&mut self, it: &WhileStatement<'a>) {
        self.loop_depth += 1;
        walk::walk_while_statement(self, it);
        self.loop_depth -= 1;
    }

    fn visit_do_while_statement(&mut self, it: &DoWhileStatement<'a>) {
        self.loop_depth += 1;
        walk::walk_do_while_statement(self, it);
        self.loop_depth -= 1;
    }

    fn visit_with_statement(&mut self, it: &WithStatement<'a>) {
        self.report("function-body:dynamic-code", it.span, "`with`");
        walk::walk_with_statement(self, it);
    }

    fn visit_debugger_statement(&mut self, it: &DebuggerStatement) {
        self.report("function-body:dynamic-code", it.span, "`debugger`");
    }

    fn visit_jsx_opening_element(&mut self, it: &JSXOpeningElement<'a>) {
        if let JSXElementName::IdentifierReference(name) = &it.name {
            self.record_call(CallKind::Instantiate, name.name.as_str(), it.span);
        }
        walk::walk_jsx_opening_element(self, it);
    }

    fn visit_jsx_attribute(&mut self, it: &JSXAttribute<'a>) {
        let handler = match (&it.name, &it.value) {
            (
                JSXAttributeName::Identifier(name),
                Some(JSXAttributeValue::ExpressionContainer(value)),
            ) if name.name.starts_with("on") && name.name.len() > 2 => {
                match value.expression.as_expression().map(unwrap) {
                    Some(Expression::ArrowFunctionExpression(arrow)) => {
                        Some((name.name.as_str(), FunctionLike::Arrow(arrow)))
                    }
                    _ => None,
                }
            }
            _ => None,
        };
        let Some((name, function)) = handler else {
            walk::walk_jsx_attribute(self, it);
            return;
        };
        self.record_call(CallKind::BindHandler, name, it.span);
        let body = self.enter_body(
            BodyKind::InlineHandler,
            Tier::Function,
            Some(name.to_string()),
            None,
            function.span(),
            function.expression_body().is_none(),
        );
        self.function_body(function, Some(body), Root::Event);
    }

    // The type rules are in `types.rs`.

    fn visit_ts_any_keyword(&mut self, it: &TSAnyKeyword) {
        self.type_any(it);
    }

    fn visit_ts_as_expression(&mut self, it: &TSAsExpression<'a>) {
        self.cast(&it.type_annotation, it.span);
        walk::walk_ts_as_expression(self, it);
    }

    fn visit_ts_type_assertion(&mut self, it: &TSTypeAssertion<'a>) {
        self.cast(&it.type_annotation, it.span);
        walk::walk_ts_type_assertion(self, it);
    }

    fn visit_ts_conditional_type(&mut self, it: &TSConditionalType<'a>) {
        self.report("subset-type:conditional", it.span, "A conditional type");
        walk::walk_ts_conditional_type(self, it);
    }

    fn visit_ts_mapped_type(&mut self, it: &TSMappedType<'a>) {
        self.report("subset-type:mapped", it.span, "A mapped type");
        walk::walk_ts_mapped_type(self, it);
    }

    fn visit_ts_template_literal_type(&mut self, it: &TSTemplateLiteralType<'a>) {
        self.report(
            "subset-type:template-literal",
            it.span,
            "A template literal type",
        );
        walk::walk_ts_template_literal_type(self, it);
    }

    fn visit_ts_symbol_keyword(&mut self, it: &TSSymbolKeyword) {
        self.report("schema-type:symbol", it.span, "`symbol` in a type");
    }

    fn visit_ts_constructor_type(&mut self, it: &TSConstructorType<'a>) {
        self.report("subset-type:class", it.span, "A constructor type");
        walk::walk_ts_constructor_type(self, it);
    }

    fn visit_ts_this_type(&mut self, it: &TSThisType) {
        self.report("subset-type:class", it.span, "A `this` type");
    }

    fn visit_ts_call_signature_declaration(&mut self, it: &TSCallSignatureDeclaration<'a>) {
        self.report(
            "subset-type:callable-object",
            it.span,
            "A call signature in an object type",
        );
        walk::walk_ts_call_signature_declaration(self, it);
    }

    fn visit_ts_construct_signature_declaration(
        &mut self,
        it: &TSConstructSignatureDeclaration<'a>,
    ) {
        self.report(
            "subset-type:callable-object",
            it.span,
            "A construct signature in an object type",
        );
        walk::walk_ts_construct_signature_declaration(self, it);
    }

    fn visit_ts_method_signature(&mut self, it: &TSMethodSignature<'a>) {
        if it.kind != TSMethodSignatureKind::Method {
            self.report(
                "subset-type:callable-object",
                it.span,
                "An accessor in an object type",
            );
        }
        walk::walk_ts_method_signature(self, it);
    }

    fn visit_ts_type_predicate(&mut self, it: &TSTypePredicate<'a>) {
        if it.asserts {
            self.report(
                "subset-type:assertion-signature",
                it.span,
                "An `asserts` signature",
            );
        }
        walk::walk_ts_type_predicate(self, it);
    }

    fn visit_ts_type_parameter(&mut self, it: &TSTypeParameter<'a>) {
        if it.r#in || it.out || it.r#const {
            self.report(
                "subset-type:unsupported-modifier",
                it.span,
                "A variance annotation or a `const` type parameter",
            );
        }
        walk::walk_ts_type_parameter(self, it);
    }

    fn visit_ts_index_signature(&mut self, it: &TSIndexSignature<'a>) {
        self.index_signature(it);
        walk::walk_ts_index_signature(self, it);
    }

    fn visit_ts_type_operator(&mut self, it: &TSTypeOperator<'a>) {
        if it.operator == TSTypeOperatorOperator::Unique {
            self.report("schema-type:symbol", it.span, "`unique symbol` in a type");
            return;
        }
        walk::walk_ts_type_operator(self, it);
    }

    fn visit_ts_enum_declaration(&mut self, it: &TSEnumDeclaration<'a>) {
        self.report("subset-syntax:enum", it.span, "An `enum`");
    }

    fn visit_ts_module_declaration(&mut self, it: &TSModuleDeclaration<'a>) {
        match &it.id {
            TSModuleDeclarationName::StringLiteral(_) => self.report(
                "subset-syntax:ambient-declaration",
                it.span,
                "A module augmentation",
            ),
            TSModuleDeclarationName::Identifier(_) => {
                self.report("subset-syntax:namespace", it.span, "A `namespace`");
            }
        }
    }

    fn visit_ts_global_declaration(&mut self, it: &TSGlobalDeclaration<'a>) {
        self.report(
            "subset-syntax:ambient-declaration",
            it.span,
            "`declare global`",
        );
    }

    fn visit_decorator(&mut self, it: &Decorator<'a>) {
        self.report("subset-syntax:decorator", it.span, "A decorator");
        walk::walk_decorator(self, it);
    }

    fn visit_ts_type_alias_declaration(&mut self, it: &TSTypeAliasDeclaration<'a>) {
        self.recursion(
            it.id.symbol_id.get(),
            it.type_parameters.as_deref(),
            |finder| {
                finder.visit_ts_type(&it.type_annotation);
            },
        );
        walk::walk_ts_type_alias_declaration(self, it);
    }

    fn visit_ts_interface_declaration(&mut self, it: &TSInterfaceDeclaration<'a>) {
        self.interface_merging(it);
        self.recursion(
            it.id.symbol_id.get(),
            it.type_parameters.as_deref(),
            |finder| {
                finder.visit_ts_interface_body(&it.body);
            },
        );
        walk::walk_ts_interface_declaration(self, it);
    }
}
