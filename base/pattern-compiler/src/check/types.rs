//! The rules on type syntax (`language-subset.md` §7.7, §7.8, §7.9) that are
//! decided where a type is written.

use oxc_ast::ast::{
    TSAnyKeyword, TSIndexSignature, TSInterfaceDeclaration, TSType, TSTypeName,
    TSTypeParameterDeclaration, TSTypeReference,
};
use oxc_ast_visit::{walk, Visit};
use oxc_span::Span;
use oxc_syntax::symbol::SymbolId;

use super::Checker;
use crate::api;
use crate::module::symbol_of;

impl<'a> Checker<'_, 'a> {
    pub(super) fn type_any(&mut self, it: &TSAnyKeyword) {
        self.count("any");
        self.report("subset-type:any", it.span, "`any`");
    }

    /// A cast: `e as T` or `<T>e`.
    pub(super) fn cast(&mut self, target: &TSType<'a>, span: Span) {
        let mut target = target;
        while let TSType::TSParenthesizedType(inner) = target {
            target = &inner.type_annotation;
        }
        match target {
            TSType::TSAnyKeyword(_) => self.count("as-any"),
            TSType::TSTypeReference(reference) => {
                let Some(name) = self.api_type(&reference.type_name) else {
                    return;
                };
                if api::is_cell_cast_target(&name) {
                    self.report(
                        "cast-validation:cell-cast",
                        span,
                        format!("A cast to the cell type `{name}`"),
                    );
                } else if name == "Reactive" {
                    self.report(
                        "cast-validation:forbidden-cast",
                        span,
                        "A cast to `Reactive<T>`",
                    );
                }
            }
            _ => {}
        }
    }

    pub(super) fn index_signature(&mut self, it: &TSIndexSignature<'a>) {
        for parameter in &it.parameters {
            let refused = matches!(
                parameter.type_annotation.type_annotation,
                TSType::TSNumberKeyword(_)
                    | TSType::TSSymbolKeyword(_)
                    | TSType::TSTemplateLiteralType(_)
            );
            if refused {
                self.report(
                    "subset-type:index-signature-key",
                    it.span,
                    "An index signature keyed by `number`, `symbol`, or a template literal",
                );
            }
        }
    }

    /// `subset-syntax:ambient-declaration` for a second interface of one
    /// name, which merges with the first.
    pub(super) fn interface_merging(&mut self, it: &TSInterfaceDeclaration<'a>) {
        let Some(symbol) = it.id.symbol_id.get() else {
            return;
        };
        if self.scoping.symbol_span(symbol) != it.id.span {
            self.report(
                "subset-syntax:ambient-declaration",
                it.id.span,
                format!("A second declaration of the interface `{}`", it.id.name),
            );
        }
    }

    /// `subset-type:non-regular-recursion`: a generic alias or interface
    /// that refers to itself with type arguments other than its own
    /// parameters, in order.
    pub(super) fn recursion(
        &mut self,
        symbol: Option<SymbolId>,
        parameters: Option<&TSTypeParameterDeclaration<'a>>,
        visit: impl FnOnce(&mut RecursionFinder<'_, 'a>),
    ) {
        let (Some(symbol), Some(parameters)) = (symbol, parameters) else {
            return;
        };
        let parameters: Vec<Option<SymbolId>> = parameters
            .params
            .iter()
            .map(|parameter| parameter.name.symbol_id.get())
            .collect();
        let mut finder = RecursionFinder {
            scoping: self.scoping,
            symbol,
            parameters,
            found: Vec::new(),
            marker: std::marker::PhantomData,
        };
        visit(&mut finder);
        for span in finder.found {
            self.report(
                "subset-type:non-regular-recursion",
                span,
                "A recursive reference that changes the declaration's type arguments",
            );
        }
    }
}

/// Finds the references to one generic declaration, inside its own body,
/// whose type arguments are not the declaration's parameters.
pub(super) struct RecursionFinder<'s, 'a> {
    scoping: &'s oxc_semantic::Scoping,
    symbol: SymbolId,
    parameters: Vec<Option<SymbolId>>,
    found: Vec<Span>,
    marker: std::marker::PhantomData<&'a ()>,
}

impl<'a> Visit<'a> for RecursionFinder<'_, 'a> {
    fn visit_ts_type_reference(&mut self, it: &TSTypeReference<'a>) {
        let own = matches!(&it.type_name, TSTypeName::IdentifierReference(name)
            if symbol_of(self.scoping, name) == Some(self.symbol));
        if own {
            let arguments: Vec<Option<SymbolId>> = it
                .type_arguments
                .iter()
                .flat_map(|arguments| &arguments.params)
                .map(|argument| match argument {
                    TSType::TSTypeReference(reference) if reference.type_arguments.is_none() => {
                        match &reference.type_name {
                            TSTypeName::IdentifierReference(name) => symbol_of(self.scoping, name),
                            _ => None,
                        }
                    }
                    _ => None,
                })
                .collect();
            if arguments != self.parameters {
                self.found.push(it.span);
            }
        }
        walk::walk_ts_type_reference(self, it);
    }
}
