//! The records the front end keeps of each body: its tier, its kind, where it
//! is written, what it captures, and the calls it makes.
//!
//! These are plain data with byte spans and no reference into the syntax
//! tree. The type checker and footprint analysis read them
//! (`footprint-analysis.md` §1.2 lists the bodies the analysis runs on).

use serde::Serialize;

/// The tiers of `language-subset.md` §1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    /// The top level of a module (tier M).
    Module,
    /// A pattern callback and everything compiled in it (tier R).
    Reactive,
    /// A body that runs in the sandbox (tier F).
    Function,
    /// A module that begins with `"use typescript";` (tier I).
    Imported,
}

/// What a body is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BodyKind {
    /// The callback of `pattern(...)`.
    Pattern,
    /// The callback of `lift(...)`.
    Lift,
    /// The callback of `handler(...)`.
    Handler,
    /// The function given to `computed(...)`.
    Computed,
    /// The function given to `action(...)`.
    Action,
    /// The function given to `assert(...)`.
    Assert,
    /// An arrow function written as an `on*` attribute of JSX.
    InlineHandler,
    /// The callback of a reactive collection method.
    ElementCallback,
    /// A function declared at module scope.
    AuthoredFunction,
}

impl BodyKind {
    /// The kinds in the order the corpus report prints them.
    pub const ALL: [BodyKind; 9] = [
        BodyKind::Pattern,
        BodyKind::Lift,
        BodyKind::Handler,
        BodyKind::Computed,
        BodyKind::Action,
        BodyKind::Assert,
        BodyKind::InlineHandler,
        BodyKind::ElementCallback,
        BodyKind::AuthoredFunction,
    ];

    pub fn label(self) -> &'static str {
        match self {
            BodyKind::Pattern => "pattern",
            BodyKind::Lift => "lift",
            BodyKind::Handler => "handler",
            BodyKind::Computed => "computed",
            BodyKind::Action => "action",
            BodyKind::Assert => "assert",
            BodyKind::InlineHandler => "inline event handler",
            BodyKind::ElementCallback => "per-element callback",
            BodyKind::AuthoredFunction => "authored function",
        }
    }
}

/// Where a body is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Site {
    /// At module scope.
    Module,
    /// In the reactive tier.
    Reactive,
    /// In a function body.
    Function,
}

/// The outcome of the promotion criterion of `language-subset.md` §6.1 for a
/// `computed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case", tag = "outcome")]
pub enum Promotion {
    /// The `computed` is in statement position and exists for its writes.
    Statement,
    /// Promoted: an expression or a `const`-then-`return` body.
    Promoted {
        /// Whether the body calls an authored function or a `lift` result.
        calls_function: bool,
        /// Whether the body needed the guard form of the criterion.
        guard: bool,
    },
    /// Not promoted. `statement_body` is true when the body is not
    /// expression-shaped, and false when an expression in it disqualifies.
    NotPromoted {
        statement_body: bool,
        reason: String,
    },
}

/// The kind of a call a body makes, for the calls the later stages need
/// (`language-subset.md` §5.2 and §4.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CallKind {
    /// An instantiation of a pattern, by a call or by a JSX tag.
    Instantiate,
    /// A handler applied to its state.
    BindHandler,
    /// A cell constructor.
    CreateCell,
    /// A request of an effectful built-in.
    Effect,
    /// A context read.
    ContextRead,
    /// A structural built-in.
    Structural,
    /// A call of an authored function.
    Function,
    /// A call of a `lift` result.
    Lift,
    /// A reactive collection method, in the reactive tier.
    Collection,
    /// A collection method on a declared cell handle, in a function body.
    HandleCollection,
}

/// One call a body makes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CallSite {
    pub kind: CallKind,
    /// The callee's name as written, or the method's name.
    pub name: String,
    pub span: (u32, u32),
}

/// One value a body refers to that is declared in an enclosing function.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Capture {
    pub name: String,
    /// The span of the captured binding's declaration.
    pub declared: (u32, u32),
}

/// One body of a module.
#[derive(Debug, Clone, Serialize)]
pub struct Body {
    pub kind: BodyKind,
    pub tier: Tier,
    pub site: Site,
    /// The name of the definition the body belongs to, or of the `const` it
    /// is assigned to, when it has one.
    pub name: Option<String>,
    /// The collection method, for a per-element callback.
    pub method: Option<String>,
    /// The index of the body that encloses this one, in the module's list.
    pub parent: Option<usize>,
    pub span: (u32, u32),
    pub line: u32,
    pub column: u32,
    /// Whether the body is a block, and not an expression.
    pub block: bool,
    /// For a per-element callback: whether the body uses its index parameter.
    pub uses_index: bool,
    /// For a `computed`: the outcome of the promotion criterion. It is the
    /// outcome of the typed criterion where that criterion decides, and of
    /// the syntactic one where a type it needs is not evaluated.
    pub promotion: Option<Promotion>,
    /// For a `computed` used as a value: whether the criterion applied by
    /// syntax and by method names promotes it.
    pub promoted_by_syntax: Option<bool>,
    /// For a `computed` used as a value: the outcome of the criterion
    /// applied with types, as `promoted`, `not promoted: <reason>`, or
    /// `not decided: <what has no type>`.
    pub promotion_by_type: Option<String>,
    /// For a `computed` used as a value: the start of its source text.
    pub excerpt: Option<String>,
    pub captures: Vec<Capture>,
    pub calls: Vec<CallSite>,
}

impl Body {
    /// The nesting of a reactive body: the kinds of the bodies that enclose
    /// it, outermost first, ending with its own.
    pub fn nesting(&self, bodies: &[Body]) -> Vec<BodyKind> {
        let mut chain = vec![self.kind];
        let mut parent = self.parent;
        while let Some(index) = parent {
            chain.push(bodies[index].kind);
            parent = bodies[index].parent;
        }
        chain.reverse();
        chain
    }
}
