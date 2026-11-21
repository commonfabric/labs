//! What the walk asks of the declared types of `crate::declared`.

use oxc_ast::ast::{Expression, TSTypeName};

use super::Checker;
use crate::api::{self, ApiValue};
use crate::declared::Declared;
use crate::module::symbol_of;
use crate::syntax::unwrap;
use crate::types::{HandleKind, Shape};

impl<'a> Checker<'_, 'a> {
    pub(super) fn declared(&self, expr: &Expression<'a>) -> Declared {
        self.resolver.declared(self.module, expr)
    }

    /// The shape of the declared type of `expr`, when a declaration gives
    /// one that was evaluated.
    pub(super) fn declared_shape(&self, expr: &Expression<'a>) -> Option<Shape> {
        match self.resolver.shape(self.declared(expr).ok()?) {
            Shape::Unresolved(_) | Shape::Parameter(_) | Shape::Unknown => None,
            shape => Some(shape),
        }
    }

    /// The kind of handle `expr` is declared as, if it is declared as one.
    pub(super) fn declared_handle(&self, expr: &Expression<'a>) -> Option<HandleKind> {
        match self.declared_shape(expr)? {
            Shape::Handle(kind, _) => Some(kind),
            _ => None,
        }
    }

    /// Whether a declaration gives `expr` a handle type.
    pub(super) fn is_declared_cell(&self, expr: &Expression<'a>) -> bool {
        self.declared_handle(expr).is_some()
    }

    /// Whether `expr` creates a cell: `new X(...)`, `X.of(...)`, `X.for(...)`,
    /// or one of the two under a scope such as `X.perUser`.
    pub(super) fn is_cell_creation(&self, expr: &Expression<'a>) -> bool {
        match unwrap(expr) {
            Expression::NewExpression(new) => self.is_cell_constructor(&new.callee),
            Expression::CallExpression(call) => match unwrap(&call.callee) {
                Expression::StaticMemberExpression(member) => {
                    matches!(member.property.name.as_str(), "of" | "for")
                        && self.is_cell_constructor(&member.object)
                }
                _ => false,
            },
            _ => false,
        }
    }

    /// Whether `expr` names a cell constructor, with or without a scope.
    pub(super) fn is_cell_constructor(&self, expr: &Expression<'a>) -> bool {
        match unwrap(expr) {
            Expression::Identifier(identifier) => symbol_of(self.scoping, identifier)
                .and_then(|symbol| self.model.api_ref(symbol))
                .is_some_and(|api| api.value() == ApiValue::CellConstructor),
            Expression::StaticMemberExpression(member) => {
                api::is_cell_scope(member.property.name.as_str())
                    && self.is_cell_constructor(&member.object)
            }
            _ => false,
        }
    }

    /// The name of the type `commonfabric` exports that `name` resolves to
    /// through its import.
    pub(super) fn api_type(&self, name: &TSTypeName<'a>) -> Option<String> {
        let TSTypeName::IdentifierReference(identifier) = name else {
            return None;
        };
        let api = self.model.api_ref(symbol_of(self.scoping, identifier)?)?;
        api.subpath.is_none().then_some(api.name)
    }
}
