//! The rules of the diagnostics catalog that need the type of an
//! expression and are not assignability at one of the three sites of
//! `crate::assign`: a property read the type does not allow, a cast, the
//! result type of a pattern, and inference at a generic call
//! (`language-subset.md` §7, §10.4).
//!
//! A rule is reported only where the types it reads are evaluated. A site
//! where one is not is counted as not decided.

use oxc_ast::ast::*;
use oxc_ast::AstKind;
use oxc_ast_visit::{walk, Visit};
use oxc_span::{GetSpan, Span};
use oxc_syntax::scope::ScopeFlags;
use oxc_syntax::symbol::SymbolId;

use crate::api::{ApiValue, Builder};
use crate::assign::Verdict;
use crate::module::{symbol_of, ModuleTier};
use crate::program::Resolver;
use crate::syntax::{unparen, FunctionLike};
use crate::types::{Shape, TypeId, Why};

/// The members every object has, which no object type declares.
const OBJECT_MEMBERS: &[&str] = &[
    "toString",
    "toLocaleString",
    "valueOf",
    "hasOwnProperty",
    "constructor",
];

impl<'a> Resolver<'_, 'a> {
    /// Applies the rules of this module to module `module`.
    pub fn check_typed_rules(&self, module: usize) {
        let (Some(parsed), Some(model)) = (self.parsed(module), self.model(module)) else {
            return;
        };
        if model.tier == ModuleTier::Imported {
            return;
        }
        let mut pass = TypedRules {
            resolver: self,
            module,
            functions: 0,
            written: Vec::new(),
        };
        pass.visit_program(parsed.program);
    }

    /// The annotation keys of a type that declare a label, at its root and
    /// at each property, as paths.
    fn label_paths(&self, ty: TypeId, depth: u32) -> Vec<String> {
        let mut paths: Vec<String> = self
            .types
            .borrow()
            .annotations(ty)
            .iter()
            .filter(|annotation| !matches!(annotation.key, "default" | "scope" | "label"))
            .map(|annotation| annotation.key.to_string())
            .collect();
        if depth < 3 {
            if let Shape::Object(properties, _) = self.shape(ty) {
                for property in properties {
                    for path in self.label_paths(property.ty, depth + 1) {
                        paths.push(format!("{}.{path}", property.name));
                    }
                }
            }
        }
        paths
    }
}

struct TypedRules<'r, 'm, 'a> {
    resolver: &'r Resolver<'m, 'a>,
    module: usize,
    /// The number of functions around the node visited.
    functions: usize,
    /// The member expressions that are written to and not read.
    written: Vec<Span>,
}

/// Whether a written type names the type parameter `symbol`.
struct Mentions<'s> {
    scoping: &'s oxc_semantic::Scoping,
    symbol: SymbolId,
    found: bool,
}

impl<'a> Visit<'a> for Mentions<'_> {
    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        if symbol_of(self.scoping, it) == Some(self.symbol) {
            self.found = true;
        }
    }
}

impl<'a> TypedRules<'_, '_, 'a> {
    fn report(&self, id: &'static str, span: Span, found: &str) {
        self.resolver.type_report(self.module, id, span, found);
    }

    fn count(&self, rule: &str, outcome: &str) {
        self.resolver
            .count(self.module, format!("types:rule:{rule}:{outcome}"));
    }

    /// `schema:unknown-type-access`, `schema:path-not-in-type`, and the
    /// possibly-absent receiver of `subset-type:mismatch`.
    fn member_read(&self, member: &StaticMemberExpression<'a>) {
        if self.functions == 0 || self.written.contains(&member.span) {
            return;
        }
        let resolver = self.resolver;
        let name = member.property.name.as_str();
        let Ok(object) = resolver.typed_at(self.module, &member.object, 0) else {
            self.count("property read", "not decided: the receiver has no type");
            return;
        };
        let text = |limit: usize| -> String {
            resolver
                .parsed(self.module)
                .map(|parsed| member.span.source_text(parsed.source))
                .unwrap_or_default()
                .chars()
                .take(limit)
                .collect()
        };
        let members = match resolver.shape(object) {
            Shape::Union(members) => members,
            _ => vec![object],
        };
        let shapes: Vec<Shape> = members
            .iter()
            .map(|member| resolver.shape(*member))
            .collect();
        let absent = shapes
            .iter()
            .any(|shape| matches!(shape, Shape::Null | Shape::Undefined));
        let present: Vec<&Shape> = shapes
            .iter()
            .filter(|shape| !matches!(shape, Shape::Null | Shape::Undefined))
            .collect();
        if present
            .iter()
            .any(|shape| matches!(shape, Shape::Unresolved(_)))
        {
            self.count(
                "property read",
                "not decided: the receiver's type is not evaluated",
            );
            return;
        }
        if absent && !member.optional && !present.is_empty() {
            // Whether the receiver may be absent only because a property
            // it is read from is optional (§7.6).
            let declared = resolver
                .with_optional_reads_declared(|| resolver.typed_at(self.module, &member.object, 0));
            let optional_alone =
                declared.is_ok_and(|declared| resolver.present(declared) == declared);
            let handle = present
                .iter()
                .all(|shape| matches!(shape, Shape::Handle(..)));
            let place = match resolver.place_at(self.module, member.span.start) {
                crate::program::Place::Reactive => "in the reactive tier",
                _ => "in a function body",
            };
            let (outcome, why) = match (optional_alone, handle) {
                (true, true) => (
                    "refused: the receiver is an optional property that holds a handle",
                    "it is read from an optional property",
                ),
                (true, false) => (
                    "refused: the receiver is an optional property",
                    "it is read from an optional property",
                ),
                (false, _) => (
                    "refused: the receiver's type names `null` or `undefined`",
                    "its type names it",
                ),
            };
            self.count("property read", &format!("{outcome}, {place}"));
            self.report(
                "subset-type:mismatch",
                member.object.span(),
                &format!(
                    "The receiver of `.{name}` may be `null` or `undefined`, because {why}: its type is {}. Use `?.` or `??`, or test it first",
                    resolver.display(object)
                ),
            );
            return;
        }
        if present
            .iter()
            .any(|shape| matches!(shape, Shape::Unknown | Shape::Parameter(_)))
        {
            // A data position, in every tier, and an unbound type
            // parameter (§7.8, §10.4). An ordinary value typed `unknown`
            // is narrowed before it is read.
            let parameter = present
                .iter()
                .any(|shape| matches!(shape, Shape::Parameter(_)));
            if parameter || resolver.is_data_expression(self.module, &member.object, 0) {
                self.count(
                    "property read",
                    "refused: the receiver is a data position typed `unknown`",
                );
                self.report(
                    "schema:unknown-type-access",
                    member.span,
                    &format!(
                        "`{}` reads a property of a data position typed `unknown`",
                        text(60)
                    ),
                );
            } else {
                self.count(
                    "property read",
                    "refused: the receiver is an ordinary value typed `unknown`",
                );
                self.report(
                    "subset-type:mismatch",
                    member.span,
                    &format!(
                        "`{}` reads a property of a value typed `unknown`. Narrow it first: `typeof`, `Array.isArray`, `instanceof`, or a type predicate",
                        text(60)
                    ),
                );
            }
            return;
        }
        let closed = !present.is_empty()
            && present
                .iter()
                .all(|shape| matches!(shape, Shape::Object(_, None) | Shape::NonPrimitive));
        let declared = present.iter().any(|shape| match shape {
            Shape::Object(properties, _) => properties.iter().any(|property| property.name == name),
            _ => false,
        });
        // `.for(cause)` on a pattern instantiation names the instance and
        // is not a property of its result.
        let names_instance = name == "for" && resolver.is_instance(self.module, &member.object, 0);
        if closed && !declared && !OBJECT_MEMBERS.contains(&name) && !names_instance {
            self.count(
                "property read",
                "refused: the type does not declare the property",
            );
            self.report(
                "schema:path-not-in-type",
                member.span,
                &format!(
                    "`{}` reads the property `{name}`, which the type {} does not declare",
                    text(60),
                    resolver.display(object)
                ),
            );
            return;
        }
        self.count("property read", "allowed");
    }

    /// `pattern:any-result-schema`, `pattern-result:unknown-type`, and
    /// `pattern-result:opaque-reserved-key`.
    fn pattern_result(&self, call: &CallExpression<'a>) {
        let resolver = self.resolver;
        let written = call
            .type_arguments
            .as_ref()
            .and_then(|arguments| arguments.params.get(1));
        let is_top = |ty: TypeId| {
            matches!(
                resolver.shape(ty),
                Shape::Unknown | Shape::Unresolved(Why::Any)
            )
        };
        if let Some(written) = written {
            let declared = resolver.resolve_type(self.module, written);
            if is_top(declared) {
                self.report(
                    "pattern:any-result-schema",
                    call.span,
                    "A pattern whose declared result is `any` or `unknown` at the top level",
                );
            }
            if let Shape::Object(properties, _) = resolver.shape(declared) {
                for property in properties {
                    if property.name.starts_with('[') && is_top(property.ty) {
                        self.report(
                            "pattern-result:opaque-reserved-key",
                            written.span(),
                            &format!(
                                "The declared result types the reserved key `{}` as `unknown`",
                                property.name
                            ),
                        );
                    }
                }
            }
            return;
        }
        let Some(callback) = call.arguments.iter().find_map(FunctionLike::of_argument) else {
            return;
        };
        let inferred = resolver.function_return(self.module, callback, None, 0);
        match inferred {
            Ok(result) if is_top(result) => {
                self.count("pattern result", "refused: `unknown` at the top level");
                self.report(
                    "pattern:any-result-schema",
                    call.span,
                    "A pattern whose inferred result is `any` or `unknown` at the top level",
                );
            }
            Ok(result) => match resolver.shape(result) {
                Shape::Object(properties, _) => {
                    let unknown: Vec<&str> = properties
                        .iter()
                        .filter(|property| is_top(property.ty))
                        .map(|property| property.name.as_str())
                        .collect();
                    if unknown.is_empty() {
                        self.count("pattern result", "inferred");
                    } else {
                        self.count("pattern result", "refused: a field typed `unknown`");
                        self.report(
                            "pattern-result:unknown-type",
                            call.span,
                            &format!(
                                "The inferred result has the field{} {} typed `unknown`",
                                if unknown.len() == 1 { "" } else { "s" },
                                unknown
                                    .iter()
                                    .map(|name| format!("`{name}`"))
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ),
                        );
                    }
                }
                Shape::Unresolved(_) | Shape::Parameter(_) => {
                    self.count("pattern result", "not decided: the result is not evaluated");
                }
                _ => self.count("pattern result", "inferred"),
            },
            Err(_) => self.count("pattern result", "not decided: the result has no type"),
        }
    }

    /// `subset-type:cannot-infer-type-argument`.
    fn type_arguments(&self, call: &CallExpression<'a>) {
        let resolver = self.resolver;
        let Some(parsed) = resolver.parsed(self.module) else {
            return;
        };
        let Expression::Identifier(callee) = unparen(&call.callee) else {
            return;
        };
        let Some((home, symbol)) = symbol_of(parsed.semantic.scoping(), callee)
            .and_then(|symbol| resolver.origin(self.module, symbol))
        else {
            return;
        };
        let Some(parsed) = resolver.parsed(home) else {
            return;
        };
        let scoping = parsed.semantic.scoping();
        let function = match parsed
            .semantic
            .nodes()
            .kind(scoping.symbol_declaration(symbol))
        {
            AstKind::Function(function) => FunctionLike::Function(function),
            AstKind::VariableDeclarator(declarator) => {
                match declarator.init.as_ref().and_then(FunctionLike::of) {
                    Some(function) => function,
                    None => return,
                }
            }
            _ => return,
        };
        let type_parameters = match function {
            FunctionLike::Arrow(arrow) => arrow.type_parameters.as_deref(),
            FunctionLike::Function(function) => function.type_parameters.as_deref(),
        };
        let Some(type_parameters) = type_parameters else {
            return;
        };
        let written = call
            .type_arguments
            .as_ref()
            .map_or(0, |arguments| arguments.params.len());
        let bound = resolver.bind_type_parameters(
            home,
            function,
            Some(type_parameters),
            Some((self.module, call)),
            0,
        );
        for (index, parameter) in type_parameters.params.iter().enumerate() {
            if index < written || parameter.default.is_some() {
                continue;
            }
            let Some(symbol) = parameter.name.symbol_id.get() else {
                continue;
            };
            if bound.iter().any(|(found, _)| *found == symbol) {
                self.count("type argument", "inferred");
                continue;
            }
            // A type parameter that no parameter given an argument names
            // is determined by nothing.
            let named = function
                .params()
                .items
                .iter()
                .take(call.arguments.len())
                .filter_map(|formal| formal.type_annotation.as_ref())
                .any(|annotation| {
                    let mut mentions = Mentions {
                        scoping,
                        symbol,
                        found: false,
                    };
                    mentions.visit_ts_type(&annotation.type_annotation);
                    mentions.found
                });
            if named {
                self.count(
                    "type argument",
                    "not decided: an argument names the parameter in a form this slice does not unify",
                );
            } else {
                self.count("type argument", "refused: nothing determines it");
                self.report(
                    "subset-type:cannot-infer-type-argument",
                    call.span,
                    &format!(
                        "No argument determines the type parameter `{}`, and it has no default",
                        parameter.name.name
                    ),
                );
            }
        }
    }

    /// `module-scope:runtime-call` for a callee that only its type shows
    /// to be a factory (§3.2): a call at module scope of a value whose type
    /// is a pattern factory or a handler factory instantiates a pattern or
    /// binds a handler.
    fn module_scope_call(&self, call: &CallExpression<'a>) {
        if self.functions > 0 {
            return;
        }
        let resolver = self.resolver;
        // A callee that names a definition is reported by the walk of
        // `crate::check`.
        if let Expression::Identifier(name) = unparen(&call.callee) {
            use crate::module::DefKind;
            if matches!(
                resolver.value_def(self.module, name),
                Some(DefKind::Pattern | DefKind::Handler | DefKind::Lift | DefKind::Function)
            ) {
                return;
            }
        }
        if matches!(unparen(&call.callee), Expression::CallExpression(_)) {
            return;
        }
        let Ok(callee) = resolver.typed_at(self.module, &call.callee, 0) else {
            return;
        };
        let what = match resolver.shape(resolver.present(callee)) {
            Shape::PatternFactory(..) => "instantiates a pattern",
            Shape::HandlerFactory(..) => "binds a handler",
            _ => return,
        };
        self.report(
            "module-scope:runtime-call",
            call.span,
            &format!("A call at module scope that {what}: the callee has a factory type"),
        );
    }

    /// `cfc-policy-authoring`, the part `language-subset.md` §4.4.4 states:
    /// `exchangeRule` and `exchangeRules` are called in the initializer of
    /// an exported module-scope constant and nowhere else.
    fn rule_declaration(&self, call: &CallExpression<'a>) {
        let resolver = self.resolver;
        let (Some(parsed), Some(model)) =
            (resolver.parsed(self.module), resolver.model(self.module))
        else {
            return;
        };
        let scoping = parsed.semantic.scoping();
        let is_rule = model
            .api_ref_of_callee(scoping, &call.callee)
            .is_some_and(|api| matches!(api.name.as_str(), "exchangeRule" | "exchangeRules"));
        if !is_rule {
            return;
        }
        let nodes = parsed.semantic.nodes();
        let mut in_function = false;
        let mut exported = false;
        for kind in nodes.ancestor_kinds(call.node_id.get()) {
            match kind {
                AstKind::Function(_) | AstKind::ArrowFunctionExpression(_) => in_function = true,
                AstKind::VariableDeclarator(declarator) => {
                    let symbol = match &declarator.id {
                        BindingPattern::BindingIdentifier(name) => name.symbol_id.get(),
                        _ => None,
                    };
                    exported = declarator.kind == VariableDeclarationKind::Const
                        && model.defs.iter().any(|def| {
                            def.exported && def.symbol.is_some() && def.symbol == symbol
                        });
                }
                _ => {}
            }
        }
        if in_function || !exported {
            self.report(
                "cfc-policy-authoring",
                call.span,
                "A rule declaration outside the initializer of an exported module-scope constant",
            );
        }
    }

    /// `cast-validation:double-unknown` and `cfc-label:cast-ignored`.
    fn cast(&self, cast: &TSAsExpression<'a>) {
        let resolver = self.resolver;
        let is_const = matches!(&cast.type_annotation, TSType::TSTypeReference(reference)
            if matches!(&reference.type_name, TSTypeName::IdentifierReference(name) if name.name == "const"));
        if is_const
            || matches!(
                cast.type_annotation,
                TSType::TSUnknownKeyword(_) | TSType::TSAnyKeyword(_)
            )
        {
            return;
        }
        let target = resolver.resolve_type(self.module, &cast.type_annotation);
        if let Expression::TSAsExpression(inner) = unparen(&cast.expression) {
            if matches!(inner.type_annotation, TSType::TSUnknownKeyword(_)) {
                let verdict = match resolver.typed_at(self.module, &inner.expression, 0) {
                    Ok(operand) => match (
                        resolver.relate(operand, target, 0),
                        resolver.relate(target, operand, 0),
                    ) {
                        (Verdict::No(..), Verdict::No(..)) => Some(operand),
                        (Verdict::Yes, _) | (_, Verdict::Yes) => {
                            self.count("cast through `unknown`", "related");
                            None
                        }
                        _ => {
                            self.count("cast through `unknown`", "not decided");
                            None
                        }
                    },
                    Err(_) => {
                        self.count("cast through `unknown`", "not decided");
                        None
                    }
                };
                if let Some(operand) = verdict {
                    self.count("cast through `unknown`", "refused: unrelated");
                    self.report(
                        "cast-validation:double-unknown",
                        cast.span,
                        &format!(
                            "A cast through `unknown` from {} to the unrelated type {}",
                            resolver.display(operand),
                            resolver.display(target)
                        ),
                    );
                }
                return;
            }
        }
        let wanted = resolver.label_paths(target, 0);
        if wanted.is_empty() {
            return;
        }
        let Ok(operand) = resolver.typed_at(self.module, &cast.expression, 0) else {
            self.count("cast to a labeled type", "not decided");
            return;
        };
        let carried = resolver.label_paths(operand, 0);
        let added: Vec<&String> = wanted
            .iter()
            .filter(|path| !carried.contains(path))
            .collect();
        if added.is_empty() {
            self.count("cast to a labeled type", "the operand carries the labels");
        } else {
            self.count("cast to a labeled type", "reported");
            self.report(
                "cfc-label:cast-ignored",
                cast.span,
                &format!(
                    "A cast whose target type carries the annotation{} {} and whose operand's type does not",
                    if added.len() == 1 { "" } else { "s" },
                    added
                        .iter()
                        .map(|path| format!("`{path}`"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            );
        }
    }
}

impl<'a> Visit<'a> for TypedRules<'_, '_, 'a> {
    fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
        self.functions += 1;
        walk::walk_function(self, it, flags);
        self.functions -= 1;
    }

    fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
        self.functions += 1;
        walk::walk_arrow_function_expression(self, it);
        self.functions -= 1;
    }

    fn visit_assignment_expression(&mut self, it: &AssignmentExpression<'a>) {
        if let AssignmentTarget::StaticMemberExpression(member) = &it.left {
            self.written.push(member.span);
        }
        walk::walk_assignment_expression(self, it);
    }

    fn visit_static_member_expression(&mut self, it: &StaticMemberExpression<'a>) {
        self.member_read(it);
        walk::walk_static_member_expression(self, it);
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
        if builder == Some(ApiValue::Builder(Builder::Pattern)) {
            self.pattern_result(it);
        }
        self.rule_declaration(it);
        self.module_scope_call(it);
        self.type_arguments(it);
        walk::walk_call_expression(self, it);
    }

    fn visit_ts_as_expression(&mut self, it: &TSAsExpression<'a>) {
        self.cast(it);
        walk::walk_ts_as_expression(self, it);
    }
}
