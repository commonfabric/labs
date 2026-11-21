//! Small helpers over the syntax tree that several stages share.

use oxc_ast::ast::{
    Argument, ArrowFunctionExpression, BindingPattern, Expression, Function, PropertyKey, Statement,
};
use oxc_span::{GetSpan, Span};

/// `expr` with the wrappers that change no value removed: parentheses, `as`,
/// `satisfies`, a non-null `!`, and an angle-bracket assertion
/// (`language-subset.md` §4.3, "Type-only wrappers").
pub fn unwrap<'e, 'a>(mut expr: &'e Expression<'a>) -> &'e Expression<'a> {
    loop {
        expr = match expr {
            Expression::ParenthesizedExpression(inner) => &inner.expression,
            Expression::TSAsExpression(inner) => &inner.expression,
            Expression::TSSatisfiesExpression(inner) => &inner.expression,
            Expression::TSNonNullExpression(inner) => &inner.expression,
            Expression::TSTypeAssertion(inner) => &inner.expression,
            _ => return expr,
        };
    }
}

/// `expr` with parentheses removed and nothing else.
pub fn unparen<'e, 'a>(mut expr: &'e Expression<'a>) -> &'e Expression<'a> {
    while let Expression::ParenthesizedExpression(inner) = expr {
        expr = &inner.expression;
    }
    expr
}

/// The byte offsets of a span.
pub fn offsets(span: Span) -> (u32, u32) {
    (span.start, span.end)
}

/// A function written in place: an arrow function or a function expression.
#[derive(Clone, Copy)]
pub enum FunctionLike<'e, 'a> {
    Arrow(&'e ArrowFunctionExpression<'a>),
    Function(&'e Function<'a>),
}

impl<'e, 'a> FunctionLike<'e, 'a> {
    /// The function `expr` is once its type-only wrappers are removed, if it
    /// is one.
    pub fn of(expr: &'e Expression<'a>) -> Option<Self> {
        match unwrap(expr) {
            Expression::ArrowFunctionExpression(arrow) => Some(FunctionLike::Arrow(arrow)),
            Expression::FunctionExpression(function) => Some(FunctionLike::Function(function)),
            _ => None,
        }
    }

    /// The function an argument is, if it is one. A spread is not.
    pub fn of_argument(argument: &'e Argument<'a>) -> Option<Self> {
        argument.as_expression().and_then(Self::of)
    }

    pub fn span(self) -> Span {
        match self {
            FunctionLike::Arrow(arrow) => arrow.span,
            FunctionLike::Function(function) => function.span,
        }
    }

    pub fn is_async(self) -> bool {
        match self {
            FunctionLike::Arrow(arrow) => arrow.r#async,
            FunctionLike::Function(function) => function.r#async,
        }
    }

    pub fn is_generator(self) -> bool {
        match self {
            FunctionLike::Arrow(_) => false,
            FunctionLike::Function(function) => function.generator,
        }
    }

    pub fn is_arrow(self) -> bool {
        matches!(self, FunctionLike::Arrow(_))
    }

    pub fn params(self) -> &'e oxc_ast::ast::FormalParameters<'a> {
        match self {
            FunctionLike::Arrow(arrow) => &arrow.params,
            FunctionLike::Function(function) => &function.params,
        }
    }

    /// The number of parameters, a rest parameter included.
    pub fn param_count(self) -> usize {
        let params = self.params();
        params.items.len() + usize::from(params.rest.is_some())
    }

    /// The expression of an arrow function with an expression body.
    pub fn expression_body(self) -> Option<&'e Expression<'a>> {
        match self {
            FunctionLike::Arrow(arrow) if arrow.expression => match arrow.body.statements.first() {
                Some(Statement::ExpressionStatement(statement)) => Some(&statement.expression),
                _ => None,
            },
            _ => None,
        }
    }

    /// The statements of a block body. `None` for an arrow function with an
    /// expression body and for a declaration without a body.
    pub fn block_body(self) -> Option<&'e [Statement<'a>]> {
        match self {
            FunctionLike::Arrow(arrow) if arrow.expression => None,
            FunctionLike::Arrow(arrow) => Some(&arrow.body.statements),
            FunctionLike::Function(function) => function
                .body
                .as_ref()
                .map(|body| body.statements.as_slice()),
        }
    }

    pub fn scope_id(self) -> Option<oxc_syntax::scope::ScopeId> {
        match self {
            FunctionLike::Arrow(arrow) => arrow.scope_id.get(),
            FunctionLike::Function(function) => function.scope_id.get(),
        }
    }

    pub fn has_type_parameters(self) -> bool {
        match self {
            FunctionLike::Arrow(arrow) => arrow.type_parameters.is_some(),
            FunctionLike::Function(function) => function.type_parameters.is_some(),
        }
    }
}

/// The name a property key denotes when it is written as an identifier or a
/// string literal, and `None` for a computed or numeric key.
pub fn static_key_name<'e>(key: &'e PropertyKey<'_>) -> Option<&'e str> {
    match key {
        PropertyKey::StaticIdentifier(name) => Some(name.name.as_str()),
        PropertyKey::StringLiteral(literal) => Some(literal.value.as_str()),
        _ => None,
    }
}

/// The identifier a binding pattern binds when it is a plain name, with a
/// default value removed.
pub fn binding_name<'e, 'a>(
    pattern: &'e BindingPattern<'a>,
) -> Option<&'e oxc_ast::ast::BindingIdentifier<'a>> {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => Some(identifier),
        BindingPattern::AssignmentPattern(assignment) => binding_name(&assignment.left),
        _ => None,
    }
}

/// The span of an expression.
pub fn expression_span(expr: &Expression<'_>) -> Span {
    expr.span()
}
