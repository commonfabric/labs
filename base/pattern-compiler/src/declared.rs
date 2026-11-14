//! The declared type of a binding, and of an expression that names one.
//!
//! Nothing here infers a type from an expression, apart from a literal and
//! the two handle methods `get` and `key`, whose result is the handle's own
//! declared type. An expression whose type would need inference gets an
//! [`Origin`] instead, which says what the missing type comes from. The
//! corpus measurement counts those.

use oxc_ast::ast::*;
use oxc_ast::AstKind;
use oxc_ast_visit::{walk, Visit};
use oxc_span::GetSpan;
use oxc_syntax::symbol::SymbolId;
use serde::Serialize;

use crate::api::{self, ApiValue, Builder};
use crate::module::{symbol_of, Binding, ModuleTier};
use crate::program::Resolver;
use crate::syntax::{unwrap, FunctionLike};
use crate::types::{HandleKind, Shape, TypeId, Why};

/// Where the type of an expression would have to come from, when no
/// declaration gives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Origin {
    /// A call this slice has no rule for.
    CallResult,
    /// A call of a value of a function type, whose signature the type
    /// representation does not keep.
    FunctionValue,
    /// A call of a `commonfabric` function this slice has no signature for.
    ApiResult,
    /// A member of a typed value that this slice has no typing for.
    UnlistedMember,
    /// A call of a function whose body is not one expression or one
    /// `return`, and that has no return annotation.
    UninferredReturn,
    /// A member of a receiver that has no type.
    UntypedReceiver,
    Operator,
    Literal,
    PropertyOfInferred,
    /// A parameter of a callback whose callee gives it no type.
    CallbackParameter,
    /// A parameter with no annotation that is not a callback's.
    UntypedParameter,
    /// A `let` without an annotation or an initializer.
    Reassigned,
    /// A value imported from a module the program does not hold, or a
    /// global.
    External,
    Other,
}

impl Origin {
    pub fn label(self) -> &'static str {
        match self {
            Origin::CallResult => "untyped: the result of a call with no rule in this slice",
            Origin::FunctionValue => "untyped: the result of a call of a function value",
            Origin::ApiResult => {
                "untyped: the result of a built-in with no signature in this slice"
            }
            Origin::UnlistedMember => "untyped: a member with no typing in this slice",
            Origin::UninferredReturn => {
                "untyped: the result of a function whose body is not one expression or one return"
            }
            Origin::UntypedReceiver => "untyped: a member of an untyped receiver",
            Origin::Operator => "untyped: an operator on untyped operands",
            Origin::Literal => "untyped: a literal",
            Origin::PropertyOfInferred => "untyped: a property of an untyped value",
            Origin::CallbackParameter => "untyped: a callback parameter its callee gives no type",
            Origin::UntypedParameter => "untyped: a parameter without an annotation",
            Origin::Reassigned => "untyped: a `let` without an annotation or an initializer",
            Origin::External => "untyped: a global or a value from outside the program",
            Origin::Other => "untyped: another expression",
        }
    }
}

/// The outcome for one expression: a declared type, or why there is none.
pub type Declared = Result<TypeId, Origin>;

const MAX_DEPTH: u32 = 12;

impl<'a> Resolver<'_, 'a> {
    /// The label the measurement files an outcome under.
    pub fn outcome_label(&self, declared: &Declared) -> &'static str {
        match declared {
            Ok(ty) => match self.shape(*ty) {
                Shape::Unresolved(Why::Any) => "declared `any`",
                Shape::Unresolved(Why::External) => "declared with a type from outside the program",
                Shape::Unresolved(_) => "declared with a type this slice does not evaluate",
                Shape::Parameter(_) => "declared with a type parameter",
                _ => "typed",
            },
            Err(origin) => origin.label(),
        }
    }

    /// The declared type of an expression of module `module`.
    pub fn declared(&self, module: usize, expression: &Expression<'a>) -> Declared {
        self.typed_at(module, expression, 0)
    }

    pub(crate) fn typed_at(
        &self,
        module: usize,
        expression: &Expression<'a>,
        depth: u32,
    ) -> Declared {
        if depth > MAX_DEPTH {
            return Err(Origin::Other);
        }
        let next = depth + 1;
        match expression {
            Expression::ParenthesizedExpression(inner) => {
                self.typed_at(module, &inner.expression, next)
            }
            Expression::TSNonNullExpression(inner) => self
                .typed_at(module, &inner.expression, next)
                .map(|ty| self.present(ty)),
            Expression::TSSatisfiesExpression(inner) => {
                self.typed_at(module, &inner.expression, next)
            }
            Expression::TSAsExpression(cast) => {
                let constant = matches!(&cast.type_annotation, TSType::TSTypeReference(reference)
                    if matches!(&reference.type_name, TSTypeName::IdentifierReference(name) if name.name == "const"));
                if constant {
                    match self.constant_type(module, &cast.expression) {
                        Some(constant) => Ok(constant),
                        None => self.typed_at(module, &cast.expression, next),
                    }
                } else {
                    Ok(self.resolve_type(module, &cast.type_annotation))
                }
            }
            Expression::Identifier(identifier) => {
                let place = self.take_place_not_narrowed();
                self.declared_name(module, identifier, next)
                    .map(|ty| match place {
                        true => ty,
                        false => self.narrowed(module, expression, ty),
                    })
            }
            Expression::StaticMemberExpression(member) => {
                let place = self.take_place_not_narrowed();
                self.declared_property(module, &member.object, member.property.name.as_str(), next)
                    .map(|ty| match place {
                        true => ty,
                        false => self.narrowed(module, expression, ty),
                    })
            }
            Expression::ComputedMemberExpression(member) => match unwrap(&member.expression) {
                Expression::StringLiteral(key) => {
                    self.declared_property(module, &member.object, key.value.as_str(), next)
                }
                // A well-known key the API exports, such as `[NAME]`, is
                // the property written with that key.
                key if self.api_key(module, key).is_some() => {
                    let name = self.api_key(module, key).expect("the key was just found");
                    self.typed_at(module, &member.object, next)
                        .map(|object| {
                            self.property(object, &name)
                                .unwrap_or_else(|| self.add_unresolved())
                        })
                        .map_err(|_| Origin::PropertyOfInferred)
                }
                Expression::NumericLiteral(_) => self
                    .typed_at(module, &member.object, next)
                    .map(|object| match self.shape(object) {
                        Shape::Object(_, Some(index)) => index,
                        _ => self
                            .element_of(object)
                            .unwrap_or_else(|| self.add_unresolved()),
                    })
                    .map(|ty| self.narrowed(module, expression, ty))
                    .map_err(|_| Origin::PropertyOfInferred),
                _ => match self.typed_at(module, &member.object, next) {
                    Ok(object) => Ok(match self.shape(object) {
                        Shape::Object(_, Some(index)) => index,
                        // A chosen child of a closed object type: one of
                        // its properties.
                        Shape::Object(properties, None) if !properties.is_empty() => {
                            self.union_of(properties.iter().map(|property| property.ty).collect())
                        }
                        _ => self
                            .element_of(object)
                            .unwrap_or_else(|| self.add_unresolved()),
                    }),
                    Err(_) => Err(Origin::PropertyOfInferred),
                },
            },
            Expression::ChainExpression(chain) => {
                let inner = match &chain.expression {
                    ChainElement::StaticMemberExpression(member) => self.declared_property(
                        module,
                        &member.object,
                        member.property.name.as_str(),
                        next,
                    ),
                    ChainElement::CallExpression(call) => self
                        .declared_call(module, call, next)
                        .or_else(|_| self.infer_call(module, call, next)),
                    _ => Err(Origin::Other),
                }?;
                // The chain is `undefined` where a receiver tested by `?.`
                // is absent. In tier R `a?.b` is a path projection, whose
                // type is the type of `b` or `undefined` (§7.6).
                let reactive =
                    self.place_at(module, chain.span.start) == crate::program::Place::Reactive;
                if reactive || self.chain_may_stop(module, &chain.expression, next) {
                    Ok(self.or_absent(inner))
                } else {
                    Ok(inner)
                }
            }
            Expression::CallExpression(call) => self
                .declared_call(module, call, next)
                .or_else(|_| self.infer_call(module, call, next)),
            Expression::NewExpression(new) => match self.handle_kind(module, &new.callee) {
                Some(kind) => Ok(self.created(
                    module,
                    kind,
                    new.type_arguments.as_deref(),
                    new.arguments.first(),
                )),
                None => self.infer_new(module, new),
            },
            Expression::StringLiteral(_)
            | Expression::NumericLiteral(_)
            | Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::BigIntLiteral(_) => self
                .exact_literal_type(module, expression)
                .ok_or(Origin::Literal),
            Expression::TemplateLiteral(template) if template.expressions.is_empty() => self
                .exact_literal_type(module, expression)
                .ok_or(Origin::Literal),
            Expression::ArrayExpression(_)
            | Expression::ObjectExpression(_)
            | Expression::RegExpLiteral(_) => self.infer_literal(module, expression, next),
            Expression::TemplateLiteral(_)
            | Expression::BinaryExpression(_)
            | Expression::LogicalExpression(_)
            | Expression::ConditionalExpression(_)
            | Expression::UnaryExpression(_)
            | Expression::UpdateExpression(_)
            | Expression::SequenceExpression(_)
            | Expression::AssignmentExpression(_) => self.infer_operator(module, expression, next),
            _ => self.infer_other(module, expression, next),
        }
    }

    /// Whether a receiver that `?.` tests in the chain may be absent.
    fn chain_may_stop(&self, module: usize, element: &ChainElement<'a>, depth: u32) -> bool {
        let (optional, mut object) = match element {
            ChainElement::StaticMemberExpression(member) => (member.optional, &member.object),
            ChainElement::ComputedMemberExpression(member) => (member.optional, &member.object),
            ChainElement::CallExpression(call) => (call.optional, &call.callee),
            _ => return true,
        };
        let mut optional = optional;
        loop {
            if optional {
                let absent = match self.typed_at(module, object, depth) {
                    Ok(ty) => self.present(ty) != ty || self.first_unresolved(ty, 0).is_some(),
                    Err(_) => true,
                };
                if absent {
                    return true;
                }
            }
            (optional, object) = match object {
                Expression::StaticMemberExpression(member) => (member.optional, &member.object),
                Expression::ComputedMemberExpression(member) => (member.optional, &member.object),
                Expression::CallExpression(call) => (call.optional, &call.callee),
                Expression::TSNonNullExpression(inner) => (false, &inner.expression),
                Expression::ParenthesizedExpression(inner) => (false, &inner.expression),
                _ => return false,
            };
        }
    }

    /// The property name of a well-known key of the API that `key` names
    /// through its import, written with its brackets.
    fn api_key(&self, module: usize, key: &Expression<'a>) -> Option<String> {
        let Expression::Identifier(identifier) = key else {
            return None;
        };
        let parsed = self.parsed(module)?;
        let symbol = symbol_of(parsed.semantic.scoping(), identifier)?;
        self.model(module)?.api_ref(symbol)?;
        Some(format!("[{}]", identifier.name))
    }

    pub(crate) fn add_unresolved(&self) -> TypeId {
        self.intern(Shape::Unresolved(Why::NotEvaluated))
    }

    fn declared_property(
        &self,
        module: usize,
        object: &Expression<'a>,
        name: &str,
        depth: u32,
    ) -> Declared {
        match self.typed_at(module, object, depth) {
            Ok(object) => Ok(match self.shape(object) {
                Shape::Unresolved(why) => self.intern(Shape::Unresolved(why)),
                Shape::Array(_) | Shape::Tuple(_) | Shape::String if name == "length" => {
                    self.intern(Shape::Number)
                }
                _ => self
                    .property(object, name)
                    .or_else(|| self.member_of(object, name))
                    .unwrap_or_else(|| self.add_unresolved()),
            }),
            Err(Origin::External) => Err(Origin::External),
            Err(_) => Err(Origin::PropertyOfInferred),
        }
    }

    /// The result of a call, for the calls whose result a declaration gives:
    /// a cell constructor, and `get`, `sample`, and `key` on a handle.
    fn declared_call(&self, module: usize, call: &CallExpression<'a>, depth: u32) -> Declared {
        let Expression::StaticMemberExpression(member) = unwrap(&call.callee) else {
            return Err(Origin::CallResult);
        };
        let name = member.property.name.as_str();
        if matches!(name, "of" | "for") {
            let constructor = match unwrap(&member.object) {
                Expression::StaticMemberExpression(scoped)
                    if api::is_cell_scope(scoped.property.name.as_str()) =>
                {
                    &scoped.object
                }
                other => other,
            };
            if let Some(kind) = self.handle_kind(module, constructor) {
                let value = if name == "of" {
                    call.arguments.first()
                } else {
                    None
                };
                return Ok(self.created(module, kind, call.type_arguments.as_deref(), value));
            }
        }
        if !matches!(name, "get" | "sample" | "key") {
            return Err(Origin::CallResult);
        }
        let Ok(receiver) = self.typed_at(module, &member.object, depth) else {
            return Err(Origin::CallResult);
        };
        let Shape::Handle(kind, value) = self.shape(receiver) else {
            return Err(Origin::CallResult);
        };
        match (
            name,
            call.arguments
                .first()
                .and_then(Argument::as_expression)
                .map(unwrap),
        ) {
            ("get" | "sample", None) => Ok(value),
            ("key", Some(Expression::StringLiteral(_))) => {
                // `key` takes a path, and flattens a handle it passes
                // through: the property of a handle that is itself a
                // handle is that handle.
                let mut current = receiver;
                for argument in &call.arguments {
                    let Some(Expression::StringLiteral(key)) = argument.as_expression().map(unwrap)
                    else {
                        return Err(Origin::CallResult);
                    };
                    let (kind, value) = match self.shape(current) {
                        Shape::Handle(kind, value) => (kind, value),
                        _ => (kind, value),
                    };
                    // `key` on a handle of `unknown` takes any key and
                    // yields a handle of `unknown` (§7.8).
                    let property = match self.shape(value) {
                        Shape::Unknown => value,
                        _ => self
                            .property(value, key.value.as_str())
                            .unwrap_or_else(|| self.add_unresolved()),
                    };
                    // A `?` on a property declared as a handle does not
                    // change the result (§4.7): the property's declared
                    // type is the handle `key` yields.
                    let declared = match self.shape(value) {
                        Shape::Unknown => property,
                        _ => self.with_optional_reads_declared(|| {
                            self.property(value, key.value.as_str()).unwrap_or(property)
                        }),
                    };
                    current = match (self.shape(declared), self.shape(property)) {
                        (Shape::Handle(..), _) => declared,
                        (_, Shape::Handle(..)) => property,
                        _ => self.intern(Shape::Handle(kind, property)),
                    };
                }
                Ok(current)
            }
            _ => Err(Origin::CallResult),
        }
    }

    /// The kind of handle a cell constructor makes, when `callee` names one
    /// through its import.
    fn handle_kind(&self, module: usize, callee: &Expression<'a>) -> Option<HandleKind> {
        let parsed = self.parsed(module)?;
        let identifier = match unwrap(callee) {
            Expression::Identifier(identifier) => identifier,
            // A constructor under a scope: `X.perUser`.
            Expression::StaticMemberExpression(scoped)
                if api::is_cell_scope(scoped.property.name.as_str()) =>
            {
                match unwrap(&scoped.object) {
                    Expression::Identifier(identifier) => identifier,
                    _ => return None,
                }
            }
            _ => return None,
        };
        let symbol = symbol_of(parsed.semantic.scoping(), identifier)?;
        let api = self.model(module)?.api_ref(symbol)?;
        match (api.value(), api.name.as_str()) {
            (ApiValue::CellConstructor, "Stream") => Some(HandleKind::Stream),
            (ApiValue::CellConstructor, "ReadonlyCell") => Some(HandleKind::ReadonlyCell),
            (ApiValue::CellConstructor, "WriteonlyCell") => Some(HandleKind::WriteonlyCell),
            (ApiValue::CellConstructor, "ComparableCell") => Some(HandleKind::ComparableCell),
            (ApiValue::CellConstructor, "OpaqueCell") => Some(HandleKind::OpaqueCell),
            (ApiValue::CellConstructor, _) => Some(HandleKind::Cell),
            _ => None,
        }
    }

    /// The type of a cell a constructor creates: its type argument, or the
    /// type of a literal initial value.
    fn created(
        &self,
        module: usize,
        kind: HandleKind,
        arguments: Option<&TSTypeParameterInstantiation<'a>>,
        value: Option<&Argument<'a>>,
    ) -> TypeId {
        let value = match arguments.and_then(|arguments| arguments.params.first()) {
            Some(written) => self.resolve_type(module, written),
            None => value
                .and_then(Argument::as_expression)
                .and_then(|value| self.literal_type(value))
                .unwrap_or_else(|| self.add_unresolved()),
        };
        self.intern(Shape::Handle(kind, value))
    }

    /// The declared type of a name.
    pub(crate) fn typed_name(
        &self,
        module: usize,
        identifier: &IdentifierReference<'a>,
    ) -> Declared {
        self.declared_name(module, identifier, 0)
    }

    fn declared_name(
        &self,
        module: usize,
        identifier: &IdentifierReference<'a>,
        depth: u32,
    ) -> Declared {
        let parsed = self.parsed(module).ok_or(Origin::External)?;
        let Some(symbol) = symbol_of(parsed.semantic.scoping(), identifier) else {
            return match identifier.name.as_str() {
                "undefined" => Ok(self.intern(Shape::Undefined)),
                "NaN" | "Infinity" => Ok(self.intern(Shape::Number)),
                _ => Err(Origin::External),
            };
        };
        self.declared_symbol(module, symbol, depth)
    }

    fn declared_symbol(&self, module: usize, symbol: SymbolId, depth: u32) -> Declared {
        if depth > MAX_DEPTH {
            return Err(Origin::Other);
        }
        let model = self.model(module).ok_or(Origin::External)?;
        if let Some(Binding::Import(import, binding)) = model.binding(symbol) {
            let import = &model.imports[import];
            let def = self
                .resolve_import(module, import, &import.bindings[binding].imported)
                .ok_or(Origin::External)?;
            let target = self
                .model(def.module)
                .and_then(|model| model.defs[def.def].symbol)
                .ok_or(Origin::External)?;
            return self.declared_symbol(def.module, target, depth + 1);
        }
        let parsed = self.parsed(module).ok_or(Origin::External)?;
        let scoping = parsed.semantic.scoping();
        let nodes = parsed.semantic.nodes();
        let (pattern, base) = match nodes.kind(scoping.symbol_declaration(symbol)) {
            AstKind::VariableDeclarator(declarator) => {
                let base = match (&declarator.type_annotation, &declarator.init) {
                    (Some(annotation), _) => {
                        Ok(self.resolve_type(module, &annotation.type_annotation))
                    }
                    (None, None) if declarator.kind == VariableDeclarationKind::Let => {
                        Err(Origin::Reassigned)
                    }
                    // A `const` keeps the literal type of its initializer,
                    // and any other binding widens it (§7.5).
                    (None, Some(init)) => self.declared_initializer(module, init, depth + 1).map(
                        |ty| match declarator.kind {
                            VariableDeclarationKind::Const => ty,
                            _ => self.widened_literal(init, ty),
                        },
                    ),
                    (None, None) => self.loop_variable(module, declarator, depth + 1),
                };
                (&declarator.id, base)
            }
            AstKind::FormalParameter(parameter) => {
                let base = match &parameter.type_annotation {
                    Some(annotation) => {
                        let written = self.resolve_type(module, &annotation.type_annotation);
                        // The input of a `pattern` is read as §7.6.1 has it.
                        Ok(if self.is_pattern_input(module, parameter) {
                            self.pattern_body_view(written)
                        } else {
                            written
                        })
                    }
                    None => self.parameter_type(module, parameter, depth + 1),
                };
                (&parameter.pattern, base)
            }
            // The variable of a `catch` clause has type `unknown` (§7.6).
            AstKind::CatchParameter(_) => return Ok(self.intern(Shape::Unknown)),
            AstKind::Function(function) => {
                return Ok(self.function_value(
                    module,
                    FunctionLike::Function(function),
                    depth + 1,
                ));
            }
            _ => return Err(Origin::Other),
        };
        let mut path = Vec::new();
        if !path_to(pattern, symbol, &mut path) {
            return match base {
                Ok(_) => Ok(self.add_unresolved()),
                Err(origin) => Err(origin),
            };
        }
        let mut ty = match base {
            Ok(ty) => ty,
            Err(origin) if path.is_empty() => return Err(origin),
            Err(Origin::External) => return Err(Origin::External),
            Err(_) => return Err(Origin::PropertyOfInferred),
        };
        for step in path {
            ty = match (self.shape(ty), step) {
                // A binding with a default is never `undefined`.
                (_, Step::Default) => self.defined_type(ty),
                (Shape::Unresolved(why), _) => self.intern(Shape::Unresolved(why)),
                (_, Step::Key(key)) => self
                    .property(ty, key)
                    .unwrap_or_else(|| self.add_unresolved()),
                (Shape::Tuple(elements), Step::Index(index)) => elements
                    .get(index)
                    .copied()
                    .unwrap_or_else(|| self.add_unresolved()),
                (_, Step::Index(_)) => self.element_of(ty).unwrap_or_else(|| self.add_unresolved()),
            };
        }
        Ok(ty)
    }

    /// The type of the variable of a `for...of` or `for...in` loop.
    fn loop_variable(
        &self,
        module: usize,
        declarator: &VariableDeclarator<'a>,
        depth: u32,
    ) -> Declared {
        let parsed = self.parsed(module).ok_or(Origin::External)?;
        for kind in parsed
            .semantic
            .nodes()
            .ancestor_kinds(declarator.node_id.get())
            .take(3)
        {
            match kind {
                AstKind::ForOfStatement(statement) => {
                    let collection = self.typed_at(module, &statement.right, depth)?;
                    return Ok(self
                        .element_of(collection)
                        .unwrap_or_else(|| self.add_unresolved()));
                }
                AstKind::ForInStatement(_) => return Ok(self.intern(Shape::String)),
                _ => {}
            }
        }
        Err(Origin::Other)
    }

    /// The type of a symbol of module `module`.
    pub(crate) fn declared_symbol_type(
        &self,
        module: usize,
        symbol: SymbolId,
        depth: u32,
    ) -> Declared {
        self.declared_symbol(module, symbol, depth)
    }

    /// The declared type of an initializer: a builder definition has a
    /// factory type, and anything else is an expression like any other.
    fn declared_initializer(&self, module: usize, init: &Expression<'a>, depth: u32) -> Declared {
        if let Expression::CallExpression(call) = unwrap(init) {
            let builder = self
                .parsed(module)
                .zip(self.model(module))
                .and_then(|(parsed, model)| {
                    model.api_ref_of_callee(parsed.semantic.scoping(), &call.callee)
                })
                .map(|api| api.value());
            if matches!(
                builder,
                Some(ApiValue::Builder(Builder::Handler | Builder::Pattern))
            ) {
                return Ok(self.factory_type(module, call, depth));
            }
        }
        self.typed_at(module, init, depth)
    }

    /// The type of a parameter without an annotation: what the type
    /// arguments of a builder give its callback, or the element type of the
    /// collection a callback is given to.
    fn parameter_type(
        &self,
        module: usize,
        parameter: &FormalParameter<'a>,
        depth: u32,
    ) -> Declared {
        let parsed = self.parsed(module).ok_or(Origin::External)?;
        let nodes = parsed.semantic.nodes();
        let mut function_span = None;
        let mut index = None;
        for kind in nodes.ancestor_kinds(parameter.node_id.get()) {
            match kind {
                AstKind::FormalParameters(parameters) => {
                    index = parameters
                        .items
                        .iter()
                        .position(|item| item.span == parameter.span);
                }
                AstKind::ArrowFunctionExpression(arrow) if function_span.is_none() => {
                    function_span = Some(arrow.span);
                }
                AstKind::Function(function) if function_span.is_none() => {
                    function_span = Some(function.span);
                }
                AstKind::ArrowFunctionExpression(_)
                | AstKind::Function(_)
                | AstKind::Program(_) => break,
                // A function that initializes a binding with a written
                // function type takes its parameter types from it.
                AstKind::VariableDeclarator(declarator) => {
                    let (Some(function_span), Some(annotation), Some(init)) =
                        (function_span, &declarator.type_annotation, &declarator.init)
                    else {
                        break;
                    };
                    if FunctionLike::of(init).is_none_or(|f| f.span() != function_span) {
                        break;
                    }
                    let expected = self.resolve_type(module, &annotation.type_annotation);
                    return self
                        .parameter_of_function_type(expected, index.unwrap_or(0))
                        .ok_or(Origin::UntypedParameter);
                }
                AstKind::CallExpression(call) => {
                    let Some(function_span) = function_span else {
                        break;
                    };
                    let position = call.arguments.iter().position(|argument| {
                        argument.as_expression().is_some_and(|argument| {
                            FunctionLike::of(argument).is_some_and(|f| f.span() == function_span)
                        })
                    });
                    let Some(position) = position else {
                        break;
                    };
                    return self.callback_parameter(
                        module,
                        call,
                        position,
                        index.unwrap_or(0),
                        depth,
                    );
                }
                _ => {}
            }
        }
        Err(Origin::UntypedParameter)
    }

    /// Whether `parameter` is the first parameter of the callback of a
    /// `pattern` call: the input of the pattern (§4.1).
    fn is_pattern_input(&self, module: usize, parameter: &FormalParameter<'a>) -> bool {
        let (Some(parsed), Some(model)) = (self.parsed(module), self.model(module)) else {
            return false;
        };
        let nodes = parsed.semantic.nodes();
        let mut function_span = None;
        let mut first = false;
        for kind in nodes.ancestor_kinds(parameter.node_id.get()) {
            match kind {
                AstKind::FormalParameters(parameters) => {
                    first = parameters
                        .items
                        .first()
                        .is_some_and(|item| item.span == parameter.span);
                }
                AstKind::ArrowFunctionExpression(arrow) if function_span.is_none() => {
                    function_span = Some(arrow.span);
                }
                AstKind::Function(function) if function_span.is_none() => {
                    function_span = Some(function.span);
                }
                AstKind::CallExpression(call) => {
                    let Some(function_span) = function_span else {
                        return false;
                    };
                    let is_callback = call.arguments.first().is_some_and(|argument| {
                        argument.as_expression().is_some_and(|argument| {
                            FunctionLike::of(argument).is_some_and(|f| f.span() == function_span)
                        })
                    });
                    let builder = model
                        .api_ref_of_callee(parsed.semantic.scoping(), &call.callee)
                        .map(|api| api.value());
                    return first
                        && is_callback
                        && matches!(builder, Some(ApiValue::Builder(Builder::Pattern)));
                }
                AstKind::ParenthesizedExpression(_) | AstKind::TSAsExpression(_) => {}
                _ if function_span.is_some() => return false,
                _ => {}
            }
        }
        false
    }

    fn callback_parameter(
        &self,
        module: usize,
        call: &CallExpression<'a>,
        position: usize,
        index: usize,
        depth: u32,
    ) -> Declared {
        let parsed = self.parsed(module).ok_or(Origin::External)?;
        let builder = self
            .model(module)
            .and_then(|model| model.api_ref_of_callee(parsed.semantic.scoping(), &call.callee))
            .map(|api| api.value());
        if let Some(ApiValue::Builder(builder)) = builder {
            let slot = match (builder, index) {
                (Builder::Handler, slot @ (0 | 1)) => slot,
                (Builder::Lift | Builder::Pattern | Builder::Action, 0) => 0,
                _ => return Err(Origin::UntypedParameter),
            };
            return call
                .type_arguments
                .as_ref()
                .and_then(|arguments| arguments.params.get(slot))
                .map(|written| {
                    let written = self.resolve_type(module, written);
                    // The input of a `pattern` is read as §7.6.1 has it.
                    if builder == Builder::Pattern {
                        self.pattern_body_view(written)
                    } else {
                        written
                    }
                })
                .ok_or(Origin::UntypedParameter);
        }
        self.contextual_parameter(module, call, position, index, depth)
            .or_else(|origin| {
                // The function type the callee declares for the argument
                // gives the callback its parameter types (§7.6).
                let expected = self
                    .callee_parameters(module, call, depth)
                    .and_then(|parameters| parameters.get(position).copied())
                    .ok_or(origin)?;
                self.parameter_of_function_type(expected.ty, index)
                    .ok_or(origin)
            })
    }

    /// The type of parameter `index` of the function type `function`.
    fn parameter_of_function_type(&self, function: TypeId, index: usize) -> Option<TypeId> {
        let function = match self.shape(function) {
            Shape::Union(members) => {
                let mut functions = members
                    .into_iter()
                    .filter(|member| self.shape(*member) == Shape::Function);
                let first = functions.next()?;
                if functions.next().is_some() {
                    return None;
                }
                first
            }
            _ => function,
        };
        if self.shape(function) != Shape::Function {
            return None;
        }
        self.signature(function)
            .parameters?
            .get(index)
            .map(|parameter| parameter.ty)
    }

    /// Whether the elements of a collection of this type are plain values
    /// whatever the collection comes from: a primitive, a literal, `null`,
    /// `undefined`, a factory, or a union of those (§4.4.1).
    pub fn has_plain_elements(&self, collection: TypeId) -> bool {
        let element = match self.shape(collection) {
            Shape::Array(element) => element,
            Shape::Handle(_, value) => match self.shape(value) {
                Shape::Array(element) => element,
                _ => return false,
            },
            _ => return false,
        };
        self.is_always_plain(element, 0)
    }

    fn is_always_plain(&self, ty: TypeId, depth: u32) -> bool {
        match self.shape(ty) {
            Shape::String
            | Shape::Number
            | Shape::Boolean
            | Shape::BigInt
            | Shape::Null
            | Shape::Undefined
            | Shape::Literal(_)
            | Shape::PatternFactory(..)
            | Shape::HandlerFactory(..) => true,
            Shape::Union(members) if depth < 4 => members
                .iter()
                .all(|member| self.is_always_plain(*member, depth + 1)),
            _ => false,
        }
    }

    /// Resolves every type written in module `module`, so that the rules
    /// resolution applies are reported, and checks the data types of
    /// builders for function types.
    pub fn check_written_types(&self, module: usize) {
        let (Some(parsed), Some(model)) = (self.parsed(module), self.model(module)) else {
            return;
        };
        if model.tier == ModuleTier::Imported {
            return;
        }
        let mut pass = WrittenTypes {
            resolver: self,
            module,
        };
        pass.visit_program(parsed.program);
    }
}

/// What a function overload signature at module scope declares, and what
/// would replace it under `language-subset.md` §12.4.
#[derive(Debug, Clone, Serialize)]
pub struct OverloadNote {
    pub name: String,
    pub line: u32,
    /// The parameter types of the signature.
    pub parameters: Vec<String>,
    /// The result type of the signature.
    pub result: String,
    /// What the implementation returns: a parameter, or another expression
    /// with its declared type where a declaration gives one.
    pub returns: String,
    /// For a function that returns its parameter under a signature from one
    /// handle type to another: the handle type of the intersection of the
    /// two value types, which is the type the position is declared with once
    /// the function is deleted. `None` when the function has another form or
    /// the intersection is not evaluated.
    pub declared_instead: Option<String>,
    /// Whether the declared type of what the implementation returns is the
    /// result type of the signature, so that the function types without it.
    pub typed_without_overload: bool,
}

impl<'a> Resolver<'_, 'a> {
    /// The overload signatures of module `module`.
    pub fn overloads(&self, module: usize) -> Vec<OverloadNote> {
        let Some(parsed) = self.parsed(module) else {
            return Vec::new();
        };
        let functions: Vec<&Function<'a>> = parsed
            .program
            .body
            .iter()
            .filter_map(|statement| match statement {
                Statement::FunctionDeclaration(function) => Some(&**function),
                Statement::ExportNamedDeclaration(export) => match &export.declaration {
                    Some(Declaration::FunctionDeclaration(function)) => Some(&**function),
                    _ => None,
                },
                _ => None,
            })
            .collect();
        let mut notes = Vec::new();
        for signature in functions
            .iter()
            .filter(|function| function.body.is_none() && !function.declare)
        {
            let Some(name) = signature.id.as_ref().map(|id| id.name.as_str()) else {
                continue;
            };
            let implementation = functions.iter().find(|function| {
                function.body.is_some() && function.id.as_ref().is_some_and(|id| id.name == name)
            });
            let parameters: Vec<TypeId> = signature
                .params
                .items
                .iter()
                .map(|parameter| match &parameter.type_annotation {
                    Some(annotation) => self.resolve_type(module, &annotation.type_annotation),
                    None => self.add_unresolved(),
                })
                .collect();
            let result = match &signature.return_type {
                Some(annotation) => self.resolve_type(module, &annotation.type_annotation),
                None => self.add_unresolved(),
            };
            let returns = implementation
                .and_then(|function| function.body.as_ref())
                .and_then(|body| match body.statements.as_slice() {
                    [Statement::ReturnStatement(statement)] => statement.argument.as_ref(),
                    _ => None,
                })
                .map_or_else(
                    || "a body that is not one `return`".to_string(),
                    |returned| match unwrap(returned) {
                        Expression::Identifier(identifier)
                            if signature.params.items.iter().any(|parameter| {
                                matches!(&parameter.pattern, BindingPattern::BindingIdentifier(name)
                                    if name.name == identifier.name)
                            }) =>
                        {
                            format!("the parameter `{}`", identifier.name)
                        }
                        other => {
                            let text = other.span().source_text(parsed.source);
                            match self.declared(module, other) {
                                Ok(ty) => format!("`{text}`, declared {}", self.display(ty)),
                                Err(origin) => format!("`{text}` ({})", origin.label()),
                            }
                        }
                    },
                );
            let typed_without_overload =
                returns.ends_with(&format!(", declared {}", self.display(result)));
            let identity = returns.starts_with("the parameter");
            let declared_instead = match (
                parameters.first().map(|ty| self.shape(*ty)),
                self.shape(result),
            ) {
                _ if !identity => None,
                (Some(Shape::Handle(kind, from)), Shape::Handle(_, to)) => {
                    let both = self.intersection(from, to);
                    match self.shape(both) {
                        Shape::Unresolved(_) | Shape::Never => None,
                        _ => Some(self.display(self.intern(Shape::Handle(kind, both)))),
                    }
                }
                _ => None,
            };
            let (line, _) = parsed.lines.position(parsed.source, signature.span.start);
            notes.push(OverloadNote {
                name: name.to_string(),
                line,
                parameters: parameters.iter().map(|ty| self.display(*ty)).collect(),
                result: self.display(result),
                returns,
                declared_instead,
                typed_without_overload,
            });
        }
        notes
    }
}

/// One step from a destructured value to a binding in it.
#[derive(Debug, Clone, Copy)]
enum Step<'p> {
    Key(&'p str),
    Index(usize),
    /// A default value: `{ note = "" }`.
    Default,
}

/// Finds the binding of `symbol` in `pattern` and collects the steps that
/// lead to it. Returns false when the binding is not in the pattern or is
/// reached through a rest element or a computed key.
fn path_to<'a>(
    pattern: &'a BindingPattern<'a>,
    symbol: SymbolId,
    path: &mut Vec<Step<'a>>,
) -> bool {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => identifier.symbol_id.get() == Some(symbol),
        BindingPattern::AssignmentPattern(assignment) => {
            path.push(Step::Default);
            if path_to(&assignment.left, symbol, path) {
                return true;
            }
            path.pop();
            false
        }
        BindingPattern::ObjectPattern(object) => object.properties.iter().any(|property| {
            let key = match &property.key {
                PropertyKey::StaticIdentifier(name) if !property.computed => name.name.as_str(),
                PropertyKey::StringLiteral(literal) => literal.value.as_str(),
                _ => return false,
            };
            path.push(Step::Key(key));
            if path_to(&property.value, symbol, path) {
                return true;
            }
            path.pop();
            false
        }),
        BindingPattern::ArrayPattern(array) => {
            array.elements.iter().enumerate().any(|(index, element)| {
                let Some(element) = element else {
                    return false;
                };
                path.push(Step::Index(index));
                if path_to(element, symbol, path) {
                    return true;
                }
                path.pop();
                false
            })
        }
    }
}

/// The walk that resolves each outermost written type of a module.
struct WrittenTypes<'r, 'm, 'a> {
    resolver: &'r Resolver<'m, 'a>,
    module: usize,
}

impl<'a> Visit<'a> for WrittenTypes<'_, '_, 'a> {
    fn visit_ts_type(&mut self, it: &TSType<'a>) {
        // The `const` of `as const` is not a type.
        if matches!(it, TSType::TSTypeReference(reference)
            if matches!(&reference.type_name, TSTypeName::IdentifierReference(name) if name.name == "const"))
        {
            return;
        }
        let ty = self.resolver.resolve_type(self.module, it);
        let label = match self.resolver.first_unresolved(ty, 0) {
            None => "evaluated",
            Some(Why::Any) => "holds `any`",
            Some(Why::RefusedForm) => "holds a refused type form",
            Some(Why::External) => "holds a type from outside the program",
            Some(Why::TypeofValue) => "holds `typeof` of a value that needs inference",
            Some(Why::Recursive) => "holds a recursive reference",
            Some(Why::NotEvaluated) => "holds a form this slice does not evaluate",
        };
        self.resolver.count_written(self.module, label);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        let resolver = self.resolver;
        let builder = resolver
            .parsed(self.module)
            .zip(resolver.model(self.module))
            .and_then(|(parsed, model)| {
                model.api_ref_of_callee(parsed.semantic.scoping(), &it.callee)
            })
            .map(|api| api.value());
        if let Some(ApiValue::Builder(Builder::Pattern | Builder::Handler)) = builder {
            for written in it
                .type_arguments
                .iter()
                .flat_map(|arguments| arguments.params.iter().take(2))
            {
                let ty = resolver.resolve_type(self.module, written);
                if resolver.contains_function(ty, 0) {
                    resolver.type_report(
                        self.module,
                        "subset-type:function-in-data",
                        written.span(),
                        "A function type inside a type the runtime stores",
                    );
                }
            }
        }
        walk::walk_call_expression(self, it);
    }
}
