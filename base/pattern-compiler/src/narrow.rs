//! Narrowing (`language-subset.md` §7.6): the type a reference has where a
//! condition has been tested.
//!
//! A reference is a binding, or a path of static property names from one.
//! Its declared type is narrowed by the conditions that hold where it is
//! written: the test of an enclosing `if` or conditional expression, the
//! left operand of an enclosing `&&` or `||`, the test of an earlier `if` of
//! the same block whose branch leaves the block, and the case of an
//! enclosing `switch`. A binding that is assigned anywhere is not narrowed,
//! and a path is narrowed only by conditions of the function it is written
//! in.

use oxc_ast::ast::*;
use oxc_ast::AstKind;
use oxc_span::{GetSpan, Span};
use oxc_syntax::operator::{BinaryOperator, LogicalOperator, UnaryOperator};
use oxc_syntax::symbol::SymbolId;

use crate::api::ApiValue;
use crate::module::symbol_of;
use crate::program::Resolver;
use crate::syntax::unparen;
use crate::types::{Shape, TypeId};

/// A reference: a binding and the property names read from it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Reference {
    root: SymbolId,
    path: Vec<String>,
}

/// What a `typeof` test, `Array.isArray`, or `instanceof` asks about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Yes,
    No,
    /// The shape does not say, so the member stays in both branches.
    Unsure,
}

fn contains(outer: Span, inner: Span) -> bool {
    outer.start <= inner.start && inner.end <= outer.end
}

/// Whether control cannot pass from the end of `statement` to the statement
/// after it.
fn leaves(statement: &Statement<'_>) -> bool {
    match statement {
        Statement::ReturnStatement(_)
        | Statement::ThrowStatement(_)
        | Statement::BreakStatement(_)
        | Statement::ContinueStatement(_) => true,
        Statement::BlockStatement(block) => block.body.last().is_some_and(leaves),
        Statement::IfStatement(statement) => {
            leaves(&statement.consequent) && statement.alternate.as_ref().is_some_and(leaves)
        }
        _ => false,
    }
}

/// The kind of value a literal type's text denotes, as `typeof` names it.
fn literal_kind(text: &str) -> &'static str {
    if text.starts_with(['"', '\'', '`']) {
        "string"
    } else if text == "true" || text == "false" {
        "boolean"
    } else if text.ends_with('n') {
        "bigint"
    } else {
        "number"
    }
}

fn is_falsy_literal(text: &str) -> bool {
    matches!(text, "false" | "0" | "0n" | "\"\"" | "''" | "``" | "-0")
}

impl<'a> Resolver<'_, 'a> {
    fn reference_of(&self, module: usize, expression: &Expression<'a>) -> Option<Reference> {
        let mut path = Vec::new();
        let mut current = expression;
        loop {
            current = match current {
                Expression::ParenthesizedExpression(inner) => &inner.expression,
                Expression::TSNonNullExpression(inner) => &inner.expression,
                Expression::StaticMemberExpression(member) => {
                    path.push(member.property.name.to_string());
                    &member.object
                }
                Expression::ComputedMemberExpression(member) => {
                    match unparen(&member.expression) {
                        Expression::NumericLiteral(index) => {
                            path.push(format!("[{}]", index.value));
                        }
                        Expression::StringLiteral(key) => path.push(key.value.to_string()),
                        _ => return None,
                    }
                    &member.object
                }
                Expression::Identifier(identifier) => {
                    let parsed = self.parsed(module)?;
                    let root = symbol_of(parsed.semantic.scoping(), identifier)?;
                    path.reverse();
                    return Some(Reference { root, path });
                }
                _ => return None,
            };
        }
    }

    /// Whether a binding is a parameter of a builder's callback, so that a
    /// position of its type declared `unknown` is a reference to stored
    /// data and not a value the body computed (§7.8).
    fn is_data_position(&self, module: usize, symbol: SymbolId) -> bool {
        let Some((parsed, model)) = self.parsed(module).zip(self.model(module)) else {
            return false;
        };
        let scoping = parsed.semantic.scoping();
        let nodes = parsed.semantic.nodes();
        let mut function = None;
        for kind in nodes.ancestor_kinds(scoping.symbol_declaration(symbol)) {
            match kind {
                AstKind::ArrowFunctionExpression(arrow) if function.is_none() => {
                    function = Some(arrow.span);
                }
                AstKind::Function(found) if function.is_none() => function = Some(found.span),
                AstKind::CallExpression(call) => {
                    let Some(function) = function else {
                        return false;
                    };
                    let is_argument = call
                        .arguments
                        .iter()
                        .any(|argument| argument.span() == function);
                    return is_argument
                        && model
                            .api_ref_of_callee(scoping, &call.callee)
                            .is_some_and(|api| matches!(api.value(), ApiValue::Builder(_)));
                }
                AstKind::FormalParameters(_)
                | AstKind::FormalParameter(_)
                | AstKind::BindingRestElement(_)
                | AstKind::ObjectPattern(_)
                | AstKind::ArrayPattern(_)
                | AstKind::BindingProperty(_)
                | AstKind::AssignmentPattern(_) => {}
                _ if function.is_some() => return false,
                AstKind::VariableDeclarator(_) => return false,
                _ => {}
            }
        }
        false
    }

    /// The type of the reference `expression`, whose declared type is `ty`,
    /// narrowed by the conditions that hold where it is written.
    pub(crate) fn narrowed(
        &self,
        module: usize,
        expression: &Expression<'a>,
        ty: TypeId,
    ) -> TypeId {
        if !matches!(
            self.shape(ty),
            Shape::Union(_)
                | Shape::Unknown
                | Shape::Boolean
                | Shape::String
                | Shape::Number
                | Shape::BigInt
        ) {
            return ty;
        }
        let Some(reference) = self.reference_of(module, expression) else {
            return ty;
        };
        let Some(parsed) = self.parsed(module) else {
            return ty;
        };
        if parsed.semantic.scoping().symbol_is_mutated(reference.root) {
            return ty;
        }
        let nodes = parsed.semantic.nodes();
        // The conditions that hold, innermost first, each with whether it
        // is true or false there.
        let mut conditions: Vec<(Condition<'_, 'a>, bool)> = Vec::new();
        let mut child = expression.span();
        for kind in nodes.ancestor_kinds(expression.node_id()) {
            match kind {
                AstKind::IfStatement(statement) => {
                    if contains(statement.consequent.span(), child) {
                        conditions.push((Condition::Test(&statement.test), true));
                    } else if statement
                        .alternate
                        .as_ref()
                        .is_some_and(|alternate| contains(alternate.span(), child))
                    {
                        conditions.push((Condition::Test(&statement.test), false));
                    }
                }
                AstKind::ConditionalExpression(conditional) => {
                    if contains(conditional.consequent.span(), child) {
                        conditions.push((Condition::Test(&conditional.test), true));
                    } else if contains(conditional.alternate.span(), child) {
                        conditions.push((Condition::Test(&conditional.test), false));
                    }
                }
                AstKind::LogicalExpression(logical) => {
                    if contains(logical.right.span(), child) {
                        match logical.operator {
                            LogicalOperator::And => {
                                conditions.push((Condition::Test(&logical.left), true));
                            }
                            LogicalOperator::Or => {
                                conditions.push((Condition::Test(&logical.left), false));
                            }
                            LogicalOperator::Coalesce => {}
                        }
                    }
                }
                AstKind::BlockStatement(block) => earlier(&block.body, child, &mut conditions),
                AstKind::FunctionBody(body) => earlier(&body.statements, child, &mut conditions),
                AstKind::Program(program) => earlier(&program.body, child, &mut conditions),
                AstKind::SwitchCase(case) => earlier(&case.consequent, child, &mut conditions),
                AstKind::SwitchStatement(statement) => {
                    let position = statement
                        .cases
                        .iter()
                        .position(|case| contains(case.span, child));
                    if let Some(position) = position {
                        let case = &statement.cases[position];
                        // A case that the case before it can fall into is
                        // reached with more values than its own.
                        let entered_alone = position == 0
                            || statement.cases[position - 1]
                                .consequent
                                .last()
                                .is_some_and(leaves);
                        if let (Some(test), true) = (&case.test, entered_alone) {
                            conditions
                                .push((Condition::Equal(&statement.discriminant, test), true));
                        }
                    }
                }
                AstKind::ArrowFunctionExpression(_) | AstKind::Function(_)
                    if !reference.path.is_empty() =>
                {
                    break;
                }
                _ => {}
            }
            child = kind.span();
        }
        let mut narrowed = ty;
        for (condition, sense) in conditions.into_iter().rev() {
            narrowed = match condition {
                Condition::Test(test) => self.assume(module, test, sense, &reference, narrowed),
                Condition::Equal(left, right) => {
                    self.assume_equal(module, left, right, true, sense, &reference, narrowed)
                }
            };
        }
        narrowed
    }

    /// `ty` with the members `keep` rejects removed. A type every member of
    /// which is rejected is left as it is, so that a condition the checker
    /// reads wrongly cannot produce `never`.
    fn filter(&self, ty: TypeId, keep: impl Fn(TypeId, &Shape) -> bool) -> TypeId {
        match self.shape(ty) {
            Shape::Union(members) => {
                let kept: Vec<TypeId> = members
                    .iter()
                    .copied()
                    .filter(|member| keep(*member, &self.shape(*member)))
                    .collect();
                if kept.is_empty() || kept.len() == members.len() {
                    ty
                } else {
                    self.union_of(kept)
                }
            }
            _ => ty,
        }
    }

    /// `ty`, the type of `reference`, where `test` is known to be `sense`.
    fn assume(
        &self,
        module: usize,
        test: &Expression<'a>,
        sense: bool,
        reference: &Reference,
        ty: TypeId,
    ) -> TypeId {
        let test = unparen(test);
        match test {
            Expression::UnaryExpression(unary) if unary.operator == UnaryOperator::LogicalNot => {
                self.assume(module, &unary.argument, !sense, reference, ty)
            }
            Expression::LogicalExpression(logical) => match (logical.operator, sense) {
                (LogicalOperator::And, true) | (LogicalOperator::Or, false) => {
                    let ty = self.assume(module, &logical.left, sense, reference, ty);
                    self.assume(module, &logical.right, sense, reference, ty)
                }
                // One of the two operands decided the result, so the type
                // is what either of them leaves.
                (LogicalOperator::And, false) | (LogicalOperator::Or, true) => {
                    let left = self.assume(module, &logical.left, sense, reference, ty);
                    let right = self.assume(module, &logical.right, sense, reference, ty);
                    self.union_by_text(vec![left, right])
                }
                _ => ty,
            },
            Expression::BinaryExpression(binary) => match binary.operator {
                BinaryOperator::StrictEquality | BinaryOperator::Equality => self.assume_equal(
                    module,
                    &binary.left,
                    &binary.right,
                    binary.operator == BinaryOperator::StrictEquality,
                    sense,
                    reference,
                    ty,
                ),
                BinaryOperator::StrictInequality | BinaryOperator::Inequality => self.assume_equal(
                    module,
                    &binary.left,
                    &binary.right,
                    binary.operator == BinaryOperator::StrictInequality,
                    !sense,
                    reference,
                    ty,
                ),
                BinaryOperator::In => {
                    let Expression::StringLiteral(key) = unparen(&binary.left) else {
                        return ty;
                    };
                    if self.reference_of(module, &binary.right).as_ref() != Some(reference) {
                        return ty;
                    }
                    let key = key.value.as_str();
                    self.filter(ty, |_, shape| match shape {
                        Shape::Object(properties, index) => {
                            let declared = properties.iter().find(|property| property.name == key);
                            if sense {
                                declared.is_some() || index.is_some()
                            } else {
                                declared.is_none_or(|property| property.optional)
                            }
                        }
                        Shape::Unknown | Shape::Unresolved(_) | Shape::Parameter(_) => true,
                        _ => !sense,
                    })
                }
                BinaryOperator::Instanceof => {
                    let Expression::Identifier(constructor) = unparen(&binary.right) else {
                        return ty;
                    };
                    let global = self.parsed(module).is_some_and(|parsed| {
                        symbol_of(parsed.semantic.scoping(), constructor).is_none()
                    });
                    if !global
                        || self.reference_of(module, &binary.left).as_ref() != Some(reference)
                    {
                        return ty;
                    }
                    let name = constructor.name.as_str();
                    let instance = self.code_type(name, Vec::new());
                    self.assume_kind(module, sense, reference, ty, Some(instance), |shape| {
                        match shape {
                            Shape::Code(code) if code == name => Kind::Yes,
                            Shape::Code(code) if name == "Error" && code.ends_with("Error") => {
                                Kind::Yes
                            }
                            Shape::Unknown | Shape::Unresolved(_) | Shape::Parameter(_) => {
                                Kind::Unsure
                            }
                            _ => Kind::No,
                        }
                    })
                }
                _ => ty,
            },
            Expression::CallExpression(call) => {
                self.assume_call(module, call, sense, reference, ty)
            }
            _ if self.reference_of(module, test).as_ref() == Some(reference) => {
                self.assume_truthy(sense, ty)
            }
            _ => ty,
        }
    }

    fn assume_truthy(&self, sense: bool, ty: TypeId) -> TypeId {
        if self.shape(ty) == Shape::Boolean {
            return self.intern(Shape::Literal(sense.to_string()));
        }
        self.filter(ty, |_, shape| match shape {
            Shape::Null | Shape::Undefined | Shape::Void => !sense,
            Shape::Literal(text) => is_falsy_literal(text) != sense,
            Shape::String
            | Shape::Number
            | Shape::Boolean
            | Shape::BigInt
            | Shape::Unknown
            | Shape::Unresolved(_)
            | Shape::Parameter(_) => true,
            _ => sense,
        })
    }

    /// Narrows by a test of the kind of a value. `whole` is the type an
    /// `unknown` value has where the test is true.
    fn assume_kind(
        &self,
        module: usize,
        sense: bool,
        reference: &Reference,
        ty: TypeId,
        whole: Option<TypeId>,
        kind: impl Fn(&Shape) -> Kind,
    ) -> TypeId {
        if self.shape(ty) == Shape::Unknown {
            // A kind test sees the reference of a data position typed
            // `unknown`, and not what is stored behind it (§7.8).
            return match whole {
                Some(whole) if sense && !self.is_data_position(module, reference.root) => whole,
                _ => ty,
            };
        }
        self.filter(ty, |_, shape| match kind(shape) {
            Kind::Yes => sense,
            Kind::No => !sense,
            Kind::Unsure => true,
        })
    }

    fn assume_call(
        &self,
        module: usize,
        call: &CallExpression<'a>,
        sense: bool,
        reference: &Reference,
        ty: TypeId,
    ) -> TypeId {
        let argument = |index: usize| call.arguments.get(index).and_then(Argument::as_expression);
        let Some(parsed) = self.parsed(module) else {
            return ty;
        };
        let scoping = parsed.semantic.scoping();
        match unparen(&call.callee) {
            // `Array.isArray(x)`.
            Expression::StaticMemberExpression(member) => {
                let is_array_test = member.property.name == "isArray"
                    && matches!(unparen(&member.object), Expression::Identifier(object)
                        if object.name == "Array" && symbol_of(scoping, object).is_none());
                if !is_array_test
                    || argument(0)
                        .and_then(|argument| self.reference_of(module, argument))
                        .as_ref()
                        != Some(reference)
                {
                    return ty;
                }
                let whole = self.intern(Shape::Array(self.intern(Shape::Unknown)));
                self.assume_kind(
                    module,
                    sense,
                    reference,
                    ty,
                    Some(whole),
                    |shape| match shape {
                        Shape::Array(_) | Shape::Tuple(_) => Kind::Yes,
                        Shape::Unknown | Shape::Unresolved(_) | Shape::Parameter(_) => Kind::Unsure,
                        _ => Kind::No,
                    },
                )
            }
            // A call of a function with a type predicate.
            Expression::Identifier(callee) => {
                let Some((home, symbol)) =
                    symbol_of(scoping, callee).and_then(|symbol| self.origin(module, symbol))
                else {
                    return ty;
                };
                let Some(parsed) = self.parsed(home) else {
                    return ty;
                };
                let declaration = parsed.semantic.scoping().symbol_declaration(symbol);
                let function = match parsed.semantic.nodes().kind(declaration) {
                    AstKind::Function(function) => Some((&function.params, &function.return_type)),
                    AstKind::VariableDeclarator(declarator) => match declarator.init.as_ref() {
                        Some(Expression::ArrowFunctionExpression(arrow)) => {
                            Some((&arrow.params, &arrow.return_type))
                        }
                        _ => None,
                    },
                    _ => None,
                };
                let Some((parameters, Some(result))) = function else {
                    return ty;
                };
                let TSType::TSTypePredicate(predicate) = &result.type_annotation else {
                    return ty;
                };
                let (TSTypePredicateName::Identifier(tested), Some(asserted), false) = (
                    &predicate.parameter_name,
                    &predicate.type_annotation,
                    predicate.asserts,
                ) else {
                    return ty;
                };
                let position = parameters.items.iter().position(|parameter| {
                    matches!(&parameter.pattern, BindingPattern::BindingIdentifier(name)
                        if name.name == tested.name)
                });
                let tests_reference = position
                    .and_then(argument)
                    .and_then(|argument| self.reference_of(module, argument))
                    .as_ref()
                    == Some(reference);
                if !tests_reference {
                    return ty;
                }
                let asserted = self.resolve_type(home, &asserted.type_annotation);
                if self.shape(ty) == Shape::Unknown {
                    return if sense { asserted } else { ty };
                }
                self.filter(ty, |member, _| {
                    self.assignable(member, asserted)
                        .is_none_or(|fits| fits == sense)
                })
            }
            _ => ty,
        }
    }

    /// Narrows by `left === right`, or by `left == right` when not
    /// `strict`, known to be `sense`.
    #[allow(clippy::too_many_arguments)]
    fn assume_equal(
        &self,
        module: usize,
        left: &Expression<'a>,
        right: &Expression<'a>,
        strict: bool,
        sense: bool,
        reference: &Reference,
        ty: TypeId,
    ) -> TypeId {
        let (left, right) = (unparen(left), unparen(right));
        // `typeof x === "kind"`.
        for (tested, kind) in [(left, right), (right, left)] {
            let (Expression::UnaryExpression(unary), Expression::StringLiteral(kind)) =
                (tested, kind)
            else {
                continue;
            };
            if unary.operator != UnaryOperator::Typeof
                || self.reference_of(module, &unary.argument).as_ref() != Some(reference)
            {
                continue;
            }
            let kind = kind.value.as_str();
            let whole = match kind {
                "string" => Some(Shape::String),
                "number" => Some(Shape::Number),
                "boolean" => Some(Shape::Boolean),
                "bigint" => Some(Shape::BigInt),
                "undefined" => Some(Shape::Undefined),
                _ => None,
            }
            .map(|shape| self.intern(shape));
            return self.assume_kind(module, sense, reference, ty, whole, |shape| {
                let found = match shape {
                    Shape::String => "string",
                    Shape::Number => "number",
                    Shape::Boolean => "boolean",
                    Shape::BigInt => "bigint",
                    Shape::Undefined | Shape::Void => "undefined",
                    Shape::Literal(text) => literal_kind(text),
                    Shape::Function => "function",
                    Shape::Null
                    | Shape::Object(..)
                    | Shape::Array(_)
                    | Shape::Tuple(_)
                    | Shape::Code(_)
                    | Shape::Handle(..) => "object",
                    _ => return Kind::Unsure,
                };
                if found == kind {
                    Kind::Yes
                } else {
                    Kind::No
                }
            });
        }
        for (tested, value) in [(left, right), (right, left)] {
            let Some(value) = self.unit_of(module, value) else {
                continue;
            };
            let Some(tested) = self.reference_of(module, tested) else {
                continue;
            };
            if tested == *reference {
                return self.assume_value(&value, strict, sense, ty);
            }
            // A discriminant: `x.kind === "mix"` narrows `x`.
            let discriminates = tested.root == reference.root
                && tested.path.len() == reference.path.len() + 1
                && tested.path.starts_with(&reference.path);
            if discriminates {
                let name = tested.path.last().expect("the path has an element");
                return self.filter(ty, |_, shape| match shape {
                    Shape::Object(properties, index) => {
                        let declared = properties.iter().find(|property| property.name == *name);
                        match declared {
                            Some(property) => {
                                let exact = self.is_unit(property.ty, &value, strict);
                                if sense {
                                    self.may_be(property.ty, &value, strict)
                                        || (property.optional && value.is_undefined(strict))
                                } else {
                                    !exact
                                }
                            }
                            None if index.is_some() => true,
                            None => value.is_undefined(strict) == sense || !sense,
                        }
                    }
                    Shape::Null | Shape::Undefined => !sense,
                    _ => true,
                });
            }
        }
        ty
    }

    /// The unit value an expression denotes: a literal, `null`, or
    /// `undefined`.
    fn unit_of(&self, module: usize, expression: &Expression<'a>) -> Option<Unit> {
        Some(match expression {
            Expression::NullLiteral(_) => Unit::Null,
            Expression::Identifier(identifier) if identifier.name == "undefined" => {
                let parsed = self.parsed(module)?;
                if symbol_of(parsed.semantic.scoping(), identifier).is_some() {
                    return None;
                }
                Unit::Undefined
            }
            Expression::StringLiteral(_)
            | Expression::NumericLiteral(_)
            | Expression::BooleanLiteral(_)
            | Expression::BigIntLiteral(_) => {
                let parsed = self.parsed(module)?;
                Unit::Literal(expression.span().source_text(parsed.source).to_string())
            }
            _ => return None,
        })
    }

    /// Whether `ty` is the type of exactly the unit value.
    fn is_unit(&self, ty: TypeId, value: &Unit, strict: bool) -> bool {
        match (self.shape(ty), value) {
            (Shape::Null, Unit::Null) | (Shape::Undefined, Unit::Undefined) => true,
            (Shape::Null | Shape::Undefined, Unit::Null | Unit::Undefined) => !strict,
            (Shape::Literal(text), Unit::Literal(literal)) => same_literal(&text, literal),
            _ => false,
        }
    }

    /// Whether a value of type `ty` can be the unit value.
    fn may_be(&self, ty: TypeId, value: &Unit, strict: bool) -> bool {
        match (self.shape(ty), value) {
            (Shape::Union(members), _) => members
                .iter()
                .any(|member| self.may_be(*member, value, strict)),
            (Shape::Unknown | Shape::Unresolved(_) | Shape::Parameter(_), _) => true,
            (Shape::String, Unit::Literal(literal)) => literal_kind(literal) == "string",
            (Shape::Number, Unit::Literal(literal)) => literal_kind(literal) == "number",
            (Shape::Boolean, Unit::Literal(literal)) => literal_kind(literal) == "boolean",
            (Shape::BigInt, Unit::Literal(literal)) => literal_kind(literal) == "bigint",
            _ => self.is_unit(ty, value, strict),
        }
    }

    fn assume_value(&self, value: &Unit, strict: bool, sense: bool, ty: TypeId) -> TypeId {
        if let (Shape::Boolean, Unit::Literal(literal)) = (self.shape(ty), value) {
            if literal_kind(literal) == "boolean" {
                let holds = (literal == "true") == sense;
                return self.intern(Shape::Literal(holds.to_string()));
            }
        }
        if !sense {
            return self.filter(ty, |member, _| !self.is_unit(member, value, strict));
        }
        match self.shape(ty) {
            Shape::Union(members) => {
                let kept: Vec<TypeId> = members
                    .iter()
                    .filter(|member| self.may_be(**member, value, strict))
                    .map(|member| match (self.shape(*member), value) {
                        (
                            Shape::String | Shape::Number | Shape::Boolean | Shape::BigInt,
                            Unit::Literal(literal),
                        ) => self.intern(Shape::Literal(literal.clone())),
                        _ => *member,
                    })
                    .collect();
                if kept.is_empty() {
                    ty
                } else {
                    self.union_of(kept)
                }
            }
            Shape::String | Shape::Number | Shape::BigInt => match value {
                Unit::Literal(literal) if self.may_be(ty, value, strict) => {
                    self.intern(Shape::Literal(literal.clone()))
                }
                _ => ty,
            },
            _ => ty,
        }
    }
}

/// A condition that holds or fails where a reference is written.
enum Condition<'e, 'a> {
    Test(&'e Expression<'a>),
    /// The discriminant of a `switch` and the test of a case.
    Equal(&'e Expression<'a>, &'e Expression<'a>),
}

/// A value with a type of its own.
enum Unit {
    Null,
    Undefined,
    Literal(String),
}

impl Unit {
    fn is_undefined(&self, strict: bool) -> bool {
        match self {
            Unit::Undefined => true,
            Unit::Null => !strict,
            Unit::Literal(_) => false,
        }
    }
}

fn same_literal(left: &str, right: &str) -> bool {
    let strip = |text: &str| -> String {
        if text.starts_with(['"', '\'', '`']) && text.len() >= 2 {
            format!("\"{}\"", &text[1..text.len() - 1])
        } else {
            text.to_string()
        }
    };
    strip(left) == strip(right)
}

/// Adds the conditions that the statements of `statements` before the one
/// that contains `child` establish: the test of an `if` whose branch leaves
/// the block is false after it, or true when it is the `else` branch that
/// leaves.
fn earlier<'e, 'a>(
    statements: &'e [Statement<'a>],
    child: Span,
    conditions: &mut Vec<(Condition<'e, 'a>, bool)>,
) {
    for statement in statements.iter().rev() {
        if statement.span().end > child.start {
            continue;
        }
        let Statement::IfStatement(statement) = statement else {
            continue;
        };
        let then_leaves = leaves(&statement.consequent);
        let else_leaves = statement.alternate.as_ref().is_some_and(leaves);
        match (then_leaves, else_leaves) {
            (true, false) => conditions.push((Condition::Test(&statement.test), false)),
            (false, true) => conditions.push((Condition::Test(&statement.test), true)),
            _ => {}
        }
    }
}
