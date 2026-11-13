//! The promotion criterion of `language-subset.md` §6.1, applied twice:
//! by syntax, and with types.
//!
//! By syntax the criterion is decided from the form of the body and from
//! names: a method is taken to be the standard-library method of its name.
//! With types it also reads the type of the receiver of a method call, of
//! the accumulator of a `reduce`, of a computed key, and of an argument,
//! and tests a `const` destructuring for a default or a rest element. Where
//! a type it needs is not evaluated, the typed criterion records what was
//! missing and decides nothing.

use oxc_ast::ast::*;

use super::{Checker, Thing};
use crate::api::{self, ApiValue, Global, GlobalMember, MethodName};
use crate::module::DefKind;
use crate::syntax::{unwrap, FunctionLike};
use crate::tiers::Promotion;

/// What a body was found to need while it was tested.
#[derive(Default)]
struct Shape {
    calls_function: bool,
    guard: bool,
    /// Whether the criterion reads types.
    typed: bool,
    /// What the typed criterion could not decide, for want of a type.
    undecided: Vec<String>,
}

/// Why a body is not promoted.
struct Refusal {
    statement_body: bool,
    reason: String,
}

type Outcome = Result<(), Refusal>;

fn statement(reason: &str) -> Outcome {
    Err(Refusal {
        statement_body: true,
        reason: reason.to_string(),
    })
}

fn expression(reason: impl Into<String>) -> Outcome {
    Err(Refusal {
        statement_body: false,
        reason: reason.into(),
    })
}

impl<'a> Checker<'_, 'a> {
    /// The outcome of the criterion for a `computed` used as a value: the
    /// outcome that decides the body's tier, whether the syntactic
    /// criterion promotes the body, and the outcome of the typed criterion
    /// as text.
    pub(super) fn promotion(&self, function: FunctionLike<'_, 'a>) -> (Promotion, bool, String) {
        let criterion = |typed: bool| {
            let mut shape = Shape {
                typed,
                ..Shape::default()
            };
            let outcome = if function.param_count() > 0 {
                expression("the function has parameters")
            } else {
                self.pure_function(function, &mut shape, true)
            };
            let promotion = match outcome {
                Ok(()) => Promotion::Promoted {
                    calls_function: shape.calls_function,
                    guard: shape.guard,
                },
                Err(refusal) => Promotion::NotPromoted {
                    statement_body: refusal.statement_body,
                    reason: refusal.reason,
                },
            };
            (promotion, shape.undecided)
        };
        let (by_syntax, _) = criterion(false);
        let (by_type, undecided) = criterion(true);
        let promoted_by_syntax = matches!(by_syntax, Promotion::Promoted { .. });
        match (&by_type, undecided.first()) {
            (Promotion::NotPromoted { reason, .. }, _) => {
                let text = format!("not promoted: {reason}");
                (by_type, promoted_by_syntax, text)
            }
            // A type the criterion needs is not evaluated, so the outcome
            // of the syntactic criterion stands.
            (_, Some(missing)) => (
                by_syntax,
                promoted_by_syntax,
                format!("not decided: {missing}"),
            ),
            _ => (by_type, promoted_by_syntax, "promoted".to_string()),
        }
    }

    /// The shape of the declared type of `expression`, for the typed
    /// criterion. `None` where it has no type or the type is not evaluated,
    /// which is recorded as `missing`.
    fn typed_shape(
        &self,
        expression: &Expression<'a>,
        shape: &mut Shape,
        missing: impl FnOnce() -> String,
    ) -> Option<(crate::types::TypeId, crate::types::Shape)> {
        use crate::types::Shape as Type;
        if !shape.typed {
            return None;
        }
        let ty = match self.declared(expression) {
            Ok(ty) => self.resolver.present(ty),
            Err(_) => {
                shape.undecided.push(missing());
                return None;
            }
        };
        match self.resolver.shape(ty) {
            Type::Unresolved(_) | Type::Parameter(_) | Type::Unknown => {
                shape.undecided.push(missing());
                None
            }
            found => Some((ty, found)),
        }
    }

    /// Whether the body of a function is expression-shaped and pure. `guards`
    /// says whether the guard form is allowed, which it is for the body of
    /// the `computed` and not for the body of a collection callback.
    fn pure_function(
        &self,
        function: FunctionLike<'_, 'a>,
        shape: &mut Shape,
        top: bool,
    ) -> Outcome {
        if function.is_async() || function.is_generator() {
            return expression("the function is `async` or a generator");
        }
        if let Some(body) = function.expression_body() {
            return self.pure(body, shape);
        }
        let Some(statements) = function.block_body() else {
            return statement("the function has no body");
        };
        let outcome = self.pure_block(statements, shape, true);
        match outcome {
            Err(refusal) if !top && refusal.statement_body => {
                expression("a collection callback has a statement body")
            }
            other => other,
        }
    }

    /// A block `S1 ... Sn R` (§6.1, condition 3). `tail` says the block has
    /// to end in a `return` on every path.
    fn pure_block(&self, statements: &[Statement<'a>], shape: &mut Shape, tail: bool) -> Outcome {
        let statements: Vec<&Statement<'a>> = statements
            .iter()
            .filter(|statement| !matches!(statement, Statement::EmptyStatement(_)))
            .collect();
        let Some((last, rest)) = statements.split_last() else {
            return statement("the body has no `return`");
        };
        for statement in rest {
            match statement {
                Statement::VariableDeclaration(declaration) => {
                    self.pure_declaration(declaration, shape)?;
                }
                Statement::IfStatement(guard) => {
                    shape.guard = true;
                    self.pure_guard(guard, shape, false)?;
                }
                Statement::TSTypeAliasDeclaration(_) | Statement::TSInterfaceDeclaration(_) => {}
                _ => {
                    return self::statement(
                        "the body has a statement other than `const` and a guard",
                    )
                }
            }
        }
        match last {
            Statement::ReturnStatement(statement) => match &statement.argument {
                Some(argument) => self.pure(argument, shape),
                None => Ok(()),
            },
            Statement::IfStatement(guard) if tail => {
                shape.guard = true;
                self.pure_guard(guard, shape, true)
            }
            _ => statement("the body does not end in a `return`"),
        }
    }

    fn pure_declaration(
        &self,
        declaration: &VariableDeclaration<'a>,
        shape: &mut Shape,
    ) -> Outcome {
        if declaration.kind != VariableDeclarationKind::Const {
            return statement("the body declares a `let` or a `var`");
        }
        for declarator in &declaration.declarations {
            if let Some(init) = &declarator.init {
                // A default value or a rest element in a destructuring of a
                // value that is not a constant expression (§4.2).
                if shape.typed
                    && super::has_default_or_rest(&declarator.id)
                    && !self.is_constant_expression(init, 0)
                {
                    return expression(
                        "a default value or a rest element in a `const` destructuring",
                    );
                }
                self.pure(init, shape)?;
            }
        }
        Ok(())
    }

    /// A guard: `if (c) B` or `if (c) B else B`. `closing` says the guard is
    /// the last statement, so that it needs an `else` branch.
    fn pure_guard(&self, guard: &IfStatement<'a>, shape: &mut Shape, closing: bool) -> Outcome {
        self.pure(&guard.test, shape)?;
        self.pure_branch(&guard.consequent, shape)?;
        match &guard.alternate {
            Some(alternate) => self.pure_branch(alternate, shape),
            None if closing => statement("the last guard has no `else` branch"),
            None => Ok(()),
        }
    }

    fn pure_branch(&self, branch: &Statement<'a>, shape: &mut Shape) -> Outcome {
        match branch {
            Statement::ReturnStatement(statement) => match &statement.argument {
                Some(argument) => self.pure(argument, shape),
                None => Ok(()),
            },
            Statement::BlockStatement(block) => self.pure_block(&block.body, shape, true),
            Statement::IfStatement(guard) => self.pure_guard(guard, shape, true),
            _ => statement("a guard's branch is not a `return` or a block that ends in one"),
        }
    }

    fn pure_all<'e>(
        &self,
        expressions: impl IntoIterator<Item = &'e Expression<'a>>,
        shape: &mut Shape,
    ) -> Outcome
    where
        'a: 'e,
    {
        for expression in expressions {
            self.pure(expression, shape)?;
        }
        Ok(())
    }

    /// Whether an expression is pure tier R (§6.1, conditions 4 and 5).
    fn pure(&self, expression: &Expression<'a>, shape: &mut Shape) -> Outcome {
        match expression {
            Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::NumericLiteral(_)
            | Expression::BigIntLiteral(_)
            | Expression::StringLiteral(_)
            | Expression::Identifier(_) => Ok(()),
            Expression::RegExpLiteral(literal) => {
                let flags = literal.regex.flags;
                if flags.contains(RegExpFlags::G) || flags.contains(RegExpFlags::Y) {
                    return self::expression("a regular expression with the `g` or `y` flag");
                }
                Ok(())
            }
            Expression::TemplateLiteral(template) => self.pure_all(&template.expressions, shape),
            Expression::ParenthesizedExpression(inner) => self.pure(&inner.expression, shape),
            Expression::TSAsExpression(inner) => self.pure(&inner.expression, shape),
            Expression::TSSatisfiesExpression(inner) => self.pure(&inner.expression, shape),
            Expression::TSNonNullExpression(inner) => self.pure(&inner.expression, shape),
            Expression::TSTypeAssertion(inner) => self.pure(&inner.expression, shape),
            Expression::StaticMemberExpression(member) => self.pure(&member.object, shape),
            Expression::ComputedMemberExpression(member) => {
                self.pure(&member.object, shape)?;
                self.pure(&member.expression, shape)
            }
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::CallExpression(call) => self.pure_call(call, shape),
                ChainElement::TSNonNullExpression(inner) => self.pure(&inner.expression, shape),
                ChainElement::StaticMemberExpression(member) => self.pure(&member.object, shape),
                ChainElement::ComputedMemberExpression(member) => {
                    self.pure(&member.object, shape)?;
                    self.pure(&member.expression, shape)
                }
                ChainElement::PrivateFieldExpression(_) => self::expression("a private field"),
            },
            Expression::UnaryExpression(unary) => match unary.operator {
                UnaryOperator::Delete => self::expression("`delete`"),
                UnaryOperator::Void => self::expression("`void`"),
                _ => self.pure(&unary.argument, shape),
            },
            Expression::BinaryExpression(binary) => {
                if binary.operator == BinaryOperator::Instanceof {
                    return self::expression("`instanceof`");
                }
                self.pure(&binary.left, shape)?;
                self.pure(&binary.right, shape)
            }
            Expression::LogicalExpression(logical) => {
                self.pure(&logical.left, shape)?;
                self.pure(&logical.right, shape)
            }
            Expression::ConditionalExpression(conditional) => {
                self.pure(&conditional.test, shape)?;
                self.pure(&conditional.consequent, shape)?;
                self.pure(&conditional.alternate, shape)
            }
            Expression::ObjectExpression(object) => {
                for property in &object.properties {
                    match property {
                        ObjectPropertyKind::SpreadProperty(spread) => {
                            self.pure(&spread.argument, shape)?;
                        }
                        ObjectPropertyKind::ObjectProperty(property) => {
                            if property.method || property.kind != PropertyKind::Init {
                                return self::expression(
                                    "a method or an accessor in an object literal",
                                );
                            }
                            if property.computed {
                                if let Some(key) = property.key.as_expression() {
                                    self.pure(key, shape)?;
                                    // A key is static when it is a
                                    // well-known key or has a literal type.
                                    let well_known = self.api_of(key).is_some();
                                    let found = if well_known {
                                        None
                                    } else {
                                        self.typed_shape(key, shape, || {
                                            "a computed key with no type".to_string()
                                        })
                                    };
                                    if let Some((_, found)) = found {
                                        if !matches!(found, crate::types::Shape::Literal(_)) {
                                            return self::expression(
                                                "an object literal with a key that is not static",
                                            );
                                        }
                                    }
                                }
                            }
                            self.pure(&property.value, shape)?;
                        }
                    }
                }
                Ok(())
            }
            Expression::ArrayExpression(array) => {
                for element in &array.elements {
                    match element {
                        ArrayExpressionElement::SpreadElement(spread) => {
                            self.pure(&spread.argument, shape)?;
                        }
                        ArrayExpressionElement::Elision(_) => {}
                        other => self.pure(other.to_expression(), shape)?,
                    }
                }
                Ok(())
            }
            Expression::CallExpression(call) => self.pure_call(call, shape),
            Expression::JSXElement(element) => self.pure_jsx_element(element, shape),
            Expression::JSXFragment(fragment) => self.pure_jsx_children(&fragment.children, shape),
            Expression::TaggedTemplateExpression(tagged) => {
                if self
                    .api_of(&tagged.tag)
                    .is_some_and(|api| api.name == "debugStr")
                {
                    self.pure_all(&tagged.quasi.expressions, shape)
                } else {
                    self::expression("a tagged template")
                }
            }
            Expression::NewExpression(new) => {
                let name = match unwrap(&new.callee) {
                    Expression::Identifier(identifier) => identifier.name.as_str(),
                    _ => "a constructor",
                };
                self::expression(format!("`new {name}`"))
            }
            Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
                self::expression("a function created outside a callback position")
            }
            Expression::AssignmentExpression(_) | Expression::UpdateExpression(_) => {
                self::expression("an assignment")
            }
            Expression::AwaitExpression(_) => self::expression("`await`"),
            Expression::YieldExpression(_) => self::expression("`yield`"),
            Expression::ThisExpression(_) => self::expression("`this`"),
            Expression::SequenceExpression(_) => self::expression("the comma operator"),
            Expression::ClassExpression(_) => self::expression("a class"),
            _ => self::expression("an expression form the reactive tier does not have"),
        }
    }

    fn pure_arguments(&self, call: &CallExpression<'a>, shape: &mut Shape) -> Outcome {
        for argument in &call.arguments {
            match argument {
                Argument::SpreadElement(spread) => self.pure(&spread.argument, shape)?,
                other => {
                    let argument = other.to_expression();
                    if FunctionLike::of(argument).is_some() {
                        return self::expression("a function passed as an argument");
                    }
                    // A function passed by name is a function argument too.
                    if shape.typed
                        && matches!(unwrap(argument), Expression::Identifier(_))
                        && self.declared(argument).is_ok_and(|ty| {
                            self.resolver.shape(ty) == crate::types::Shape::Function
                        })
                    {
                        return self::expression("a function passed as an argument");
                    }
                    self.pure(argument, shape)?;
                }
            }
        }
        Ok(())
    }

    fn pure_call(&self, call: &CallExpression<'a>, shape: &mut Shape) -> Outcome {
        match unwrap(&call.callee) {
            Expression::Identifier(identifier) => {
                let name = identifier.name.as_str();
                match self.thing(identifier) {
                    Thing::Def(_, DefKind::Function | DefKind::Lift, _) | Thing::Import => {
                        shape.calls_function = true;
                    }
                    Thing::Def(_, DefKind::Pattern, _) => {
                        return self::expression(format!("an instantiation of `{name}`"));
                    }
                    Thing::Def(_, DefKind::Handler, _) => {
                        return self::expression(format!("a binding of the handler `{name}`"));
                    }
                    Thing::Def(..) => {
                        return self::expression(format!("a call of `{name}`"));
                    }
                    Thing::Api(api) => match api.value() {
                        ApiValue::Pure | ApiValue::ContextRead => {}
                        _ => return self::expression(format!("a call of `{name}`")),
                    },
                    Thing::ApiNamespace(_) => {
                        return self::expression(format!("a call of `{name}`"))
                    }
                    Thing::Local(_) => {
                        return self::expression(format!("a call of the value `{name}`"));
                    }
                    Thing::Global => match api::global(name) {
                        Global::ReactiveFunction => {}
                        _ => return self::expression(format!("a call of `{name}`")),
                    },
                }
                self.pure_arguments(call, shape)
            }
            Expression::StaticMemberExpression(member) => {
                let name = member.property.name.as_str();
                if let Some(namespace) = self.global_name(&member.object) {
                    if api::is_global_namespace(namespace) {
                        return match api::global_member(namespace, name) {
                            Some(GlobalMember::Reactive) => self.pure_arguments(call, shape),
                            _ => self::expression(format!("`{namespace}.{name}`")),
                        };
                    }
                }
                if self.is_cell_constructor(&member.object) {
                    return match name {
                        "equals" | "equalLinks" => self.pure_arguments(call, shape),
                        _ => self::expression("a cell is created"),
                    };
                }
                if let Expression::Identifier(object) = unwrap(&member.object) {
                    if matches!(self.thing(object), Thing::Import) {
                        shape.calls_function = true;
                        return self.pure_arguments(call, shape);
                    }
                }
                self.pure(&member.object, shape)?;
                let receiver = self.typed_shape(&member.object, shape, || {
                    format!("`.{name}(...)` on a receiver with no type")
                });
                if let Some((receiver, found)) = receiver {
                    use crate::types::Shape as Type;
                    match found {
                        // On a cell the criterion lists six methods, and a
                        // collection method on a cell is refused in a
                        // function body (§4.7).
                        Type::Handle(..) => {
                            return match name {
                                "get" | "key" | "elementById" | "resolveAsCell" | "equals"
                                | "equalLinks" => self.pure_arguments(call, shape),
                                _ => self::expression(format!("`.{name}(...)` on a cell")),
                            };
                        }
                        Type::Object(..) => {
                            let property = self
                                .resolver
                                .property(receiver, name)
                                .map(|property| self.resolver.shape(property));
                            match property {
                                Some(Type::Function) => {
                                    return self::expression(format!(
                                        "a call of the function value `.{name}`"
                                    ));
                                }
                                Some(Type::PatternFactory(..)) => {
                                    return self::expression(format!(
                                        "an instantiation of the pattern `.{name}`"
                                    ));
                                }
                                Some(Type::HandlerFactory(..)) => {
                                    return self::expression(format!(
                                        "a binding of the handler `.{name}`"
                                    ));
                                }
                                _ => {}
                            }
                        }
                        _ => {}
                    }
                }
                if api::is_selector_method(name) {
                    return self::expression(format!(
                        "`.{name}(...)`, an aggregate or a collection-index method"
                    ));
                }
                if api::is_handle_collection_method(name) {
                    return self.pure_collection(call, name, shape);
                }
                match api::method_name(name) {
                    MethodName::Reactive
                        if !matches!(name, "for" | "query" | "asScope" | "inSpace") =>
                    {
                        self.pure_arguments(call, shape)
                    }
                    _ => self::expression(format!("`.{name}(...)`")),
                }
            }
            _ => self::expression("a call of a computed callee"),
        }
    }

    fn pure_collection(&self, call: &CallExpression<'a>, name: &str, shape: &mut Shape) -> Outcome {
        let reduce = name == "reduce";
        let Some(first) = call.arguments.first() else {
            return if api::is_selector_method(name) {
                Ok(())
            } else {
                self::expression(format!("`{name}` without a callback"))
            };
        };
        for argument in call.arguments.iter().skip(1) {
            match argument.as_expression() {
                Some(argument) if FunctionLike::of(argument).is_none() => {
                    self.pure(argument, shape)?;
                }
                _ => return self::expression("a function passed as an argument"),
            }
        }
        let Some(function) = FunctionLike::of_argument(first) else {
            return match first.as_expression() {
                Some(argument) if api::is_selector_method(name) => self.pure(argument, shape),
                _ => self::expression(format!(
                    "the callback of `{name}` is not written at the call"
                )),
            };
        };
        if reduce && (function.expression_body().is_none() || call.arguments.len() < 2) {
            return self::expression(
                "a `reduce` callback that is not an expression with an initial value",
            );
        }
        if reduce {
            let initial = call.arguments.get(1).and_then(Argument::as_expression);
            let found = initial.and_then(|initial| {
                self.typed_shape(initial, shape, || {
                    "the initial value of a `reduce` has no type".to_string()
                })
            });
            if let Some((accumulator, found)) = found {
                if matches!(found, crate::types::Shape::Code(_))
                    || self.resolver.contains_function(accumulator, 0)
                {
                    return self::expression("a `reduce` whose accumulator has a code type");
                }
            }
        }
        if !function.is_arrow() {
            return self::expression(format!("the callback of `{name}` is not an arrow function"));
        }
        if function.param_count() > if reduce { 3 } else { 2 } {
            return self::expression(format!("the callback of `{name}` takes the whole array"));
        }
        self.pure_function(function, shape, false)
    }

    fn pure_jsx_element(&self, element: &JSXElement<'a>, shape: &mut Shape) -> Outcome {
        let opening = &element.opening_element;
        if !matches!(
            opening.name,
            JSXElementName::Identifier(_) | JSXElementName::NamespacedName(_)
        ) {
            return self::expression("a JSX tag that names a pattern");
        }
        for attribute in &opening.attributes {
            match attribute {
                JSXAttributeItem::SpreadAttribute(spread) => self.pure(&spread.argument, shape)?,
                JSXAttributeItem::Attribute(attribute) => match &attribute.value {
                    Some(JSXAttributeValue::ExpressionContainer(container)) => {
                        if let Some(value) = container.expression.as_expression() {
                            if FunctionLike::of(value).is_some() {
                                return self::expression(
                                    "an inline event handler, which binds a handler",
                                );
                            }
                            self.pure(value, shape)?;
                        }
                    }
                    Some(JSXAttributeValue::Element(element)) => {
                        self.pure_jsx_element(element, shape)?;
                    }
                    Some(JSXAttributeValue::Fragment(fragment)) => {
                        self.pure_jsx_children(&fragment.children, shape)?;
                    }
                    _ => {}
                },
            }
        }
        self.pure_jsx_children(&element.children, shape)
    }

    fn pure_jsx_children(&self, children: &[JSXChild<'a>], shape: &mut Shape) -> Outcome {
        for child in children {
            match child {
                JSXChild::Element(element) => self.pure_jsx_element(element, shape)?,
                JSXChild::Fragment(fragment) => {
                    self.pure_jsx_children(&fragment.children, shape)?
                }
                JSXChild::ExpressionContainer(container) => {
                    if let Some(value) = container.expression.as_expression() {
                        self.pure(value, shape)?;
                    }
                }
                JSXChild::Spread(spread) => self.pure(&spread.expression, shape)?,
                JSXChild::Text(_) => {}
            }
        }
        Ok(())
    }
}
