//! Assignability (`language-subset.md` §7.5), and the three sites this
//! slice applies it at: an argument against its parameter, a returned value
//! against a written return type, and an initializer against an annotation.
//!
//! The relation is structural and ignores annotations, which the shape of a
//! type never holds (§8.6). It has three outcomes. Where a part of either
//! type is not evaluated the outcome is [`Verdict::Unsure`], which is
//! counted and never reported.

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_span::{GetSpan, Span};
use oxc_syntax::scope::ScopeFlags;

use crate::module::ModuleTier;
use crate::program::Resolver;
use crate::syntax::{unparen, unwrap, FunctionLike};
use crate::types::{HandleKind, Shape, TypeId};

/// Why a value is not assignable, as the measurement groups the refusals.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// A value that is not a handle where a handle type is declared.
    ValueForCell,
    /// A handle where a type that is not a handle type is declared.
    CellForValue,
    /// A handle of another kind, or a writable handle of another type.
    Handle,
    /// A handle of some type where a writable handle of `unknown` is
    /// declared.
    HandleOfUnknown,
    /// A read-only array, tuple, container, or property where a mutable
    /// one is declared.
    ReadOnly,
    MissingProperty,
    ExcessProperty,
    /// `null` or `undefined` where the declared type has neither.
    Absent,
    ArgumentCount,
    /// A primitive type where literal types of it are declared.
    Widened,
    Other,
}

impl Class {
    pub fn label(self) -> &'static str {
        match self {
            Class::ValueForCell => "a value where a cell is declared",
            Class::CellForValue => "a cell where a value is declared",
            Class::Handle => "a handle of another kind or of another value type",
            Class::HandleOfUnknown => "a cell of a known type where `Cell<unknown>` is declared",
            Class::ReadOnly => "read-only where mutable is declared",
            Class::MissingProperty => "a missing property",
            Class::ExcessProperty => "a property the type does not declare",
            Class::Absent => "`null` or `undefined` where the type has neither",
            Class::ArgumentCount => "a wrong argument count",
            Class::Widened => "a primitive type where its literal types are declared",
            Class::Other => "another difference",
        }
    }
}

/// The outcome of one assignability question.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Yes,
    No(Class, String),
    /// A part of one of the types is not evaluated.
    Unsure,
}

impl Verdict {
    fn and(self, next: impl FnOnce() -> Verdict) -> Verdict {
        match self {
            Verdict::No(..) => self,
            Verdict::Unsure => match next() {
                no @ Verdict::No(..) => no,
                _ => Verdict::Unsure,
            },
            Verdict::Yes => next(),
        }
    }
}

fn all(verdicts: impl IntoIterator<Item = Verdict>) -> Verdict {
    let mut unsure = false;
    for verdict in verdicts {
        match verdict {
            Verdict::No(..) => return verdict,
            Verdict::Unsure => unsure = true,
            Verdict::Yes => {}
        }
    }
    if unsure {
        Verdict::Unsure
    } else {
        Verdict::Yes
    }
}

fn literal_kind(text: &str) -> Shape {
    if text.starts_with(['"', '\'', '`']) {
        Shape::String
    } else if text == "true" || text == "false" {
        Shape::Boolean
    } else if text.ends_with('n') {
        Shape::BigInt
    } else {
        Shape::Number
    }
}

fn same_literal(left: &str, right: &str) -> bool {
    let quoted = |text: &str| text.starts_with(['"', '\'', '`']) && text.len() >= 2;
    if quoted(left) && quoted(right) {
        left[1..left.len() - 1] == right[1..right.len() - 1]
    } else {
        left == right
    }
}

const MAX_DEPTH: u32 = 12;

impl<'a> Resolver<'_, 'a> {
    /// Whether a value of type `from` is assignable to a position of type
    /// `to`. `None` where a part of either type is not evaluated.
    pub fn assignable(&self, from: TypeId, to: TypeId) -> Option<bool> {
        match self.relate(from, to, 0) {
            Verdict::Yes => Some(true),
            Verdict::No(..) => Some(false),
            Verdict::Unsure => None,
        }
    }

    /// The members of a type other than `null` and `undefined`.
    fn present_members(&self, ty: TypeId) -> Vec<Shape> {
        match self.shape(ty) {
            Shape::Union(members) => members
                .into_iter()
                .map(|member| self.shape(member))
                .filter(|member| !matches!(member, Shape::Null | Shape::Undefined))
                .collect(),
            Shape::Null | Shape::Undefined => Vec::new(),
            shape => vec![shape],
        }
    }

    fn mismatch(&self, class: Class, from: TypeId, to: TypeId, why: &str) -> Verdict {
        // A handle on one side only is the difference that matters most,
        // whatever member of a union the refusal was found at.
        let is_handle = |shape: &Shape| matches!(shape, Shape::Handle(..));
        let (source, target) = (self.present_members(from), self.present_members(to));
        let (class, why) = if source.is_empty() || target.is_empty() {
            (class, why)
        } else if source.iter().all(is_handle) && !target.iter().any(is_handle) {
            (Class::CellForValue, "a cell where a value is declared")
        } else if target.iter().all(is_handle) && !source.iter().any(is_handle) {
            (Class::ValueForCell, "a value where a cell is declared")
        } else if !source.is_empty()
            && source
                .iter()
                .all(|shape| matches!(shape, Shape::String | Shape::Number | Shape::BigInt))
            && target
                .iter()
                .all(|shape| matches!(shape, Shape::Literal(_)))
        {
            (
                Class::Widened,
                "a primitive type where its literal types are declared",
            )
        } else {
            (class, why)
        };
        let mut text = format!(
            "expected {}, found {}",
            self.display(to),
            self.display(from)
        );
        if !why.is_empty() {
            text.push_str(": ");
            text.push_str(why);
        }
        Verdict::No(class, text)
    }

    /// `ty | undefined`.
    fn or_undefined(&self, ty: TypeId) -> TypeId {
        self.union_of(vec![ty, self.intern(Shape::Undefined)])
    }

    /// `ty` without an `undefined` member.
    fn defined(&self, ty: TypeId) -> TypeId {
        match self.shape(ty) {
            Shape::Union(members) => {
                let kept = members
                    .into_iter()
                    .filter(|member| self.shape(*member) != Shape::Undefined)
                    .collect();
                self.union_of(kept)
            }
            _ => ty,
        }
    }

    /// The assignability of `from` to `to` (§7.5).
    pub fn relate(&self, from: TypeId, to: TypeId, depth: u32) -> Verdict {
        if depth > MAX_DEPTH {
            return Verdict::Unsure;
        }
        let next = depth + 1;
        let (source, target) = (self.shape(from), self.shape(to));
        match (&source, &target) {
            (Shape::Parameter(a), Shape::Parameter(b)) if a == b => return Verdict::Yes,
            (Shape::Unresolved(_) | Shape::Parameter(_), _)
            | (_, Shape::Unresolved(_) | Shape::Parameter(_)) => return Verdict::Unsure,
            (_, Shape::Unknown) | (Shape::Never, _) => return Verdict::Yes,
            _ => {}
        }
        if let Shape::Union(members) = &source {
            return match all(members.iter().map(|member| self.relate(*member, to, next))) {
                Verdict::No(class, _) => self.mismatch(class, from, to, class.label()),
                other => other,
            };
        }
        if let Shape::Union(members) = &target {
            if source == Shape::Boolean {
                // `boolean` is `true | false`.
                let both = ["true", "false"].map(|text| {
                    self.relate(self.intern(Shape::Literal(text.to_string())), to, next)
                });
                if all(both) == Verdict::Yes {
                    return Verdict::Yes;
                }
            }
            let mut unsure = false;
            let mut refusal = None;
            for member in members {
                match self.relate(from, *member, next) {
                    Verdict::Yes => return Verdict::Yes,
                    Verdict::Unsure => unsure = true,
                    Verdict::No(class, _) => {
                        // The refusal that says most is the one against the
                        // member of the same kind as the value.
                        let same_kind = std::mem::discriminant(&self.shape(*member))
                            == std::mem::discriminant(&source);
                        if refusal.is_none() || same_kind {
                            refusal = Some(class);
                        }
                    }
                }
            }
            if unsure {
                return Verdict::Unsure;
            }
            let class = match (&source, refusal) {
                (Shape::Null | Shape::Undefined, _) => Class::Absent,
                (_, Some(class)) => class,
                (_, None) => Class::Other,
            };
            return self.mismatch(class, from, to, class.label());
        }
        match (&source, &target) {
            (Shape::Literal(a), Shape::Literal(b)) if same_literal(a, b) => Verdict::Yes,
            (Shape::Literal(text), primitive) if literal_kind(text) == *primitive => Verdict::Yes,
            (Shape::String, Shape::String)
            | (Shape::Number, Shape::Number)
            | (Shape::Boolean, Shape::Boolean)
            | (Shape::BigInt, Shape::BigInt)
            | (Shape::Null, Shape::Null)
            | (Shape::Undefined, Shape::Undefined | Shape::Void)
            | (Shape::Void, Shape::Void) => Verdict::Yes,
            (Shape::Null | Shape::Undefined, _) if !matches!(target, Shape::Handle(..)) => {
                self.mismatch(Class::Absent, from, to, "")
            }
            (Shape::Handle(source_kind, value), Shape::Handle(target_kind, wanted)) => {
                self.relate_handles(from, to, *source_kind, *value, *target_kind, *wanted, next)
            }
            (Shape::Handle(..), _) => self.mismatch(
                Class::CellForValue,
                from,
                to,
                "a cell where a value is declared",
            ),
            (_, Shape::Handle(..)) => self.mismatch(
                Class::ValueForCell,
                from,
                to,
                "a value where a cell is declared",
            ),
            (Shape::Object(properties, index), Shape::Object(wanted, wanted_index)) => {
                let mut verdicts = Vec::new();
                for want in wanted {
                    let Some(have) = properties.iter().find(|have| have.name == want.name) else {
                        // A value with a part whose properties are not
                        // known may have the property.
                        if index.is_some_and(|index| {
                            matches!(
                                self.shape(index),
                                Shape::Unresolved(_) | Shape::Parameter(_)
                            )
                        }) {
                            verdicts.push(Verdict::Unsure);
                            continue;
                        }
                        if !want.optional {
                            return self.mismatch(
                                Class::MissingProperty,
                                from,
                                to,
                                &format!("the property `{}` is missing", want.name),
                            );
                        }
                        continue;
                    };
                    if have.optional && !want.optional {
                        return self.mismatch(
                            Class::MissingProperty,
                            from,
                            to,
                            &format!(
                                "the property `{}` is optional in the value and required in the type",
                                want.name
                            ),
                        );
                    }
                    if have.readonly && !want.readonly {
                        return self.mismatch(
                            Class::ReadOnly,
                            from,
                            to,
                            &format!(
                                "the property `{}` is read-only in the value and mutable in the type",
                                want.name
                            ),
                        );
                    }
                    let have_type = if want.optional {
                        self.defined(have.ty)
                    } else {
                        have.ty
                    };
                    verdicts.push(self.relate(have_type, want.ty, next));
                }
                if let Some(wanted_index) = wanted_index {
                    for have in properties {
                        verdicts.push(self.relate(have.ty, *wanted_index, next));
                    }
                    if let Some(index) = index {
                        verdicts.push(self.relate(*index, *wanted_index, next));
                    }
                }
                all(verdicts)
            }
            (Shape::Array(element), Shape::Array(wanted)) => self
                .mutable_enough(from, to, "array")
                .and(|| self.relate(*element, *wanted, next)),
            (Shape::Tuple(elements), Shape::Array(wanted)) => {
                self.mutable_enough(from, to, "array").and(|| {
                    all(elements
                        .iter()
                        .map(|element| self.relate(*element, *wanted, next)))
                })
            }
            (Shape::Tuple(elements), Shape::Tuple(wanted)) => {
                self.mutable_enough(from, to, "tuple").and(|| {
                    if elements.len() > wanted.len() {
                        return self.mismatch(Class::Other, from, to, "the tuple is longer");
                    }
                    let pairs = all(elements
                        .iter()
                        .zip(wanted)
                        .map(|(element, wanted)| self.relate(*element, *wanted, next)));
                    // Whether a trailing element is optional is not kept.
                    if elements.len() < wanted.len() {
                        pairs.and(|| Verdict::Unsure)
                    } else {
                        pairs
                    }
                })
            }
            (Shape::Function, Shape::Function) => {
                let (have, want) = (self.signature(from), self.signature(to));
                let parameters = match (&have.parameters, &want.parameters) {
                    (Some(have), Some(want)) => {
                        let required = have.iter().filter(|parameter| !parameter.optional).count();
                        if required > want.len() {
                            return self.mismatch(
                                Class::Other,
                                from,
                                to,
                                "the function takes more parameters",
                            );
                        }
                        // Parameters are assignable in reverse.
                        all(have
                            .iter()
                            .zip(want)
                            .map(|(have, want)| self.relate(want.ty, have.ty, next)))
                    }
                    _ => Verdict::Unsure,
                };
                parameters.and(|| match (have.result, want.result) {
                    (_, Some(wanted)) if self.shape(wanted) == Shape::Void => Verdict::Yes,
                    (Some(result), Some(wanted)) => self.relate(result, wanted, next),
                    _ => Verdict::Unsure,
                })
            }
            (
                Shape::PatternFactory(input, output),
                Shape::PatternFactory(wanted_in, wanted_out),
            ) => self
                .relate(*wanted_in, *input, next)
                .and(|| self.relate(*output, *wanted_out, next)),
            (
                Shape::HandlerFactory(event, state),
                Shape::HandlerFactory(wanted_event, wanted_state),
            ) => self
                .relate(*wanted_event, *event, next)
                .and(|| self.relate(*wanted_state, *state, next)),
            (Shape::Code(name), Shape::Code(wanted)) => {
                let arguments = || {
                    let (have, want) = (self.code_arguments(from), self.code_arguments(to));
                    if have.len() != want.len() {
                        return Verdict::Unsure;
                    }
                    all(have
                        .iter()
                        .zip(&want)
                        .map(|(have, want)| self.relate(*have, *want, next)))
                };
                match (name.as_str(), wanted.as_str()) {
                    (a, b) if a == b => arguments(),
                    ("Map", "ReadonlyMap") | ("Set", "ReadonlySet") => arguments(),
                    ("ReadonlyMap", "Map") | ("ReadonlySet", "Set") => self.mismatch(
                        Class::ReadOnly,
                        from,
                        to,
                        "a read-only container where a mutable one is declared",
                    ),
                    (a, "Error") if a.ends_with("Error") => Verdict::Yes,
                    ("Set" | "ReadonlySet" | "Map" | "ReadonlyMap", "Iterable") => Verdict::Unsure,
                    _ => self.mismatch(Class::Other, from, to, ""),
                }
            }
            (Shape::Array(element), Shape::Code(wanted)) if wanted == "Iterable" => {
                match self.code_arguments(to).first() {
                    Some(wanted) => self.relate(*element, *wanted, next),
                    None => Verdict::Unsure,
                }
            }
            (Shape::Opaque(name), Shape::Opaque(wanted)) if name == wanted => Verdict::Yes,
            // The structure of an opaque API type is not part of the
            // language (§7.2), so nothing is decided against one.
            (Shape::Opaque(_), _) | (_, Shape::Opaque(_)) => Verdict::Unsure,
            // The members of a standard-library object, and whether a
            // factory is callable as a function type, are not modelled.
            (Shape::Code(_), Shape::Object(..))
            | (Shape::PatternFactory(..) | Shape::HandlerFactory(..), Shape::Function)
            | (Shape::Void, _) => Verdict::Unsure,
            (_, Shape::Object(wanted, None))
                if wanted.is_empty() && !matches!(source, Shape::Null | Shape::Undefined) =>
            {
                Verdict::Yes
            }
            _ => self.mismatch(Class::Other, from, to, ""),
        }
    }

    /// A read-only array or tuple is not assignable to a mutable one.
    fn mutable_enough(&self, from: TypeId, to: TypeId, what: &str) -> Verdict {
        if self.is_read_only(from) && !self.is_read_only(to) {
            return self.mismatch(
                Class::ReadOnly,
                from,
                to,
                &format!("a read-only {what} where a mutable one is declared"),
            );
        }
        Verdict::Yes
    }

    #[allow(clippy::too_many_arguments)]
    fn relate_handles(
        &self,
        from: TypeId,
        to: TypeId,
        source_kind: HandleKind,
        value: TypeId,
        target_kind: HandleKind,
        wanted: TypeId,
        depth: u32,
    ) -> Verdict {
        let narrower = source_kind == HandleKind::Cell
            && matches!(
                target_kind,
                HandleKind::ReadonlyCell
                    | HandleKind::WriteonlyCell
                    | HandleKind::ComparableCell
                    | HandleKind::OpaqueCell
            );
        if source_kind != target_kind && !narrower {
            return self.mismatch(
                Class::Handle,
                from,
                to,
                &format!("a {source_kind:?} where a {target_kind:?} is declared"),
            );
        }
        let forward = self.relate(value, wanted, depth);
        if target_kind == HandleKind::ReadonlyCell || target_kind == HandleKind::Sqlite {
            return forward;
        }
        // A handle that can write holds the same type, up to annotations.
        let same = forward.and(|| self.relate(wanted, value, depth));
        match same {
            Verdict::No(..) => self.mismatch(
                if self.shape(wanted) == Shape::Unknown {
                    Class::HandleOfUnknown
                } else {
                    Class::Handle
                },
                from,
                to,
                "a cell that can be written has to hold the same type",
            ),
            other => other,
        }
    }

    /// Whether `expression` is an instantiation of a pattern, or a `const`
    /// bound to one (§7.5).
    fn is_instance(&self, module: usize, expression: &Expression<'a>, depth: u32) -> bool {
        if depth > 3 {
            return false;
        }
        match unwrap(expression) {
            Expression::CallExpression(call) => {
                self.typed_at(module, &call.callee, 0).is_ok_and(|callee| {
                    matches!(self.shape(self.present(callee)), Shape::PatternFactory(..))
                })
            }
            Expression::Identifier(identifier) => {
                let Some(parsed) = self.parsed(module) else {
                    return false;
                };
                let scoping = parsed.semantic.scoping();
                let Some(symbol) = crate::module::symbol_of(scoping, identifier) else {
                    return false;
                };
                match parsed
                    .semantic
                    .nodes()
                    .kind(scoping.symbol_declaration(symbol))
                {
                    oxc_ast::AstKind::VariableDeclarator(declarator)
                        if declarator.kind == VariableDeclarationKind::Const
                            && matches!(declarator.id, BindingPattern::BindingIdentifier(_)) =>
                    {
                        declarator
                            .init
                            .as_ref()
                            .is_some_and(|init| self.is_instance(module, init, depth + 1))
                    }
                    _ => false,
                }
            }
            _ => false,
        }
    }

    /// Whether the value of `expression` is assignable to `to`. A literal
    /// is checked part by part against the type expected at its position,
    /// so that a literal keeps its literal type there, and an object
    /// literal may not have a property the type does not declare (§7.5).
    pub fn check_against(&self, module: usize, expression: &Expression<'a>, to: TypeId) -> Verdict {
        let expression = unparen(expression);
        let target = self.shape(to);
        // A type that is `never` was refused where it was written, and
        // nothing more is decided against it.
        if matches!(
            target,
            Shape::Unresolved(_) | Shape::Parameter(_) | Shape::Never
        ) {
            return Verdict::Unsure;
        }
        if target == Shape::Unknown {
            return Verdict::Yes;
        }
        match expression {
            Expression::ConditionalExpression(conditional) => {
                return self
                    .check_against(module, &conditional.consequent, to)
                    .and(|| self.check_against(module, &conditional.alternate, to));
            }
            Expression::TSSatisfiesExpression(inner) => {
                return self.check_against(module, &inner.expression, to);
            }
            Expression::ObjectExpression(object) => {
                if let Some(verdict) = self.object_against(module, object, to) {
                    return verdict;
                }
            }
            Expression::ArrayExpression(array) => {
                if let Some(verdict) = self.array_against(module, array, to) {
                    return verdict;
                }
            }
            _ => {}
        }
        let Ok(from) = self.typed_at(module, expression, 0) else {
            return Verdict::Unsure;
        };
        let verdict = self.relate(from, to, 0);
        if matches!(verdict, Verdict::No(..)) && self.is_instance(module, expression, 0) {
            // The value a pattern instantiation returns is assignable to a
            // cell of a type its result type is assignable to.
            let members = match &target {
                Shape::Union(members) => members.clone(),
                _ => vec![to],
            };
            for member in members {
                if let Shape::Handle(_, value) = self.shape(member) {
                    match self.relate(from, value, 0) {
                        Verdict::No(..) => {}
                        other => return other,
                    }
                }
            }
        }
        verdict
    }

    /// An object literal against the object types among `to`. `None` where
    /// `to` has no object type, so that the literal is checked by its type.
    fn object_against(
        &self,
        module: usize,
        object: &ObjectExpression<'a>,
        to: TypeId,
    ) -> Option<Verdict> {
        let candidates: Vec<TypeId> = match self.shape(to) {
            Shape::Object(..) => vec![to],
            Shape::Union(members) => members
                .into_iter()
                .filter(|member| matches!(self.shape(*member), Shape::Object(..)))
                .collect(),
            _ => return None,
        };
        let mut refusal = None;
        let mut unsure = false;
        for candidate in candidates {
            match self.object_against_one(module, object, candidate) {
                Verdict::Yes => return Some(Verdict::Yes),
                Verdict::Unsure => unsure = true,
                no @ Verdict::No(..) => {
                    refusal.get_or_insert(no);
                }
            }
        }
        if unsure {
            return Some(Verdict::Unsure);
        }
        refusal
    }

    fn object_against_one(
        &self,
        module: usize,
        object: &ObjectExpression<'a>,
        to: TypeId,
    ) -> Verdict {
        let Shape::Object(wanted, index) = self.shape(to) else {
            return Verdict::Unsure;
        };
        let mut written: Vec<&str> = Vec::new();
        // Whether the literal has a part whose property names are not
        // known: a spread or a computed key.
        let mut open = false;
        let mut verdicts = Vec::new();
        for property in &object.properties {
            let ObjectPropertyKind::ObjectProperty(property) = property else {
                open = true;
                continue;
            };
            let name = match crate::syntax::static_key_name(&property.key) {
                Some(name) if !property.computed => name,
                _ => {
                    open = true;
                    continue;
                }
            };
            written.push(name);
            let declared = wanted.iter().find(|want| want.name == name);
            match (declared, index) {
                (Some(want), _) => {
                    // An optional property takes `undefined` too.
                    let expected = if want.optional {
                        self.or_undefined(want.ty)
                    } else {
                        want.ty
                    };
                    verdicts.push(self.check_against(module, &property.value, expected));
                }
                (None, Some(index)) => {
                    verdicts.push(self.check_against(module, &property.value, index));
                }
                (None, None) => {
                    return Verdict::No(
                        Class::ExcessProperty,
                        format!(
                            "expected {}: the object literal has the property `{name}`, which the type does not declare",
                            self.display(to)
                        ),
                    );
                }
            }
        }
        if !open {
            if let Some(missing) = wanted
                .iter()
                .find(|want| !want.optional && !written.contains(&want.name.as_str()))
            {
                return Verdict::No(
                    Class::MissingProperty,
                    format!(
                        "expected {}: the property `{}` is missing",
                        self.display(to),
                        missing.name
                    ),
                );
            }
        }
        all(verdicts)
    }

    fn array_against(
        &self,
        module: usize,
        array: &ArrayExpression<'a>,
        to: TypeId,
    ) -> Option<Verdict> {
        let candidates: Vec<TypeId> = match self.shape(to) {
            Shape::Array(_) | Shape::Tuple(_) => vec![to],
            Shape::Union(members) => members
                .into_iter()
                .filter(|member| matches!(self.shape(*member), Shape::Array(_) | Shape::Tuple(_)))
                .collect(),
            _ => return None,
        };
        let [candidate] = candidates.as_slice() else {
            return None;
        };
        let wanted = |position: usize| match self.shape(*candidate) {
            Shape::Array(element) => Some(element),
            Shape::Tuple(elements) => elements.get(position).copied(),
            _ => None,
        };
        let mut verdicts = Vec::new();
        for (position, element) in array.elements.iter().enumerate() {
            match element {
                ArrayExpressionElement::SpreadElement(spread) => {
                    let Shape::Array(wanted) = self.shape(*candidate) else {
                        return None;
                    };
                    verdicts.push(
                        match self
                            .typed_at(module, &spread.argument, 0)
                            .ok()
                            .and_then(|spread| self.element_of(spread))
                        {
                            Some(element) => self.relate(element, wanted, 0),
                            None => Verdict::Unsure,
                        },
                    );
                }
                ArrayExpressionElement::Elision(_) => {}
                other => match wanted(position) {
                    Some(wanted) => {
                        verdicts.push(self.check_against(module, other.to_expression(), wanted));
                    }
                    None => {
                        return Some(Verdict::No(
                            Class::Other,
                            format!(
                                "expected {}: the array literal is longer",
                                self.display(*candidate)
                            ),
                        ));
                    }
                },
            }
        }
        Some(all(verdicts))
    }

    /// Checks every assignment site of module `module` and reports the
    /// values that are not assignable (`subset-type:mismatch`).
    pub fn check_assignments(&self, module: usize) {
        let (Some(parsed), Some(model)) = (self.parsed(module), self.model(module)) else {
            return;
        };
        if model.tier == ModuleTier::Imported {
            return;
        }
        let mut pass = Assignments {
            resolver: self,
            module,
            returns: Vec::new(),
        };
        pass.visit_program(parsed.program);
    }

    fn record(&self, module: usize, site: &'static str, span: Span, verdict: Verdict) {
        let outcome = match &verdict {
            Verdict::Yes => "assignable".to_string(),
            Verdict::Unsure => "not decided".to_string(),
            Verdict::No(class, _) => format!("refused: {}", class.label()),
        };
        self.count(module, format!("types:assignability:{site}:{outcome}"));
        if let Verdict::No(_, found) = verdict {
            self.type_report(
                module,
                "subset-type:mismatch",
                span,
                &format!("The {site} is not assignable: {found}"),
            );
        }
    }
}

/// The walk that checks the assignment sites of a module.
struct Assignments<'r, 'm, 'a> {
    resolver: &'r Resolver<'m, 'a>,
    module: usize,
    /// The written return type of each enclosing function, innermost last.
    returns: Vec<Option<TypeId>>,
}

impl<'a> Assignments<'_, '_, 'a> {
    fn function(&mut self, function: FunctionLike<'_, 'a>) -> Option<TypeId> {
        let annotation = match function {
            FunctionLike::Arrow(arrow) => arrow.return_type.as_deref(),
            FunctionLike::Function(function) => function.return_type.as_deref(),
        }?;
        if function.is_async() || function.is_generator() {
            return None;
        }
        match &annotation.type_annotation {
            TSType::TSTypePredicate(_) | TSType::TSVoidKeyword(_) => None,
            written => Some(self.resolver.resolve_type(self.module, written)),
        }
    }

    fn arguments(&mut self, call: &CallExpression<'a>) {
        let resolver = self.resolver;
        let Some(parameters) = resolver.callee_parameters(self.module, call, 0) else {
            return;
        };
        let spread = call
            .arguments
            .iter()
            .any(|argument| matches!(argument, Argument::SpreadElement(_)));
        let callee = resolver
            .typed_at(self.module, &call.callee, 0)
            .map(|callee| resolver.shape(resolver.present(callee)));
        // A factory is called with one argument, and what it is called
        // with when the argument is left out is not this rule's question.
        let counted = !matches!(
            callee,
            Ok(Shape::PatternFactory(..) | Shape::HandlerFactory(..))
        );
        let site = if counted {
            "argument"
        } else {
            "argument of a pattern or a handler"
        };
        if counted && !spread {
            let required = parameters
                .iter()
                .filter(|parameter| !parameter.optional)
                .count();
            let rest = parameters.iter().any(|parameter| parameter.rest);
            let found = call.arguments.len();
            if found < required || (found > parameters.len() && !rest) {
                let expected = if rest {
                    format!("at least {required} arguments")
                } else if required == parameters.len() {
                    format!(
                        "{required} argument{}",
                        if required == 1 { "" } else { "s" }
                    )
                } else {
                    format!("{required} to {} arguments", parameters.len())
                };
                resolver.record(
                    self.module,
                    "argument",
                    call.span,
                    Verdict::No(
                        Class::ArgumentCount,
                        format!("expected {expected}, found {found}"),
                    ),
                );
                return;
            }
        }
        for (position, argument) in call.arguments.iter().enumerate() {
            let Some(argument) = argument.as_expression() else {
                break;
            };
            let Some(parameter) = parameters
                .get(position)
                .or_else(|| parameters.last().filter(|parameter| parameter.rest))
            else {
                break;
            };
            // A function written in place is typed from the parameter, and
            // its body is checked where it is written.
            if FunctionLike::of(argument).is_some() {
                continue;
            }
            let expected = if parameter.rest {
                match resolver.element_of(parameter.ty) {
                    Some(element) => element,
                    None => continue,
                }
            } else {
                parameter.ty
            };
            // An optional parameter takes `undefined` too.
            let expected = if parameter.optional && !parameter.rest {
                resolver.or_undefined(expected)
            } else {
                expected
            };
            let verdict = resolver.check_against(self.module, argument, expected);
            resolver.record(self.module, site, argument.span(), verdict);
        }
    }
}

impl<'a> Visit<'a> for Assignments<'_, '_, 'a> {
    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let (Some(annotation), Some(init)) = (&it.type_annotation, &it.init) {
            if FunctionLike::of(init).is_none() {
                let expected = self
                    .resolver
                    .resolve_type(self.module, &annotation.type_annotation);
                let verdict = self.resolver.check_against(self.module, init, expected);
                self.resolver
                    .record(self.module, "initializer", init.span(), verdict);
            }
        }
        walk::walk_variable_declarator(self, it);
    }

    fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
        let expected = self.function(FunctionLike::Function(it));
        self.returns.push(expected);
        walk::walk_function(self, it, flags);
        self.returns.pop();
    }

    fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
        let function = FunctionLike::Arrow(it);
        let expected = self.function(function);
        if let (Some(expected), Some(body)) = (expected, function.expression_body()) {
            let verdict = self.resolver.check_against(self.module, body, expected);
            self.resolver
                .record(self.module, "returned value", body.span(), verdict);
        }
        self.returns.push(expected);
        walk::walk_arrow_function_expression(self, it);
        self.returns.pop();
    }

    fn visit_return_statement(&mut self, it: &ReturnStatement<'a>) {
        if let (Some(Some(expected)), Some(argument)) = (self.returns.last(), &it.argument) {
            let verdict = self
                .resolver
                .check_against(self.module, argument, *expected);
            self.resolver
                .record(self.module, "returned value", argument.span(), verdict);
        }
        walk::walk_return_statement(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        self.arguments(it);
        walk::walk_call_expression(self, it);
    }
}
