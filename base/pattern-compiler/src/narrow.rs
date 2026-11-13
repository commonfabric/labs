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
#[derive(Debug, Clone)]
struct Reference {
    root: SymbolId,
    path: Vec<String>,
    /// Whether the reference narrowed is a data position (§7.8). It is set
    /// for the reference whose type is asked for, and takes no part in
    /// comparing two references.
    data: bool,
}

impl PartialEq for Reference {
    fn eq(&self, other: &Self) -> bool {
        self.root == other.root && self.path == other.path
    }
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
                // `a?.b` reads the path `a.b`.
                Expression::ChainExpression(chain) => match &chain.expression {
                    ChainElement::StaticMemberExpression(member) => {
                        path.push(member.property.name.to_string());
                        &member.object
                    }
                    _ => return None,
                },
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
                    return Some(Reference {
                        root,
                        path,
                        data: false,
                    });
                }
                _ => return None,
            };
        }
    }

    /// Whether a binding is a root of data positions, or is reached from
    /// one through `const` bindings and destructuring alone (§7.8): a
    /// parameter of the callback of a builder, of an inline event handler,
    /// or of a reactive collection callback, and a binding of tier R. A
    /// position typed `unknown` that is reached from such a binding is a
    /// reference to stored data and not a value the body computed.
    pub(crate) fn is_data_binding(&self, module: usize, symbol: SymbolId, depth: u32) -> bool {
        if depth > 8 {
            return false;
        }
        let Some((home, symbol)) = self.origin(module, symbol) else {
            return false;
        };
        let module = home;
        let Some((parsed, model)) = self.parsed(module).zip(self.model(module)) else {
            return false;
        };
        let scoping = parsed.semantic.scoping();
        let nodes = parsed.semantic.nodes();
        let declaration = scoping.symbol_declaration(symbol);
        let mut kinds = vec![nodes.kind(declaration)];
        kinds.extend(nodes.ancestor_kinds(declaration));
        let mut function: Option<Span> = None;
        for kind in kinds {
            match kind {
                AstKind::ArrowFunctionExpression(arrow) if function.is_none() => {
                    function = Some(arrow.span);
                }
                AstKind::Function(found) if function.is_none() => function = Some(found.span),
                AstKind::FormalParameters(_)
                | AstKind::FormalParameter(_)
                | AstKind::BindingRestElement(_)
                | AstKind::ObjectPattern(_)
                | AstKind::ArrayPattern(_)
                | AstKind::BindingProperty(_)
                | AstKind::BindingIdentifier(_)
                | AstKind::AssignmentPattern(_) => {}
                // A local binding: every binding of tier R, and a `const`
                // whose initializer is a data position.
                AstKind::VariableDeclarator(declarator) if function.is_none() => {
                    if self.place_at(module, declarator.span.start)
                        == crate::program::Place::Reactive
                    {
                        return true;
                    }
                    if declarator.kind != VariableDeclarationKind::Const {
                        return false;
                    }
                    return match &declarator.init {
                        Some(init) => self.is_data_expression(module, init, depth + 1),
                        // The variable of a `for...of` over a data position.
                        None => nodes
                            .ancestor_kinds(declarator.node_id.get())
                            .take(3)
                            .find_map(|kind| match kind {
                                AstKind::ForOfStatement(statement) => Some(
                                    self.is_data_expression(module, &statement.right, depth + 1),
                                ),
                                _ => None,
                            })
                            .unwrap_or(false),
                    };
                }
                // The parameter of a function: the function is the callback
                // of a builder, an inline event handler, or a reactive
                // collection callback.
                AstKind::CallExpression(call) => {
                    let Some(function) = function else {
                        return false;
                    };
                    let is_argument = call
                        .arguments
                        .iter()
                        .any(|argument| argument.span() == function);
                    if is_argument
                        && model
                            .api_ref_of_callee(scoping, &call.callee)
                            .is_some_and(|api| matches!(api.value(), ApiValue::Builder(_)))
                    {
                        return true;
                    }
                    return self.is_reactive_callback(module, function);
                }
                _ => {
                    return function
                        .is_some_and(|function| self.is_reactive_callback(module, function))
                }
            }
        }
        false
    }

    /// Whether the function at `span` is a reactive collection callback or
    /// an inline event handler.
    fn is_reactive_callback(&self, module: usize, span: Span) -> bool {
        use crate::tiers::BodyKind;
        matches!(
            self.body_of_span(module, (span.start, span.end)),
            Some(BodyKind::ElementCallback | BodyKind::InlineHandler)
        )
    }

    /// Whether an expression typed `unknown` is a data position (§7.8): it
    /// is written in tier R, or it is reached through property reads,
    /// element reads, destructuring, and `const` bindings from a root of
    /// data positions or from the result of `get()` or `sample()` on a
    /// handle.
    pub(crate) fn is_data_expression(
        &self,
        module: usize,
        expression: &Expression<'a>,
        depth: u32,
    ) -> bool {
        if depth > 8 {
            return false;
        }
        if self.place_at(module, expression.span().start) == crate::program::Place::Reactive {
            return true;
        }
        let mut current = expression;
        loop {
            current = match current {
                Expression::ParenthesizedExpression(inner) => &inner.expression,
                Expression::TSNonNullExpression(inner) => &inner.expression,
                Expression::StaticMemberExpression(member) => &member.object,
                Expression::ComputedMemberExpression(member) => &member.object,
                Expression::ChainExpression(chain) => match &chain.expression {
                    ChainElement::StaticMemberExpression(member) => &member.object,
                    ChainElement::ComputedMemberExpression(member) => &member.object,
                    ChainElement::CallExpression(call) => return self.is_handle_read(module, call),
                    _ => return false,
                },
                Expression::CallExpression(call) => return self.is_handle_read(module, call),
                Expression::Identifier(identifier) => {
                    return self
                        .parsed(module)
                        .and_then(|parsed| symbol_of(parsed.semantic.scoping(), identifier))
                        .is_some_and(|symbol| self.is_data_binding(module, symbol, depth + 1));
                }
                _ => return false,
            };
        }
    }

    /// Whether a call is `get()` or `sample()` on a handle.
    fn is_handle_read(&self, module: usize, call: &CallExpression<'a>) -> bool {
        let Expression::StaticMemberExpression(member) = unparen(&call.callee) else {
            return false;
        };
        matches!(member.property.name.as_str(), "get" | "sample")
            && call.arguments.is_empty()
            && self
                .typed_at(module, &member.object, 0)
                .is_ok_and(|receiver| {
                    matches!(self.shape(self.present(receiver)), Shape::Handle(..))
                })
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
        let Some(mut reference) = self.reference_of(module, expression) else {
            return ty;
        };
        let Some(parsed) = self.parsed(module) else {
            return ty;
        };
        reference.data = self.is_data_expression(module, expression, 0);
        let nodes = parsed.semantic.nodes();
        // A binding that is assigned is narrowed by the assignment that
        // reaches the reference, and by the conditions no assignment
        // follows (§7.6).
        let writes = if parsed.semantic.scoping().symbol_is_mutated(reference.root) {
            if !reference.path.is_empty() {
                return ty;
            }
            match self.writes_of(module, reference.root, expression) {
                Some(writes) => Some(writes),
                None => return ty,
            }
        } else {
            None
        };
        let at = expression.span().start;
        let ty = match &writes {
            Some(writes) => self.assigned(module, writes, at, ty),
            None => ty,
        };
        // The conditions that hold, innermost first, each with whether it
        // is true or false there.
        let mut conditions: Vec<(Condition<'_, 'a>, bool, u32)> = Vec::new();
        let mut child = expression.span();
        for kind in nodes.ancestor_kinds(expression.node_id()) {
            match kind {
                AstKind::IfStatement(statement) => {
                    if contains(statement.consequent.span(), child) {
                        conditions.push((
                            Condition::Test(&statement.test),
                            true,
                            statement.test.span().end,
                        ));
                    } else if statement
                        .alternate
                        .as_ref()
                        .is_some_and(|alternate| contains(alternate.span(), child))
                    {
                        conditions.push((
                            Condition::Test(&statement.test),
                            false,
                            statement.test.span().end,
                        ));
                    }
                }
                AstKind::ConditionalExpression(conditional) => {
                    if contains(conditional.consequent.span(), child) {
                        conditions.push((
                            Condition::Test(&conditional.test),
                            true,
                            conditional.test.span().end,
                        ));
                    } else if contains(conditional.alternate.span(), child) {
                        conditions.push((
                            Condition::Test(&conditional.test),
                            false,
                            conditional.test.span().end,
                        ));
                    }
                }
                AstKind::LogicalExpression(logical) => {
                    if contains(logical.right.span(), child) {
                        match logical.operator {
                            LogicalOperator::And => {
                                conditions.push((
                                    Condition::Test(&logical.left),
                                    true,
                                    logical.left.span().end,
                                ));
                            }
                            LogicalOperator::Or => {
                                conditions.push((
                                    Condition::Test(&logical.left),
                                    false,
                                    logical.left.span().end,
                                ));
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
                            conditions.push((
                                Condition::Equal(&statement.discriminant, test),
                                true,
                                statement.discriminant.span().end,
                            ));
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
        for (condition, sense, guard) in conditions.into_iter().rev() {
            if writes
                .as_ref()
                .is_some_and(|writes| writes.follows(guard, at))
            {
                continue;
            }
            narrowed = match condition {
                Condition::Test(test) => self.assume(module, test, sense, &reference, narrowed),
                Condition::Equal(left, right) => {
                    self.assume_equal(module, left, right, true, sense, &reference, narrowed)
                }
            };
        }
        narrowed
    }

    /// The assignments to a binding, for narrowing the reference
    /// `expression` to it. `None` where the reference is not narrowed at
    /// all: the binding is assigned in another function than the one the
    /// reference is written in.
    fn writes_of(
        &self,
        module: usize,
        symbol: SymbolId,
        expression: &Expression<'a>,
    ) -> Option<Writes<'a>> {
        let parsed = self.parsed(module)?;
        let scoping = parsed.semantic.scoping();
        let nodes = parsed.semantic.nodes();
        let function_of = |node| {
            nodes.ancestor_kinds(node).find_map(|kind| match kind {
                AstKind::ArrowFunctionExpression(arrow) => Some(arrow.span),
                AstKind::Function(function) => Some(function.span),
                _ => None,
            })
        };
        let declaration = scoping.symbol_declaration(symbol);
        // The function the reference is written in. Every assignment has to
        // be written in it too: what another function assigns is not seen
        // in this one's order of statements.
        let home = function_of(expression.node_id());
        let mut writes = Vec::new();
        let AstKind::VariableDeclarator(declarator) = nodes.kind(declaration) else {
            return None;
        };
        if !matches!(declarator.id, BindingPattern::BindingIdentifier(_)) {
            return None;
        }
        // The declaration assigns its initializer, where it is written in
        // the same function. A binding of an enclosing function has its
        // declared type where this function begins.
        if function_of(declaration) == home {
            if let Some(init) = &declarator.init {
                // The statement of a declarator is the declaration.
                let statement = nodes
                    .ancestor_kinds(declaration)
                    .find_map(|kind| match kind {
                        AstKind::VariableDeclaration(declaration) => Some(declaration.span),
                        _ => None,
                    })
                    .unwrap_or(declarator.span);
                writes.push(Write {
                    span: declarator.span,
                    statement: Some(statement),
                    value: Some(init),
                });
            }
        }
        for reference in scoping.get_resolved_references(symbol) {
            if !reference.is_write() {
                continue;
            }
            let node = reference.node_id();
            if function_of(node) != home {
                return None;
            }
            let mut ancestors = nodes.ancestor_kinds(node);
            let write = match ancestors.next() {
                Some(AstKind::AssignmentExpression(assignment))
                    if assignment.operator == oxc_syntax::operator::AssignmentOperator::Assign =>
                {
                    // An assignment that is a statement of its own.
                    let statement = match ancestors.next() {
                        Some(AstKind::ExpressionStatement(statement)) => Some(statement.span),
                        _ => None,
                    };
                    Write {
                        span: assignment.span,
                        statement,
                        value: Some(&assignment.right),
                    }
                }
                Some(other) => Write {
                    span: other.span(),
                    statement: None,
                    value: None,
                },
                None => continue,
            };
            writes.push(write);
        }
        // The loops and the blocks around the reference, innermost first.
        let mut loops = Vec::new();
        let mut blocks = Vec::new();
        for kind in nodes.ancestor_kinds(expression.node_id()) {
            match kind {
                AstKind::ForStatement(_)
                | AstKind::ForInStatement(_)
                | AstKind::ForOfStatement(_)
                | AstKind::WhileStatement(_)
                | AstKind::DoWhileStatement(_) => loops.push(kind.span()),
                AstKind::BlockStatement(block) => blocks.push(&block.body),
                AstKind::FunctionBody(body) => blocks.push(&body.statements),
                AstKind::Program(program) => blocks.push(&program.body),
                AstKind::SwitchCase(case) => blocks.push(&case.consequent),
                AstKind::ArrowFunctionExpression(_) | AstKind::Function(_) => break,
                _ => {}
            }
        }
        let blocks = blocks
            .into_iter()
            .map(|statements| statements.iter().map(GetSpan::span).collect())
            .collect();
        Some(Writes {
            writes,
            loops,
            blocks,
        })
    }

    /// `declared`, the declared type of a binding, narrowed by the
    /// assignment that reaches the reference at `at`: the last assignment
    /// before it, where that assignment is a statement of a block around
    /// the reference and no loop around the reference assigns the binding
    /// outside it.
    fn assigned(&self, module: usize, writes: &Writes<'a>, at: u32, declared: TypeId) -> TypeId {
        let Shape::Union(members) = self.shape(declared) else {
            return declared;
        };
        let Some(last) = writes
            .writes
            .iter()
            .filter(|write| write.span.start < at && !contains(write.span, Span::new(at, at)))
            .max_by_key(|write| write.span.start)
        else {
            return declared;
        };
        let (Some(statement), Some(value)) = (last.statement, last.value) else {
            return declared;
        };
        let reaches = writes
            .blocks
            .iter()
            .any(|block: &Vec<Span>| block.contains(&statement));
        let looped = writes.loops.iter().any(|around| {
            !contains(*around, last.span)
                && writes
                    .writes
                    .iter()
                    .any(|write| contains(*around, write.span))
        });
        if !reaches || looped {
            return declared;
        }
        let Ok(assigned) = self.typed_at(module, value, 0) else {
            return declared;
        };
        let given = match self.shape(assigned) {
            Shape::Union(given) => given,
            _ => vec![assigned],
        };
        let mut kept = Vec::new();
        for member in &members {
            let mut fits = false;
            for given in &given {
                match self.assignable(*given, *member) {
                    Some(true) => fits = true,
                    Some(false) => {}
                    // A container made without type arguments is the
                    // declared container of that name.
                    None => match (self.shape(*given), self.shape(*member)) {
                        (Shape::Code(given), Shape::Code(member)) if given == member => {
                            fits = true;
                        }
                        _ => return declared,
                    },
                }
            }
            if fits {
                kept.push(*member);
            }
        }
        if kept.is_empty() {
            declared
        } else {
            self.union_of(kept)
        }
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
                    // Both operands hold. The left one is applied again
                    // after the right one, which may have given `unknown`
                    // the members the left one removes.
                    let ty = self.assume(module, &logical.left, sense, reference, ty);
                    let ty = self.assume(module, &logical.right, sense, reference, ty);
                    self.assume(module, &logical.left, sense, reference, ty)
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
                    self.assume_kind(sense, reference, ty, Some(instance), |shape| match shape {
                        Shape::Code(code) if code == name => Kind::Yes,
                        Shape::Code(code) if name == "Error" && code.ends_with("Error") => {
                            Kind::Yes
                        }
                        Shape::Unknown | Shape::Unresolved(_) | Shape::Parameter(_) => Kind::Unsure,
                        _ => Kind::No,
                    })
                }
                _ => ty,
            },
            Expression::CallExpression(call) => {
                self.assume_call(module, call, sense, reference, ty)
            }
            // A chain that is truthy did not stop, so each receiver it
            // tests with `?.` is present.
            Expression::ChainExpression(chain) if sense => {
                if self.chain_tests(module, &chain.expression, reference) {
                    self.present(ty)
                } else {
                    ty
                }
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
                Some(whole) if sense && !reference.data => whole,
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
                self.assume_kind(sense, reference, ty, Some(whole), |shape| match shape {
                    Shape::Array(_) | Shape::Tuple(_) => Kind::Yes,
                    Shape::Unknown | Shape::Unresolved(_) | Shape::Parameter(_) => Kind::Unsure,
                    _ => Kind::No,
                })
            }
            // `isWellFormedDID(x)` has the predicate `x is DID`, and a DID
            // is a string.
            Expression::Identifier(_)
                if self.api_callee(module, call).as_deref() == Some("isWellFormedDID") =>
            {
                if argument(0)
                    .and_then(|argument| self.reference_of(module, argument))
                    .as_ref()
                    != Some(reference)
                {
                    return ty;
                }
                let string = self.intern(Shape::String);
                if self.shape(ty) == Shape::Unknown {
                    return if sense { string } else { ty };
                }
                self.filter(ty, |member, _| {
                    self.assignable(member, string)
                        .is_none_or(|fits| fits == sense)
                })
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
            .map(|shape| self.intern(shape))
            // An object, or `null`: a type with no property (§7.8).
            .or_else(|| {
                (kind == "object").then(|| {
                    self.union_of(vec![
                        self.intern(Shape::NonPrimitive),
                        self.intern(Shape::Null),
                    ])
                })
            });
            return self.assume_kind(sense, reference, ty, whole, |shape| {
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
                    | Shape::NonPrimitive
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
        // `typeof a?.b === "kind"` with a kind other than `undefined`, and
        // `a?.b === value` with a value that is never absent: the chain did
        // not stop.
        if sense {
            for (tested, other) in [(left, right), (right, left)] {
                let chain = match tested {
                    Expression::ChainExpression(chain) => {
                        let present = self.typed_at(module, other, 0).is_ok_and(|ty| {
                            self.present(ty) == ty
                                && self.first_unresolved(ty, 0).is_none()
                                && !matches!(
                                    self.shape(ty),
                                    Shape::Unknown | Shape::Null | Shape::Undefined | Shape::Void
                                )
                        });
                        present.then_some(chain)
                    }
                    Expression::UnaryExpression(unary)
                        if unary.operator == UnaryOperator::Typeof =>
                    {
                        match (unparen(&unary.argument), other) {
                            (
                                Expression::ChainExpression(chain),
                                Expression::StringLiteral(kind),
                            ) if kind.value != "undefined" => Some(chain),
                            _ => None,
                        }
                    }
                    _ => None,
                };
                if let Some(chain) = chain {
                    if self.chain_tests(module, &chain.expression, reference) {
                        return self.present(ty);
                    }
                }
            }
        }
        for (tested, value) in [(left, right), (right, left)] {
            let Some(value) = self.unit_of(module, value) else {
                continue;
            };
            // A chain that is not `undefined` did not stop, so each
            // receiver it tests with `?.` is present.
            if let Expression::ChainExpression(chain) = tested {
                let defined = match &value {
                    Unit::Undefined => !sense,
                    Unit::Null => !sense && !strict,
                    Unit::Literal(_) => sense,
                };
                if defined && self.chain_tests(module, &chain.expression, reference) {
                    return self.present(ty);
                }
                // The path the chain reads is narrowed as a path is. A
                // receiver of the chain is not narrowed by it otherwise.
                match self.reference_of(module, tested) {
                    Some(tested) if tested == *reference => {
                        return self.assume_value(&value, strict, sense, ty);
                    }
                    _ => continue,
                }
            }
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

    /// Whether the chain tests `reference` with `?.`: some link of it is
    /// optional and has the reference as its receiver.
    fn chain_tests(
        &self,
        module: usize,
        element: &ChainElement<'a>,
        reference: &Reference,
    ) -> bool {
        let (mut optional, mut object) = match element {
            ChainElement::StaticMemberExpression(member) => (member.optional, &member.object),
            ChainElement::ComputedMemberExpression(member) => (member.optional, &member.object),
            ChainElement::CallExpression(call) => (call.optional, &call.callee),
            _ => return false,
        };
        loop {
            if optional && self.reference_of(module, object).as_ref() == Some(reference) {
                return true;
            }
            (optional, object) = match object {
                Expression::StaticMemberExpression(member) => (member.optional, &member.object),
                Expression::ComputedMemberExpression(member) => (member.optional, &member.object),
                Expression::CallExpression(call) => (call.optional, &call.callee),
                Expression::TSNonNullExpression(inner) => (false, &inner.expression),
                Expression::ParenthesizedExpression(inner) => (false, &inner.expression),
                _ => return false,
            };
        }
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

/// One assignment to a binding.
struct Write<'a> {
    span: Span,
    /// The statement the assignment is, where it is one of its own.
    statement: Option<Span>,
    /// The value assigned, for `=` and for an initializer.
    value: Option<&'a Expression<'a>>,
}

/// The assignments to a binding, with the loops and the blocks around the
/// reference that is narrowed.
struct Writes<'a> {
    writes: Vec<Write<'a>>,
    loops: Vec<Span>,
    /// The spans of the statements of each block around the reference.
    blocks: Vec<Vec<Span>>,
}

impl Writes<'_> {
    /// Whether an assignment may run after the condition tested at `guard`
    /// and before the reference at `at`: one is written between the two, or
    /// a loop that begins after the condition holds the reference and an
    /// assignment.
    fn follows(&self, guard: u32, at: u32) -> bool {
        let between = self.writes.iter().any(|write| {
            guard <= write.span.start
                && write.span.start < at
                && !contains(write.span, Span::new(at, at))
        });
        let looped = self.loops.iter().any(|around| {
            guard <= around.start
                && self
                    .writes
                    .iter()
                    .any(|write| contains(*around, write.span))
        });
        between || looped
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
    conditions: &mut Vec<(Condition<'e, 'a>, bool, u32)>,
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
            (true, false) => conditions.push((
                Condition::Test(&statement.test),
                false,
                statement.test.span().end,
            )),
            (false, true) => conditions.push((
                Condition::Test(&statement.test),
                true,
                statement.test.span().end,
            )),
            _ => {}
        }
    }
}
