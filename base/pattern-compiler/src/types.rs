//! The first slice of the subset type checker (`language-subset.md` §7 and
//! §8): a representation of types, the resolution of written types, and the
//! declared type of a binding.
//!
//! A type is a shape with annotations. The shapes are in one table and the
//! annotations in a second, keyed by the type, so that nothing that asks for
//! a shape sees a label (§8.1). Written types are resolved eagerly: an alias
//! or an interface is instantiated by substitution, an intersection is
//! computed where it is written (§7.4), and the operators of §7.1 are
//! applied natively. The types `commonfabric` exports are constructors with
//! rules of their own (§7.2), and their declarations are never read.
//!
//! Nothing here infers the type of an expression, apart from a literal. A
//! form this slice does not evaluate resolves to [`Shape::Unresolved`], and
//! no rule refuses a program because of one.

use std::cell::RefCell;
use std::collections::HashMap;

use oxc_ast::ast::*;
use oxc_ast::AstKind;
use oxc_span::{GetSpan, Span};
use oxc_syntax::symbol::SymbolId;
use serde::Serialize;

use crate::api::{self, ApiValue, Builder};
use crate::module::{symbol_of, Binding};
use crate::program::Resolver;
use crate::syntax::{static_key_name, unwrap};

/// A type in the table of a [`TypeStore`].
pub type TypeId = u32;

/// The handle types of §1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum HandleKind {
    Cell,
    ReadonlyCell,
    WriteonlyCell,
    ComparableCell,
    OpaqueCell,
    Stream,
    Sqlite,
}

impl HandleKind {
    fn of(name: &str) -> Option<Self> {
        Some(match name {
            "Cell" | "Writable" => HandleKind::Cell,
            "ReadonlyCell" => HandleKind::ReadonlyCell,
            "WriteonlyCell" => HandleKind::WriteonlyCell,
            "ComparableCell" => HandleKind::ComparableCell,
            "OpaqueCell" => HandleKind::OpaqueCell,
            "Stream" => HandleKind::Stream,
            "SqliteDb" => HandleKind::Sqlite,
            _ => return None,
        })
    }

    /// Whether `.get()` reads a handle of this kind (§4.4).
    pub fn is_readable(self) -> bool {
        matches!(self, HandleKind::Cell | HandleKind::ReadonlyCell)
    }
}

/// Why a written type was not evaluated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Why {
    /// `any`, which the subset refuses.
    Any,
    /// A type form §7.9 refuses.
    RefusedForm,
    /// A name the program does not declare.
    External,
    /// `typeof` of a value whose type needs expression inference.
    TypeofValue,
    /// A reference to a declaration that is being resolved.
    Recursive,
    /// A form this slice does not evaluate.
    NotEvaluated,
}

/// The shape of a type (§7.1).
#[derive(Debug, Clone, PartialEq)]
pub enum Shape {
    Unknown,
    Never,
    Void,
    Null,
    Undefined,
    String,
    Number,
    Boolean,
    BigInt,
    /// A literal type, as its source text.
    Literal(String),
    /// An object type: its properties, and the value type of its index
    /// signature.
    Object(Vec<Property>, Option<TypeId>),
    Array(TypeId),
    Tuple(Vec<TypeId>),
    Union(Vec<TypeId>),
    /// A function type, which is a code type.
    Function,
    Handle(HandleKind, TypeId),
    PatternFactory(TypeId, TypeId),
    HandlerFactory(TypeId, TypeId),
    /// A standard-library object type, which is a code type.
    Code(String),
    /// A named API type the checker treats as opaque data.
    Opaque(String),
    /// A type parameter that is not bound.
    Parameter(String),
    Unresolved(Why),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Property {
    pub name: String,
    pub ty: TypeId,
    pub optional: bool,
}

/// One annotation on a type node (§8.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Annotation {
    /// The annotation's key, such as `confidentiality`, `default`, or
    /// `scope`.
    pub key: &'static str,
    /// The source text of the alias's argument.
    pub argument: String,
}

/// A diagnostic a type rule reports, before it is given a position.
#[derive(Debug, Clone)]
pub struct TypeReport {
    pub module: usize,
    pub id: &'static str,
    pub span: Span,
    pub found: String,
}

/// The table of types, the annotations beside it, and what resolution
/// reported.
#[derive(Default)]
pub struct TypeStore {
    shapes: Vec<Shape>,
    annotations: HashMap<TypeId, Vec<Annotation>>,
    /// The resolved declarations without type arguments, by module and
    /// symbol. `None` marks one that is being resolved.
    declarations: HashMap<(usize, SymbolId), Option<TypeId>>,
    pub reports: Vec<TypeReport>,
    /// The number of written types of each module by how far they were
    /// evaluated.
    pub written: HashMap<(usize, &'static str), usize>,
    /// The result type of each function type whose signature gives one.
    results: HashMap<TypeId, TypeId>,
    /// The type arguments of each standard-library object type.
    code_arguments: HashMap<TypeId, Vec<TypeId>>,
    /// The functions whose return type is being inferred.
    in_progress: std::collections::HashSet<(usize, u32)>,
}

impl TypeStore {
    pub fn shape(&self, ty: TypeId) -> &Shape {
        &self.shapes[ty as usize]
    }

    pub fn annotations(&self, ty: TypeId) -> &[Annotation] {
        self.annotations.get(&ty).map_or(&[], Vec::as_slice)
    }

    fn add(&mut self, shape: Shape) -> TypeId {
        self.shapes.push(shape);
        self.shapes.len() as TypeId - 1
    }
}

/// The type parameters in scope, each bound to a type.
type Env = Vec<(SymbolId, TypeId)>;

const MAX_DEPTH: u32 = 24;

impl<'a> Resolver<'_, 'a> {
    fn add(&self, shape: Shape) -> TypeId {
        self.types.borrow_mut().add(shape)
    }

    /// Adds a type with the given shape and no annotation.
    pub fn intern(&self, shape: Shape) -> TypeId {
        self.add(shape)
    }

    /// Records a report of a type rule.
    pub fn type_report(&self, module: usize, id: &'static str, span: Span, found: &str) {
        self.report(module, id, span, found);
    }

    /// The type of an initializer that is a builder definition or a literal.
    pub fn initializer_type(&self, module: usize, init: &Expression<'a>) -> TypeId {
        self.type_of_initializer(module, init, 0)
    }

    pub fn shape(&self, ty: TypeId) -> Shape {
        self.types.borrow().shape(ty).clone()
    }

    fn unresolved(&self, why: Why) -> TypeId {
        self.add(Shape::Unresolved(why))
    }

    fn report(&self, module: usize, id: &'static str, span: Span, found: impl Into<String>) {
        self.types.borrow_mut().reports.push(TypeReport {
            module,
            id,
            span,
            found: found.into(),
        });
    }

    /// A copy of `ty` with one more annotation on its root.
    fn annotate(&self, ty: TypeId, key: &'static str, argument: String) -> TypeId {
        let shape = self.shape(ty);
        let mut annotations = self.types.borrow().annotations(ty).to_vec();
        annotations.push(Annotation { key, argument });
        let annotated = self.add(shape);
        self.types
            .borrow_mut()
            .annotations
            .insert(annotated, annotations);
        annotated
    }

    fn has_annotation(&self, ty: TypeId, key: &str) -> bool {
        self.types
            .borrow()
            .annotations(ty)
            .iter()
            .any(|annotation| annotation.key == key)
    }

    fn text(&self, module: usize, span: Span) -> String {
        self.parsed(module)
            .map(|parsed| span.source_text(parsed.source).to_string())
            .unwrap_or_default()
    }

    /// Resolves a type written in module `module`, with no type parameter
    /// bound.
    pub fn resolve_type(&self, module: usize, ty: &TSType<'a>) -> TypeId {
        self.resolve(module, ty, &Env::new(), 0)
    }

    fn resolve(&self, module: usize, ty: &TSType<'a>, env: &Env, depth: u32) -> TypeId {
        if depth > MAX_DEPTH {
            return self.unresolved(Why::Recursive);
        }
        let next = depth + 1;
        match ty {
            TSType::TSAnyKeyword(_) => self.unresolved(Why::Any),
            TSType::TSUnknownKeyword(_) => self.add(Shape::Unknown),
            TSType::TSNeverKeyword(_) => self.add(Shape::Never),
            TSType::TSVoidKeyword(_) => self.add(Shape::Void),
            TSType::TSNullKeyword(_) => self.add(Shape::Null),
            TSType::TSUndefinedKeyword(_) => self.add(Shape::Undefined),
            TSType::TSStringKeyword(_) => self.add(Shape::String),
            TSType::TSNumberKeyword(_) => self.add(Shape::Number),
            TSType::TSBooleanKeyword(_) => self.add(Shape::Boolean),
            TSType::TSBigIntKeyword(_) => self.add(Shape::BigInt),
            TSType::TSObjectKeyword(_) => self.add(Shape::Object(Vec::new(), None)),
            TSType::TSLiteralType(literal) => match &literal.literal {
                TSLiteral::TemplateLiteral(_) => self.unresolved(Why::RefusedForm),
                other => self.add(Shape::Literal(self.text(module, other.span()))),
            },
            TSType::TSParenthesizedType(inner) => {
                self.resolve(module, &inner.type_annotation, env, next)
            }
            TSType::TSArrayType(array) => {
                let element = self.resolve(module, &array.element_type, env, next);
                self.add(Shape::Array(element))
            }
            TSType::TSTupleType(tuple) => {
                let elements = tuple
                    .element_types
                    .iter()
                    .map(|element| match element {
                        TSTupleElement::TSOptionalType(optional) => {
                            self.resolve(module, &optional.type_annotation, env, next)
                        }
                        TSTupleElement::TSRestType(rest) => {
                            self.resolve(module, &rest.type_annotation, env, next)
                        }
                        TSTupleElement::TSNamedTupleMember(member) => match &member.element_type {
                            TSTupleElement::TSOptionalType(_) | TSTupleElement::TSRestType(_) => {
                                self.unresolved(Why::NotEvaluated)
                            }
                            other => self.resolve(module, other.to_ts_type(), env, next),
                        },
                        other => self.resolve(module, other.to_ts_type(), env, next),
                    })
                    .collect();
                self.add(Shape::Tuple(elements))
            }
            TSType::TSUnionType(union) => {
                let members: Vec<TypeId> = union
                    .types
                    .iter()
                    .map(|member| self.resolve(module, member, env, next))
                    .collect();
                self.scope_in_union(module, union.span, &members);
                self.union(members)
            }
            TSType::TSIntersectionType(intersection) => {
                let mut members = intersection
                    .types
                    .iter()
                    .map(|member| self.resolve(module, member, env, next));
                let Some(first) = members.next() else {
                    return self.add(Shape::Never);
                };
                let result = members.fold(first, |left, right| self.intersect(left, right, 0));
                if self.shape(result) == Shape::Never {
                    self.report(
                        module,
                        "subset-type:empty-intersection",
                        intersection.span,
                        "An intersection that is `never`",
                    );
                }
                result
            }
            TSType::TSTypeLiteral(literal) => self.members(module, &literal.members, env, next),
            TSType::TSFunctionType(function) => {
                let result = self.resolve(module, &function.return_type.type_annotation, env, next);
                self.function_type(Some(result))
            }
            TSType::TSConstructorType(_) => self.add(Shape::Function),
            TSType::TSTypeOperatorType(operator) => {
                let operand = self.resolve(module, &operator.type_annotation, env, next);
                match operator.operator {
                    TSTypeOperatorOperator::Readonly => operand,
                    TSTypeOperatorOperator::Keyof => self.keyof(operand),
                    TSTypeOperatorOperator::Unique => self.unresolved(Why::RefusedForm),
                }
            }
            TSType::TSIndexedAccessType(access) => {
                let object = self.resolve(module, &access.object_type, env, next);
                let index = self.resolve(module, &access.index_type, env, next);
                self.indexed(object, index)
            }
            TSType::TSTypeQuery(query) => match &query.expr_name {
                TSTypeQueryExprName::IdentifierReference(name) => {
                    self.type_of_value(module, name, next)
                }
                _ => self.unresolved(Why::TypeofValue),
            },
            TSType::TSTypeReference(reference) => self.reference(module, reference, env, next),
            TSType::TSConditionalType(_)
            | TSType::TSMappedType(_)
            | TSType::TSTemplateLiteralType(_)
            | TSType::TSInferType(_)
            | TSType::TSSymbolKeyword(_)
            | TSType::TSThisType(_) => self.unresolved(Why::RefusedForm),
            _ => self.unresolved(Why::NotEvaluated),
        }
    }

    /// A union of `members`, flattened where a member is a union without
    /// annotations of its own (§8.4).
    fn union(&self, members: Vec<TypeId>) -> TypeId {
        let mut flat = Vec::new();
        for member in members {
            match self.shape(member) {
                Shape::Union(inner) if self.types.borrow().annotations(member).is_empty() => {
                    flat.extend(inner);
                }
                Shape::Never => {}
                _ => flat.push(member),
            }
        }
        match flat.len() {
            0 => self.add(Shape::Never),
            1 => flat[0],
            _ => self.add(Shape::Union(flat)),
        }
    }

    /// `scope:union-member`: a scope wrapper on a member of a union that has
    /// a member other than `null` and `undefined` (§8.8).
    fn scope_in_union(&self, module: usize, span: Span, members: &[TypeId]) {
        let scoped = members
            .iter()
            .filter(|member| self.has_annotation(**member, "scope"))
            .count();
        if scoped == 0 {
            return;
        }
        let others = members.iter().any(|member| {
            !self.has_annotation(*member, "scope")
                && !matches!(self.shape(*member), Shape::Null | Shape::Undefined)
        });
        if others || scoped > 1 {
            self.report(
                module,
                "scope:union-member",
                span,
                "A scope wrapper on a member of a union with other members",
            );
        }
    }

    fn members(&self, module: usize, members: &[TSSignature<'a>], env: &Env, depth: u32) -> TypeId {
        let mut properties = Vec::new();
        let mut index = None;
        for member in members {
            match member {
                TSSignature::TSPropertySignature(property) => {
                    let Some(name) = self.key_name(module, &property.key, property.computed) else {
                        continue;
                    };
                    let ty = match &property.type_annotation {
                        Some(annotation) => {
                            self.resolve(module, &annotation.type_annotation, env, depth)
                        }
                        None => self.unresolved(Why::Any),
                    };
                    properties.push(Property {
                        name,
                        ty,
                        optional: property.optional,
                    });
                }
                TSSignature::TSMethodSignature(method) => {
                    if let Some(name) = self.key_name(module, &method.key, method.computed) {
                        let result = method.return_type.as_ref().map(|annotation| {
                            self.resolve(module, &annotation.type_annotation, env, depth)
                        });
                        properties.push(Property {
                            name,
                            ty: self.function_type(result),
                            optional: method.optional,
                        });
                    }
                }
                TSSignature::TSIndexSignature(signature) => {
                    index = Some(self.resolve(
                        module,
                        &signature.type_annotation.type_annotation,
                        env,
                        depth,
                    ));
                }
                _ => {}
            }
        }
        self.add(Shape::Object(properties, index))
    }

    /// The name of a property key: an identifier, a string literal, or a
    /// well-known key such as `[UI]`, which is written with its brackets.
    fn key_name(&self, module: usize, key: &PropertyKey<'a>, computed: bool) -> Option<String> {
        if !computed {
            return static_key_name(key).map(str::to_string);
        }
        match key {
            PropertyKey::StringLiteral(literal) => Some(literal.value.to_string()),
            other => Some(format!("[{}]", self.text(module, other.span()))),
        }
    }

    fn keyof(&self, operand: TypeId) -> TypeId {
        match self.shape(operand) {
            Shape::Object(properties, None) => {
                let names = properties
                    .iter()
                    .map(|property| self.add(Shape::Literal(format!("\"{}\"", property.name))))
                    .collect();
                self.union(names)
            }
            Shape::Object(_, Some(_)) => self.add(Shape::String),
            _ => self.unresolved(Why::NotEvaluated),
        }
    }

    fn indexed(&self, object: TypeId, index: TypeId) -> TypeId {
        match (self.shape(object), self.shape(index)) {
            (Shape::Array(element), Shape::Number) => element,
            (Shape::Tuple(elements), Shape::Number) => self.union(elements),
            (Shape::Object(..), Shape::Literal(key)) => self
                .property(object, key.trim_matches(['"', '\'']))
                .unwrap_or_else(|| self.unresolved(Why::NotEvaluated)),
            (Shape::Object(..), Shape::Union(keys)) => {
                let members = keys.iter().map(|key| self.indexed(object, *key)).collect();
                self.union(members)
            }
            _ => self.unresolved(Why::NotEvaluated),
        }
    }

    /// The declared type of property `name` of `ty`, with `undefined` added
    /// for an optional property left out.
    pub fn property(&self, ty: TypeId, name: &str) -> Option<TypeId> {
        match self.shape(ty) {
            Shape::Object(properties, index) => properties
                .iter()
                .find(|property| property.name == name)
                .map(|property| property.ty)
                .or(index),
            Shape::Union(members) => {
                let present: Vec<TypeId> = members
                    .into_iter()
                    .filter(|member| !matches!(self.shape(*member), Shape::Null | Shape::Undefined))
                    .collect();
                match present.as_slice() {
                    [one] => self.property(*one, name),
                    _ => None,
                }
            }
            _ => None,
        }
    }

    /// `left & right`, computed (§7.4).
    fn intersect(&self, left: TypeId, right: TypeId, depth: u32) -> TypeId {
        if depth > 8 {
            return self.unresolved(Why::Recursive);
        }
        let (a, b) = (self.shape(left), self.shape(right));
        if a == b {
            return left;
        }
        match (&a, &b) {
            (Shape::Unknown, _) => right,
            (_, Shape::Unknown) => left,
            (Shape::Never, _) | (_, Shape::Never) => self.add(Shape::Never),
            (Shape::Union(members), _) => {
                let members = members
                    .iter()
                    .map(|member| self.intersect(*member, right, depth + 1))
                    .collect();
                self.union(members)
            }
            (_, Shape::Union(members)) => {
                let members = members
                    .iter()
                    .map(|member| self.intersect(left, *member, depth + 1))
                    .collect();
                self.union(members)
            }
            (
                Shape::Object(left_properties, left_index),
                Shape::Object(right_properties, right_index),
            ) => {
                let mut properties = left_properties.clone();
                for property in right_properties {
                    match properties.iter_mut().find(|own| own.name == property.name) {
                        Some(own) => {
                            own.ty = self.intersect(own.ty, property.ty, depth + 1);
                            own.optional = own.optional && property.optional;
                        }
                        None => properties.push(property.clone()),
                    }
                }
                self.add(Shape::Object(properties, left_index.or(*right_index)))
            }
            (Shape::Literal(literal), primitive) | (primitive, Shape::Literal(literal)) => {
                let fits = match primitive {
                    Shape::String => literal.starts_with(['"', '\'']),
                    Shape::Number => literal.starts_with(|c: char| c.is_ascii_digit() || c == '-'),
                    Shape::Boolean => literal == "true" || literal == "false",
                    Shape::Literal(_) => false,
                    Shape::Object(..) | Shape::Null | Shape::Undefined | Shape::BigInt => false,
                    _ => return self.unresolved(Why::NotEvaluated),
                };
                if fits {
                    self.add(Shape::Literal(literal.clone()))
                } else {
                    self.add(Shape::Never)
                }
            }
            _ if is_plain(&a) && is_plain(&b) => self.add(Shape::Never),
            // §7.4 does not compute an intersection with a handle, a factory,
            // a function, or an opaque API type, so one is `never`.
            _ if is_uncomputed(&a) || is_uncomputed(&b) => self.add(Shape::Never),
            _ => self.unresolved(Why::NotEvaluated),
        }
    }

    fn arguments(
        &self,
        module: usize,
        reference: &TSTypeReference<'a>,
        env: &Env,
        depth: u32,
    ) -> Vec<TypeId> {
        reference
            .type_arguments
            .iter()
            .flat_map(|arguments| &arguments.params)
            .map(|argument| self.resolve(module, argument, env, depth))
            .collect()
    }

    fn reference(
        &self,
        module: usize,
        reference: &TSTypeReference<'a>,
        env: &Env,
        depth: u32,
    ) -> TypeId {
        let TSTypeName::IdentifierReference(name) = &reference.type_name else {
            return self.unresolved(Why::NotEvaluated);
        };
        let Some(parsed) = self.parsed(module) else {
            return self.unresolved(Why::External);
        };
        let Some(symbol) = symbol_of(parsed.semantic.scoping(), name) else {
            return self.global(module, reference, name.name.as_str(), env, depth);
        };
        if let Some((_, bound)) = env.iter().rev().find(|(parameter, _)| *parameter == symbol) {
            return *bound;
        }
        let Some(model) = self.model(module) else {
            return self.unresolved(Why::External);
        };
        if let Some(api) = model.api_ref(symbol) {
            return self.api_type(module, reference, &api.name, env, depth);
        }
        let arguments = self.arguments(module, reference, env, depth);
        self.named(module, symbol, arguments, depth)
    }

    /// The type a declaration of module `module` denotes with `arguments`
    /// for its type parameters.
    fn declaration(
        &self,
        module: usize,
        symbol: SymbolId,
        arguments: Vec<TypeId>,
        depth: u32,
    ) -> TypeId {
        let Some(parsed) = self.parsed(module) else {
            return self.unresolved(Why::External);
        };
        let plain = arguments.is_empty();
        if plain {
            let known = self
                .types
                .borrow()
                .declarations
                .get(&(module, symbol))
                .copied();
            match known {
                Some(Some(known)) => return known,
                Some(None) => return self.unresolved(Why::Recursive),
                None => {}
            }
            self.types
                .borrow_mut()
                .declarations
                .insert((module, symbol), None);
        }
        let scoping = parsed.semantic.scoping();
        let nodes = parsed.semantic.nodes();
        let bind = |parameters: Option<&TSTypeParameterDeclaration<'a>>| -> Env {
            parameters
                .iter()
                .flat_map(|parameters| &parameters.params)
                .enumerate()
                .filter_map(|(index, parameter)| {
                    let symbol = parameter.name.symbol_id.get()?;
                    let bound = match (arguments.get(index), &parameter.default) {
                        (Some(argument), _) => *argument,
                        (None, Some(default)) => self.resolve(module, default, &Env::new(), depth),
                        (None, None) => self.add(Shape::Parameter(parameter.name.name.to_string())),
                    };
                    Some((symbol, bound))
                })
                .collect()
        };
        let resolved = match nodes.kind(scoping.symbol_declaration(symbol)) {
            AstKind::TSTypeAliasDeclaration(alias) => {
                let env = bind(alias.type_parameters.as_deref());
                self.resolve(module, &alias.type_annotation, &env, depth)
            }
            AstKind::TSInterfaceDeclaration(interface) => {
                let env = bind(interface.type_parameters.as_deref());
                let mut ty = self.members(module, &interface.body.body, &env, depth);
                for heritage in &interface.extends {
                    let Expression::Identifier(base) = &heritage.expression else {
                        continue;
                    };
                    let Some(base) = symbol_of(scoping, base) else {
                        continue;
                    };
                    let arguments = heritage
                        .type_arguments
                        .iter()
                        .flat_map(|arguments| &arguments.params)
                        .map(|argument| self.resolve(module, argument, &env, depth))
                        .collect();
                    let base = self.named(module, base, arguments, depth);
                    ty = self.intersect(base, ty, 0);
                }
                ty
            }
            AstKind::TSTypeParameter(parameter) => {
                self.add(Shape::Parameter(parameter.name.name.to_string()))
            }
            _ => self.unresolved(Why::NotEvaluated),
        };
        if plain {
            // A type resolved while another declaration is being resolved
            // may hold a recursive reference to that declaration, so only
            // the outermost resolution is kept.
            let mut types = self.types.borrow_mut();
            types.declarations.remove(&(module, symbol));
            if types.declarations.values().all(Option::is_some) {
                types.declarations.insert((module, symbol), Some(resolved));
            }
        }
        resolved
    }

    /// The type a symbol of module `module` names, an import followed.
    fn named(&self, module: usize, symbol: SymbolId, arguments: Vec<TypeId>, depth: u32) -> TypeId {
        let Some(model) = self.model(module) else {
            return self.unresolved(Why::External);
        };
        match model.binding(symbol) {
            Some(Binding::Import(import, binding)) => {
                let import = &model.imports[import];
                let def = self.resolve_import(module, import, &import.bindings[binding].imported);
                let target = def.and_then(|def| {
                    let symbol = self.model(def.module)?.defs[def.def].symbol?;
                    Some((def.module, symbol))
                });
                match target {
                    Some((module, symbol)) => self.declaration(module, symbol, arguments, depth),
                    None => self.unresolved(Why::External),
                }
            }
            _ => self.declaration(module, symbol, arguments, depth),
        }
    }

    /// A type `commonfabric` exports, as a constructor with a native rule
    /// (§7.2, §8.1).
    fn api_type(
        &self,
        module: usize,
        reference: &TSTypeReference<'a>,
        name: &str,
        env: &Env,
        depth: u32,
    ) -> TypeId {
        let arguments = self.arguments(module, reference, env, depth);
        let first = || {
            arguments
                .first()
                .copied()
                .unwrap_or_else(|| self.add(Shape::Unknown))
        };
        let written = |index: usize| {
            reference
                .type_arguments
                .as_ref()
                .and_then(|arguments| arguments.params.get(index))
        };
        let argument_text =
            |index: usize| written(index).map_or(String::new(), |ty| self.text(module, ty.span()));
        if let Some(kind) = HandleKind::of(name) {
            let value = first();
            if self.contains_function(value, 0) {
                self.report(
                    module,
                    "subset-type:function-in-data",
                    reference.span,
                    "A function type inside the value type of a cell",
                );
            }
            return self.add(Shape::Handle(kind, value));
        }
        match name {
            "Reactive" => first(),
            "PatternFactory" => {
                let output = arguments
                    .get(1)
                    .copied()
                    .unwrap_or_else(|| self.add(Shape::Unknown));
                self.add(Shape::PatternFactory(first(), output))
            }
            "HandlerFactory" => {
                let state = arguments
                    .get(1)
                    .copied()
                    .unwrap_or_else(|| self.add(Shape::Unknown));
                self.add(Shape::HandlerFactory(first(), state))
            }
            "Default" => {
                // `Default<T, V>`, and `Default<V>` for `T | Default<V>`.
                let value = arguments.last().copied();
                let last = arguments.len().saturating_sub(1);
                let constant = match written(last) {
                    Some(TSType::TSTypeQuery(query)) => match &query.expr_name {
                        TSTypeQueryExprName::IdentifierReference(name) => {
                            Some(self.constant_is_literal(module, name))
                        }
                        _ => None,
                    },
                    _ => None,
                };
                if let Some(value) = value {
                    let literal_like = match constant {
                        Some(decided) => decided,
                        None => self.is_literal_like(value, 0),
                    };
                    if literal_like == Some(false) {
                        self.report(
                            module,
                            "default:not-static",
                            reference.span,
                            "A `Default` value that is not literal-like",
                        );
                    }
                }
                // `T | Default<V>`: the member gives the union a default and
                // is not a member of the value's type.
                if arguments.len() == 1 {
                    return self.annotate(self.add(Shape::Never), "default", argument_text(0));
                }
                self.annotate(
                    first(),
                    "default",
                    argument_text(arguments.len().saturating_sub(1)),
                )
            }
            "PerSpace" | "PerUser" | "PerSession" | "PerAny" | "Scoped" => {
                self.annotate(first(), "scope", name.to_string())
            }
            "Confidential" | "Integrity" | "AddIntegrity" | "RequiresIntegrity"
            | "MaxConfidentiality" => {
                if let Some(list) = written(1) {
                    self.label_list(module, list, reference.span);
                }
                let key = match name {
                    "Confidential" => "confidentiality",
                    "Integrity" => "integrity",
                    "AddIntegrity" => "addIntegrity",
                    "RequiresIntegrity" => "requiredIntegrity",
                    _ => "maxConfidentiality",
                };
                self.annotate(first(), key, argument_text(1))
            }
            "WriteAuthorizedBy" => {
                if let Some(binding) = written(1) {
                    self.writer_binding(module, binding, reference.span);
                }
                self.annotate(first(), "writeAuthorizedBy", argument_text(1))
            }
            _ if api::is_transparent_wrapper(name) => {
                self.annotate(first(), "label", name.to_string())
            }
            _ => self.add(Shape::Opaque(name.to_string())),
        }
    }

    /// Whether the constant `name` is initialized by a literal expression,
    /// whatever its annotation: `Default<T, typeof NAME>` takes the default
    /// value from the initializer. `None` when the initializer refers to
    /// other values, which this slice does not follow.
    fn constant_is_literal(&self, module: usize, name: &IdentifierReference<'a>) -> Option<bool> {
        let parsed = self.parsed(module)?;
        let symbol = symbol_of(parsed.semantic.scoping(), name)?;
        let (module, symbol) = match self.model(module)?.binding(symbol) {
            Some(Binding::Import(import, binding)) => {
                let import = &self.model(module)?.imports[import];
                let def =
                    self.resolve_import(module, import, &import.bindings[binding].imported)?;
                (def.module, self.model(def.module)?.defs[def.def].symbol?)
            }
            _ => (module, symbol),
        };
        let parsed = self.parsed(module)?;
        let declaration = parsed.semantic.scoping().symbol_declaration(symbol);
        let AstKind::VariableDeclarator(declarator) = parsed.semantic.nodes().kind(declaration)
        else {
            return None;
        };
        let init = unwrap(declarator.init.as_ref()?);
        if self.literal_type_as(init, true, module).is_some() {
            return Some(true);
        }
        match init {
            Expression::CallExpression(_) | Expression::NewExpression(_) => Some(false),
            _ => None,
        }
    }

    /// A label argument is a tuple of atoms (§8.5).
    fn label_list(&self, module: usize, list: &TSType<'a>, alias: Span) {
        let mut list = list;
        loop {
            list = match list {
                TSType::TSParenthesizedType(inner) => &inner.type_annotation,
                TSType::TSTypeOperatorType(operator)
                    if operator.operator == TSTypeOperatorOperator::Readonly =>
                {
                    &operator.type_annotation
                }
                _ => break,
            };
        }
        match list {
            TSType::TSTupleType(tuple) => {
                for element in &tuple.element_types {
                    let atom = match element {
                        TSTupleElement::TSRestType(rest) => {
                            self.label_list(module, &rest.type_annotation, alias);
                            continue;
                        }
                        TSTupleElement::TSOptionalType(_)
                        | TSTupleElement::TSNamedTupleMember(_) => None,
                        other => Some(other.to_ts_type()),
                    };
                    if !atom.is_some_and(is_label_atom) {
                        self.report(
                            module,
                            "cfc-label:not-static",
                            alias,
                            "A label atom outside the constant language",
                        );
                    }
                }
            }
            // An alias that stands for a list is evaluated by substitution,
            // which this slice does not do for label arguments.
            TSType::TSTypeReference(_) | TSType::TSTypeQuery(_) => {}
            _ => self.report(
                module,
                "cfc-label:not-a-list",
                alias,
                "A label argument that is not a tuple of atoms",
            ),
        }
    }

    /// The writer binding of `WriteAuthorizedBy` is `typeof` of a
    /// module-scope `handler(...)` definition or a function declaration.
    fn writer_binding(&self, module: usize, binding: &TSType<'a>, alias: Span) {
        let supported = match binding {
            TSType::TSTypeQuery(query) => match &query.expr_name {
                TSTypeQueryExprName::IdentifierReference(name) => {
                    self.value_def(module, name).is_none_or(|kind| {
                        matches!(
                            kind,
                            crate::module::DefKind::Handler | crate::module::DefKind::Function
                        )
                    })
                }
                _ => false,
            },
            // An alias or a type parameter that stands for a binding.
            TSType::TSTypeReference(_) => true,
            _ => false,
        };
        if !supported {
            self.report(
                module,
                "cfc-write-authorized-by",
                alias,
                "A writer binding that is not `typeof` of a handler definition or a function declaration",
            );
        }
    }

    /// The kind of the module-scope definition a value name denotes, an
    /// import followed. `None` when the program does not hold it.
    fn value_def(
        &self,
        module: usize,
        name: &IdentifierReference<'a>,
    ) -> Option<crate::module::DefKind> {
        let parsed = self.parsed(module)?;
        let symbol = symbol_of(parsed.semantic.scoping(), name)?;
        let model = self.model(module)?;
        match model.binding(symbol)? {
            Binding::Def(def) => Some(model.defs[def].kind),
            Binding::Import(import, binding) => {
                let import = &model.imports[import];
                let def =
                    self.resolve_import(module, import, &import.bindings[binding].imported)?;
                self.kind(def).map(|(kind, _)| kind)
            }
        }
    }

    /// A type that is not declared in the program: a native operator of
    /// §7.1, a standard-library object type, or a name the checker does not
    /// know.
    fn global(
        &self,
        module: usize,
        reference: &TSTypeReference<'a>,
        name: &str,
        env: &Env,
        depth: u32,
    ) -> TypeId {
        let arguments = self.arguments(module, reference, env, depth);
        let first = arguments.first().copied();
        let operand = |checker: &Self| -> Option<(TypeId, Shape)> {
            let operand = first?;
            let shape = checker.shape(operand);
            match shape {
                Shape::Object(..) => Some((operand, shape)),
                Shape::Unresolved(_) | Shape::Parameter(_) | Shape::Opaque(_) | Shape::Union(_) => {
                    None
                }
                _ => {
                    checker.report(
                        module,
                        "subset-type:operator-operand",
                        reference.span,
                        format!("`{name}` applied to a type that is not an object type"),
                    );
                    None
                }
            }
        };
        let keys = |checker: &Self| -> Option<Vec<String>> {
            let keys = *arguments.get(1)?;
            let members = match checker.shape(keys) {
                Shape::Union(members) => members,
                Shape::Literal(_) => vec![keys],
                _ => return None,
            };
            members
                .iter()
                .map(|member| match checker.shape(*member) {
                    Shape::Literal(text) => Some(text.trim_matches(['"', '\'']).to_string()),
                    _ => None,
                })
                .collect()
        };
        match name {
            "Array" | "ReadonlyArray" => match first {
                Some(element) => self.add(Shape::Array(element)),
                None => self.unresolved(Why::NotEvaluated),
            },
            "Readonly" => first.unwrap_or_else(|| self.unresolved(Why::NotEvaluated)),
            "Partial" | "Required" => match operand(self) {
                Some((_, Shape::Object(mut properties, index))) => {
                    for property in &mut properties {
                        property.optional = name == "Partial";
                    }
                    self.add(Shape::Object(properties, index))
                }
                _ => self.unresolved(Why::NotEvaluated),
            },
            "Pick" | "Omit" => match (operand(self), keys(self)) {
                (Some((_, Shape::Object(properties, index))), Some(keys)) => {
                    let kept = properties
                        .into_iter()
                        .filter(|property| keys.contains(&property.name) == (name == "Pick"))
                        .collect();
                    self.add(Shape::Object(kept, index))
                }
                _ => self.unresolved(Why::NotEvaluated),
            },
            "Record" => match (first.map(|key| self.shape(key)), arguments.get(1)) {
                (Some(Shape::String), Some(value)) => {
                    self.add(Shape::Object(Vec::new(), Some(*value)))
                }
                (Some(Shape::Literal(_) | Shape::Union(_)), Some(value)) => {
                    match keys_of(self, first) {
                        Some(names) => {
                            let properties = names
                                .into_iter()
                                .map(|name| Property {
                                    name,
                                    ty: *value,
                                    optional: false,
                                })
                                .collect();
                            self.add(Shape::Object(properties, None))
                        }
                        None => self.unresolved(Why::NotEvaluated),
                    }
                }
                _ => self.unresolved(Why::NotEvaluated),
            },
            "NonNullable" => match first.map(|operand| (operand, self.shape(operand))) {
                Some((_, Shape::Union(members))) => {
                    let kept = members
                        .into_iter()
                        .filter(|member| {
                            !matches!(self.shape(*member), Shape::Null | Shape::Undefined)
                        })
                        .collect();
                    self.union(kept)
                }
                Some((operand, _)) => operand,
                None => self.unresolved(Why::NotEvaluated),
            },
            "ReturnType" => match first.map(|operand| self.shape(operand)) {
                Some(Shape::HandlerFactory(event, _)) => {
                    self.add(Shape::Handle(HandleKind::Stream, event))
                }
                Some(Shape::PatternFactory(_, output)) => output,
                _ => self.unresolved(Why::NotEvaluated),
            },
            "Parameters" => match first.map(|operand| self.shape(operand)) {
                Some(Shape::PatternFactory(input, _)) => self.add(Shape::Tuple(vec![input])),
                Some(Shape::HandlerFactory(_, state)) => self.add(Shape::Tuple(vec![state])),
                _ => self.unresolved(Why::NotEvaluated),
            },
            "Exclude" | "Extract" => match (first, arguments.get(1)) {
                (Some(subject), Some(test))
                    if self.first_unresolved(subject, 0).is_none()
                        && self.first_unresolved(*test, 0).is_none() =>
                {
                    let members = match self.shape(subject) {
                        Shape::Union(members) => members,
                        _ => vec![subject],
                    };
                    let kept = members
                        .into_iter()
                        .filter(|member| self.fits(*member, *test) == (name == "Extract"))
                        .collect();
                    self.union(kept)
                }
                _ => self.unresolved(Why::NotEvaluated),
            },
            "PropertyKey" => self.add(Shape::String),
            "Awaited"
            | "InstanceType"
            | "ConstructorParameters"
            | "ThisParameterType"
            | "OmitThisParameter"
            | "ThisType"
            | "NoInfer"
            | "Uppercase"
            | "Lowercase"
            | "Capitalize"
            | "Uncapitalize" => {
                self.report(
                    module,
                    "stdlib:unsupported-member",
                    reference.span,
                    format!("The utility type `{name}` is not part of the subset"),
                );
                self.unresolved(Why::RefusedForm)
            }
            _ if matches!(api::global(name), api::Global::Refused(_)) => {
                self.report(
                    module,
                    "function-body:unsupported-global",
                    reference.span,
                    format!("The type of the global `{name}` is not available"),
                );
                self.unresolved(Why::RefusedForm)
            }
            "Date" | "RegExp" | "Error" | "TypeError" | "RangeError" | "Map" | "Set"
            | "ReadonlyMap" | "ReadonlySet" | "URL" | "Uint8Array" | "Iterable" => {
                self.code_type(name, arguments)
            }
            _ => self.unresolved(Why::External),
        }
    }

    /// `typeof name`: the declared type of a value binding (§7.1). A
    /// `handler(...)` or `pattern(...)` definition has a factory type, and a
    /// constant initialized by a literal has the type of the literal.
    fn type_of_value(&self, module: usize, name: &IdentifierReference<'a>, depth: u32) -> TypeId {
        let Some(parsed) = self.parsed(module) else {
            return self.unresolved(Why::External);
        };
        let scoping = parsed.semantic.scoping();
        let Some(symbol) = symbol_of(scoping, name) else {
            return self.unresolved(Why::External);
        };
        let (module, symbol) = match self.model(module).and_then(|model| model.binding(symbol)) {
            Some(Binding::Import(import, binding)) => {
                let model = self.model(module).expect("the model was just read");
                let import = &model.imports[import];
                let target = self
                    .resolve_import(module, import, &import.bindings[binding].imported)
                    .and_then(|def| {
                        Some((def.module, self.model(def.module)?.defs[def.def].symbol?))
                    });
                match target {
                    Some(target) => target,
                    None => return self.unresolved(Why::External),
                }
            }
            _ => (module, symbol),
        };
        let Some(parsed) = self.parsed(module) else {
            return self.unresolved(Why::External);
        };
        let declaration = parsed.semantic.scoping().symbol_declaration(symbol);
        match parsed.semantic.nodes().kind(declaration) {
            AstKind::VariableDeclarator(declarator) => {
                if let Some(annotation) = &declarator.type_annotation {
                    return self.resolve(module, &annotation.type_annotation, &Env::new(), depth);
                }
                match &declarator.init {
                    Some(init) => self.type_of_initializer(module, init, depth),
                    None => self.unresolved(Why::TypeofValue),
                }
            }
            _ => self.unresolved(Why::TypeofValue),
        }
    }

    /// The type of an initializer, where it is a builder definition or a
    /// literal.
    fn type_of_initializer(&self, module: usize, init: &Expression<'a>, depth: u32) -> TypeId {
        let init = unwrap(init);
        if let Expression::CallExpression(call) = init {
            let parsed = self.parsed(module).expect("the module is parsed");
            let builder = self
                .model(module)
                .and_then(|model| model.api_ref_of_callee(parsed.semantic.scoping(), &call.callee))
                .map(|api| api.value());
            let argument = |index: usize| {
                call.type_arguments
                    .as_ref()
                    .and_then(|arguments| arguments.params.get(index))
                    .map_or_else(
                        || self.add(Shape::Unknown),
                        |ty| self.resolve(module, ty, &Env::new(), depth),
                    )
            };
            return match builder {
                Some(ApiValue::Builder(Builder::Handler)) => {
                    self.add(Shape::HandlerFactory(argument(0), argument(1)))
                }
                Some(ApiValue::Builder(Builder::Pattern)) => {
                    self.add(Shape::PatternFactory(argument(0), argument(1)))
                }
                _ => self.unresolved(Why::TypeofValue),
            };
        }
        self.literal_type_as(init, true, module)
            .unwrap_or_else(|| self.unresolved(Why::TypeofValue))
    }

    /// The type of a literal expression: a primitive, or an object or array
    /// literal of literals.
    pub fn literal_type(&self, expression: &Expression<'a>) -> Option<TypeId> {
        self.literal_type_as(expression, false, 0)
    }

    /// The type of a literal expression. With `exact`, a primitive literal
    /// has its literal type and not the primitive type it widens to, which
    /// is what `typeof` of a constant needs to give a default value (§8.8).
    fn literal_type_as(
        &self,
        expression: &Expression<'a>,
        exact: bool,
        module: usize,
    ) -> Option<TypeId> {
        let primitive = |shape: Shape| {
            if exact {
                self.add(Shape::Literal(self.text(module, expression.span())))
            } else {
                self.add(shape)
            }
        };
        Some(match unwrap(expression) {
            Expression::StringLiteral(_) => primitive(Shape::String),
            Expression::TemplateLiteral(template) if template.expressions.is_empty() => {
                primitive(Shape::String)
            }
            Expression::NumericLiteral(_) => primitive(Shape::Number),
            Expression::BooleanLiteral(_) => primitive(Shape::Boolean),
            Expression::NullLiteral(_) => self.add(Shape::Null),
            Expression::BigIntLiteral(_) => primitive(Shape::BigInt),
            Expression::ArrayExpression(array) => {
                let elements = array
                    .elements
                    .iter()
                    .map(|element| self.literal_type_as(element.as_expression()?, exact, module))
                    .collect::<Option<Vec<TypeId>>>()?;
                self.add(Shape::Tuple(elements))
            }
            Expression::ObjectExpression(object) => {
                let properties = object
                    .properties
                    .iter()
                    .map(|property| {
                        let ObjectPropertyKind::ObjectProperty(property) = property else {
                            return None;
                        };
                        Some(Property {
                            name: static_key_name(&property.key)?.to_string(),
                            ty: self.literal_type_as(&property.value, exact, module)?,
                            optional: false,
                        })
                    })
                    .collect::<Option<Vec<Property>>>()?;
                self.add(Shape::Object(properties, None))
            }
            _ => return None,
        })
    }

    /// Whether a type is literal-like in the sense of §8.8. `None` when the
    /// type was not evaluated.
    fn is_literal_like(&self, ty: TypeId, depth: u32) -> Option<bool> {
        if depth > 8 {
            return None;
        }
        Some(match self.shape(ty) {
            Shape::Literal(_) | Shape::Null | Shape::Undefined => true,
            Shape::Tuple(elements) => {
                for element in elements {
                    if !self.is_literal_like(element, depth + 1)? {
                        return Some(false);
                    }
                }
                true
            }
            Shape::Object(properties, index) => {
                if index.is_some_and(|index| self.shape(index) != Shape::Never) {
                    return Some(false);
                }
                for property in properties {
                    if !self.is_literal_like(property.ty, depth + 1)? {
                        return Some(false);
                    }
                }
                true
            }
            Shape::Unresolved(_) | Shape::Parameter(_) => return None,
            _ => false,
        })
    }

    /// Whether a type contains a function type, a handle's value type not
    /// followed.
    pub fn contains_function(&self, ty: TypeId, depth: u32) -> bool {
        if depth > 8 {
            return false;
        }
        match self.shape(ty) {
            Shape::Function => true,
            Shape::Object(properties, index) => properties
                .iter()
                .map(|property| property.ty)
                .chain(index)
                .any(|ty| self.contains_function(ty, depth + 1)),
            Shape::Array(element) => self.contains_function(element, depth + 1),
            Shape::Tuple(members) | Shape::Union(members) => members
                .iter()
                .any(|member| self.contains_function(*member, depth + 1)),
            _ => false,
        }
    }

    /// Whether a member of a union is assignable to `target`, for `Exclude`
    /// and `Extract` (§7.10): to a member of a union target, to an equal
    /// type, or, for a literal, to its primitive type.
    fn fits(&self, member: TypeId, target: TypeId) -> bool {
        let (from, to) = (self.shape(member), self.shape(target));
        if let Shape::Union(targets) = &to {
            return targets.iter().any(|target| self.fits(member, *target));
        }
        if matches!(to, Shape::Unknown) || self.display(member) == self.display(target) {
            return true;
        }
        match (&from, &to) {
            (Shape::Literal(text), Shape::String) => text.starts_with(['"', '\'']),
            (Shape::Literal(text), Shape::Number) => {
                text.starts_with(|c: char| c.is_ascii_digit() || c == '-')
            }
            (Shape::Literal(text), Shape::Boolean) => text == "true" || text == "false",
            _ => false,
        }
    }

    /// `left & right`, computed (§7.4).
    pub fn intersection(&self, left: TypeId, right: TypeId) -> TypeId {
        self.intersect(left, right, 0)
    }

    /// Why some part of a type was not evaluated, if a part was not. A
    /// recursive reference inside a type that is otherwise evaluated is not
    /// counted.
    pub fn first_unresolved(&self, ty: TypeId, depth: u32) -> Option<Why> {
        if depth > 6 {
            return None;
        }
        let next = depth + 1;
        match self.shape(ty) {
            Shape::Unresolved(Why::Recursive) if depth > 0 => None,
            Shape::Unresolved(why) => Some(why),
            Shape::Object(properties, index) => properties
                .iter()
                .map(|property| property.ty)
                .chain(index)
                .find_map(|ty| self.first_unresolved(ty, next)),
            Shape::Array(inner) | Shape::Handle(_, inner) => self.first_unresolved(inner, next),
            Shape::Tuple(members) | Shape::Union(members) => members
                .iter()
                .find_map(|member| self.first_unresolved(*member, next)),
            Shape::PatternFactory(a, b) | Shape::HandlerFactory(a, b) => self
                .first_unresolved(a, next)
                .or_else(|| self.first_unresolved(b, next)),
            _ => None,
        }
    }

    /// Counts one written type of module `module` under `label`.
    pub fn count_written(&self, module: usize, label: &'static str) {
        *self
            .types
            .borrow_mut()
            .written
            .entry((module, label))
            .or_insert(0) += 1;
    }

    /// A function type with the result type `result`, where one is known.
    pub(crate) fn function_type(&self, result: Option<TypeId>) -> TypeId {
        let function = self.add(Shape::Function);
        if let Some(result) = result {
            self.types.borrow_mut().results.insert(function, result);
        }
        function
    }

    /// The result type of a function type, where its signature gives one.
    pub(crate) fn function_result(&self, function: TypeId) -> Option<TypeId> {
        self.types.borrow().results.get(&function).copied()
    }

    /// A standard-library object type with its type arguments, such as
    /// `Map<K, V>`.
    pub(crate) fn code_type(&self, name: &str, arguments: Vec<TypeId>) -> TypeId {
        let code = self.add(Shape::Code(name.to_string()));
        if !arguments.is_empty() {
            self.types
                .borrow_mut()
                .code_arguments
                .insert(code, arguments);
        }
        code
    }

    /// The type arguments of a standard-library object type.
    pub(crate) fn code_arguments(&self, code: TypeId) -> Vec<TypeId> {
        self.types
            .borrow()
            .code_arguments
            .get(&code)
            .cloned()
            .unwrap_or_default()
    }

    /// A union of `members`.
    pub(crate) fn union_of(&self, members: Vec<TypeId>) -> TypeId {
        self.union(members)
    }

    /// Resolves a type written in module `module` with type parameters
    /// bound.
    pub(crate) fn resolve_with(
        &self,
        module: usize,
        ty: &TSType<'a>,
        env: &[(SymbolId, TypeId)],
    ) -> TypeId {
        self.resolve(module, ty, &env.to_vec(), 0)
    }

    /// Marks the function at `key` as being inferred. Returns false when it
    /// already is, which is a recursive call.
    pub(crate) fn enter(&self, key: (usize, u32)) -> bool {
        self.types.borrow_mut().in_progress.insert(key)
    }

    pub(crate) fn leave(&self, key: (usize, u32)) {
        self.types.borrow_mut().in_progress.remove(&key);
    }

    /// A type as text, for reports.
    pub fn display(&self, ty: TypeId) -> String {
        self.display_at(ty, 0)
    }

    fn display_at(&self, ty: TypeId, depth: u32) -> String {
        if depth > 3 {
            return "...".to_string();
        }
        let show = |ty: TypeId| self.display_at(ty, depth + 1);
        let shape = match self.shape(ty) {
            Shape::Unknown => "unknown".to_string(),
            Shape::Never => "never".to_string(),
            Shape::Void => "void".to_string(),
            Shape::Null => "null".to_string(),
            Shape::Undefined => "undefined".to_string(),
            Shape::String => "string".to_string(),
            Shape::Number => "number".to_string(),
            Shape::Boolean => "boolean".to_string(),
            Shape::BigInt => "bigint".to_string(),
            Shape::Literal(text) => text,
            Shape::Object(properties, index) => {
                let mut parts: Vec<String> = properties
                    .iter()
                    .map(|property| {
                        let mark = if property.optional { "?" } else { "" };
                        format!("{}{mark}: {}", property.name, show(property.ty))
                    })
                    .collect();
                if let Some(index) = index {
                    parts.push(format!("[key: string]: {}", show(index)));
                }
                format!("{{ {} }}", parts.join("; "))
            }
            Shape::Array(element) => format!("{}[]", show(element)),
            Shape::Tuple(elements) => {
                format!(
                    "[{}]",
                    elements
                        .iter()
                        .map(|ty| show(*ty))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }
            Shape::Union(members) => members
                .iter()
                .map(|ty| show(*ty))
                .collect::<Vec<_>>()
                .join(" | "),
            Shape::Function => "(function)".to_string(),
            Shape::Handle(kind, value) => format!("{kind:?}<{}>", show(value)),
            Shape::PatternFactory(input, output) => {
                format!("PatternFactory<{}, {}>", show(input), show(output))
            }
            Shape::HandlerFactory(event, state) => {
                format!("HandlerFactory<{}, {}>", show(event), show(state))
            }
            Shape::Code(name) | Shape::Opaque(name) | Shape::Parameter(name) => name,
            Shape::Unresolved(why) => format!("(unresolved: {why:?})"),
        };
        let annotations = self.types.borrow().annotations(ty).to_vec();
        annotations.iter().fold(shape, |shape, annotation| {
            format!("{shape} @{}", annotation.key)
        })
    }
}

fn keys_of(resolver: &Resolver<'_, '_>, keys: Option<TypeId>) -> Option<Vec<String>> {
    let keys = keys?;
    let members = match resolver.shape(keys) {
        Shape::Union(members) => members,
        _ => vec![keys],
    };
    members
        .iter()
        .map(|member| match resolver.shape(*member) {
            Shape::Literal(text) => Some(text.trim_matches(['"', '\'']).to_string()),
            _ => None,
        })
        .collect()
}

/// Whether a shape is one §7.4 computes no intersection for.
fn is_uncomputed(shape: &Shape) -> bool {
    matches!(
        shape,
        Shape::Handle(..)
            | Shape::PatternFactory(..)
            | Shape::HandlerFactory(..)
            | Shape::Function
            | Shape::Opaque(_)
    )
}

/// Whether a shape is a primitive, a literal, or an object type: the shapes
/// whose intersections §7.4 defines.
fn is_plain(shape: &Shape) -> bool {
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
    )
}

/// Whether a written type is an atom of the label-argument language (§8.5),
/// as far as its form shows: a literal, `null`, an object type literal, or a
/// reference, which is `AnyOf`, `PolicyOf`, a marker type, or an alias.
fn is_label_atom(ty: &TSType<'_>) -> bool {
    match ty {
        TSType::TSLiteralType(literal) => !matches!(literal.literal, TSLiteral::TemplateLiteral(_)),
        TSType::TSNullKeyword(_)
        | TSType::TSTypeLiteral(_)
        | TSType::TSTypeReference(_)
        | TSType::TSTypeQuery(_) => true,
        TSType::TSParenthesizedType(inner) => is_label_atom(&inner.type_annotation),
        _ => false,
    }
}

/// The store a [`Resolver`] keeps its types in.
pub type Types = RefCell<TypeStore>;
