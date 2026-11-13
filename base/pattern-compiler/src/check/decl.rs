//! The declared type of a binding, read from annotations alone.
//!
//! This is not type checking. It finds the type a parameter or a `const` was
//! written with, follows property names through type literals, interfaces,
//! and aliases of the same module, and reports whether the type found is a
//! cell handle type. A rule that uses it is decided only where an annotation
//! or a cell constructor declares the type, and is left to the type checker
//! everywhere else.

use oxc_ast::ast::{
    BindingPattern, Expression, FormalParameter, PropertyKey, TSSignature, TSType, TSTypeName,
};
use oxc_ast::AstKind;
use oxc_span::GetSpan;
use oxc_syntax::symbol::SymbolId;

use super::Checker;
use crate::api::{self, ApiValue, Builder};
use crate::module::symbol_of;
use crate::syntax::{static_key_name, unwrap};

const MAX_DEPTH: u32 = 8;

impl<'a> Checker<'_, 'a> {
    /// Whether an annotation or a cell constructor declares `expr` as a cell
    /// handle.
    pub(super) fn is_declared_cell(&self, expr: &Expression<'a>) -> bool {
        let expr = unwrap(expr);
        if self.is_cell_creation(expr) {
            return true;
        }
        if let Expression::Identifier(identifier) = expr {
            let created = symbol_of(self.scoping, identifier).is_some_and(|symbol| {
                let nodes = self.parsed.semantic.nodes();
                match nodes.kind(self.scoping.symbol_declaration(symbol)) {
                    AstKind::VariableDeclarator(declarator) => {
                        matches!(declarator.id, BindingPattern::BindingIdentifier(_))
                            && declarator
                                .init
                                .as_ref()
                                .is_some_and(|init| self.is_cell_creation(init))
                    }
                    _ => false,
                }
            });
            if created {
                return true;
            }
        }
        self.declared_type(expr, 0)
            .is_some_and(|ty| self.is_cell_type(ty, 0))
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

    fn declared_type(&self, expr: &Expression<'a>, depth: u32) -> Option<&'a TSType<'a>> {
        if depth > MAX_DEPTH {
            return None;
        }
        match unwrap(expr) {
            Expression::Identifier(identifier) => {
                self.symbol_type(symbol_of(self.scoping, identifier)?, depth)
            }
            Expression::StaticMemberExpression(member) => {
                let object = self.declared_type(&member.object, depth + 1)?;
                self.property_type(object, member.property.name.as_str(), depth + 1)
            }
            _ => None,
        }
    }

    fn symbol_type(&self, symbol: SymbolId, depth: u32) -> Option<&'a TSType<'a>> {
        let nodes = self.parsed.semantic.nodes();
        let declaration = self.scoping.symbol_declaration(symbol);
        let (pattern, mut ty) = match nodes.kind(declaration) {
            AstKind::VariableDeclarator(declarator) => {
                let ty = declarator
                    .type_annotation
                    .as_ref()
                    .map(|annotation| &annotation.type_annotation);
                (&declarator.id, ty)
            }
            AstKind::FormalParameter(parameter) => {
                let ty = match &parameter.type_annotation {
                    Some(annotation) => Some(&annotation.type_annotation),
                    None => self.builder_parameter_type(parameter),
                };
                (&parameter.pattern, ty)
            }
            _ => return None,
        };
        let mut path = Vec::new();
        if !path_to(pattern, symbol, &mut path) {
            return None;
        }
        for key in path {
            ty = Some(self.property_type(ty?, key, depth + 1)?);
        }
        ty
    }

    /// The type a builder's type arguments give a parameter of its callback:
    /// the event and the state of `handler<E, S>`, the argument of `lift<T>`
    /// and of `pattern<T>`, and the event of `action<E>`.
    fn builder_parameter_type(&self, parameter: &FormalParameter<'a>) -> Option<&'a TSType<'a>> {
        let nodes = self.parsed.semantic.nodes();
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
                AstKind::CallExpression(call) => {
                    let function_span = function_span?;
                    let is_callback = call.arguments.iter().any(|argument| {
                        argument
                            .as_expression()
                            .is_some_and(|argument| unwrap(argument).span() == function_span)
                    });
                    if !is_callback {
                        return None;
                    }
                    let api = self.model.api_ref_of_callee(self.scoping, &call.callee)?;
                    let ApiValue::Builder(builder) = api.value() else {
                        return None;
                    };
                    let arguments = &call.type_arguments.as_ref()?.params;
                    let slot = match (builder, index?) {
                        (Builder::Handler, slot @ (0 | 1)) => slot,
                        (Builder::Lift | Builder::Pattern | Builder::Action, 0) => 0,
                        _ => return None,
                    };
                    return arguments.get(slot);
                }
                AstKind::Program(_) => return None,
                _ => {}
            }
        }
        None
    }

    /// The declared type of property `key` of `ty`, where `ty` is a type
    /// literal, an interface or an alias of this module, an intersection of
    /// those, or one of them under a wrapper that adds an annotation.
    fn property_type(&self, ty: &'a TSType<'a>, key: &str, depth: u32) -> Option<&'a TSType<'a>> {
        if depth > MAX_DEPTH {
            return None;
        }
        match ty {
            TSType::TSParenthesizedType(inner) => {
                self.property_type(&inner.type_annotation, key, depth + 1)
            }
            TSType::TSTypeLiteral(literal) => member_type(&literal.members, key),
            TSType::TSIntersectionType(intersection) => intersection
                .types
                .iter()
                .find_map(|member| self.property_type(member, key, depth + 1)),
            TSType::TSTypeReference(reference) => {
                let TSTypeName::IdentifierReference(name) = &reference.type_name else {
                    return None;
                };
                let symbol = symbol_of(self.scoping, name)?;
                if let Some(api) = self.model.api_ref(symbol) {
                    if api.subpath.is_none() && api::is_transparent_wrapper(&api.name) {
                        let inner = reference.type_arguments.as_ref()?.params.first()?;
                        return self.property_type(inner, key, depth + 1);
                    }
                    return None;
                }
                if reference.type_arguments.is_some() {
                    return None;
                }
                let nodes = self.parsed.semantic.nodes();
                match nodes.kind(self.scoping.symbol_declaration(symbol)) {
                    AstKind::TSTypeAliasDeclaration(alias) if alias.type_parameters.is_none() => {
                        self.property_type(&alias.type_annotation, key, depth + 1)
                    }
                    AstKind::TSInterfaceDeclaration(interface)
                        if interface.type_parameters.is_none() =>
                    {
                        member_type(&interface.body.body, key)
                    }
                    _ => None,
                }
            }
            _ => None,
        }
    }

    fn is_cell_type(&self, ty: &TSType<'a>, depth: u32) -> bool {
        if depth > MAX_DEPTH {
            return false;
        }
        match ty {
            TSType::TSParenthesizedType(inner) => self.is_cell_type(&inner.type_annotation, depth),
            TSType::TSTypeReference(reference) => {
                let Some(api) = self.api_type(&reference.type_name) else {
                    return false;
                };
                if api::is_cell_type(&api) {
                    return true;
                }
                api::is_transparent_wrapper(&api)
                    && reference
                        .type_arguments
                        .as_ref()
                        .and_then(|arguments| arguments.params.first())
                        .is_some_and(|inner| self.is_cell_type(inner, depth + 1))
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

fn member_type<'a>(members: &'a [TSSignature<'a>], key: &str) -> Option<&'a TSType<'a>> {
    members.iter().find_map(|member| match member {
        TSSignature::TSPropertySignature(property)
            if !property.computed && static_key_name(&property.key) == Some(key) =>
        {
            property
                .type_annotation
                .as_ref()
                .map(|annotation| &annotation.type_annotation)
        }
        _ => None,
    })
}

/// Finds the binding of `symbol` in `pattern` and collects the property
/// names that lead to it. Returns false when the binding is not in the
/// pattern or is reached through an array pattern, a rest element, or a
/// computed key.
fn path_to<'a>(pattern: &'a BindingPattern<'a>, symbol: SymbolId, path: &mut Vec<&'a str>) -> bool {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => identifier.symbol_id.get() == Some(symbol),
        BindingPattern::AssignmentPattern(assignment) => path_to(&assignment.left, symbol, path),
        BindingPattern::ObjectPattern(object) => object.properties.iter().any(|property| {
            let key = match &property.key {
                PropertyKey::StaticIdentifier(name) if !property.computed => name.name.as_str(),
                PropertyKey::StringLiteral(literal) => literal.value.as_str(),
                _ => return false,
            };
            path.push(key);
            if path_to(&property.value, symbol, path) {
                return true;
            }
            path.pop();
            false
        }),
        BindingPattern::ArrayPattern(_) => false,
    }
}
