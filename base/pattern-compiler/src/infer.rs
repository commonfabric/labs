//! The types of expressions that no declaration gives: the result of a
//! call, a member of the standard library, an operator, a literal, and the
//! parameters of a callback.
//!
//! The rules are those of `language-subset.md` §7.6 as far as this slice
//! goes. There is no unification: a type parameter is bound from a written
//! type argument, or from an argument whose parameter is the type parameter
//! itself, an array of it, or a cell of it. Where inference gives up, the
//! expression has no type and is counted under the reason
//! ([`Origin`]); a part of a larger type that has no type is
//! [`Shape::Unresolved`]. Neither is ever treated as `any`.

use oxc_ast::ast::*;
use oxc_ast::AstKind;
use oxc_syntax::operator::{BinaryOperator, LogicalOperator, UnaryOperator};
use oxc_syntax::symbol::SymbolId;

use crate::api::{self, ApiValue, Builder};
use crate::declared::{Declared, Origin};
use crate::module::{symbol_of, Binding};
use crate::program::Resolver;
use crate::syntax::{static_key_name, unwrap, FunctionLike};
use crate::types::{HandleKind, Parameter, Property, Shape, Signature, TypeId};

const MAX_DEPTH: u32 = 14;

impl<'a> Resolver<'_, 'a> {
    fn of(&self, shape: Shape) -> Declared {
        Ok(self.intern(shape))
    }

    /// The type of `expression`, or an unresolved part where it has none.
    fn part(&self, module: usize, expression: &Expression<'a>, depth: u32) -> TypeId {
        self.typed_at(module, expression, depth)
            .unwrap_or_else(|_| self.add_unresolved())
    }

    /// `ty` without its `null` and `undefined` members.
    pub(crate) fn present(&self, ty: TypeId) -> TypeId {
        match self.shape(ty) {
            Shape::Union(members) => {
                let kept = members
                    .into_iter()
                    .filter(|member| !matches!(self.shape(*member), Shape::Null | Shape::Undefined))
                    .collect();
                self.union_of(kept)
            }
            _ => ty,
        }
    }

    fn union_distinct(&self, members: Vec<TypeId>) -> TypeId {
        self.union_by_text(members)
    }

    /// The element type of a collection type: of an array, a tuple, a
    /// string, or a handle of one of those.
    pub(crate) fn element_of(&self, collection: TypeId) -> Option<TypeId> {
        match self.shape(self.present(collection)) {
            Shape::Array(element) => Some(element),
            Shape::Tuple(elements) => Some(self.union_distinct(elements)),
            Shape::String => Some(self.intern(Shape::String)),
            Shape::Code(code) if code.ends_with("Set") => self
                .code_arguments(self.present(collection))
                .first()
                .copied(),
            Shape::Code(code) if code.ends_with("Map") => {
                let arguments = self.code_arguments(self.present(collection));
                (arguments.len() == 2).then(|| self.intern(Shape::Tuple(arguments)))
            }
            Shape::Handle(_, value) => match self.shape(self.present(value)) {
                Shape::Array(element) => Some(element),
                Shape::Tuple(elements) => Some(self.union_distinct(elements)),
                _ => None,
            },
            _ => None,
        }
    }

    /// The declaration a symbol of module `module` names, an import
    /// followed.
    pub(crate) fn origin(&self, module: usize, symbol: SymbolId) -> Option<(usize, SymbolId)> {
        let model = self.model(module)?;
        match model.binding(symbol) {
            Some(Binding::Import(import, binding)) => {
                let import = &model.imports[import];
                let def =
                    self.resolve_import(module, import, &import.bindings[binding].imported)?;
                Some((def.module, self.model(def.module)?.defs[def.def].symbol?))
            }
            _ => Some((module, symbol)),
        }
    }

    /// The builder a call is a call of, if its callee is one through its
    /// import.
    fn builder_of(&self, module: usize, call: &CallExpression<'a>) -> Option<(Builder, String)> {
        let parsed = self.parsed(module)?;
        let api = self
            .model(module)?
            .api_ref_of_callee(parsed.semantic.scoping(), &call.callee)?;
        match api.value() {
            ApiValue::Builder(builder) => Some((builder, api.name)),
            _ => None,
        }
    }

    fn api_name(&self, module: usize, callee: &Expression<'a>) -> Option<String> {
        let parsed = self.parsed(module)?;
        let api = self
            .model(module)?
            .api_ref_of_callee(parsed.semantic.scoping(), callee)?;
        Some(api.name)
    }

    fn type_argument(
        &self,
        module: usize,
        call: &CallExpression<'a>,
        index: usize,
    ) -> Option<TypeId> {
        call.type_arguments
            .as_ref()
            .and_then(|arguments| arguments.params.get(index))
            .map(|written| self.resolve_type(module, written))
    }

    fn callback<'e>(call: &'e CallExpression<'a>) -> Option<FunctionLike<'e, 'a>> {
        call.arguments.iter().find_map(FunctionLike::of_argument)
    }

    // ----- Calls -----

    /// The type of the result of a call.
    pub(crate) fn infer_call(
        &self,
        module: usize,
        call: &CallExpression<'a>,
        depth: u32,
    ) -> Declared {
        if depth > MAX_DEPTH {
            return Err(Origin::Other);
        }
        let next = depth + 1;
        match unwrap(&call.callee) {
            Expression::Identifier(identifier) => self.call_of_name(module, call, identifier, next),
            Expression::StaticMemberExpression(member) => {
                let name = member.property.name.as_str();
                if let Expression::Identifier(object) = unwrap(&member.object) {
                    let parsed = self.parsed(module).ok_or(Origin::External)?;
                    let global = symbol_of(parsed.semantic.scoping(), object).is_none();
                    if global && api::is_global_namespace(object.name.as_str()) {
                        return self.static_member(module, object.name.as_str(), name, call, next);
                    }
                }
                if let Some(api) = self.api_name(module, &call.callee) {
                    return self.api_call(module, &api, call, next);
                }
                let receiver = self
                    .typed_at(module, &member.object, next)
                    .map_err(|_| Origin::UntypedReceiver)?;
                self.method(module, receiver, name, call, next)
            }
            Expression::CallExpression(inner) => match self.builder_of(module, inner) {
                Some((Builder::Lift, _)) => self.lift_result(module, inner, next),
                Some((Builder::Pattern, _)) => Ok(self.pattern_output(module, inner, next)),
                _ => {
                    // A pattern under a modifier: `P.asScope(scope)({ ... })`.
                    let callee = self.typed_at(module, &call.callee, next)?;
                    self.call_of_value(callee)
                }
            },
            _ => Err(Origin::CallResult),
        }
    }

    /// The result of calling a value of type `callee`.
    fn call_of_value(&self, callee: TypeId) -> Declared {
        let callee = self.present(callee);
        match self.shape(callee) {
            Shape::PatternFactory(_, output) => Ok(output),
            Shape::HandlerFactory(event, _) => self.of(Shape::Handle(HandleKind::Stream, event)),
            Shape::Function => self.function_result(callee).ok_or(Origin::FunctionValue),
            _ => Err(Origin::CallResult),
        }
    }

    fn call_of_name(
        &self,
        module: usize,
        call: &CallExpression<'a>,
        identifier: &IdentifierReference<'a>,
        depth: u32,
    ) -> Declared {
        let parsed = self.parsed(module).ok_or(Origin::External)?;
        let Some(symbol) = symbol_of(parsed.semantic.scoping(), identifier) else {
            return self.global_function(identifier.name.as_str());
        };
        if let Some(api) = self.api_name(module, &call.callee) {
            return self.api_call(module, &api, call, depth);
        }
        let (home, symbol) = self.origin(module, symbol).ok_or(Origin::External)?;
        let parsed = self.parsed(home).ok_or(Origin::External)?;
        let declaration = parsed.semantic.scoping().symbol_declaration(symbol);
        match parsed.semantic.nodes().kind(declaration) {
            AstKind::Function(function) => self.function_return(
                home,
                FunctionLike::Function(function),
                Some((module, call)),
                depth,
            ),
            AstKind::VariableDeclarator(declarator)
                if matches!(declarator.id, BindingPattern::BindingIdentifier(_)) =>
            {
                let init = declarator.init.as_ref().map(unwrap);
                if let Some(function) = init.and_then(FunctionLike::of) {
                    return self.function_return(home, function, Some((module, call)), depth);
                }
                if let Some(Expression::CallExpression(definition)) = init {
                    match self.builder_of(home, definition) {
                        Some((Builder::Lift, _)) => {
                            return self.lift_result(home, definition, depth)
                        }
                        Some((Builder::Pattern, _)) => {
                            return Ok(self.pattern_output(home, definition, depth));
                        }
                        Some((Builder::Handler, _)) => {
                            let event = self
                                .type_argument(home, definition, 0)
                                .unwrap_or_else(|| self.intern(Shape::Unknown));
                            return self.of(Shape::Handle(HandleKind::Stream, event));
                        }
                        _ => {}
                    }
                }
                let callee = self
                    .declared_symbol_type(home, symbol, depth)
                    .map_err(|_| Origin::FunctionValue)?;
                self.call_of_value(callee)
            }
            _ => {
                let callee = self
                    .declared_symbol_type(home, symbol, depth)
                    .map_err(|_| Origin::FunctionValue)?;
                self.call_of_value(callee)
            }
        }
    }

    /// The result of a `lift(...)` definition: its second type argument, or
    /// what its callback returns.
    fn lift_result(&self, module: usize, definition: &CallExpression<'a>, depth: u32) -> Declared {
        if let Some(result) = self.type_argument(module, definition, 1) {
            return Ok(result);
        }
        let callback = Self::callback(definition).ok_or(Origin::CallResult)?;
        self.function_return(module, callback, None, depth)
    }

    /// The result type of a `pattern(...)` definition: its second type
    /// argument, or what its callback returns.
    pub(crate) fn pattern_output(
        &self,
        module: usize,
        definition: &CallExpression<'a>,
        depth: u32,
    ) -> TypeId {
        if let Some(result) = self.type_argument(module, definition, 1) {
            return result;
        }
        Self::callback(definition)
            .and_then(|callback| self.function_return(module, callback, None, depth).ok())
            .unwrap_or_else(|| self.add_unresolved())
    }

    /// The return type of a function: its annotation, or the type of its
    /// expression body or of its one `return`. `call` is the call the type
    /// is wanted for and the module it is written in, which bind the
    /// function's type parameters.
    pub(crate) fn function_return(
        &self,
        module: usize,
        function: FunctionLike<'_, 'a>,
        call: Option<(usize, &CallExpression<'a>)>,
        depth: u32,
    ) -> Declared {
        if depth > MAX_DEPTH {
            return Err(Origin::Other);
        }
        let (annotation, parameters) = match function {
            FunctionLike::Arrow(arrow) => (
                arrow.return_type.as_deref(),
                arrow.type_parameters.as_deref(),
            ),
            FunctionLike::Function(function) => (
                function.return_type.as_deref(),
                function.type_parameters.as_deref(),
            ),
        };
        if let Some(annotation) = annotation {
            if matches!(annotation.type_annotation, TSType::TSTypePredicate(_)) {
                return self.of(Shape::Boolean);
            }
            let env = self.bind_type_parameters(module, function, parameters, call, depth);
            return Ok(self.resolve_with(module, &annotation.type_annotation, &env));
        }
        let key = (module, function.span().start);
        if !self.enter(key) {
            return Err(Origin::UninferredReturn);
        }
        let result = if let Some(body) = function.expression_body() {
            self.typed_at(module, body, depth + 1)
        } else {
            let mut returns = Vec::new();
            for statement in function.block_body().unwrap_or(&[]) {
                returned(statement, &mut returns);
            }
            match returns.as_slice() {
                [] => self.of(Shape::Void),
                [one] => match &one.argument {
                    Some(argument) => self.typed_at(module, argument, depth + 1),
                    None => self.of(Shape::Void),
                },
                several => {
                    let mut members = Vec::new();
                    for statement in several {
                        members.push(match &statement.argument {
                            Some(argument) => self.typed_at(module, argument, depth + 1)?,
                            None => self.intern(Shape::Undefined),
                        });
                    }
                    Ok(self.union_distinct(members))
                }
            }
        };
        self.leave(key);
        result
    }

    /// Binds the type parameters of a function for one call: from the
    /// written type arguments, or from the argument whose parameter is the
    /// type parameter, an array of it, or a handle of it.
    fn bind_type_parameters(
        &self,
        module: usize,
        function: FunctionLike<'_, 'a>,
        parameters: Option<&TSTypeParameterDeclaration<'a>>,
        call: Option<(usize, &CallExpression<'a>)>,
        depth: u32,
    ) -> Vec<(SymbolId, TypeId)> {
        let (Some(parameters), Some((site, call)), Some(parsed)) =
            (parameters, call, self.parsed(module))
        else {
            return Vec::new();
        };
        let scoping = parsed.semantic.scoping();
        let mut env = Vec::new();
        for (index, parameter) in parameters.params.iter().enumerate() {
            let Some(symbol) = parameter.name.symbol_id.get() else {
                continue;
            };
            if let Some(written) = self.type_argument(site, call, index) {
                env.push((symbol, written));
                continue;
            }
            let names = |ty: &TSType<'a>| {
                matches!(ty, TSType::TSTypeReference(reference)
                    if reference.type_arguments.is_none()
                        && matches!(&reference.type_name, TSTypeName::IdentifierReference(name)
                            if symbol_of(scoping, name) == Some(symbol)))
            };
            let bound =
                function
                    .params()
                    .items
                    .iter()
                    .enumerate()
                    .find_map(|(position, formal)| {
                        let annotation = &formal.type_annotation.as_ref()?.type_annotation;
                        let argument = call.arguments.get(position)?.as_expression()?;
                        if names(annotation) {
                            return self.typed_at(site, argument, depth + 1).ok();
                        }
                        let inner = match annotation {
                            TSType::TSArrayType(array) => Some(&array.element_type),
                            TSType::TSTypeOperatorType(operator) => match &operator.type_annotation
                            {
                                TSType::TSArrayType(array) => Some(&array.element_type),
                                _ => None,
                            },
                            TSType::TSTypeReference(reference) => reference
                                .type_arguments
                                .as_ref()
                                .and_then(|arguments| arguments.params.first()),
                            _ => None,
                        }?;
                        if !names(inner) {
                            return None;
                        }
                        let argument = self.typed_at(site, argument, depth + 1).ok()?;
                        match self.shape(self.present(argument)) {
                            Shape::Handle(_, value)
                                if !matches!(annotation, TSType::TSArrayType(_)) =>
                            {
                                Some(value)
                            }
                            _ => self.element_of(argument),
                        }
                    });
            if let Some(bound) = bound {
                env.push((symbol, bound));
            }
        }
        env
    }

    /// The result of a call of a function `commonfabric` exports, for the
    /// functions whose signature this slice knows.
    fn api_call(
        &self,
        module: usize,
        name: &str,
        call: &CallExpression<'a>,
        depth: u32,
    ) -> Declared {
        let effect_result = |value: TypeId| {
            let optional = self.union_of(vec![value, self.intern(Shape::Undefined)]);
            let property = |name: &str, ty: TypeId| Property {
                name: name.to_string(),
                ty,
                optional: false,
            };
            self.of(Shape::Object(
                vec![
                    property("pending", self.intern(Shape::Boolean)),
                    property("result", optional),
                    property("error", self.intern(Shape::Unknown)),
                ],
                None,
            ))
        };
        match name {
            "computed" => {
                let callback = Self::callback(call).ok_or(Origin::CallResult)?;
                self.function_return(module, callback, None, depth)
            }
            "action" => {
                let event = self
                    .type_argument(module, call, 0)
                    .unwrap_or_else(|| self.intern(Shape::Unknown));
                self.of(Shape::Handle(HandleKind::Stream, event))
            }
            "handler" | "pattern" => Ok(self.factory_type(module, call, depth)),
            "lift" => {
                let parameters = match (self.type_argument(module, call, 0), Self::callback(call)) {
                    (Some(input), _) => Some(vec![Parameter {
                        ty: input,
                        optional: false,
                        rest: false,
                    }]),
                    (None, Some(callback)) => {
                        Some(self.written_parameters(module, callback.params(), &[], 0))
                    }
                    (None, None) => None,
                };
                Ok(self.function_with(Signature {
                    parameters,
                    result: self.lift_result(module, call, depth).ok(),
                }))
            }
            "equals" | "valueEqual" | "isWellFormedDID" => self.of(Shape::Boolean),
            "eventKey"
            | "entityRefToString"
            | "toCompactDebugString"
            | "toIndentedDebugString"
            | "renderCellReference"
            | "debugStr"
            | "currentPrincipal" => self.of(Shape::String),
            "wish" | "fetchJson" | "fetchJsonUnchecked" | "generateObject" => {
                let value = self
                    .type_argument(module, call, 0)
                    .unwrap_or_else(|| self.add_unresolved());
                effect_result(value)
            }
            "generateText" | "fetchText" => effect_result(self.intern(Shape::String)),
            "uiVariant" => self.of(Shape::Opaque("VNode".to_string())),
            "toSchema" | "schema" => self.of(Shape::Opaque("JSONSchema".to_string())),
            "sqliteDatabase" => self.of(Shape::Handle(
                HandleKind::Sqlite,
                self.intern(Shape::Unknown),
            )),
            _ => Err(Origin::ApiResult),
        }
    }

    /// The factory type of a `pattern(...)` or `handler(...)` definition.
    pub(crate) fn factory_type(
        &self,
        module: usize,
        definition: &CallExpression<'a>,
        depth: u32,
    ) -> TypeId {
        let argument = |index: usize| {
            self.type_argument(module, definition, index)
                .unwrap_or_else(|| self.intern(Shape::Unknown))
        };
        match self.builder_of(module, definition) {
            Some((Builder::Handler, _)) => {
                self.intern(Shape::HandlerFactory(argument(0), argument(1)))
            }
            _ => {
                let output = self.pattern_output(module, definition, depth);
                self.intern(Shape::PatternFactory(argument(0), output))
            }
        }
    }

    /// A global function of §9.4.
    fn global_function(&self, name: &str) -> Declared {
        match name {
            "String" | "encodeURIComponent" | "decodeURIComponent" | "encodeURI" | "decodeURI"
            | "btoa" | "atob" => self.of(Shape::String),
            "Number" | "parseInt" | "parseFloat" => self.of(Shape::Number),
            "Boolean" | "isNaN" | "isFinite" => self.of(Shape::Boolean),
            "BigInt" => self.of(Shape::BigInt),
            _ => Err(Origin::External),
        }
    }

    /// A member of a standard-library namespace, called (§9).
    fn static_member(
        &self,
        module: usize,
        namespace: &str,
        name: &str,
        call: &CallExpression<'a>,
        depth: u32,
    ) -> Declared {
        let argument = |index: usize| {
            call.arguments
                .get(index)
                .and_then(Argument::as_expression)
                .and_then(|argument| self.typed_at(module, argument, depth).ok())
        };
        let values =
            |object: Option<TypeId>| match object.map(|object| self.shape(self.present(object))) {
                Some(Shape::Object(properties, index)) => {
                    let members: Vec<TypeId> = properties
                        .iter()
                        .map(|property| property.ty)
                        .chain(index)
                        .collect();
                    if members.is_empty() {
                        self.add_unresolved()
                    } else {
                        self.union_distinct(members)
                    }
                }
                _ => self.add_unresolved(),
            };
        match (namespace, name) {
            ("Math", _) | ("Date", "now" | "parse" | "UTC") => self.of(Shape::Number),
            ("Number", "parseFloat" | "parseInt") => self.of(Shape::Number),
            ("Number", _) | ("Array", "isArray") | ("Object", "hasOwn") => self.of(Shape::Boolean),
            ("String", _) | ("JSON", "stringify") => self.of(Shape::String),
            ("JSON", "parse") => self.of(Shape::Unknown),
            ("console", _) => self.of(Shape::Void),
            ("Object", "keys") => self.of(Shape::Array(self.intern(Shape::String))),
            ("Object", "values") => self.of(Shape::Array(values(argument(0)))),
            ("Object", "entries") => {
                let pair = self.intern(Shape::Tuple(vec![
                    self.intern(Shape::String),
                    values(argument(0)),
                ]));
                self.of(Shape::Array(pair))
            }
            ("Object", "fromEntries") => {
                let value = argument(0)
                    .and_then(|entries| self.element_of(entries))
                    .and_then(|pair| match self.shape(pair) {
                        Shape::Tuple(elements) => elements.get(1).copied(),
                        _ => None,
                    })
                    .unwrap_or_else(|| self.add_unresolved());
                self.of(Shape::Object(Vec::new(), Some(value)))
            }
            ("Object", "assign" | "freeze") => argument(0).ok_or(Origin::CallResult),
            ("Array", "from") => {
                let element = match Self::callback(call) {
                    Some(mapper) => self.function_return(module, mapper, None, depth).ok(),
                    None => argument(0).and_then(|source| self.element_of(source)),
                };
                self.of(Shape::Array(
                    element.unwrap_or_else(|| self.add_unresolved()),
                ))
            }
            ("Array", "of") => {
                let elements = (0..call.arguments.len()).filter_map(argument).collect();
                self.of(Shape::Array(self.union_distinct(elements)))
            }
            _ => Err(Origin::UnlistedMember),
        }
    }

    /// The result of calling method `name` on a value of type `receiver`.
    fn method(
        &self,
        module: usize,
        receiver: TypeId,
        name: &str,
        call: &CallExpression<'a>,
        depth: u32,
    ) -> Declared {
        let receiver = self.present(receiver);
        let shape = self.shape(receiver);
        // A property that holds a factory or a function is called as a value.
        if matches!(shape, Shape::Object(..)) {
            if let Some(property) = self.property(receiver, name) {
                return self.call_of_value(property);
            }
        }
        let string = || self.of(Shape::String);
        let number = || self.of(Shape::Number);
        let boolean = || self.of(Shape::Boolean);
        match (&shape, name) {
            (Shape::Unresolved(_) | Shape::Parameter(_) | Shape::Unknown, _) => {
                Err(Origin::UntypedReceiver)
            }
            (_, "toString" | "toLocaleString") => string(),
            (Shape::String | Shape::Literal(_), _) if !is_number_literal(&shape) => match name {
                "charAt" | "concat" | "normalize" | "padEnd" | "padStart" | "repeat" | "slice"
                | "substring" | "toLowerCase" | "toUpperCase" | "trim" | "trimEnd"
                | "trimStart" | "replace" | "replaceAll" | "toLocaleLowerCase"
                | "toLocaleUpperCase" => string(),
                "at" => Ok(self.union_of(vec![
                    self.intern(Shape::String),
                    self.intern(Shape::Undefined),
                ])),
                "charCodeAt" | "codePointAt" | "indexOf" | "lastIndexOf" | "localeCompare" => {
                    number()
                }
                "endsWith" | "includes" | "startsWith" => boolean(),
                "split" => self.of(Shape::Array(self.intern(Shape::String))),
                "match" => {
                    let groups = self.intern(Shape::Array(self.intern(Shape::String)));
                    Ok(self.union_of(vec![groups, self.intern(Shape::Null)]))
                }
                _ => Err(Origin::UnlistedMember),
            },
            (Shape::Number | Shape::Literal(_), "toFixed" | "toPrecision") => string(),
            (Shape::Array(_) | Shape::Tuple(_), _) => {
                let element = self
                    .element_of(receiver)
                    .unwrap_or_else(|| self.add_unresolved());
                self.array_method(module, receiver, element, name, call, depth)
            }
            (Shape::Handle(_, value), _) => match name {
                "set" | "update" | "push" | "pushAll" | "addUnique" | "remove"
                | "removeByValue" | "removeAll" | "increment" | "applyChanges" | "send"
                | "exec" => self.of(Shape::Void),
                "equals" | "equalLinks" => boolean(),
                "resolveAsCell" | "for" => Ok(receiver),
                // `key` with a key that is not a literal: the chosen child,
                // flattened as `key` with a literal is.
                "key" | "elementById" => {
                    let child = match self.shape(self.present(*value)) {
                        Shape::Object(_, Some(index)) => index,
                        _ => self
                            .element_of(*value)
                            .unwrap_or_else(|| self.add_unresolved()),
                    };
                    match self.shape(child) {
                        Shape::Handle(..) => Ok(child),
                        _ => self.of(Shape::Handle(handle_kind_of(&shape), child)),
                    }
                }
                _ => match self.element_of(*value) {
                    Some(element) if api::is_handle_collection_method(name) => {
                        self.array_method(module, *value, element, name, call, depth)
                    }
                    _ => Err(Origin::UnlistedMember),
                },
            },
            (Shape::PatternFactory(..), "asScope" | "inSpace") => Ok(receiver),
            (Shape::Code(code), _) if code.ends_with("Map") || code.ends_with("Set") => {
                let arguments = self.code_arguments(receiver);
                let argument = |index: usize| {
                    arguments
                        .get(index)
                        .copied()
                        .unwrap_or_else(|| self.add_unresolved())
                };
                let (key, value) = if code.ends_with("Map") {
                    (argument(0), argument(1))
                } else {
                    (argument(0), argument(0))
                };
                match name {
                    "get" => Ok(self.union_of(vec![value, self.intern(Shape::Undefined)])),
                    "has" | "delete" => boolean(),
                    "set" | "add" => Ok(receiver),
                    "clear" | "forEach" => self.of(Shape::Void),
                    "keys" => self.of(Shape::Array(key)),
                    "values" => self.of(Shape::Array(value)),
                    "entries" => self.of(Shape::Array(self.intern(Shape::Tuple(vec![key, value])))),
                    _ => Err(Origin::UnlistedMember),
                }
            }
            (Shape::Code(code), _) => match (code.as_str(), name) {
                (
                    "Date",
                    "toISOString" | "toLocaleDateString" | "toLocaleTimeString" | "toDateString",
                ) => string(),
                ("Date", _) => number(),
                ("RegExp", "test")
                | ("Map" | "Set" | "ReadonlyMap" | "ReadonlySet", "has" | "delete") => boolean(),
                _ => Err(Origin::UnlistedMember),
            },
            _ => Err(Origin::UnlistedMember),
        }
    }

    /// A method of an array whose elements have type `element` (§9.2).
    fn array_method(
        &self,
        module: usize,
        array: TypeId,
        element: TypeId,
        name: &str,
        call: &CallExpression<'a>,
        depth: u32,
    ) -> Declared {
        let returned = || {
            Self::callback(call)
                .and_then(|callback| self.function_return(module, callback, None, depth).ok())
                .unwrap_or_else(|| self.add_unresolved())
        };
        let maybe = |ty: TypeId| Ok(self.union_of(vec![ty, self.intern(Shape::Undefined)]));
        match name {
            "map" => self.of(Shape::Array(returned())),
            "flatMap" => {
                let result = returned();
                let flat = self.element_of(result).unwrap_or(result);
                self.of(Shape::Array(flat))
            }
            "filter" | "slice" | "concat" | "toReversed" | "toSorted" | "toSpliced" | "reverse"
            | "sort" | "splice" | "fill" | "with" => self.of(Shape::Array(element)),
            "flat" => self.of(Shape::Array(self.element_of(element).unwrap_or(element))),
            "some" | "every" | "includes" => self.of(Shape::Boolean),
            "find" | "findLast" | "at" | "pop" | "shift" | "minBy" | "maxBy" | "min" | "max" => {
                maybe(element)
            }
            "findIndex" | "findLastIndex" | "indexOf" | "lastIndexOf" | "push" | "unshift"
            | "count" | "sum" => self.of(Shape::Number),
            "join" => self.of(Shape::String),
            "forEach" => self.of(Shape::Void),
            "reduce" | "reduceRight" => {
                if let Some(written) = self.type_argument(module, call, 0) {
                    return Ok(written);
                }
                match call.arguments.get(1).and_then(Argument::as_expression) {
                    Some(initial) => self.typed_at(module, initial, depth),
                    None => Ok(element),
                }
            }
            _ => {
                let _ = array;
                Err(Origin::UnlistedMember)
            }
        }
    }

    // ----- Callback parameters -----

    /// The type the callee of a call gives parameter `index` of the callback
    /// that is its argument `position`.
    pub(crate) fn contextual_parameter(
        &self,
        module: usize,
        call: &CallExpression<'a>,
        position: usize,
        index: usize,
        depth: u32,
    ) -> Declared {
        let Expression::StaticMemberExpression(member) = unwrap(&call.callee) else {
            return Err(Origin::CallbackParameter);
        };
        let method = member.property.name.as_str();
        if position != 0 {
            let from = matches!(unwrap(&member.object), Expression::Identifier(object) if object.name == "Array")
                && method == "from"
                && position == 1;
            if !from {
                return Err(Origin::CallbackParameter);
            }
            return match index {
                0 => call
                    .arguments
                    .first()
                    .and_then(Argument::as_expression)
                    .and_then(|source| self.typed_at(module, source, depth).ok())
                    .and_then(|source| self.element_of(source))
                    .ok_or(Origin::CallbackParameter),
                _ => self.of(Shape::Number),
            };
        }
        let receiver = self
            .typed_at(module, &member.object, depth)
            .map_err(|_| Origin::CallbackParameter)?;
        if matches!(self.shape(self.present(receiver)), Shape::String)
            && matches!(method, "replace" | "replaceAll")
        {
            return self.of(Shape::String);
        }
        if let Shape::Code(code) = self.shape(self.present(receiver)) {
            if code.ends_with("Map") && method == "forEach" {
                let arguments = self.code_arguments(self.present(receiver));
                return match (arguments.as_slice(), index) {
                    ([_, value], 0) => Ok(*value),
                    ([key, _], 1) => Ok(*key),
                    _ => Err(Origin::CallbackParameter),
                };
            }
        }
        let element = self.element_of(receiver).ok_or(Origin::CallbackParameter)?;
        match (method, index) {
            ("reduce" | "reduceRight", 0) => {
                if let Some(written) = self.type_argument(module, call, 0) {
                    return Ok(written);
                }
                call.arguments
                    .get(1)
                    .and_then(Argument::as_expression)
                    .map_or(Ok(element), |initial| self.typed_at(module, initial, depth))
            }
            ("reduce" | "reduceRight", 1) | ("sort" | "toSorted", 0 | 1) => Ok(element),
            ("reduce" | "reduceRight", 2) => self.of(Shape::Number),
            (
                "map" | "filter" | "flatMap" | "some" | "every" | "find" | "findIndex" | "findLast"
                | "findLastIndex" | "forEach" | "count" | "minBy" | "maxBy" | "groupBy" | "keyBy",
                0,
            ) => Ok(element),
            (_, 1) if api::is_element_method(method) || method == "forEach" => {
                self.of(Shape::Number)
            }
            _ => Err(Origin::CallbackParameter),
        }
    }

    // ----- Operators and literals -----

    pub(crate) fn infer_operator(
        &self,
        module: usize,
        expression: &Expression<'a>,
        depth: u32,
    ) -> Declared {
        let next = depth + 1;
        match expression {
            Expression::TemplateLiteral(_) => self.of(Shape::String),
            Expression::UpdateExpression(_) => self.of(Shape::Number),
            Expression::AssignmentExpression(assignment) => {
                self.typed_at(module, &assignment.right, next)
            }
            Expression::SequenceExpression(sequence) => match sequence.expressions.last() {
                Some(last) => self.typed_at(module, last, next),
                None => Err(Origin::Operator),
            },
            Expression::UnaryExpression(unary) => match unary.operator {
                UnaryOperator::LogicalNot | UnaryOperator::Delete => self.of(Shape::Boolean),
                UnaryOperator::Typeof => self.of(Shape::String),
                UnaryOperator::Void => self.of(Shape::Undefined),
                _ => self.of(Shape::Number),
            },
            Expression::BinaryExpression(binary) => match binary.operator {
                BinaryOperator::Addition => {
                    let text = |side: &Expression<'a>| {
                        self.typed_at(module, side, next).ok().map(|ty| {
                            let shape = self.shape(self.present(ty));
                            (
                                matches!(shape, Shape::String)
                                    || (matches!(shape, Shape::Literal(_))
                                        && !is_number_literal(&shape)),
                                matches!(shape, Shape::Number) || is_number_literal(&shape),
                            )
                        })
                    };
                    match (text(&binary.left), text(&binary.right)) {
                        (Some((true, _)), _) | (_, Some((true, _))) => self.of(Shape::String),
                        (Some((_, true)), Some((_, true))) => self.of(Shape::Number),
                        _ => Err(Origin::Operator),
                    }
                }
                BinaryOperator::Subtraction
                | BinaryOperator::Multiplication
                | BinaryOperator::Division
                | BinaryOperator::Remainder
                | BinaryOperator::Exponential
                | BinaryOperator::ShiftLeft
                | BinaryOperator::ShiftRight
                | BinaryOperator::ShiftRightZeroFill
                | BinaryOperator::BitwiseOR
                | BinaryOperator::BitwiseXOR
                | BinaryOperator::BitwiseAnd => self.of(Shape::Number),
                _ => self.of(Shape::Boolean),
            },
            Expression::LogicalExpression(logical) => {
                let left = self.typed_at(module, &logical.left, next)?;
                let right = self.typed_at(module, &logical.right, next)?;
                let left = match logical.operator {
                    LogicalOperator::Coalesce | LogicalOperator::Or => self.present(left),
                    LogicalOperator::And => left,
                };
                Ok(self.union_distinct(vec![left, right]))
            }
            Expression::ConditionalExpression(conditional) => {
                let consequent = self.typed_at(module, &conditional.consequent, next)?;
                let alternate = self.typed_at(module, &conditional.alternate, next)?;
                Ok(self.union_distinct(vec![consequent, alternate]))
            }
            _ => Err(Origin::Operator),
        }
    }

    pub(crate) fn infer_literal(
        &self,
        module: usize,
        expression: &Expression<'a>,
        depth: u32,
    ) -> Declared {
        let next = depth + 1;
        match expression {
            Expression::RegExpLiteral(_) => self.of(Shape::Code("RegExp".to_string())),
            Expression::ArrayExpression(array) => {
                let mut elements = Vec::new();
                for element in &array.elements {
                    match element {
                        ArrayExpressionElement::SpreadElement(spread) => {
                            let spread = self.part(module, &spread.argument, next);
                            elements.push(
                                self.element_of(spread)
                                    .unwrap_or_else(|| self.add_unresolved()),
                            );
                        }
                        ArrayExpressionElement::Elision(_) => {}
                        other => elements.push(self.part(module, other.to_expression(), next)),
                    }
                }
                if elements.is_empty() {
                    return self.of(Shape::Array(self.add_unresolved()));
                }
                self.of(Shape::Array(self.union_distinct(elements)))
            }
            Expression::ObjectExpression(object) => {
                let mut properties: Vec<Property> = Vec::new();
                let mut index = None;
                for property in &object.properties {
                    match property {
                        ObjectPropertyKind::SpreadProperty(spread) => {
                            let spread = self.part(module, &spread.argument, next);
                            match self.shape(self.present(spread)) {
                                Shape::Object(inner, inner_index) => {
                                    for property in inner {
                                        properties.retain(|own| own.name != property.name);
                                        properties.push(property);
                                    }
                                    index = index.or(inner_index);
                                }
                                // What the spread adds is not known, so any
                                // other property reads as unresolved.
                                _ => index = Some(self.add_unresolved()),
                            }
                        }
                        ObjectPropertyKind::ObjectProperty(property) => {
                            let Some(name) =
                                static_key_name(&property.key).filter(|_| !property.computed)
                            else {
                                index = Some(self.add_unresolved());
                                continue;
                            };
                            let ty = self.part(module, &property.value, next);
                            properties.retain(|own| own.name != name);
                            properties.push(Property {
                                name: name.to_string(),
                                ty,
                                optional: false,
                            });
                        }
                    }
                }
                self.of(Shape::Object(properties, index))
            }
            _ => Err(Origin::Literal),
        }
    }

    /// The type of `new callee(...)` for a constructor of §9.
    pub(crate) fn infer_new(&self, module: usize, new: &NewExpression<'a>) -> Declared {
        let parsed = self.parsed(module).ok_or(Origin::External)?;
        let Expression::Identifier(callee) = unwrap(&new.callee) else {
            return Err(Origin::CallResult);
        };
        if symbol_of(parsed.semantic.scoping(), callee).is_some() {
            return Err(Origin::CallResult);
        }
        match callee.name.as_str() {
            "Array" => self.of(Shape::Array(self.add_unresolved())),
            name @ ("Map" | "Set") => {
                let mut arguments: Vec<TypeId> = new
                    .type_arguments
                    .iter()
                    .flat_map(|arguments| &arguments.params)
                    .map(|written| self.resolve_type(module, written))
                    .collect();
                if arguments.is_empty() {
                    // The element type of the iterable the container is made
                    // from: an element for a `Set`, a pair for a `Map`.
                    let element = new
                        .arguments
                        .first()
                        .and_then(Argument::as_expression)
                        .and_then(|source| self.typed_at(module, source, 1).ok())
                        .and_then(|source| self.element_of(source));
                    match (name, element.map(|element| (element, self.shape(element)))) {
                        ("Set", Some((element, _))) => arguments.push(element),
                        ("Map", Some((_, Shape::Tuple(pair)))) if pair.len() == 2 => {
                            arguments = pair
                        }
                        _ => {}
                    }
                }
                Ok(self.code_type(name, arguments))
            }
            name @ ("Date" | "Error" | "TypeError" | "RangeError" | "URL" | "RegExp"
            | "Uint8Array" | "TextEncoder") => self.of(Shape::Code(name.to_string())),
            _ => Err(Origin::External),
        }
    }

    /// The type of an expression of another form: JSX, a function, and the
    /// rest, which has none.
    pub(crate) fn infer_other(
        &self,
        module: usize,
        expression: &Expression<'a>,
        depth: u32,
    ) -> Declared {
        match expression {
            Expression::JSXElement(_) | Expression::JSXFragment(_) => {
                self.of(Shape::Opaque("VNode".to_string()))
            }
            Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
                let function = FunctionLike::of(expression).ok_or(Origin::Other)?;
                Ok(self.function_value(module, function, depth))
            }
            _ => Err(Origin::Other),
        }
    }

    /// The function type of a function written in the source: its
    /// parameter types as annotated, and its result type as annotated or
    /// inferred (§7.1, §7.6).
    pub(crate) fn function_value(
        &self,
        module: usize,
        function: FunctionLike<'_, 'a>,
        depth: u32,
    ) -> TypeId {
        let parameters = self.written_parameters(module, function.params(), &[], 0);
        let result = self.function_return(module, function, None, depth).ok();
        self.function_with(Signature {
            parameters: Some(parameters),
            result,
        })
    }

    /// The parameters the callee of `call` declares, with the callee's type
    /// parameters bound for this call. `None` where the callee has no
    /// signature this slice knows.
    pub(crate) fn callee_parameters(
        &self,
        module: usize,
        call: &CallExpression<'a>,
        depth: u32,
    ) -> Option<Vec<Parameter>> {
        if depth > MAX_DEPTH {
            return None;
        }
        let next = depth + 1;
        let parsed = self.parsed(module)?;
        let callee = unwrap(&call.callee);
        if self.api_name(module, callee).is_some() {
            return None;
        }
        if let Expression::Identifier(identifier) = callee {
            let symbol = symbol_of(parsed.semantic.scoping(), identifier)?;
            let (home, symbol) = self.origin(module, symbol)?;
            let parsed = self.parsed(home)?;
            let declaration = parsed.semantic.scoping().symbol_declaration(symbol);
            let function = match parsed.semantic.nodes().kind(declaration) {
                AstKind::Function(function) => Some(FunctionLike::Function(function)),
                AstKind::VariableDeclarator(declarator)
                    if matches!(declarator.id, BindingPattern::BindingIdentifier(_))
                        && declarator.type_annotation.is_none() =>
                {
                    declarator.init.as_ref().and_then(FunctionLike::of)
                }
                _ => None,
            };
            if let Some(function) = function {
                let type_parameters = match function {
                    FunctionLike::Arrow(arrow) => arrow.type_parameters.as_deref(),
                    FunctionLike::Function(function) => function.type_parameters.as_deref(),
                };
                let env = self.bind_type_parameters(
                    home,
                    function,
                    type_parameters,
                    Some((module, call)),
                    next,
                );
                return Some(self.written_parameters(home, function.params(), &env, 0));
            }
        }
        let callee = self.typed_at(module, callee, next).ok()?;
        self.parameters_of(callee)
    }

    /// The parameters a value of type `callee` is called with: those of a
    /// function type, the input of a pattern factory, and the state of a
    /// handler factory (§4.4.2).
    pub(crate) fn parameters_of(&self, callee: TypeId) -> Option<Vec<Parameter>> {
        let callee = self.present(callee);
        let one = |ty: TypeId| {
            Some(vec![Parameter {
                ty,
                optional: false,
                rest: false,
            }])
        };
        match self.shape(callee) {
            Shape::Function => self.signature(callee).parameters,
            Shape::PatternFactory(input, _) => one(input),
            Shape::HandlerFactory(_, state) => one(state),
            _ => None,
        }
    }

    /// The type of a member of a standard-library value that is read and
    /// not called: `length` and `size`.
    pub(crate) fn member_of(&self, object: TypeId, name: &str) -> Option<TypeId> {
        match (self.shape(self.present(object)), name) {
            (Shape::Array(_) | Shape::Tuple(_) | Shape::String, "length") => {
                Some(self.intern(Shape::Number))
            }
            (Shape::Code(code), "size") if code.ends_with("Map") || code.ends_with("Set") => {
                Some(self.intern(Shape::Number))
            }
            (Shape::Code(code), "message" | "name") if code.ends_with("Error") => {
                Some(self.intern(Shape::String))
            }
            _ => None,
        }
    }
}

fn handle_kind_of(shape: &Shape) -> HandleKind {
    match shape {
        Shape::Handle(kind, _) => *kind,
        _ => HandleKind::Cell,
    }
}

fn is_number_literal(shape: &Shape) -> bool {
    matches!(shape, Shape::Literal(text) if text.starts_with(|c: char| c.is_ascii_digit() || c == '-'))
}

/// Collects the `return` statements of a body, without those of functions
/// nested in it.
fn returned<'e, 'a>(statement: &'e Statement<'a>, out: &mut Vec<&'e ReturnStatement<'a>>) {
    match statement {
        Statement::ReturnStatement(statement) => out.push(statement),
        Statement::BlockStatement(block) => block
            .body
            .iter()
            .for_each(|statement| returned(statement, out)),
        Statement::IfStatement(statement) => {
            returned(&statement.consequent, out);
            if let Some(alternate) = &statement.alternate {
                returned(alternate, out);
            }
        }
        Statement::ForStatement(statement) => returned(&statement.body, out),
        Statement::ForInStatement(statement) => returned(&statement.body, out),
        Statement::ForOfStatement(statement) => returned(&statement.body, out),
        Statement::WhileStatement(statement) => returned(&statement.body, out),
        Statement::DoWhileStatement(statement) => returned(&statement.body, out),
        Statement::LabeledStatement(statement) => returned(&statement.body, out),
        Statement::SwitchStatement(statement) => statement
            .cases
            .iter()
            .flat_map(|case| &case.consequent)
            .for_each(|statement| returned(statement, out)),
        Statement::TryStatement(statement) => {
            statement
                .block
                .body
                .iter()
                .for_each(|statement| returned(statement, out));
            if let Some(handler) = &statement.handler {
                handler
                    .body
                    .body
                    .iter()
                    .for_each(|statement| returned(statement, out));
            }
            if let Some(finalizer) = &statement.finalizer {
                finalizer
                    .body
                    .iter()
                    .for_each(|statement| returned(statement, out));
            }
        }
        _ => {}
    }
}
