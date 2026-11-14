//! Footprint analysis (`footprint-analysis.md`, cited as FA): what a
//! function body reads and writes of its inputs.
//!
//! The analysis evaluates each expression of a body to an abstract value
//! (FA §2.1) and records observations of the body's formal inputs, each a
//! path and a class (FA §2.2). A call of an authored function is analyzed
//! with the arguments' abstract values in place of the parameters, which
//! gives what applying the function's summary gives (FA §3.6). A read or a
//! write through a handle is static or dynamic by the conditions of FA
//! §7.2 and §6.2. Where a rule cannot follow a value, the body's record
//! names the widening cause (FA §5.2).
//!
//! `SPEC-NOTES.md` lists what this module does not implement and the
//! readings it chose.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::rc::Rc;

use oxc_ast::ast::*;
use oxc_ast::AstKind;
use oxc_span::GetSpan;
use oxc_syntax::symbol::SymbolId;

use crate::module::{symbol_of, DefKind, ModuleTier};
use crate::program::Resolver;
use crate::syntax::{static_key_name, unwrap, FunctionLike};
use crate::tiers::{Body, BodyKind, Promotion};
use crate::types::{Shape, TypeId};

/// The record of one body, in the notation of FA.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Record {
    /// The static entries: `input path : class, class`, sorted.
    pub reads: Vec<String>,
    /// The entries below a hop whose read is dynamic (FA §7.3).
    pub envelope: Vec<String>,
    /// The number of `get()` and `sample()` calls that are static (FA
    /// §7.2).
    pub static_reads: usize,
    /// The dynamic reads: the handle, and why the read is not static.
    pub dynamic_reads: Vec<String>,
    /// The targets of the writes through handles (FA §6.2). A target the
    /// body cannot name statically ends in ` (dynamic)`.
    pub writes: Vec<String>,
    /// The number of write sites, and how many have a static target.
    pub write_sites: (usize, usize),
    /// The cause of each widening (FA §5.2), one per site.
    pub widenings: Vec<String>,
    /// The widenings whose site is in the body's own text.
    pub direct_widenings: Vec<String>,
    /// The number of `key` and `elementById` calls with a key that is not
    /// static.
    pub dynamic_keys: usize,
    /// The number of expressions observed that have no type, where the
    /// class was chosen as for a scalar.
    pub untyped: usize,
    /// The sites in the body's own text, each with what the analysis found
    /// there: `read:static`, `read:dynamic:` and the reason, `write:static`,
    /// `write:dynamic`, `key:dynamic`, and `widen:` and the cause. The
    /// measurement counts each site once, for the innermost body around it.
    pub sites: Vec<(u32, String)>,
    /// What a function the body calls brought into it (FA §3.6, "A
    /// summary has no tier"): the call in the body's own text, what was
    /// found, in the words of `sites`, and the module and position inside
    /// the function. Where calls nest, the call is the one written in the
    /// body.
    pub brought: Vec<(u32, String, usize, u32)>,
    /// The sites of the runtime calls that create something (FA §8), in
    /// source order: `instantiate:order`, `instantiate:tag`,
    /// `createCell:order`, `createCell:cause`, `createCell:cause (state)`,
    /// `createCell:cause (data)`, `effect:` and the built-in, and `bind`.
    pub calls: Vec<String>,
    /// The dynamic reads that belong to no handle's envelope (FA §7.1,
    /// §8.4): `link: ` and the entries the journaled resolutions start
    /// from, `space: ` and the entries, and `labelMetadata`.
    pub other_dynamic: Vec<String>,
    /// `Body.outputs` (FA §3.8): `path : passes entry` and
    /// `path : oneOf entry, entry`.
    pub outputs: Vec<String>,
    /// The tier of a computation (FA §6.3): `primary output`, `static
    /// side-write`, or `materializer`. `None` for a handler (FA §6.4).
    pub tier: Option<&'static str>,
    /// The shapes of FA §6.6 a computation has, one per site: `append`,
    /// `send`, and `reads its own target`.
    pub not_idempotent: Vec<String>,
    /// The number of pushes in a handler onto a collection the handler
    /// read before (`mergeable-push:read-then-push`).
    pub read_then_push: usize,
    /// `Body.handles`: the position of each handle the body reads through
    /// in a way no static entry covers, and `call n` and the index of the
    /// site in `calls` for what a site made (FA §7.2, §8.1, §8.2).
    pub handles: Vec<String>,
    /// `Body.writes` (FA §6.2, §6.5): `handle` and the handle's position,
    /// then the path below its cell; `created n`, `argument n` and
    /// `request n` and the index of the site. A path that holds a
    /// reference the body was given is an edge of its own that ends in
    /// ` : passes entry` or ` : oneOf entry, entry`.
    pub edges: Vec<String>,
    /// `Body.envelopes` (FA §6.2), in the form of `edges`.
    pub envelopes: Vec<String>,
    /// The same record as data, for the plan.
    pub detail: Detail,
}

/// One entry of a footprint: a path of a formal input and a class.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Entry {
    pub input: String,
    pub path: Vec<Seg>,
    pub class: Class,
}

impl std::fmt::Display for Entry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} : {}",
            display_path(&self.input, &self.path),
            self.class.label()
        )
    }
}

/// What an entry of `Body.handles` names.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum HandleAt {
    /// The `identity` entry at a position of a formal input.
    Entry(String, Vec<Seg>),
    /// For one use of the body: the index of the `identity` entry in
    /// `Body.computed`.
    Computed(usize),
    /// The index of a site in `calls`.
    Call(usize),
}

/// One entry of `Body.handles`, with the entries of its read envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandleRead {
    pub at: HandleAt,
    pub envelope: Vec<Entry>,
}

/// The target of a write edge or of a write envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteTarget {
    Handle {
        input: String,
        path: Vec<Seg>,
        resolved: bool,
    },
    Created(usize),
    Argument(usize),
    Request(usize),
}

/// The name of an `identity` entry a reference is, or is one of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefName {
    pub input: String,
    pub path: Vec<Seg>,
    pub resolved: bool,
}

impl std::fmt::Display for RefName {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}{}",
            display_path(&self.input, &self.path),
            if self.resolved { " (resolved)" } else { "" }
        )
    }
}

/// One write edge, or one write envelope where `fixed` is false.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteRec {
    pub target: WriteTarget,
    /// The path below the target.
    pub path: Vec<Seg>,
    pub fixed: bool,
    /// Whether the reference is `passes`, and the entries it names.
    pub reference: Option<(bool, Vec<RefName>)>,
}

impl std::fmt::Display for WriteRec {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.target {
            WriteTarget::Handle {
                input,
                path,
                resolved,
            } => write!(
                formatter,
                "handle {}{}",
                display_path(input, path),
                if *resolved { " (resolved)" } else { "" }
            )?,
            WriteTarget::Created(site) => write!(formatter, "created n{site}")?,
            WriteTarget::Argument(site) => write!(formatter, "argument n{site}")?,
            WriteTarget::Request(site) => write!(formatter, "request n{site}")?,
        }
        if !self.path.is_empty() {
            write!(formatter, " {}", plain_path(&self.path))?;
        }
        if let Some((passes, names)) = &self.reference {
            let names: Vec<String> = names.iter().map(RefName::to_string).collect();
            write!(
                formatter,
                " : {} {}",
                if *passes { "passes" } else { "oneOf" },
                names.join(", ")
            )?;
        }
        Ok(())
    }
}

/// A path with no input before it, as `a/*/b`.
pub fn plain_path(path: &[Seg]) -> String {
    let segments: Vec<&str> = path
        .iter()
        .map(|segment| match segment {
            Seg::Key(key) => key.as_str(),
            Seg::Star => "*",
            Seg::Hop => "->",
        })
        .collect();
    segments.join("/")
}

/// The record of a body as data.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Detail {
    pub entries: Vec<Entry>,
    pub envelope: Vec<Entry>,
    pub handles: Vec<HandleRead>,
    /// The write edges and the write envelopes.
    pub edges: Vec<WriteRec>,
    /// The entries each journaled resolution starts from.
    pub links: Vec<Vec<(String, Vec<Seg>)>>,
    pub label_metadata: bool,
    /// `Body.outputs`: the result path, whether the reference is `passes`,
    /// and the entries it names.
    pub outputs: Vec<(Vec<Seg>, bool, Vec<RefName>)>,
}

/// The record of one use of a body (FA §1.1): the entries on an input
/// bound to a slot root, and the entries on an input bound to a value the
/// instance computed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UseRecord {
    pub reads: Vec<Entry>,
    pub computed: Vec<Entry>,
    pub handles: Vec<HandleRead>,
    /// The dynamic reads of kind `link`: the entries each starts from, a
    /// computed one as `computed` and its index.
    pub links: Vec<String>,
    pub label_metadata: bool,
}

impl UseRecord {
    pub fn read_lines(&self) -> Vec<String> {
        self.reads.iter().map(Entry::to_string).collect()
    }

    pub fn computed_lines(&self) -> Vec<String> {
        self.computed.iter().map(Entry::to_string).collect()
    }

    pub fn handle_lines(&self) -> Vec<String> {
        self.handles.iter().map(|handle| handle.at.line()).collect()
    }

    /// The index in `computed` of the `identity` entry at a position.
    pub fn computed_index(&self, input: &str, path: &[Seg]) -> Option<usize> {
        self.computed.iter().position(|entry| {
            entry.input == input && entry.path == path && entry.class == Class::Identity
        })
    }
}

impl HandleAt {
    pub fn line(&self) -> String {
        match self {
            HandleAt::Entry(input, path) => display_path(input, path),
            HandleAt::Computed(index) => format!("computed {index}"),
            HandleAt::Call(index) => format!("call n{index}"),
        }
    }
}

/// The record of a body for one use of it, in which the formal inputs
/// named in `computed` are bound to values the instance computed (FA
/// §1.1). A read through a handle from such an input is dynamic, and a
/// resolution and an observation of label metadata of one are journaled,
/// whatever the conditions say (FA §7.2, §8.4).
pub fn bind_use(record: &Record, computed: &BTreeSet<String>) -> UseRecord {
    let detail = &record.detail;
    let mut used = UseRecord {
        label_metadata: detail.label_metadata,
        ..UseRecord::default()
    };
    // The position of the handle a path first crosses the link of.
    let position = |path: &[Seg]| -> Vec<Seg> {
        let end = path
            .iter()
            .position(|segment| *segment == Seg::Hop)
            .unwrap_or(path.len());
        path[..end].to_vec()
    };
    let mut journaled: BTreeSet<(String, Vec<Seg>)> = BTreeSet::new();
    let mut envelopes: BTreeMap<(String, Vec<Seg>), Vec<Entry>> = BTreeMap::new();
    for entry in &detail.entries {
        if !computed.contains(&entry.input) {
            used.reads.push(entry.clone());
            continue;
        }
        if entry.path.contains(&Seg::Hop) {
            envelopes
                .entry((entry.input.clone(), position(&entry.path)))
                .or_default()
                .push(entry.clone());
            continue;
        }
        match entry.class {
            Class::LabelMetadata => used.label_metadata = true,
            Class::Resolved => {
                journaled.insert((entry.input.clone(), entry.path.clone()));
                used.computed.push(Entry {
                    class: Class::Identity,
                    ..entry.clone()
                });
            }
            _ => used.computed.push(entry.clone()),
        }
    }
    used.computed.sort_by_key(Entry::to_string);
    used.computed.dedup();
    for handle in &detail.handles {
        match &handle.at {
            HandleAt::Entry(input, path) if computed.contains(input) => {
                envelopes
                    .entry((input.clone(), position(path)))
                    .or_default()
                    .extend(handle.envelope.iter().cloned());
            }
            _ => used.handles.push(handle.clone()),
        }
    }
    for ((input, path), mut envelope) in envelopes {
        envelope.sort_by_key(Entry::to_string);
        envelope.dedup();
        let at = match used.computed_index(&input, &path) {
            Some(index) => HandleAt::Computed(index),
            None => HandleAt::Entry(input, path),
        };
        used.handles.push(HandleRead { at, envelope });
    }
    let name = |used: &UseRecord, input: &str, path: &[Seg]| {
        if computed.contains(input) {
            if let Some(index) = used.computed_index(input, path) {
                return format!("computed {index}");
            }
        }
        display_path(input, path)
    };
    let mut links: BTreeSet<String> = BTreeSet::new();
    for starts in &detail.links {
        let names: Vec<String> = starts
            .iter()
            .map(|(input, path)| name(&used, input, path))
            .collect();
        links.insert(names.join(", "));
    }
    for (input, path) in &journaled {
        links.insert(name(&used, input, path));
    }
    used.links = links.into_iter().collect();
    used
}

/// The footprint of one body.
#[derive(Debug, Clone)]
pub struct BodyFootprint {
    pub module: String,
    pub name: Option<String>,
    pub kind: BodyKind,
    pub line: u32,
    pub record: Record,
}

/// One segment of a path (FA, "Notation").
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Seg {
    Key(String),
    /// Each element of an array or each child of a record.
    Star,
    /// The place where the path crosses a handle's link, written `->`.
    Hop,
}

type PathKey = (String, Vec<Seg>);

/// A projection: a path of a formal input (FA §2.1).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Proj {
    input: String,
    path: Vec<Seg>,
    /// Whether the projection was found below a hop whose read is dynamic.
    dynamic: bool,
    /// Whether the projection is a handle that `key` made for a position
    /// that holds no handle: it names the position, and `get()` on it adds
    /// no hop.
    made: bool,
    /// For a handle a resolution returned: the length of the path of the
    /// position that was resolved, and whether the resolution is static
    /// (FA §7.1).
    resolved: Option<(usize, bool)>,
    /// One mark for each time the path entered a recursive type again, for
    /// W6 (FA §5.2).
    entered: Vec<String>,
}

impl Proj {
    fn root(input: String) -> Val {
        Val::Proj(Proj {
            input,
            path: Vec::new(),
            dynamic: false,
            made: false,
            resolved: None,
            entered: Vec::new(),
        })
    }

    fn key(&self) -> PathKey {
        (self.input.clone(), self.path.clone())
    }

    fn with(&self, segment: Seg) -> Proj {
        let mut path = self.path.clone();
        path.push(segment);
        Proj {
            input: self.input.clone(),
            path,
            dynamic: self.dynamic,
            made: false,
            resolved: self.resolved,
            entered: self.entered.clone(),
        }
    }

    /// The path of the root of the cell a handle links to.
    fn cell(&self) -> PathKey {
        let mut path = self.path.clone();
        if !self.made {
            path.push(Seg::Hop);
        }
        (self.input.clone(), path)
    }

    /// The path as a write target shows it, with the flag of FA §6.2.
    fn target(&self) -> String {
        let full = display_path(&self.input, &self.path);
        match self.resolved {
            Some((length, _)) if length <= self.path.len() => {
                let head = display_path(&self.input, &self.path[..length]);
                match full.strip_prefix(&head) {
                    Some(rest) => format!("{head} (resolved){rest}"),
                    None => full,
                }
            }
            _ => full,
        }
    }
}

pub fn display_path(input: &str, path: &[Seg]) -> String {
    let mut text = input.to_string();
    let mut previous: Option<&Seg> = None;
    for segment in path {
        match segment {
            Seg::Key(key) => {
                text.push_str(match previous {
                    None => ".",
                    Some(Seg::Hop) => "",
                    Some(_) => "/",
                });
                text.push_str(key);
            }
            Seg::Star => text.push_str("/*"),
            Seg::Hop => text.push_str("->"),
        }
        previous = Some(segment);
    }
    text
}

/// The observation classes this module records (FA §2.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Class {
    Enumeration,
    Identity,
    /// A resolved `identity` entry (FA §7.1, "Resolutions").
    Resolved,
    LabelMetadata,
    Shape,
    Value,
}

impl Class {
    pub fn label(self) -> &'static str {
        match self {
            Class::Enumeration => "enumeration",
            Class::Identity => "identity",
            Class::Resolved => "identity (resolved)",
            Class::LabelMetadata => "labelMetadata",
            Class::Shape => "shape",
            Class::Value => "value",
        }
    }
}

/// A record, a list, or a bag the body built (FA §2.1).
#[derive(Debug, Default)]
struct Built {
    fields: BTreeMap<String, Val>,
    /// The members the analysis does not tell apart.
    bag: Vec<Val>,
    /// The values spread into the record: a member the record does not
    /// name is the member of one of them.
    spreads: Vec<Val>,
}

impl Built {
    fn members(&self) -> Vec<Val> {
        self.fields
            .values()
            .chain(self.bag.iter())
            .chain(self.spreads.iter())
            .cloned()
            .collect()
    }
}

/// An abstract value (FA §2.1).
#[derive(Debug, Clone)]
enum Val {
    Proj(Proj),
    Alts(Vec<Val>),
    /// Two names for one built value share it (FA §3.5).
    Built(Rc<RefCell<Built>>),
    /// A function: the module and the start of its span.
    Func(usize, u32),
    Created,
    /// What a site of a runtime call returned: a cell or an instance a
    /// later invocation can find again (FA §7.2).
    Site(usize, u32),
    Computed,
}

impl Val {
    fn built(fields: BTreeMap<String, Val>, bag: Vec<Val>) -> Val {
        Val::Built(Rc::new(RefCell::new(Built {
            fields,
            bag,
            spreads: Vec::new(),
        })))
    }

    fn bag(member: Val) -> Val {
        Val::built(BTreeMap::new(), vec![member])
    }

    fn alts(members: Vec<Val>) -> Val {
        let mut flat: Vec<Val> = Vec::new();
        for member in members {
            match member {
                Val::Alts(inner) => flat.extend(inner),
                Val::Computed => {}
                other => flat.push(other),
            }
        }
        let mut kept: Vec<Val> = Vec::new();
        for member in flat {
            let seen = kept.iter().any(|other| match (other, &member) {
                (Val::Proj(a), Val::Proj(b)) => a == b,
                (Val::Built(a), Val::Built(b)) => Rc::ptr_eq(a, b),
                (Val::Func(a, b), Val::Func(c, d)) => a == c && b == d,
                (Val::Created, Val::Created) => true,
                (Val::Site(a, b), Val::Site(c, d)) => a == c && b == d,
                _ => false,
            });
            if !seen {
                kept.push(member);
            }
        }
        match kept.len() {
            0 => Val::Computed,
            1 => kept.pop().unwrap_or(Val::Computed),
            _ => Val::Alts(kept),
        }
    }

    /// The projections the value is, or is one of.
    fn projections(&self) -> Vec<Proj> {
        match self {
            Val::Proj(proj) => vec![proj.clone()],
            Val::Alts(members) => members.iter().flat_map(Val::projections).collect(),
            _ => Vec::new(),
        }
    }

    fn has_projection(&self) -> bool {
        !self.projections().is_empty()
    }
}

/// What the static type of an expression says about a position (FA,
/// "Notation").
#[derive(Debug, Clone, Copy, Default)]
struct Kinds {
    scalar: bool,
    container: bool,
    handle: bool,
    reference: bool,
    factory: bool,
    /// Whether the type admits `null` or `undefined`.
    nullable: bool,
    /// Whether the type is a union of several kinds, so that a kind test
    /// is not decided by it.
    several: bool,
    untyped: bool,
    array: bool,
    tuple: bool,
    string: bool,
    /// An object type with an index signature.
    open: bool,
}

/// What the analysis keeps while it evaluates one body.
#[derive(Default)]
struct Store {
    entries: BTreeMap<PathKey, BTreeSet<Class>>,
    envelope: BTreeMap<PathKey, BTreeSet<Class>>,
    /// The `shape` entries a test the type decides recorded (FA §2.2).
    decided: BTreeSet<PathKey>,
    /// The `shape` entries a test the type does not decide recorded.
    tested: BTreeSet<PathKey>,
    static_reads: BTreeSet<(usize, u32)>,
    dynamic_reads: BTreeMap<(usize, u32), String>,
    writes: BTreeSet<String>,
    write_sites: BTreeMap<(usize, u32), bool>,
    widenings: BTreeSet<(String, usize, u32)>,
    direct: BTreeSet<(String, usize, u32)>,
    dynamic_keys: BTreeSet<(usize, u32)>,
    untyped: BTreeSet<(usize, u32)>,
    /// The sites of the runtime calls (FA §8).
    calls: BTreeMap<(usize, u32), String>,
    /// The entries the journaled resolutions start from, one line per
    /// resolution, and the entries of the dynamic reads of kind `space`.
    links: BTreeSet<String>,
    spaces: BTreeSet<String>,
    label_metadata: bool,
    /// The sites that make a computation a materializer besides a write
    /// whose target is not static.
    materializer: BTreeSet<(usize, u32)>,
    /// The shapes of FA §6.6, by site.
    not_idempotent: BTreeMap<(usize, u32), &'static str>,
    /// The cell each write through one anchored handle lands in.
    write_targets: Vec<(PathKey, (usize, u32))>,
    /// The cells the body has read through a handle.
    read_cells: BTreeSet<PathKey>,
    read_then_push: BTreeSet<(usize, u32)>,
    outputs: Vec<String>,
    output_refs: Vec<(Vec<Seg>, bool, Vec<RefName>)>,
    /// The handles the body reads through dynamically, and whether each
    /// was found below a hop whose read is dynamic.
    dynamic_handles: BTreeSet<(PathKey, bool)>,
    /// The sites whose result the body reads through.
    site_reads: BTreeSet<(usize, u32)>,
    /// The writes, each with the value written.
    pending: Vec<(Pending, Val, bool)>,
    link_entries: BTreeSet<Vec<PathKey>>,
}

/// The target of a write the record is filled in for at the end.
enum Pending {
    /// A handle, and whether the write appends an element.
    Handle(Proj, bool),
    Created((usize, u32)),
    Argument((usize, u32)),
    Request((usize, u32)),
}

struct Frame {
    module: usize,
    env: HashMap<SymbolId, Val>,
    /// The span of the function the frame evaluates.
    span: (u32, u32),
}

/// The handle methods that write (FA §6.1).
const WRITERS: [&str; 12] = [
    "set",
    "update",
    "push",
    "pushAll",
    "addUnique",
    "remove",
    "removeByValue",
    "removeAll",
    "increment",
    "applyChanges",
    "send",
    "exec",
];

/// The deepest nesting of calls the analysis follows.
const MAX_INLINE: usize = 8;

struct Analyzer<'r, 'm, 'a> {
    resolver: &'r Resolver<'m, 'a>,
    functions: HashMap<usize, HashMap<u32, FunctionLike<'a, 'a>>>,
    frames: Vec<Frame>,
    store: Store,
    /// The number of conditions the point being evaluated is under (FA
    /// §3.7).
    cond: u32,
    /// Whether a statement before the point can return on some path.
    returned: bool,
    /// The functions being evaluated, for the recursion guard.
    active: Vec<(usize, u32)>,
    /// The closures created in the body and whether each was evaluated.
    closures: Vec<(usize, u32, bool)>,
    /// The module and the span of the body.
    root: (usize, (u32, u32)),
    /// Whether the body is evaluated again: a `lift`, a `computed`, an
    /// `assert`, or an authored function (FA §6.3, §8).
    computation: bool,
    /// Whether the body is a handler or a computation, and not an authored
    /// function, which is held to the rules of the bodies that call it (FA
    /// §8).
    handler: bool,
    /// How many bindings the body is analyzed below, for a bound handler.
    depth: u32,
    /// The calls written in the body's own text that are being evaluated,
    /// innermost last.
    calls_in_text: Vec<u32>,
    /// A site outside the body's text, and the call in the body's text
    /// whose evaluation reached it.
    reached: RefCell<BTreeMap<(usize, u32), u32>>,
}

impl<'a> Analyzer<'_, '_, 'a> {
    fn module(&self) -> usize {
        self.frames.last().map_or(self.root.0, |frame| frame.module)
    }

    fn function_at(&mut self, module: usize, start: u32) -> Option<FunctionLike<'a, 'a>> {
        if let std::collections::hash_map::Entry::Vacant(entry) = self.functions.entry(module) {
            let mut found = HashMap::new();
            if let Some(parsed) = self.resolver.parsed(module) {
                for node in parsed.semantic.nodes().iter() {
                    match node.kind() {
                        AstKind::ArrowFunctionExpression(arrow) => {
                            found.insert(arrow.span.start, FunctionLike::Arrow(arrow));
                        }
                        AstKind::Function(function) => {
                            found.insert(function.span.start, FunctionLike::Function(function));
                        }
                        _ => {}
                    }
                }
            }
            entry.insert(found);
        }
        self.functions.get(&module)?.get(&start).copied()
    }

    // ----- types -----

    fn kinds(&self, expression: &Expression<'a>) -> Kinds {
        let resolver = self.resolver;
        let Ok(ty) = resolver.typed_at(self.module(), expression, 0) else {
            return Kinds {
                untyped: true,
                ..Kinds::default()
            };
        };
        let mut kinds = Kinds::default();
        let members = match resolver.shape(ty) {
            Shape::Union(members) => members,
            _ => vec![ty],
        };
        let mut count = 0;
        for member in members {
            let before = (
                kinds.scalar,
                kinds.container,
                kinds.handle,
                kinds.reference,
                kinds.factory,
            );
            match resolver.shape(member) {
                Shape::Null | Shape::Undefined | Shape::Void => kinds.nullable = true,
                Shape::String => {
                    kinds.scalar = true;
                    kinds.string = true;
                }
                Shape::Literal(text) => {
                    kinds.scalar = true;
                    kinds.string |= text.starts_with('"') || text.starts_with('\'');
                }
                Shape::Number | Shape::Boolean | Shape::BigInt => kinds.scalar = true,
                Shape::Array(_) => {
                    kinds.container = true;
                    kinds.array = true;
                }
                Shape::Tuple(_) => {
                    kinds.container = true;
                    kinds.tuple = true;
                }
                Shape::Object(_, index) => {
                    kinds.container = true;
                    kinds.open |= index.is_some();
                }
                Shape::NonPrimitive | Shape::Code(_) | Shape::Opaque(_) => kinds.container = true,
                Shape::Handle(..) => kinds.handle = true,
                Shape::Unknown => {
                    kinds.reference = true;
                    kinds.nullable = true;
                }
                Shape::PatternFactory(..) | Shape::HandlerFactory(..) => kinds.factory = true,
                Shape::Never | Shape::Function => {}
                Shape::Union(_) | Shape::Parameter(_) | Shape::Unresolved(_) => {
                    kinds.untyped = true;
                }
            }
            let after = (
                kinds.scalar,
                kinds.container,
                kinds.handle,
                kinds.reference,
                kinds.factory,
            );
            if before != after {
                count += 1;
            }
        }
        kinds.several = count > 1;
        kinds
    }

    /// Whether the value type of the handle `receiver` declares the
    /// property `key` as a handle, so that `key` flattens (FA §7.1).
    fn key_is_handle(&self, receiver: &Expression<'a>, key: &str) -> bool {
        let resolver = self.resolver;
        let Ok(ty) = resolver.typed_at(self.module(), receiver, 0) else {
            return false;
        };
        let Shape::Handle(_, value) = resolver.shape(resolver.present(ty)) else {
            return false;
        };
        resolver
            .with_optional_reads_declared(|| resolver.property(resolver.present(value), key))
            .is_some_and(|property| {
                matches!(
                    resolver.shape(resolver.present(property)),
                    Shape::Handle(..)
                )
            })
    }

    // ----- observations -----

    fn site(&self, start: u32) -> (usize, u32) {
        let site = (self.module(), start);
        self.reach(site);
        site
    }

    fn in_text(&self, site: (usize, u32)) -> bool {
        let (module, (from, to)) = self.root;
        site.0 == module && from <= site.1 && site.1 < to
    }

    /// Records the call of the body's text that reached a site in a
    /// function the body calls.
    fn reach(&self, site: (usize, u32)) {
        if self.in_text(site) {
            return;
        }
        if let Some(call) = self.calls_in_text.last() {
            self.reached.borrow_mut().entry(site).or_insert(*call);
        }
    }

    fn observe(&mut self, val: &Val, class: Class) {
        for proj in val.projections() {
            if class == Class::Shape {
                self.store.tested.insert(proj.key());
            }
            let entries = if proj.dynamic {
                &mut self.store.envelope
            } else {
                &mut self.store.entries
            };
            entries.entry(proj.key()).or_default().insert(class);
        }
    }

    /// A `shape` observation that the type decides when `decided` holds.
    fn observe_shape(&mut self, val: &Val, decided: bool) {
        if !decided {
            self.observe(val, Class::Shape);
            return;
        }
        for proj in val.projections() {
            let entries = if proj.dynamic {
                &mut self.store.envelope
            } else {
                &mut self.store.entries
            };
            entries.entry(proj.key()).or_default().insert(Class::Shape);
            self.store.decided.insert(proj.key());
        }
    }

    /// `value` at every projection a built value holds.
    fn observe_members(&mut self, val: &Val, depth: u32) {
        match val {
            Val::Proj(_) => self.observe(val, Class::Value),
            Val::Alts(members) => {
                for member in members {
                    self.observe_members(member, depth);
                }
            }
            Val::Built(built) if depth < 6 => {
                let members = built.borrow().members();
                for member in members {
                    self.observe_members(&member, depth + 1);
                }
            }
            _ => {}
        }
    }

    fn widen(&mut self, cause: &str, start: u32) {
        let site = (cause.to_string(), self.module(), start);
        self.reach((self.module(), start));
        let (module, (from, to)) = self.root;
        if self.module() == module && from <= start && start < to {
            self.store.direct.insert(site.clone());
        }
        self.store.widenings.insert(site);
    }

    /// An operation consumes the content of `val`, the value of
    /// `expression` (FA §2.2, the first two rows). `conversion` is set for
    /// a conversion to a string, which observes a reference for
    /// `identity`.
    fn consume(&mut self, expression: &Expression<'a>, val: &Val, conversion: bool) {
        if !val.has_projection() {
            // A value the body built is read member by member.
            self.observe_members(val, 0);
            return;
        }
        let kinds = self.kinds(expression);
        if kinds.untyped {
            self.store
                .untyped
                .insert(self.site(expression.span().start));
            self.observe(val, Class::Value);
            return;
        }
        if kinds.scalar {
            self.observe(val, Class::Value);
        }
        if kinds.container {
            self.observe(val, Class::Value);
            self.widen("W2", expression.span().start);
        }
        if (kinds.reference || kinds.factory) && conversion {
            self.observe(val, Class::Identity);
        }
    }

    /// A scalar used as a key, an index, or an argument of a member of the
    /// standard library is consumed (FA §3). A container there is not
    /// converted, and records nothing here.
    fn consume_scalar(&mut self, expression: &Expression<'a>, val: &Val) {
        if !val.has_projection() {
            return;
        }
        let kinds = self.kinds(expression);
        if kinds.untyped {
            self.store
                .untyped
                .insert(self.site(expression.span().start));
        }
        if kinds.scalar || kinds.untyped {
            self.observe(val, Class::Value);
        }
    }

    /// A test of truthiness (FA §2.2).
    fn truthiness(&mut self, expression: &Expression<'a>, val: &Val) {
        if !val.has_projection() {
            return;
        }
        let kinds = self.kinds(expression);
        if kinds.scalar || kinds.untyped {
            self.observe(val, Class::Value);
        }
        if kinds.container || kinds.handle || kinds.reference || kinds.factory {
            self.observe_shape(val, !kinds.nullable && !kinds.several);
        }
    }

    /// A test of presence: `=== undefined`, `?.`, `??` (FA §2.2).
    fn presence(&mut self, expression: &Expression<'a>, val: &Val) {
        if !val.has_projection() {
            return;
        }
        let kinds = self.kinds(expression);
        self.observe_shape(val, !kinds.nullable && !kinds.untyped);
    }

    /// A test of kind: `typeof`, `Array.isArray`, `instanceof`.
    fn kind_test(&mut self, expression: &Expression<'a>, val: &Val) {
        if !val.has_projection() {
            return;
        }
        let kinds = self.kinds(expression);
        let decided = !kinds.nullable && !kinds.several && !kinds.untyped && !kinds.reference;
        self.observe_shape(val, decided);
    }

    /// A value arrives at a place that keeps a container or a handle by
    /// reference (FA §3.8). A literal is taken apart, so that each member
    /// is recorded by its own type.
    fn leaves(&mut self, expression: &Expression<'a>, val: &Val) {
        let expression = unwrap(expression);
        if let (Expression::ObjectExpression(object), Val::Built(built)) = (expression, val) {
            let mut named = BTreeSet::new();
            for property in &object.properties {
                let ObjectPropertyKind::ObjectProperty(property) = property else {
                    continue;
                };
                let Some(name) = static_key_name(&property.key).filter(|_| !property.computed)
                else {
                    continue;
                };
                let member = built.borrow().fields.get(name).cloned();
                if let Some(member) = member {
                    named.insert(name.to_string());
                    self.leaves(&property.value, &member);
                }
            }
            let others: Vec<Val> = {
                let built = built.borrow();
                built
                    .fields
                    .iter()
                    .filter(|(name, _)| !named.contains(*name))
                    .map(|(_, member)| member.clone())
                    .chain(built.bag.iter().cloned())
                    .chain(built.spreads.iter().cloned())
                    .collect()
            };
            for member in others {
                self.leaves_untyped(&member, 0);
            }
            return;
        }
        if !val.has_projection() {
            self.leaves_untyped(val, 0);
            return;
        }
        let kinds = self.kinds(expression);
        if kinds.untyped {
            self.store
                .untyped
                .insert(self.site(expression.span().start));
        }
        if kinds.scalar || kinds.untyped {
            self.observe(val, Class::Value);
        }
        if kinds.container || kinds.reference || kinds.factory {
            self.observe(val, Class::Identity);
        }
        if kinds.handle {
            for proj in val.projections() {
                self.use_handle(&proj);
            }
        }
    }

    /// A value that leaves the body and has no expression to take a type
    /// from: a member of a value the body built earlier. A projection is
    /// recorded for `identity`, unless the body reads its value already.
    fn leaves_untyped(&mut self, val: &Val, depth: u32) {
        match val {
            Val::Proj(proj) => {
                let read = self
                    .store
                    .entries
                    .get(&proj.key())
                    .or_else(|| self.store.envelope.get(&proj.key()))
                    .is_some_and(|classes| classes.contains(&Class::Value));
                if !read {
                    self.observe(val, Class::Identity);
                }
            }
            Val::Alts(members) => {
                for member in members {
                    self.leaves_untyped(member, depth);
                }
            }
            Val::Built(built) if depth < 6 => {
                let members = built.borrow().members();
                for member in members {
                    self.leaves_untyped(&member, depth + 1);
                }
            }
            _ => {}
        }
    }

    /// The `identity` observations a use of a handle records: at each
    /// position of handle type the path crosses, and at the handle itself
    /// (FA §7.1).
    fn use_handle(&mut self, proj: &Proj) {
        let mut crossed = false;
        for (index, segment) in proj.path.iter().enumerate() {
            if *segment == Seg::Hop {
                // The position above the first hop is an entry of the
                // footprint whatever the read through it is.
                let position = Proj {
                    input: proj.input.clone(),
                    path: proj.path[..index].to_vec(),
                    dynamic: proj.dynamic && crossed,
                    made: false,
                    resolved: None,
                    entered: Vec::new(),
                };
                let class = match proj.resolved {
                    Some((length, true)) if length == index => Class::Resolved,
                    _ => Class::Identity,
                };
                self.observe(&Val::Proj(position), class);
                crossed = true;
            }
        }
        if !proj.made {
            let position = Proj {
                dynamic: proj.dynamic && crossed,
                ..proj.clone()
            };
            let class = match proj.resolved {
                Some((length, true)) if length == proj.path.len() => Class::Resolved,
                _ => Class::Identity,
            };
            self.observe(&Val::Proj(position), class);
        }
    }

    /// Whether the point being evaluated is one every run that returns
    /// normally reaches (FA §3.7).
    fn unconditional(&self) -> bool {
        self.cond == 0 && !self.returned
    }

    /// Whether `val` is one projection whose path has no `*` and no hop
    /// whose read is dynamic: the first two conditions of FA §7.1 and
    /// §7.2.
    fn anchored(val: &Val) -> Option<&Proj> {
        match val {
            Val::Proj(proj) if !proj.path.contains(&Seg::Star) && !proj.dynamic => Some(proj),
            _ => None,
        }
    }

    /// A resolution of `val` (FA §7.1, "Resolutions"): a resolved
    /// `identity` entry where it is static, and a plain entry with a
    /// dynamic read of kind `link` where it is journaled. `fixed` is false
    /// for a call that never records a resolved entry. The result is `val`
    /// as the handle the resolution returns.
    fn resolution(&mut self, val: &Val, fixed: bool) -> Val {
        let is_static = fixed && self.unconditional() && Self::anchored(val).is_some();
        let projections = val.projections();
        let mut names = Vec::new();
        let mut results = Vec::new();
        for proj in &projections {
            let resolved = Proj {
                resolved: Some((proj.path.len(), is_static)),
                made: false,
                ..proj.clone()
            };
            // The hops above the operand, and the operand itself.
            self.use_handle(&Proj {
                made: proj.made,
                ..resolved.clone()
            });
            if proj.made {
                let class = if is_static {
                    Class::Resolved
                } else {
                    Class::Identity
                };
                self.observe(&Val::Proj(proj.clone()), class);
            }
            names.push(display_path(&proj.input, &proj.path));
            results.push(Val::Proj(Proj {
                made: proj.made,
                ..resolved
            }));
        }
        if !is_static && !names.is_empty() {
            self.store.links.insert(names.join(", "));
            self.store
                .link_entries
                .insert(projections.iter().map(Proj::key).collect());
        }
        if results.is_empty() {
            return val.clone();
        }
        Val::alts(results)
    }

    /// An observation of the label metadata of `val` (FA §8.4).
    fn label_metadata(&mut self, val: &Val) {
        if self.unconditional() && Self::anchored(val).is_some() {
            self.observe(val, Class::LabelMetadata);
        } else if val.has_projection() {
            self.store.label_metadata = true;
        }
    }

    /// The creation of a cell (FA §8.2). `cause` is the argument of
    /// `X.for(cause)`.
    fn create_cell(&mut self, cause: Option<&Expression<'a>>, start: u32) {
        let site = self.site(start);
        let kind = match cause {
            None => "createCell:order",
            Some(_) if !self.computation => "createCell:cause",
            Some(cause) => {
                // The cause is evaluated for what it reads, whether or
                // not it is constant.
                self.eval(cause);
                if self.constant(cause, 0) {
                    "createCell:cause (state)"
                } else {
                    self.store.materializer.insert(site);
                    "createCell:cause (data)"
                }
            }
        };
        self.store.calls.insert(site, kind.to_string());
    }

    /// Whether an expression is constant (FA §8.2): a literal, a template
    /// literal whose substitutions are constant, an operator over
    /// constants, a module-scope constant, or a local `const` whose
    /// initializer is constant. A `let` binding, a parameter, a call, and
    /// a member access are not.
    fn constant(&self, expression: &Expression<'a>, depth: u32) -> bool {
        if depth > 16 {
            return false;
        }
        match unwrap(expression) {
            Expression::StringLiteral(_)
            | Expression::NumericLiteral(_)
            | Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::BigIntLiteral(_) => true,
            Expression::TemplateLiteral(template) => template
                .expressions
                .iter()
                .all(|part| self.constant(part, depth + 1)),
            Expression::BinaryExpression(binary) => {
                self.constant(&binary.left, depth + 1) && self.constant(&binary.right, depth + 1)
            }
            Expression::LogicalExpression(logical) => {
                self.constant(&logical.left, depth + 1) && self.constant(&logical.right, depth + 1)
            }
            Expression::UnaryExpression(unary) => self.constant(&unary.argument, depth + 1),
            Expression::ConditionalExpression(conditional) => {
                self.constant(&conditional.test, depth + 1)
                    && self.constant(&conditional.consequent, depth + 1)
                    && self.constant(&conditional.alternate, depth + 1)
            }
            Expression::Identifier(identifier) => {
                if identifier.name == "undefined" {
                    return true;
                }
                let Some(parsed) = self.resolver.parsed(self.module()) else {
                    return false;
                };
                let scoping = parsed.semantic.scoping();
                let Some(symbol) = symbol_of(scoping, identifier) else {
                    return false;
                };
                let nodes = parsed.semantic.nodes();
                let declaration = scoping.symbol_declaration(symbol);
                let AstKind::VariableDeclarator(declarator) = nodes.kind(declaration) else {
                    return false;
                };
                let is_const = nodes
                    .ancestor_kinds(declaration)
                    .find_map(|kind| match kind {
                        AstKind::VariableDeclaration(list) => {
                            Some(list.kind == VariableDeclarationKind::Const)
                        }
                        _ => None,
                    })
                    .unwrap_or(false);
                // A name a destructuring binds is a part of a value.
                let plain = matches!(declarator.id, BindingPattern::BindingIdentifier(_));
                match &declarator.init {
                    Some(init) if is_const && plain => self.constant(init, depth + 1),
                    _ => false,
                }
            }
            _ => false,
        }
    }

    /// Whether `expression` has a type the checker cut because it is the
    /// recursive use of a type inside itself, for W6.
    fn recursive_type(&self, expression: &Expression<'a>, below: bool) -> bool {
        let Ok(ty) = self.resolver.typed_at(self.module(), expression, 0) else {
            return false;
        };
        self.cut_type(ty, below)
    }

    /// Whether `ty` is the cut of a recursive type. `below` says that the
    /// value was reached through a cut, where the checker evaluated no
    /// type.
    fn cut_type(&self, ty: TypeId, below: bool) -> bool {
        let resolver = self.resolver;
        let members = match resolver.shape(ty) {
            Shape::Union(members) => members,
            _ => vec![ty],
        };
        members.into_iter().any(|member| {
            match resolver.shape(member) {
                Shape::Unresolved(crate::types::Why::Recursive) => true,
                // What is read below the cut has a type the checker did
                // not evaluate.
                Shape::Unresolved(_) => below,
                _ => false,
            }
        })
    }

    // ----- the environment -----

    fn symbol(&self, identifier: &IdentifierReference<'a>) -> Option<SymbolId> {
        let parsed = self.resolver.parsed(self.module())?;
        symbol_of(parsed.semantic.scoping(), identifier)
    }

    fn lookup(&mut self, identifier: &IdentifierReference<'a>) -> Val {
        let module = self.module();
        let Some(parsed) = self.resolver.parsed(module) else {
            return Val::Computed;
        };
        let scoping = parsed.semantic.scoping();
        let Some(symbol) = symbol_of(scoping, identifier) else {
            return Val::Computed;
        };
        for frame in self.frames.iter().rev() {
            if frame.module != module {
                break;
            }
            if let Some(val) = frame.env.get(&symbol) {
                return val.clone();
            }
        }
        // A module-scope binding is a constant or a definition.
        if self
            .resolver
            .model(module)
            .is_some_and(|model| model.binding(symbol).is_some())
        {
            return match self.resolve_function(module, symbol) {
                Some((home, start)) => Val::Func(home, start),
                None => Val::Computed,
            };
        }
        // A value the body captures is a formal input (FA, "Notation").
        let declared = scoping.symbol_span(symbol);
        let (root_module, (from, to)) = self.root;
        let in_body = self
            .frames
            .iter()
            .all(|frame| frame.module == root_module && from <= frame.span.0 && frame.span.1 <= to);
        if in_body && !(from <= declared.start && declared.end <= to) {
            if let AstKind::Function(function) = parsed
                .semantic
                .nodes()
                .kind(scoping.symbol_declaration(symbol))
            {
                return Val::Func(module, function.span.start);
            }
            return Proj::root(identifier.name.to_string());
        }
        Val::Computed
    }

    /// The authored function a module-scope symbol names: a function
    /// declaration, a `const` initialized with a function, or the function
    /// a `lift(...)` definition wraps (FA §1.2).
    fn resolve_function(&mut self, module: usize, symbol: SymbolId) -> Option<(usize, u32)> {
        let (home, symbol) = self.resolver.origin(module, symbol)?;
        let parsed = self.resolver.parsed(home)?;
        let declaration = parsed.semantic.scoping().symbol_declaration(symbol);
        match parsed.semantic.nodes().kind(declaration) {
            AstKind::Function(function) => Some((home, function.span.start)),
            AstKind::VariableDeclarator(declarator) => {
                let init = unwrap(declarator.init.as_ref()?);
                if let Some(function) = FunctionLike::of(init) {
                    return Some((home, function.span().start));
                }
                let Expression::CallExpression(call) = init else {
                    return None;
                };
                if self.resolver.is_lift_call(home, call) {
                    let function = call.arguments.first().and_then(FunctionLike::of_argument)?;
                    return Some((home, function.span().start));
                }
                None
            }
            _ => None,
        }
    }

    fn bind(&mut self, symbol: Option<SymbolId>, val: Val) {
        if let (Some(symbol), Some(frame)) = (symbol, self.frames.last_mut()) {
            frame.env.insert(symbol, val);
        }
    }

    fn assign(&mut self, symbol: SymbolId, val: Val) {
        let module = self.module();
        let conditional = self.cond > 0;
        for frame in self.frames.iter_mut().rev() {
            if frame.module != module {
                break;
            }
            if let Some(old) = frame.env.get(&symbol).cloned() {
                // An assignment under a condition joins (FA §3.7).
                let next = if conditional {
                    Val::alts(vec![old, val])
                } else {
                    val
                };
                frame.env.insert(symbol, next);
                return;
            }
        }
        if let Some(frame) = self.frames.last_mut() {
            frame.env.insert(symbol, val);
        }
    }

    fn extend(&mut self, val: &Val, key: &str) -> Val {
        match val {
            Val::Proj(proj) => Val::Proj(proj.with(Seg::Key(key.to_string()))),
            Val::Alts(members) => {
                let members = members
                    .iter()
                    .map(|member| self.extend(member, key))
                    .collect();
                Val::alts(members)
            }
            Val::Built(built) => {
                let (named, bag, spreads) = {
                    let built = built.borrow();
                    (
                        built.fields.get(key).cloned(),
                        built.bag.clone(),
                        built.spreads.clone(),
                    )
                };
                match named {
                    Some(member) => member,
                    None => {
                        let mut members = bag;
                        for spread in &spreads {
                            members.push(self.extend(spread, key));
                        }
                        Val::alts(members)
                    }
                }
            }
            _ => Val::Computed,
        }
    }

    /// The member of a collection value: `v/*` of a projection, and the
    /// join of the members of a built value.
    fn member(&mut self, val: &Val) -> Val {
        match val {
            Val::Proj(proj) => Val::Proj(proj.with(Seg::Star)),
            Val::Alts(members) => {
                let members = members.iter().map(|member| self.member(member)).collect();
                Val::alts(members)
            }
            Val::Built(built) => {
                let (mut members, spreads) = {
                    let built = built.borrow();
                    let members: Vec<Val> = built
                        .fields
                        .values()
                        .chain(built.bag.iter())
                        .cloned()
                        .collect();
                    (members, built.spreads.clone())
                };
                for spread in &spreads {
                    members.push(self.member(spread));
                }
                Val::alts(members)
            }
            _ => Val::Computed,
        }
    }

    fn bind_pattern(&mut self, pattern: &BindingPattern<'a>, val: Val) {
        self.bind_typed(pattern, val, None);
    }

    /// Binds a pattern to a value whose type is `ty`, where the caller
    /// has it. The type decides whether a destructuring enters a
    /// recursive type (FA §5.2, W6).
    fn bind_typed(&mut self, pattern: &BindingPattern<'a>, val: Val, ty: Option<TypeId>) {
        match pattern {
            BindingPattern::BindingIdentifier(identifier) => {
                self.bind(identifier.symbol_id.get(), val);
            }
            BindingPattern::AssignmentPattern(assignment) => {
                // A default in a destructuring (FA §3.1).
                self.observe(&val, Class::Shape);
                let default = self.eval(&assignment.right);
                self.bind_typed(&assignment.left, Val::alts(vec![val, default]), ty);
            }
            BindingPattern::ObjectPattern(object) => {
                for property in &object.properties {
                    let mut inner = None;
                    let member = match static_key_name(&property.key) {
                        Some(name) if !property.computed => {
                            let below = Self::below_cut(&val);
                            // Below a cut the checker evaluated no type.
                            let recursive = val.has_projection()
                                && match ty {
                                    Some(ty) => self.cut_type(ty, below),
                                    None => below,
                                };
                            inner = ty.and_then(|ty| self.resolver.property(ty, name));
                            self.enter_key(&val, recursive, name, property.span.start)
                        }
                        _ => {
                            // A destructuring under a computed key.
                            self.observe(&val, Class::Enumeration);
                            if val.has_projection() {
                                self.widen("W1", property.span.start);
                            }
                            self.member(&val)
                        }
                    };
                    self.bind_typed(&property.value, member, inner);
                }
                if let Some(rest) = &object.rest {
                    // The rest of a value is a record of its remaining
                    // properties, each the projection the value has for
                    // it: a spread of the value.
                    let built = Built {
                        spreads: vec![val.clone()],
                        ..Built::default()
                    };
                    self.bind_pattern(&rest.argument, Val::Built(Rc::new(RefCell::new(built))));
                }
            }
            BindingPattern::ArrayPattern(array) => {
                self.observe(&val, Class::Enumeration);
                let member = self.member(&val);
                let inner = ty.and_then(|ty| self.resolver.element_of(ty));
                for element in array.elements.iter().flatten() {
                    self.bind_typed(element, member.clone(), inner);
                }
                if let Some(rest) = &array.rest {
                    self.bind_pattern(&rest.argument, Val::bag(member));
                }
            }
        }
    }

    // ----- functions -----

    /// Evaluates a function with its parameters bound to `arguments`, and
    /// returns the join of what it returns.
    fn call_function(
        &mut self,
        module: usize,
        start: u32,
        arguments: Vec<Val>,
        conditional: bool,
    ) -> Val {
        let Some(function) = self.function_at(module, start) else {
            return Val::Computed;
        };
        for closure in &mut self.closures {
            if closure.0 == module && closure.1 == start {
                closure.2 = true;
            }
        }
        if self.active.contains(&(module, start)) || self.active.len() >= MAX_INLINE {
            // A function that is being evaluated, or a call nested deeper
            // than the bound: an analysis limit (FA §5.2, W7). Each
            // argument that is a projection is read in full.
            for argument in &arguments {
                if argument.has_projection() {
                    self.observe(argument, Class::Value);
                    self.widen("W7", start);
                }
            }
            return Val::Computed;
        }
        let span = function.span();
        // A function written in the function being evaluated shares its
        // environment (FA §3.6, "Closures").
        let closure = self.frames.last().is_some_and(|frame| {
            frame.module == module && frame.span.0 <= span.start && span.end <= frame.span.1
        });
        self.active.push((module, start));
        if !closure {
            self.frames.push(Frame {
                module,
                env: HashMap::new(),
                span: (span.start, span.end),
            });
        }
        let mut arguments = arguments.into_iter();
        for parameter in &function.params().items {
            let val = arguments.next().unwrap_or(Val::Computed);
            self.bind_pattern(&parameter.pattern, val);
        }
        if let Some(rest) = &function.params().rest {
            let members: Vec<Val> = arguments.collect();
            self.bind_pattern(&rest.rest.argument, Val::built(BTreeMap::new(), members));
        }
        let (cond, returned) = (self.cond, self.returned);
        if conditional {
            self.cond += 1;
        }
        self.returned = false;
        let mut results = Vec::new();
        if let Some(body) = function.expression_body() {
            results.push(self.eval(body));
        } else {
            for statement in function.block_body().unwrap_or(&[]) {
                self.statement(statement, &mut results);
            }
        }
        self.cond = cond;
        self.returned = returned;
        if !closure {
            self.frames.pop();
        }
        self.active.pop();
        Val::alts(results)
    }

    /// Calls what `callee` is with `arguments`. A callee the analysis
    /// cannot resolve to a function is widening W4 (FA §3.6).
    fn call_value(
        &mut self,
        callee: &Val,
        arguments: Vec<Val>,
        expressions: &[&Expression<'a>],
        conditional: bool,
        start: u32,
    ) -> Val {
        match callee {
            Val::Func(module, at) => self.call_function(*module, *at, arguments, conditional),
            Val::Alts(members) if members.iter().all(|member| matches!(member, Val::Func(..))) => {
                let results = members
                    .iter()
                    .map(|member| {
                        self.call_value(member, arguments.clone(), expressions, true, start)
                    })
                    .collect();
                Val::alts(results)
            }
            _ => {
                for (index, argument) in arguments.iter().enumerate() {
                    if !argument.has_projection() {
                        continue;
                    }
                    self.widen("W4", start);
                    match expressions.get(index) {
                        Some(expression) if self.kinds(expression).handle => {
                            for proj in argument.projections() {
                                self.use_handle(&proj);
                            }
                        }
                        _ => self.observe(argument, Class::Value),
                    }
                }
                Val::Computed
            }
        }
    }

    /// The value of a function written in place: a closure (FA §3.6).
    fn closure(&mut self, function: FunctionLike<'_, 'a>) -> Val {
        let module = self.module();
        let start = function.span().start;
        if !self
            .closures
            .iter()
            .any(|closure| closure.0 == module && closure.1 == start)
        {
            self.closures.push((module, start, false));
        }
        Val::Func(module, start)
    }

    /// Calls the function an argument is, as a callback.
    fn callback(&mut self, argument: &Expression<'a>, values: Vec<Val>, start: u32) -> Val {
        if let Some(function) = FunctionLike::of(argument) {
            let module = self.module();
            self.closure(function);
            return self.call_function(module, function.span().start, values, true);
        }
        // A global function of the standard library, such as `Boolean`,
        // consumes the member it is called with.
        if let Expression::Identifier(identifier) = unwrap(argument) {
            if self.symbol(identifier).is_none() {
                if let Some(first) = values.first() {
                    if identifier.name == "Boolean" {
                        self.observe(first, Class::Shape);
                    } else {
                        self.observe_members(first, 5);
                    }
                }
                return Val::Computed;
            }
        }
        let target = self.eval(argument);
        self.call_value(&target, values, &[], true, start)
    }

    // ----- statements -----

    fn block(&mut self, statements: &[Statement<'a>], results: &mut Vec<Val>) {
        for statement in statements {
            self.statement(statement, results);
        }
    }

    fn statement(&mut self, statement: &Statement<'a>, results: &mut Vec<Val>) {
        match statement {
            Statement::BlockStatement(block) => self.block(&block.body, results),
            Statement::ExpressionStatement(expression) => {
                self.eval(&expression.expression);
            }
            Statement::VariableDeclaration(declaration) => self.declaration(declaration),
            Statement::FunctionDeclaration(function) => {
                let val = self.closure(FunctionLike::Function(function));
                self.bind(function.id.as_ref().and_then(|id| id.symbol_id.get()), val);
            }
            Statement::ReturnStatement(statement) => {
                if let Some(argument) = &statement.argument {
                    let val = self.eval(argument);
                    // What the body returns leaves it (FA §3.8). What a
                    // called function returns goes to its caller.
                    if self.active.len() == 1 {
                        self.leaves(argument, &val);
                    }
                    results.push(val);
                }
                if self.cond > 0 {
                    self.returned = true;
                }
            }
            Statement::IfStatement(statement) => {
                let test = self.eval(&statement.test);
                self.truthiness(&statement.test, &test);
                self.cond += 1;
                self.statement(&statement.consequent, results);
                if let Some(alternate) = &statement.alternate {
                    self.statement(alternate, results);
                }
                self.cond -= 1;
            }
            Statement::ForOfStatement(statement) => {
                let iterated = self.eval(&statement.right);
                let kinds = self.kinds(&statement.right);
                let member = if kinds.string && !kinds.container {
                    self.observe(&iterated, Class::Value);
                    Val::Computed
                } else {
                    self.observe(&iterated, Class::Enumeration);
                    self.member(&iterated)
                };
                let element = self
                    .resolver
                    .typed_at(self.module(), &statement.right, 0)
                    .ok()
                    .and_then(|ty| self.resolver.element_of(ty));
                self.cond += 1;
                // Twice, so that what one round binds reaches the next.
                for _ in 0..2 {
                    match &statement.left {
                        ForStatementLeft::VariableDeclaration(declaration) => {
                            for declarator in &declaration.declarations {
                                self.bind_typed(&declarator.id, member.clone(), element);
                            }
                        }
                        ForStatementLeft::AssignmentTargetIdentifier(identifier) => {
                            if let Some(symbol) = self.symbol(identifier) {
                                self.assign(symbol, member.clone());
                            }
                        }
                        _ => {}
                    }
                    self.statement(&statement.body, results);
                }
                self.cond -= 1;
            }
            Statement::ForStatement(statement) => {
                match &statement.init {
                    Some(ForStatementInit::VariableDeclaration(declaration)) => {
                        self.declaration(declaration);
                    }
                    Some(init) => {
                        if let Some(expression) = init.as_expression() {
                            self.eval(expression);
                        }
                    }
                    None => {}
                }
                self.cond += 1;
                for _ in 0..2 {
                    if let Some(test) = &statement.test {
                        let val = self.eval(test);
                        self.truthiness(test, &val);
                    }
                    self.statement(&statement.body, results);
                    if let Some(update) = &statement.update {
                        self.eval(update);
                    }
                }
                self.cond -= 1;
            }
            Statement::WhileStatement(statement) => {
                self.cond += 1;
                for _ in 0..2 {
                    let val = self.eval(&statement.test);
                    self.truthiness(&statement.test, &val);
                    self.statement(&statement.body, results);
                }
                self.cond -= 1;
            }
            Statement::DoWhileStatement(statement) => {
                self.cond += 1;
                for _ in 0..2 {
                    self.statement(&statement.body, results);
                    let val = self.eval(&statement.test);
                    self.truthiness(&statement.test, &val);
                }
                self.cond -= 1;
            }
            Statement::SwitchStatement(statement) => {
                let val = self.eval(&statement.discriminant);
                self.consume_scalar(&statement.discriminant, &val);
                self.cond += 1;
                for case in &statement.cases {
                    if let Some(test) = &case.test {
                        let val = self.eval(test);
                        self.consume_scalar(test, &val);
                    }
                    self.block(&case.consequent, results);
                }
                self.cond -= 1;
            }
            Statement::ThrowStatement(statement) => {
                // The operand of `throw` is a conversion (FA §3.7).
                let val = self.eval(&statement.argument);
                self.consume(&statement.argument, &val, true);
            }
            Statement::TryStatement(statement) => {
                let guarded = statement.handler.is_some();
                if guarded {
                    self.cond += 1;
                }
                self.block(&statement.block.body, results);
                if let Some(handler) = &statement.handler {
                    self.block(&handler.body.body, results);
                }
                if guarded {
                    self.cond -= 1;
                }
                if let Some(finalizer) = &statement.finalizer {
                    self.block(&finalizer.body, results);
                }
            }
            Statement::LabeledStatement(statement) => self.statement(&statement.body, results),
            _ => {}
        }
    }

    fn declaration(&mut self, declaration: &VariableDeclaration<'a>) {
        for declarator in &declaration.declarations {
            let val = match &declarator.init {
                Some(init) => self.eval(init),
                None => Val::Computed,
            };
            let ty = declarator
                .init
                .as_ref()
                .and_then(|init| self.resolver.typed_at(self.module(), init, 0).ok());
            self.bind_typed(&declarator.id, val, ty);
        }
    }

    // ----- expressions -----

    fn eval(&mut self, expression: &Expression<'a>) -> Val {
        match expression {
            Expression::ParenthesizedExpression(inner) => self.eval(&inner.expression),
            Expression::TSAsExpression(inner) => self.eval(&inner.expression),
            Expression::TSSatisfiesExpression(inner) => self.eval(&inner.expression),
            Expression::TSNonNullExpression(inner) => self.eval(&inner.expression),
            Expression::Identifier(identifier) => self.lookup(identifier),
            Expression::StaticMemberExpression(member) => self.static_member(member),
            Expression::ComputedMemberExpression(member) => self.computed_member(member),
            Expression::CallExpression(call) => self.call(call),
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::StaticMemberExpression(member) => self.static_member(member),
                ChainElement::ComputedMemberExpression(member) => self.computed_member(member),
                ChainElement::CallExpression(call) => self.call(call),
                ChainElement::TSNonNullExpression(inner) => self.eval(&inner.expression),
                _ => Val::Computed,
            },
            Expression::ArrowFunctionExpression(arrow) => self.closure(FunctionLike::Arrow(arrow)),
            Expression::FunctionExpression(function) => {
                self.closure(FunctionLike::Function(function))
            }
            Expression::ObjectExpression(object) => self.object(object),
            Expression::ArrayExpression(array) => {
                let mut members = Vec::new();
                for element in &array.elements {
                    match element {
                        ArrayExpressionElement::SpreadElement(spread) => {
                            let val = self.eval(&spread.argument);
                            self.observe(&val, Class::Enumeration);
                            members.push(self.member(&val));
                        }
                        ArrayExpressionElement::Elision(_) => {}
                        other => {
                            if let Some(expression) = other.as_expression() {
                                members.push(self.eval(expression));
                            }
                        }
                    }
                }
                Val::built(BTreeMap::new(), members)
            }
            Expression::TemplateLiteral(template) => {
                for substitution in &template.expressions {
                    let val = self.eval(substitution);
                    self.consume(substitution, &val, true);
                }
                Val::Computed
            }
            Expression::TaggedTemplateExpression(tagged) => {
                for substitution in &tagged.quasi.expressions {
                    let val = self.eval(substitution);
                    self.consume(substitution, &val, true);
                }
                Val::Computed
            }
            Expression::ConditionalExpression(conditional) => {
                let test = self.eval(&conditional.test);
                self.truthiness(&conditional.test, &test);
                self.cond += 1;
                let consequent = self.eval(&conditional.consequent);
                let alternate = self.eval(&conditional.alternate);
                self.cond -= 1;
                Val::alts(vec![consequent, alternate])
            }
            Expression::LogicalExpression(logical) => {
                let left = self.eval(&logical.left);
                if logical.operator == LogicalOperator::Coalesce {
                    self.presence(&logical.left, &left);
                } else {
                    self.truthiness(&logical.left, &left);
                }
                self.cond += 1;
                let right = self.eval(&logical.right);
                self.cond -= 1;
                Val::alts(vec![left, right])
            }
            Expression::UnaryExpression(unary) => {
                let val = self.eval(&unary.argument);
                match unary.operator {
                    UnaryOperator::LogicalNot => self.truthiness(&unary.argument, &val),
                    UnaryOperator::Typeof => self.kind_test(&unary.argument, &val),
                    UnaryOperator::Void => {}
                    UnaryOperator::Delete => {
                        if val.has_projection() {
                            self.observe(&val, Class::Value);
                            self.widen("W5", unary.span.start);
                        }
                    }
                    _ => self.consume(&unary.argument, &val, false),
                }
                Val::Computed
            }
            Expression::BinaryExpression(binary) => self.binary(binary),
            Expression::AssignmentExpression(assignment) => self.assignment(assignment),
            Expression::UpdateExpression(update) => {
                match &update.argument {
                    SimpleAssignmentTarget::AssignmentTargetIdentifier(identifier) => {
                        if let Some(symbol) = self.symbol(identifier) {
                            self.assign(symbol, Val::Computed);
                        }
                    }
                    SimpleAssignmentTarget::StaticMemberExpression(member) => {
                        let val = self.static_member(member);
                        if val.has_projection() {
                            self.observe(&val, Class::Value);
                            self.widen("W5", update.span.start);
                        }
                    }
                    _ => {}
                }
                Val::Computed
            }
            Expression::SequenceExpression(sequence) => {
                let mut last = Val::Computed;
                for expression in &sequence.expressions {
                    last = self.eval(expression);
                }
                last
            }
            Expression::NewExpression(new) => self.construct(new),
            Expression::AwaitExpression(inner) => self.eval(&inner.argument),
            Expression::JSXElement(element) => {
                self.jsx_element(element);
                Val::Created
            }
            Expression::JSXFragment(fragment) => {
                for child in &fragment.children {
                    self.jsx_child(child);
                }
                Val::Created
            }
            _ => Val::Computed,
        }
    }

    fn jsx_element(&mut self, element: &JSXElement<'a>) {
        // JSX keeps each attribute and child by reference (FA §3.3, §3.8).
        for attribute in &element.opening_element.attributes {
            match attribute {
                JSXAttributeItem::Attribute(attribute) => {
                    if let Some(JSXAttributeValue::ExpressionContainer(container)) =
                        &attribute.value
                    {
                        if let Some(expression) = container.expression.as_expression() {
                            if let Some(function) = FunctionLike::of(expression) {
                                // An inline event handler is a body of its
                                // own (FA §1.2), and the element binds it
                                // (FA §8.5).
                                let site = self.site(expression.span().start);
                                self.store.calls.insert(site, "bind".to_string());
                                self.bind_captures(function, BodyKind::InlineHandler);
                                continue;
                            }
                            let val = self.eval(expression);
                            self.leaves(expression, &val);
                        }
                    }
                }
                JSXAttributeItem::SpreadAttribute(spread) => {
                    let val = self.eval(&spread.argument);
                    self.leaves(&spread.argument, &val);
                }
            }
        }
        for child in &element.children {
            self.jsx_child(child);
        }
    }

    fn jsx_child(&mut self, child: &JSXChild<'a>) {
        match child {
            JSXChild::Element(element) => self.jsx_element(element),
            JSXChild::Fragment(fragment) => {
                for child in &fragment.children {
                    self.jsx_child(child);
                }
            }
            JSXChild::ExpressionContainer(container) => {
                if let Some(expression) = container.expression.as_expression() {
                    let val = self.eval(expression);
                    self.leaves(expression, &val);
                }
            }
            JSXChild::Spread(spread) => {
                let val = self.eval(&spread.expression);
                self.leaves(&spread.expression, &val);
            }
            JSXChild::Text(_) => {}
        }
    }

    fn object(&mut self, object: &ObjectExpression<'a>) -> Val {
        let mut built = Built::default();
        for property in &object.properties {
            match property {
                ObjectPropertyKind::ObjectProperty(property) => {
                    let val = self.eval(&property.value);
                    match static_key_name(&property.key) {
                        Some(name) if !property.computed => {
                            built.fields.insert(name.to_string(), val);
                        }
                        _ => {
                            if let Some(key) = property.key.as_expression() {
                                let key_val = self.eval(key);
                                self.consume_scalar(key, &key_val);
                            }
                            built.bag.push(val);
                        }
                    }
                }
                ObjectPropertyKind::SpreadProperty(spread) => {
                    // A spread reads no child (FA §3.3). The record gains
                    // the projection the spread value has for each
                    // property.
                    let val = self.eval(&spread.argument);
                    let kinds = self.kinds(&spread.argument);
                    if kinds.open {
                        self.observe(&val, Class::Enumeration);
                    } else if kinds.nullable && val.has_projection() {
                        self.observe(&val, Class::Shape);
                    }
                    match &val {
                        Val::Built(inner) => {
                            let inner = inner.borrow();
                            built.fields.extend(
                                inner
                                    .fields
                                    .iter()
                                    .map(|(key, val)| (key.clone(), val.clone())),
                            );
                            built.bag.extend(inner.bag.iter().cloned());
                            built.spreads.extend(inner.spreads.iter().cloned());
                        }
                        other => built.spreads.push(other.clone()),
                    }
                }
            }
        }
        Val::Built(Rc::new(RefCell::new(built)))
    }

    fn static_member(&mut self, member: &StaticMemberExpression<'a>) -> Val {
        let object = self.eval(&member.object);
        if member.optional {
            self.presence(&member.object, &object);
        }
        let name = member.property.name.as_str();
        if let Val::Site(module, start) = object {
            // A read through the link a site returned (FA §8.1).
            self.store.site_reads.insert((module, start));
            return object;
        }
        if !object.has_projection() {
            return match &object {
                Val::Built(built) => {
                    let named = built.borrow().fields.contains_key(name);
                    if !named && matches!(name, "length" | "size") {
                        Val::Computed
                    } else {
                        self.extend(&object, name)
                    }
                }
                _ => Val::Computed,
            };
        }
        let kinds = self.kinds(&member.object);
        if matches!(name, "length" | "size") && (kinds.array || kinds.tuple || kinds.string) {
            if kinds.string {
                self.observe(&object, Class::Value);
            }
            if kinds.array || kinds.tuple {
                self.observe(&object, Class::Enumeration);
            }
            return Val::Computed;
        }
        if matches!(name, "length" | "size") && kinds.untyped {
            // The length of a value that has no type: of a string, as the
            // class that reads most.
            self.store.untyped.insert(self.site(member.span.start));
            self.observe(&object, Class::Value);
            return Val::Computed;
        }
        if kinds.scalar && !kinds.container && !kinds.untyped {
            // A member of a string or a number consumes it.
            self.observe(&object, Class::Value);
            return Val::Computed;
        }
        let recursive = self.recursive_type(&member.object, Self::below_cut(&object));
        self.enter_key(&object, recursive, name, member.span.start)
    }

    /// Whether a value was reached through the cut of a recursive type.
    fn below_cut(val: &Val) -> bool {
        val.projections()
            .iter()
            .any(|proj| !proj.entered.is_empty())
    }

    /// The property `name` of `object`, in whatever form the access is
    /// written: a property access, a keyed access, or a destructuring.
    /// `recursive` says that the type of `object` is the cut of a
    /// recursive type. W6: the path enters a recursive type a second time
    /// (FA §5.2).
    fn enter_key(&mut self, object: &Val, recursive: bool, name: &str, start: u32) -> Val {
        if !recursive {
            return self.extend(object, name);
        }
        let entered = "(recursive)".to_string();
        let again = object
            .projections()
            .iter()
            .any(|proj| proj.entered.iter().any(|other| *other == entered));
        if again {
            for proj in object.projections() {
                let mut path = proj.path.clone();
                while path.last() == Some(&Seg::Star) {
                    path.pop();
                }
                self.observe(&Val::Proj(Proj { path, ..proj }), Class::Value);
            }
            self.widen("W6", start);
            return Val::Computed;
        }
        let extended = self.extend(object, name);
        Self::enter(extended, &entered)
    }

    fn enter(val: Val, entered: &str) -> Val {
        match val {
            Val::Proj(mut proj) => {
                proj.entered.push(entered.to_string());
                Val::Proj(proj)
            }
            Val::Alts(members) => Val::Alts(
                members
                    .into_iter()
                    .map(|member| Self::enter(member, entered))
                    .collect(),
            ),
            other => other,
        }
    }

    fn computed_member(&mut self, member: &ComputedMemberExpression<'a>) -> Val {
        let object = self.eval(&member.object);
        if member.optional {
            self.presence(&member.object, &object);
        }
        match unwrap(&member.expression) {
            Expression::StringLiteral(key) => {
                // A keyed access enters a recursive type as a property
                // access does (FA §5.2).
                let recursive = object.has_projection()
                    && self.recursive_type(&member.object, Self::below_cut(&object));
                return self.enter_key(&object, recursive, key.value.as_str(), member.span.start);
            }
            Expression::NumericLiteral(index) if self.kinds(&member.object).tuple => {
                return self.extend(&object, &index.value.to_string());
            }
            _ => {}
        }
        let key = self.eval(&member.expression);
        self.consume_scalar(&member.expression, &key);
        if !object.has_projection() {
            return self.member(&object);
        }
        let kinds = self.kinds(&member.object);
        if kinds.string && !kinds.container {
            self.observe(&object, Class::Value);
            return Val::Computed;
        }
        if kinds.array || !kinds.tuple {
            self.observe(&object, Class::Enumeration);
        }
        if kinds.untyped {
            self.store.untyped.insert(self.site(member.span.start));
        } else if !kinds.array && !kinds.tuple {
            // A key that is not static on an object or record type (FA
            // §5.2, W1).
            self.widen("W1", member.span.start);
        }
        self.member(&object)
    }

    fn binary(&mut self, binary: &BinaryExpression<'a>) -> Val {
        let left = self.eval(&binary.left);
        let right = self.eval(&binary.right);
        let absent = |expression: &Expression<'a>| match unwrap(expression) {
            Expression::NullLiteral(_) => true,
            Expression::Identifier(identifier) => identifier.name == "undefined",
            _ => false,
        };
        match binary.operator {
            BinaryOperator::StrictEquality
            | BinaryOperator::StrictInequality
            | BinaryOperator::Equality
            | BinaryOperator::Inequality => {
                if absent(&binary.right) {
                    self.presence(&binary.left, &left);
                } else if absent(&binary.left) {
                    self.presence(&binary.right, &right);
                } else {
                    for (expression, val) in [(&binary.left, &left), (&binary.right, &right)] {
                        if !val.has_projection() {
                            continue;
                        }
                        let kinds = self.kinds(expression);
                        if kinds.scalar || kinds.untyped {
                            self.observe(val, Class::Value);
                        }
                        if kinds.container || kinds.handle || kinds.reference || kinds.factory {
                            self.observe(val, Class::Identity);
                        }
                    }
                }
            }
            BinaryOperator::In => match unwrap(&binary.left) {
                // `"k" in v` tests `v.k`; another key enumerates `v`.
                Expression::StringLiteral(key) => {
                    let tested = self.extend(&right, key.value.as_str());
                    self.observe(&tested, Class::Shape);
                }
                _ => {
                    self.consume_scalar(&binary.left, &left);
                    self.observe(&right, Class::Enumeration);
                }
            },
            BinaryOperator::Instanceof => self.kind_test(&binary.left, &left),
            _ => {
                self.consume(&binary.left, &left, true);
                self.consume(&binary.right, &right, true);
            }
        }
        Val::Computed
    }

    fn assignment(&mut self, assignment: &AssignmentExpression<'a>) -> Val {
        let val = self.eval(&assignment.right);
        let start = assignment.span.start;
        match &assignment.left {
            AssignmentTarget::AssignmentTargetIdentifier(identifier) => {
                if let Some(symbol) = self.symbol(identifier) {
                    let next = if assignment.operator == AssignmentOperator::Assign {
                        val.clone()
                    } else {
                        self.consume(&assignment.right, &val, true);
                        Val::Computed
                    };
                    self.assign(symbol, next);
                }
            }
            AssignmentTarget::StaticMemberExpression(member) => {
                let object = self.eval(&member.object);
                self.member_assignment(&object, Some(member.property.name.as_str()), &val, start);
            }
            AssignmentTarget::ComputedMemberExpression(member) => {
                let object = self.eval(&member.object);
                let key = self.eval(&member.expression);
                self.consume_scalar(&member.expression, &key);
                self.member_assignment(&object, None, &val, start);
            }
            _ => {}
        }
        val
    }

    /// A member assignment: on a built value it replaces or adds a member,
    /// and on an input it is an update in place (FA §3.5, W5).
    fn member_assignment(&mut self, object: &Val, key: Option<&str>, val: &Val, start: u32) {
        match object {
            Val::Built(built) => {
                let mut built = built.borrow_mut();
                match key {
                    Some(key) => {
                        built.fields.insert(key.to_string(), val.clone());
                    }
                    None => built.bag.push(val.clone()),
                }
            }
            other => {
                if other.has_projection() {
                    self.observe(other, Class::Value);
                    self.widen("W5", start);
                }
            }
        }
    }

    fn construct(&mut self, new: &NewExpression<'a>) -> Val {
        let global = match unwrap(&new.callee) {
            Expression::Identifier(identifier) if self.symbol(identifier).is_none() => {
                Some(identifier.name.as_str())
            }
            _ => None,
        };
        let arguments: Vec<&Expression<'a>> = new
            .arguments
            .iter()
            .filter_map(Argument::as_expression)
            .collect();
        match global {
            Some(name @ ("Map" | "Set" | "Array")) => {
                let mut members = Vec::new();
                if let Some(first) = arguments.first() {
                    let val = self.eval(first);
                    self.observe(&val, Class::Enumeration);
                    let member = self.member(&val);
                    match name {
                        "Map" => members.push(self.member(&member)),
                        "Set" => members.push(member),
                        _ => {}
                    }
                }
                Val::built(BTreeMap::new(), members)
            }
            Some(_) => {
                for argument in arguments {
                    let val = self.eval(argument);
                    self.consume(argument, &val, true);
                }
                Val::Computed
            }
            None => {
                // A cell constructor or a class of the API: the argument
                // leaves the body (FA §8.2).
                let creates = matches!(
                    unwrap(&new.callee),
                    Expression::Identifier(identifier)
                        if crate::api::is_cell_type(identifier.name.as_str())
                            && self
                                .resolver
                                .value_def(self.module(), identifier)
                                .is_none()
                );
                let site = self.site(new.span.start);
                if creates {
                    self.create_cell(None, new.span.start);
                }
                for argument in arguments {
                    let val = self.eval(argument);
                    self.leaves(argument, &val);
                    if creates {
                        self.store.pending.push((Pending::Created(site), val, true));
                    }
                }
                if creates {
                    Val::Site(site.0, site.1)
                } else {
                    Val::Created
                }
            }
        }
    }

    // ----- calls -----

    fn call(&mut self, call: &CallExpression<'a>) -> Val {
        let written = self.in_text((self.module(), call.span.start));
        if written {
            self.calls_in_text.push(call.span.start);
        }
        let val = self.call_inner(call);
        if written {
            self.calls_in_text.pop();
        }
        val
    }

    fn call_inner(&mut self, call: &CallExpression<'a>) -> Val {
        let arguments: Vec<&Expression<'a>> = call
            .arguments
            .iter()
            .filter_map(|argument| match argument {
                Argument::SpreadElement(spread) => Some(&spread.argument),
                other => other.as_expression(),
            })
            .collect();
        let callee = unwrap(&call.callee);
        let member = match callee {
            Expression::StaticMemberExpression(member) => Some(&**member),
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::StaticMemberExpression(member) => Some(&**member),
                _ => None,
            },
            _ => None,
        };
        if let Some(member) = member {
            return self.method(call, member, &arguments);
        }
        // An immediately invoked function is unconditional (FA §3.7).
        if let Some(function) = FunctionLike::of(callee) {
            let values = arguments
                .iter()
                .map(|argument| self.eval(argument))
                .collect();
            let module = self.module();
            self.closure(function);
            return self.call_function(module, function.span().start, values, false);
        }
        if let Expression::Identifier(identifier) = callee {
            let module = self.module();
            let Some(symbol) = self.symbol(identifier) else {
                return self.global_call(identifier.name.as_str(), &arguments);
            };
            let api = self.resolver.parsed(module).and_then(|parsed| {
                self.resolver
                    .model(module)?
                    .api_ref_of_callee(parsed.semantic.scoping(), callee)
            });
            if let Some(api) = api {
                return self.api_call(api.name.as_str(), &arguments, call.span.start);
            }
            // A pattern or a handler: the argument leaves the body by
            // reference (FA §8.1, §8.5).
            if let Some(kind @ (DefKind::Pattern | DefKind::Handler)) =
                self.resolver.value_def(module, identifier)
            {
                let site = self.site(call.span.start);
                let kind = match kind {
                    DefKind::Pattern => "instantiate:order",
                    _ => "bind",
                };
                let instantiates = kind == "instantiate:order";
                self.store
                    .calls
                    .entry(site)
                    .or_insert_with(|| kind.to_string());
                // A copy holds what the bound handler observes of it (FA
                // §8.5).
                let bound = if instantiates {
                    None
                } else {
                    self.handler_record(module, identifier)
                };
                for argument in &arguments {
                    let val = self.eval(argument);
                    match &bound {
                        Some(record) => {
                            let entries = entries_on(record, "state");
                            self.bind_state(Some(argument), &val, &entries);
                        }
                        None => self.leaves(argument, &val),
                    }
                    if instantiates {
                        self.store
                            .pending
                            .push((Pending::Argument(site), val, true));
                    }
                }
                return if instantiates {
                    Val::Site(site.0, site.1)
                } else {
                    Val::Created
                };
            }
            // A function of an imported TypeScript module reads each
            // argument in full (FA §1.2, W3).
            if let Some((home, _)) = self.resolver.origin(module, symbol) {
                let imported = self
                    .resolver
                    .model(home)
                    .is_some_and(|model| model.tier == ModuleTier::Imported);
                if imported && home != module {
                    for argument in &arguments {
                        let val = self.eval(argument);
                        if val.has_projection() {
                            self.observe(&val, Class::Value);
                            self.widen("W3", call.span.start);
                        }
                    }
                    return Val::Computed;
                }
            }
        }
        let target = self.eval(callee);
        let values: Vec<Val> = arguments
            .iter()
            .map(|argument| self.eval(argument))
            .collect();
        self.call_value(&target, values, &arguments, false, call.span.start)
    }

    /// A call of a global function of the standard library (FA §3.4): each
    /// argument is consumed.
    fn global_call(&mut self, name: &str, arguments: &[&Expression<'a>]) -> Val {
        for argument in arguments {
            let val = self.eval(argument);
            if name == "Boolean" {
                self.truthiness(argument, &val);
            } else {
                self.consume(argument, &val, true);
            }
        }
        Val::Computed
    }

    /// A call of a function `commonfabric` exports.
    fn api_call(&mut self, name: &str, arguments: &[&Expression<'a>], start: u32) -> Val {
        let site = self.site(start);
        let (first, rest) = match arguments.split_first() {
            Some((first, rest)) => (Some(*first), rest),
            None => (None, arguments),
        };
        match name {
            // The `cause` entries (FA §8.4): no input is observed.
            "eventKey" | "currentPrincipal" => {
                let key = if name == "eventKey" {
                    "eventKey"
                } else {
                    "principal"
                };
                self.store
                    .entries
                    .entry(("cause".to_string(), vec![Seg::Key(key.to_string())]))
                    .or_default()
                    .insert(Class::Value);
                Val::Computed
            }
            // Each operand is resolved, and decided on its own.
            "equals" => {
                for argument in arguments {
                    let val = self.eval(argument);
                    self.resolution(&val, true);
                }
                Val::Computed
            }
            "equalLinks" => {
                for argument in arguments {
                    let val = self.eval(argument);
                    self.observe(&val, Class::Identity);
                }
                Val::Computed
            }
            "principalOf" | "principalsOf" | "writtenPrincipalOf" | "profileOwnerOf"
            | "spaceOf" | "spaceAccess" | "spaceAccessOf" | "spaceMembers" | "spaceDeleted"
            | "resultOwnerOf" => {
                if let Some(first) = first {
                    let val = self.eval(first);
                    let scalar = {
                        let kinds = self.kinds(first);
                        kinds.scalar && !kinds.handle && !kinds.container && !kinds.reference
                    };
                    if scalar {
                        // An operand that names a space.
                        self.observe(&val, Class::Value);
                    } else {
                        self.resolution(&val, name != "resultOwnerOf");
                    }
                    if name.starts_with("principal")
                        || matches!(name, "writtenPrincipalOf" | "profileOwnerOf")
                    {
                        self.label_metadata(&val);
                    }
                    if name.starts_with("spaceA") || matches!(name, "spaceMembers" | "spaceDeleted")
                    {
                        let names: Vec<String> = val
                            .projections()
                            .iter()
                            .map(|proj| display_path(&proj.input, &proj.path))
                            .collect();
                        if !names.is_empty() {
                            self.store.spaces.insert(names.join(", "));
                        }
                    }
                }
                for argument in rest {
                    let val = self.eval(argument);
                    self.consume_scalar(argument, &val);
                }
                Val::Computed
            }
            "linksOf" => {
                if let Some(first) = first {
                    let val = self.eval(first);
                    self.observe(&val, Class::Enumeration);
                    let member = self.member(&val);
                    self.observe(&member, Class::Identity);
                }
                Val::Computed
            }
            "getPatternEnvironment" => Val::Computed,
            // A builder call in a body creates a value. Its callback is a
            // body of its own. An `action` is a binding (FA §8.5).
            "action" => {
                self.store.calls.insert(site, "bind".to_string());
                if let Some(function) = first.and_then(FunctionLike::of) {
                    self.bind_captures(function, BodyKind::Action);
                }
                Val::Created
            }
            "computed" | "lift" | "handler" | "pattern" | "assert" => Val::Created,
            _ => {
                // An effect request (FA §8.3), or another call: what it is
                // given leaves the body by reference (FA §3.8).
                if matches!(
                    name,
                    "fetchBinary"
                        | "fetchText"
                        | "fetchJson"
                        | "fetchJsonUnchecked"
                        | "fetchProgram"
                        | "generateText"
                        | "generateObject"
                        | "llmDialog"
                        | "agent"
                        | "sqliteQuery"
                        | "navigateTo"
                        | "compileAndRun"
                ) {
                    self.store.calls.insert(site, format!("effect:{name}"));
                }
                let effect = self.store.calls.contains_key(&site);
                for argument in arguments {
                    if FunctionLike::of(argument).is_some() {
                        continue;
                    }
                    let val = self.eval(argument);
                    self.leaves(argument, &val);
                    if effect {
                        self.store.pending.push((Pending::Request(site), val, true));
                    }
                }
                Val::Created
            }
        }
    }

    fn method(
        &mut self,
        call: &CallExpression<'a>,
        member: &StaticMemberExpression<'a>,
        arguments: &[&Expression<'a>],
    ) -> Val {
        let name = member.property.name.as_str();
        let start = call.span.start;
        // A member of a global object of the standard library.
        if let Expression::Identifier(object) = unwrap(&member.object) {
            if self.symbol(object).is_none() {
                return self.static_call(object.name.as_str(), name, arguments, start);
            }
        }
        // `X.of(value)` and `X.for(cause)`, and the same under
        // `X.perSpace`, `X.perUser`, and `X.perSession` (FA §8.2).
        let constructor = match unwrap(&member.object) {
            Expression::StaticMemberExpression(scope)
                if matches!(
                    scope.property.name.as_str(),
                    "perSpace" | "perUser" | "perSession"
                ) =>
            {
                unwrap(&scope.object)
            }
            other => other,
        };
        if let Expression::Identifier(object) = constructor {
            let is_constructor = matches!(
                object.name.as_str(),
                "Cell"
                    | "Writable"
                    | "OpaqueCell"
                    | "Stream"
                    | "ComparableCell"
                    | "ReadonlyCell"
                    | "WriteonlyCell"
            ) && self.resolver.value_def(self.module(), object).is_none();
            if is_constructor && matches!(name, "of" | "for") {
                self.create_cell(arguments.first().copied().filter(|_| name == "for"), start);
                let site = self.site(start);
                for argument in arguments {
                    let val = self.eval(argument);
                    self.leaves(argument, &val);
                    if name == "of" {
                        // The initial value (FA §8.2).
                        self.store.pending.push((Pending::Created(site), val, true));
                    }
                }
                return Val::Site(site.0, site.1);
            }
        }
        let receiver = self.eval(&member.object);
        // `.for(tag)` on an instantiation (FA §8.1).
        if name == "for" {
            if let Expression::CallExpression(inner) = unwrap(&member.object) {
                let site = self.site(inner.span.start);
                if let Some(kind) = self.store.calls.get_mut(&site) {
                    if kind == "instantiate:order" {
                        *kind = "instantiate:tag".to_string();
                    }
                    for argument in arguments {
                        let val = self.eval(argument);
                        self.leaves(argument, &val);
                    }
                    return receiver;
                }
            }
        }
        if member.optional || call.optional {
            self.presence(&member.object, &receiver);
        }
        if let Val::Site(module, site_start) = receiver {
            // A method of what a site returned: a read through it is
            // dynamic (FA §7.2), and a write lands in what the site made.
            if matches!(name, "get" | "sample") {
                self.store.site_reads.insert((module, site_start));
                return Val::Computed;
            }
            for argument in arguments {
                if FunctionLike::of(argument).is_some() {
                    continue;
                }
                let val = self.eval(argument);
                self.leaves(argument, &val);
            }
            return if WRITERS.contains(&name) {
                Val::Computed
            } else {
                receiver
            };
        }
        let kinds = self.kinds(&member.object);
        let made = receiver.projections().iter().any(|proj| proj.made);
        // A receiver that has no type is taken as a handle where the call
        // is one only a handle has.
        let only_a_handle = kinds.untyped
            && matches!(
                (name, arguments.len()),
                ("get" | "sample" | "resolveAsCell", 0)
                    | ("set", 1)
                    | (
                        "key"
                            | "elementById"
                            | "update"
                            | "send"
                            | "pushAll"
                            | "addUnique"
                            | "removeByValue",
                        _
                    )
            );
        if (kinds.handle || made || only_a_handle) && receiver.has_projection() {
            return self.handle_method(call, member, &receiver, name, arguments);
        }
        // A function held in a record the body built.
        if let Val::Built(built) = &receiver {
            let held = built.borrow().fields.get(name).cloned();
            if let Some(function @ Val::Func(..)) = held {
                let values: Vec<Val> = arguments
                    .iter()
                    .map(|argument| self.eval(argument))
                    .collect();
                return self.call_value(&function, values, arguments, false, start);
            }
        }
        if matches!(receiver, Val::Built(_)) || kinds.array || kinds.tuple {
            return self.collection_method(call, &receiver, name, arguments);
        }
        if receiver.has_projection() && kinds.container && !kinds.scalar {
            // A method of a `Map`, a `Set`, or another library object held
            // in an input: its members are enumerated.
            self.observe(&receiver, Class::Enumeration);
            let member = self.member(&receiver);
            for argument in arguments {
                if FunctionLike::of(argument).is_some() {
                    self.callback(argument, vec![member.clone(), Val::Computed], start);
                } else {
                    let val = self.eval(argument);
                    self.consume_scalar(argument, &val);
                }
            }
            return member;
        }
        if receiver.has_projection() && kinds.untyped {
            self.store.untyped.insert(self.site(start));
        }
        // A member of a string, a number, or another scalar (FA §3.4).
        self.observe(&receiver, Class::Value);
        for argument in arguments {
            if FunctionLike::of(argument).is_some() {
                self.callback(argument, Vec::new(), start);
            } else {
                let val = self.eval(argument);
                self.consume(argument, &val, true);
            }
        }
        Val::Computed
    }

    fn static_call(
        &mut self,
        object: &str,
        name: &str,
        arguments: &[&Expression<'a>],
        start: u32,
    ) -> Val {
        let Some(first) = arguments.first().copied() else {
            return Val::Computed;
        };
        match (object, name) {
            ("Object", "keys") => {
                let val = self.eval(first);
                self.observe(&val, Class::Enumeration);
                Val::Computed
            }
            ("Object", "values" | "entries") => {
                let val = self.eval(first);
                self.observe(&val, Class::Enumeration);
                let member = self.member(&val);
                if name == "entries" {
                    // A pair of a computed key and the member.
                    Val::bag(Val::bag(member))
                } else {
                    Val::bag(member)
                }
            }
            ("Object", "fromEntries") => {
                let val = self.eval(first);
                let pair = self.member(&val);
                Val::bag(self.member(&pair))
            }
            ("Object", "assign") => {
                let values: Vec<Val> = arguments
                    .iter()
                    .map(|argument| self.eval(argument))
                    .collect();
                if let Some(Val::Built(target)) = values.first() {
                    for source in values.iter().skip(1) {
                        target.borrow_mut().spreads.push(source.clone());
                    }
                }
                values.into_iter().next().unwrap_or(Val::Computed)
            }
            ("Object", "freeze" | "getPrototypeOf") => {
                let val = self.eval(first);
                self.observe(&val, Class::Shape);
                if name == "freeze" {
                    val
                } else {
                    Val::Computed
                }
            }
            ("Object", "hasOwn") => {
                let val = self.eval(first);
                match arguments.get(1).map(|key| unwrap(key)) {
                    Some(Expression::StringLiteral(key)) => {
                        let tested = self.extend(&val, key.value.as_str());
                        self.observe(&tested, Class::Shape);
                    }
                    Some(other) => {
                        let key = self.eval(other);
                        self.consume_scalar(other, &key);
                        self.observe(&val, Class::Enumeration);
                    }
                    None => {}
                }
                Val::Computed
            }
            ("Array", "isArray") => {
                let val = self.eval(first);
                self.kind_test(first, &val);
                Val::Computed
            }
            ("Array", "from") => {
                let val = self.eval(first);
                self.observe(&val, Class::Enumeration);
                let member = self.member(&val);
                match arguments.get(1) {
                    Some(function) => {
                        Val::bag(self.callback(function, vec![member, Val::Computed], start))
                    }
                    None => Val::bag(member),
                }
            }
            ("Array", "of") => {
                let members = arguments
                    .iter()
                    .map(|argument| self.eval(argument))
                    .collect();
                Val::built(BTreeMap::new(), members)
            }
            // `JSON.stringify`, `console`, `Math`, and every other member:
            // each argument is consumed, and a container is converted (FA
            // §3.4).
            _ => {
                for argument in arguments {
                    let val = self.eval(argument);
                    self.consume(argument, &val, true);
                }
                Val::Computed
            }
        }
    }

    /// A method of an array, or of a list, a bag, a `Map`, or a `Set` the
    /// body built (FA §3.4).
    fn collection_method(
        &mut self,
        call: &CallExpression<'a>,
        receiver: &Val,
        name: &str,
        arguments: &[&Expression<'a>],
    ) -> Val {
        let input = receiver.has_projection();
        let start = call.span.start;
        let member = self.member(receiver);
        let first = arguments.first().copied();
        match name {
            "push" | "unshift" | "add" | "set" if !input => {
                let values: Vec<Val> = arguments
                    .iter()
                    .map(|argument| self.eval(argument))
                    .collect();
                if matches!(name, "add" | "set") {
                    if let Some(key) = first {
                        self.consume_scalar(key, &values[0]);
                    }
                }
                // `map.set(key, value)` puts the value in, and not the key.
                let skip = usize::from(name == "set" && values.len() == 2);
                if let Val::Built(built) = receiver {
                    for (index, val) in values.into_iter().enumerate().skip(skip) {
                        // A spread argument adds the members of the value.
                        let spread =
                            matches!(call.arguments.get(index), Some(Argument::SpreadElement(_)));
                        let added = if spread {
                            self.observe(&val, Class::Enumeration);
                            self.member(&val)
                        } else {
                            val
                        };
                        built.borrow_mut().bag.push(added);
                    }
                }
                Val::Computed
            }
            // A mutating method on an input is an update in place (W5).
            "push" | "pop" | "shift" | "unshift" | "splice" | "fill" | "reverse" | "sort"
                if input =>
            {
                self.observe(receiver, Class::Value);
                self.widen("W5", start);
                for argument in arguments {
                    self.eval(argument);
                }
                Val::Computed
            }
            "map" | "flatMap" | "forEach" => {
                self.observe(receiver, Class::Enumeration);
                let Some(function) = first else {
                    return Val::Computed;
                };
                let values = vec![member, Val::Computed, receiver.clone()];
                let result = self.callback(function, values, start);
                match name {
                    "forEach" => Val::Computed,
                    "flatMap" => {
                        let inner = self.member(&result);
                        Val::built(BTreeMap::new(), vec![inner, result])
                    }
                    _ => Val::bag(result),
                }
            }
            "filter" | "find" | "findLast" | "some" | "every" | "findIndex" | "findLastIndex" => {
                self.observe(receiver, Class::Enumeration);
                if let Some(function) = first {
                    let values = vec![member.clone(), Val::Computed, receiver.clone()];
                    self.callback(function, values, start);
                }
                match name {
                    "filter" => Val::bag(member),
                    "find" | "findLast" => member,
                    _ => Val::Computed,
                }
            }
            "reduce" | "reduceRight" => {
                self.observe(receiver, Class::Enumeration);
                let Some(function) = first else {
                    return Val::Computed;
                };
                let initial = match arguments.get(1) {
                    Some(initial) => self.eval(initial),
                    None => member.clone(),
                };
                // The accumulator is the join of the initial value and
                // what the callback returns.
                let once = self.callback(function, vec![initial.clone(), member.clone()], start);
                let joined = Val::alts(vec![initial, once]);
                let twice = self.callback(function, vec![joined.clone(), member], start);
                Val::alts(vec![joined, twice])
            }
            "toSorted" | "sort" => {
                self.observe(receiver, Class::Enumeration);
                match first {
                    Some(compare) => {
                        self.callback(compare, vec![member.clone(), member.clone()], start);
                    }
                    // Elements are compared as strings.
                    None => self.observe(&member, Class::Value),
                }
                Val::bag(member)
            }
            "slice" | "concat" | "toReversed" | "toSpliced" | "with" | "values" | "entries"
            | "keys" | "flat" => {
                self.observe(receiver, Class::Enumeration);
                let mut members = vec![member.clone()];
                for argument in arguments {
                    let val = self.eval(argument);
                    if self.kinds(argument).array || matches!(val, Val::Built(_)) {
                        self.observe(&val, Class::Enumeration);
                        members.push(self.member(&val));
                    } else {
                        self.consume_scalar(argument, &val);
                    }
                }
                if name == "flat" {
                    self.observe(&member, Class::Enumeration);
                    members.push(self.member(&member));
                }
                Val::built(BTreeMap::new(), members)
            }
            "includes" | "indexOf" | "lastIndexOf" => {
                self.observe(receiver, Class::Enumeration);
                if let Some(wanted) = first {
                    let val = self.eval(wanted);
                    let kinds = self.kinds(wanted);
                    let class = if kinds.scalar || kinds.untyped || !val.has_projection() {
                        Class::Value
                    } else {
                        Class::Identity
                    };
                    self.observe(&val, class);
                    self.observe(&member, class);
                }
                Val::Computed
            }
            "join" => {
                self.observe(receiver, Class::Enumeration);
                self.observe(&member, Class::Value);
                Val::Computed
            }
            // A lookup by key or by index: the key is compared.
            "has" | "get" | "at" | "delete" => {
                if input {
                    self.observe(receiver, Class::Enumeration);
                }
                if let Some(key) = first {
                    let val = self.eval(key);
                    let kinds = self.kinds(key);
                    if kinds.scalar || kinds.untyped {
                        self.consume_scalar(key, &val);
                    } else {
                        self.observe(&val, Class::Identity);
                    }
                }
                if matches!(name, "get" | "at") {
                    member
                } else {
                    Val::Computed
                }
            }
            _ => {
                if input {
                    self.observe(receiver, Class::Enumeration);
                }
                for argument in arguments {
                    if FunctionLike::of(argument).is_some() {
                        self.callback(argument, vec![member.clone(), Val::Computed], start);
                    } else {
                        let val = self.eval(argument);
                        self.consume_scalar(argument, &val);
                    }
                }
                Val::Computed
            }
        }
    }

    /// A method of a handle (FA §7.1, §6.1).
    fn handle_method(
        &mut self,
        call: &CallExpression<'a>,
        member: &StaticMemberExpression<'a>,
        receiver: &Val,
        name: &str,
        arguments: &[&Expression<'a>],
    ) -> Val {
        let handles = receiver.projections();
        let site = self.site(call.span.start);
        match name {
            "get" | "sample" if arguments.is_empty() => {
                // The three conditions of FA §7.2.
                let reason = if handles.len() != 1 {
                    Some("alternatives")
                } else if handles[0].path.contains(&Seg::Star) || handles[0].dynamic {
                    Some("not anchored")
                } else if self.cond > 0 || self.returned {
                    Some("conditional")
                } else {
                    None
                };
                match reason {
                    None => {
                        self.store.static_reads.insert(site);
                    }
                    Some(reason) => {
                        let names: Vec<String> = handles
                            .iter()
                            .map(|handle| display_path(&handle.input, &handle.path))
                            .collect();
                        self.store
                            .dynamic_reads
                            .insert(site, format!("{}: {reason}", names.join(", ")));
                        for handle in &handles {
                            let mut key = handle.key();
                            if handle.made {
                                // The handle read through is the one of
                                // the cell the position is in.
                                if let Some(hop) =
                                    key.1.iter().rposition(|segment| *segment == Seg::Hop)
                                {
                                    key.1.truncate(hop);
                                }
                            }
                            self.store.dynamic_handles.insert((key, handle.dynamic));
                        }
                    }
                }
                let mut results = Vec::new();
                for handle in &handles {
                    self.use_handle(handle);
                    self.store.read_cells.insert(handle.cell());
                    let mut result = if handle.made {
                        Proj {
                            made: false,
                            ..handle.clone()
                        }
                    } else {
                        handle.with(Seg::Hop)
                    };
                    result.dynamic = handle.dynamic || reason.is_some();
                    results.push(Val::Proj(result));
                }
                Val::alts(results)
            }
            "key" | "elementById" => {
                let literal = match (name, arguments) {
                    ("key", [argument]) => match unwrap(argument) {
                        Expression::StringLiteral(key) => Some(key.value.to_string()),
                        Expression::NumericLiteral(index) => Some(index.value.to_string()),
                        _ => None,
                    },
                    _ => None,
                };
                let flattens = literal
                    .as_deref()
                    .is_some_and(|key| self.key_is_handle(&member.object, key));
                if literal.is_none() {
                    self.store.dynamic_keys.insert(site);
                    for argument in arguments {
                        let val = self.eval(argument);
                        self.consume_scalar(argument, &val);
                    }
                }
                let results = handles
                    .iter()
                    .map(|handle| {
                        let mut path = handle.path.clone();
                        if !handle.made {
                            path.push(Seg::Hop);
                        }
                        path.push(match &literal {
                            Some(key) => Seg::Key(key.clone()),
                            None => Seg::Star,
                        });
                        Val::Proj(Proj {
                            input: handle.input.clone(),
                            path,
                            dynamic: handle.dynamic,
                            made: !flattens,
                            resolved: handle.resolved,
                            entered: Vec::new(),
                        })
                    })
                    .collect();
                Val::alts(results)
            }
            "resolveAsCell" if arguments.is_empty() => self.resolution(receiver, true),
            "for" | "withTx" | "asSchema" | "resolveAsCell" => {
                for argument in arguments {
                    let val = self.eval(argument);
                    self.leaves(argument, &val);
                }
                receiver.clone()
            }
            "equals" => {
                self.resolution(receiver, true);
                for argument in arguments {
                    let val = self.eval(argument);
                    self.resolution(&val, true);
                }
                Val::Computed
            }
            "equalLinks" => {
                for handle in &handles {
                    self.use_handle(handle);
                }
                for argument in arguments {
                    let val = self.eval(argument);
                    self.observe(&val, Class::Identity);
                }
                Val::Computed
            }
            _ if WRITERS.contains(&name) => {
                let mut every_static = true;
                for handle in &handles {
                    self.use_handle(handle);
                    let dynamic = handle.path.contains(&Seg::Star) || handle.dynamic;
                    every_static &= !dynamic;
                    self.store.writes.insert(format!(
                        "{}{}",
                        handle.target(),
                        if dynamic { " (dynamic)" } else { "" }
                    ));
                    if !dynamic {
                        self.store.write_targets.push((handle.cell(), site));
                    }
                    // A push onto a collection the handler read before.
                    // `addUnique` is the merge-safe operation, and is
                    // not reported (LS §10.3).
                    let read = self.store.read_cells.iter().any(|(input, path)| {
                        let (target_input, target) = handle.cell();
                        *input == target_input
                            && (path.starts_with(&target) || target.starts_with(path))
                    });
                    if !self.computation
                        && self.handler
                        && read
                        && matches!(name, "push" | "pushAll")
                    {
                        self.store.read_then_push.insert(site);
                    }
                }
                if self.computation {
                    // The first two shapes of FA §6.6.
                    match name {
                        "push" | "pushAll" | "increment" => {
                            self.store.not_idempotent.insert(site, "append");
                        }
                        "send" => {
                            self.store.not_idempotent.insert(site, "send");
                        }
                        _ => {}
                    }
                }
                self.store.write_sites.insert(site, every_static);
                let appends = matches!(name, "push" | "pushAll" | "addUnique");
                let mut values = Vec::new();
                for argument in arguments {
                    let val = self.eval(argument);
                    self.leaves(argument, &val);
                    values.push(val);
                }
                if values.is_empty() {
                    values.push(Val::Computed);
                }
                for handle in &handles {
                    let dynamic = handle.path.contains(&Seg::Star) || handle.dynamic;
                    for val in &values {
                        self.store.pending.push((
                            Pending::Handle(handle.clone(), appends),
                            val.clone(),
                            !dynamic,
                        ));
                    }
                }
                Val::Computed
            }
            _ => {
                // Another method of a handle: the handle is used, and a
                // scalar argument is consumed.
                for handle in &handles {
                    self.use_handle(handle);
                }
                for argument in arguments {
                    if FunctionLike::of(argument).is_some() {
                        continue;
                    }
                    let val = self.eval(argument);
                    self.consume_scalar(argument, &val);
                }
                Val::Computed
            }
        }
    }

    /// `Body.outputs` (FA §3.8): the result paths that hold a reference
    /// the body was given.
    fn outputs(&mut self, val: &Val) {
        let mut found = Vec::new();
        references(&self.store, val, &mut Vec::new(), 0, &mut found);
        for (path, passes, names) in found {
            let shown = if path.is_empty() {
                "(root)".to_string()
            } else {
                plain_path(&path)
            };
            let listed: Vec<String> = names
                .iter()
                .map(|name| display_path(&name.input, &name.path))
                .collect();
            self.store.outputs.push(format!(
                "{shown} : {} {}",
                if passes { "passes" } else { "oneOf" },
                listed.join(", ")
            ));
            self.store.output_refs.push((path, passes, names));
        }
    }

    /// The record as data: the entries, `Body.handles`, and the write
    /// edges and envelopes with their references (FA §6.5).
    fn detail(&self) -> Detail {
        let store = &self.store;
        let entries = normal_entries(&store.entries, store);
        let envelope = normal_entries(&store.envelope, store);
        // The handles: one the body was given, or the one a found handle
        // was found through.
        let given: BTreeSet<&PathKey> = store
            .dynamic_handles
            .iter()
            .filter(|(_, found)| !*found)
            .map(|(key, _)| key)
            .collect();
        let mut positions: BTreeSet<PathKey> = BTreeSet::new();
        for ((input, path), found) in &store.dynamic_handles {
            if !*found {
                positions.insert((input.clone(), path.clone()));
                continue;
            }
            let hops = path
                .iter()
                .enumerate()
                .filter(|(_, segment)| **segment == Seg::Hop)
                .map(|(index, _)| index);
            let mut through: Option<usize> = None;
            let mut first: Option<usize> = None;
            for hop in hops {
                first.get_or_insert(hop);
                if given.contains(&(input.clone(), path[..hop].to_vec())) {
                    through = Some(hop);
                }
            }
            if let Some(hop) = through.or(first) {
                positions.insert((input.clone(), path[..hop].to_vec()));
            }
        }
        let mut handles: Vec<HandleRead> = positions
            .into_iter()
            .map(|(input, path)| {
                let mut below = path.clone();
                below.push(Seg::Hop);
                HandleRead {
                    envelope: envelope
                        .iter()
                        .filter(|entry| entry.input == input && entry.path.starts_with(&below))
                        .cloned()
                        .collect(),
                    at: HandleAt::Entry(input, path),
                }
            })
            .collect();
        let site_index = |site: &(usize, u32)| store.calls.keys().position(|other| other == site);
        for site in &store.site_reads {
            // A site that makes something a later invocation can find
            // again (FA §7.2, §8.1, §8.2).
            let found_again = match store.calls.get(site).map(String::as_str) {
                Some("instantiate:tag") => true,
                Some("instantiate:order") => self.computation,
                Some(kind) => kind.starts_with("createCell:cause"),
                None => false,
            };
            if let (true, Some(index)) = (found_again, site_index(site)) {
                handles.push(HandleRead {
                    at: HandleAt::Call(index),
                    envelope: Vec::new(),
                });
            }
        }
        let mut edges: Vec<WriteRec> = Vec::new();
        for (pending, val, fixed) in &store.pending {
            let (target, mut below) = match pending {
                Pending::Handle(proj, appends) => {
                    // The handle's position, and the path below its cell.
                    let hop = proj
                        .path
                        .iter()
                        .rposition(|segment| *segment == Seg::Hop)
                        .filter(|_| proj.made);
                    let (position, mut below) = match hop {
                        Some(hop) => (proj.path[..hop].to_vec(), proj.path[hop + 1..].to_vec()),
                        None => (proj.path.clone(), Vec::new()),
                    };
                    if *appends {
                        below.push(Seg::Star);
                    }
                    let resolved =
                        matches!(proj.resolved, Some((length, _)) if length == position.len());
                    (
                        WriteTarget::Handle {
                            input: proj.input.clone(),
                            path: position,
                            resolved,
                        },
                        below,
                    )
                }
                Pending::Created(site) => match site_index(site) {
                    Some(index) => (WriteTarget::Created(index), Vec::new()),
                    None => continue,
                },
                Pending::Argument(site) => match site_index(site) {
                    Some(index) => (WriteTarget::Argument(index), Vec::new()),
                    None => continue,
                },
                Pending::Request(site) => match site_index(site) {
                    Some(index) => (WriteTarget::Request(index), Vec::new()),
                    None => continue,
                },
            };
            edges.push(WriteRec {
                target: target.clone(),
                path: below.clone(),
                fixed: *fixed,
                reference: None,
            });
            if !*fixed {
                continue;
            }
            let mut found = Vec::new();
            references(store, val, &mut below, 0, &mut found);
            for (path, passes, names) in found {
                edges.push(WriteRec {
                    target: target.clone(),
                    path,
                    fixed: true,
                    reference: Some((passes, names)),
                });
            }
        }
        edges.sort_by_key(WriteRec::to_string);
        edges.dedup();
        Detail {
            entries,
            envelope,
            handles,
            edges,
            links: store
                .link_entries
                .iter()
                .map(|starts| starts.to_vec())
                .collect(),
            label_metadata: store.label_metadata,
            outputs: store.output_refs.clone(),
        }
    }

    // ----- binding a handler (FA §8.5) -----

    /// The record of the handler a module-scope name is defined as.
    fn handler_record(
        &mut self,
        module: usize,
        identifier: &IdentifierReference<'a>,
    ) -> Option<Record> {
        if self.depth >= MAX_BOUND {
            return None;
        }
        let symbol = self.symbol(identifier)?;
        let (home, symbol) = self.resolver.origin(module, symbol)?;
        let parsed = self.resolver.parsed(home)?;
        let declaration = parsed.semantic.scoping().symbol_declaration(symbol);
        let AstKind::VariableDeclarator(declarator) = parsed.semantic.nodes().kind(declaration)
        else {
            return None;
        };
        let Expression::CallExpression(call) = unwrap(declarator.init.as_ref()?) else {
            return None;
        };
        let function = call
            .arguments
            .iter()
            .rev()
            .find_map(FunctionLike::of_argument)?;
        analyze_body(
            self.resolver,
            home,
            BodyKind::Handler,
            function.span().start,
            self.depth + 1,
        )
    }

    /// Records what a value bound to a path of a handler's state leaves
    /// the body as, by the table of FA §8.5. `entries` is the bound
    /// handler's footprint at and below the path.
    fn bind_state(
        &mut self,
        expression: Option<&Expression<'a>>,
        val: &Val,
        entries: &[(Vec<Seg>, Class)],
    ) {
        let below = |name: &str| -> Vec<(Vec<Seg>, Class)> {
            entries
                .iter()
                .filter(|(path, _)| path.first() == Some(&Seg::Key(name.to_string())))
                .map(|(path, class)| (path[1..].to_vec(), *class))
                .collect()
        };
        let expression = expression.map(unwrap);
        if let (Some(Expression::ObjectExpression(object)), Val::Built(built)) = (expression, val) {
            // A record written at the site: each member by its own row.
            let mut named = BTreeSet::new();
            for property in &object.properties {
                let ObjectPropertyKind::ObjectProperty(property) = property else {
                    continue;
                };
                let Some(name) = static_key_name(&property.key).filter(|_| !property.computed)
                else {
                    continue;
                };
                let member = built.borrow().fields.get(name).cloned();
                if let Some(member) = member {
                    named.insert(name.to_string());
                    self.bind_state(Some(&property.value), &member, &below(name));
                }
            }
            let others: Vec<Val> = {
                let built = built.borrow();
                built
                    .fields
                    .iter()
                    .filter(|(name, _)| !named.contains(*name))
                    .map(|(_, member)| member.clone())
                    .chain(built.bag.iter().cloned())
                    .chain(built.spreads.iter().cloned())
                    .collect()
            };
            for member in others {
                self.leaves_untyped(&member, 0);
            }
            return;
        }
        match val {
            Val::Proj(_) | Val::Alts(_) if val.has_projection() => {
                // A scalar is copied, in the classes the handler has at
                // the path. Anything else stays a link.
                let scalar = match expression {
                    Some(expression) => {
                        let kinds = self.kinds(expression);
                        !(kinds.container || kinds.handle || kinds.reference || kinds.factory)
                    }
                    None => {
                        entries.iter().all(|(path, _)| path.is_empty())
                            && entries
                                .iter()
                                .any(|(_, class)| matches!(class, Class::Value | Class::Shape))
                    }
                };
                if scalar {
                    for (path, class) in entries {
                        if !path.is_empty() {
                            continue;
                        }
                        match class {
                            Class::Value => self.observe(val, Class::Value),
                            Class::Shape => self.observe_shape(val, false),
                            _ => {}
                        }
                    }
                } else if let Some(expression) = expression {
                    self.leaves(expression, val);
                } else if !entries.is_empty() {
                    for proj in val.projections() {
                        self.use_handle(&proj);
                    }
                }
            }
            Val::Built(built) => {
                // A container the body computed: the copy holds the paths
                // the handler observes.
                let (fields, rest) = {
                    let built = built.borrow();
                    let rest: Vec<Val> = built
                        .bag
                        .iter()
                        .cloned()
                        .chain(built.spreads.iter().cloned())
                        .collect();
                    (built.fields.clone(), rest)
                };
                let whole = entries.iter().any(|(path, class)| {
                    path.is_empty() && matches!(class, Class::Value | Class::Identity)
                });
                if whole {
                    self.observe_members(val, 0);
                    return;
                }
                for (name, member) in &fields {
                    self.bind_state(None, member, &below(name));
                }
                let starred: Vec<(Vec<Seg>, Class)> = entries
                    .iter()
                    .filter(|(path, _)| path.first() == Some(&Seg::Star))
                    .map(|(path, class)| (path[1..].to_vec(), *class))
                    .collect();
                for member in &rest {
                    self.bind_state(None, member, &starred);
                }
            }
            _ => {}
        }
    }

    /// Records what the values a function written in the body captures
    /// leave the body as, where the function is bound as a handler: an
    /// `action`, or an inline event handler.
    fn bind_captures(&mut self, function: FunctionLike<'_, 'a>, kind: BodyKind) {
        if self.depth >= MAX_BOUND {
            return;
        }
        let module = self.module();
        let span = function.span();
        let Some(record) = analyze_body(self.resolver, module, kind, span.start, self.depth + 1)
        else {
            return;
        };
        let Some(parsed) = self.resolver.parsed(module) else {
            return;
        };
        let scoping = parsed.semantic.scoping();
        let mut seen = BTreeSet::new();
        let mut captured: Vec<&'a IdentifierReference<'a>> = Vec::new();
        for node in parsed.semantic.nodes().iter() {
            let AstKind::IdentifierReference(identifier) = node.kind() else {
                continue;
            };
            if !(span.start <= identifier.span.start && identifier.span.end <= span.end) {
                continue;
            }
            let Some(symbol) = symbol_of(scoping, identifier) else {
                continue;
            };
            let declared = scoping.symbol_span(symbol);
            if span.start <= declared.start && declared.end <= span.end {
                continue;
            }
            if seen.insert(symbol) {
                captured.push(identifier);
            }
        }
        for identifier in captured {
            let entries = entries_on(&record, identifier.name.as_str());
            if entries.is_empty() {
                continue;
            }
            let val = self.lookup(identifier);
            self.bind_state(None, &val, &entries);
        }
    }

    // ----- the record -----

    fn finish(mut self) -> Record {
        // The body of a closure is analyzed, called or not (FA §3.6).
        let mut index = 0;
        while index < self.closures.len() {
            let (module, start, evaluated) = self.closures[index];
            index += 1;
            if !evaluated {
                self.call_function(module, start, Vec::new(), true);
            }
        }
        // The third shape of FA §6.6: a read at or below a path the body
        // writes, through the same anchored handle.
        if self.computation {
            let targets = self.store.write_targets.clone();
            for ((input, path), site) in targets {
                let store = &self.store;
                let read = store
                    .entries
                    .keys()
                    .chain(store.envelope.keys())
                    .chain(store.read_cells.iter())
                    .any(|(other, below)| *other == input && below.starts_with(&path));
                if read {
                    self.store
                        .not_idempotent
                        .entry(site)
                        .or_insert("reads its own target");
                }
            }
        }
        let computation = self.computation;
        let store = &self.store;
        let (root_module, (from, to)) = self.root;
        let own = |site: &(usize, u32)| site.0 == root_module && from <= site.1 && site.1 < to;
        let mut sites: Vec<(u32, String)> = Vec::new();
        sites.extend(
            store
                .static_reads
                .iter()
                .filter(|site| own(site))
                .map(|site| (site.1, "read:static".to_string())),
        );
        sites.extend(
            store
                .dynamic_reads
                .iter()
                .filter(|(site, _)| own(site))
                .map(|(site, reason)| {
                    let reason = reason.rsplit(": ").next().unwrap_or("");
                    (site.1, format!("read:dynamic:{reason}"))
                }),
        );
        sites.extend(store.write_sites.iter().filter(|(site, _)| own(site)).map(
            |(site, fixed)| {
                let kind = if *fixed {
                    "write:static"
                } else {
                    "write:dynamic"
                };
                (site.1, kind.to_string())
            },
        ));
        sites.extend(
            store
                .dynamic_keys
                .iter()
                .filter(|site| own(site))
                .map(|site| (site.1, "key:dynamic".to_string())),
        );
        sites.extend(
            store
                .direct
                .iter()
                .map(|(cause, _, start)| (*start, format!("widen:{cause}"))),
        );
        let materializer =
            store.write_sites.values().any(|fixed| !*fixed) || !store.materializer.is_empty();
        let state_cell = store.calls.values().any(|call| call.ends_with("(state)"));
        let tier = if !computation {
            None
        } else if materializer {
            Some("materializer")
        } else if !store.write_sites.is_empty() || state_cell {
            Some("static side-write")
        } else {
            Some("primary output")
        };
        if computation {
            // The sites that make the body a materializer, for the hint.
            sites.extend(
                store
                    .write_sites
                    .iter()
                    .filter(|(site, fixed)| own(site) && !**fixed)
                    .map(|(site, _)| site)
                    .chain(store.materializer.iter().filter(|site| own(site)))
                    .map(|site| (site.1, "materializer".to_string())),
            );
        }
        sites.extend(
            store
                .not_idempotent
                .iter()
                .filter(|(site, _)| own(site))
                .map(|(site, shape)| (site.1, format!("not-idempotent:{shape}"))),
        );
        sites.extend(
            store
                .read_then_push
                .iter()
                .filter(|site| own(site))
                .map(|site| (site.1, "read-then-push".to_string())),
        );
        // What a function the body calls brought into it.
        let mut brought: Vec<(u32, String, usize, u32)> = Vec::new();
        {
            let reached = self.reached.borrow();
            let mut bring = |site: &(usize, u32), what: String| {
                if let Some(call) = reached.get(site) {
                    brought.push((*call, what, site.0, site.1));
                }
            };
            for (site, reason) in &store.dynamic_reads {
                let reason = reason.rsplit(": ").next().unwrap_or("");
                bring(site, format!("read:dynamic:{reason}"));
            }
            for (cause, module, start) in &store.widenings {
                bring(&(*module, *start), format!("widen:{cause}"));
            }
            if computation {
                for (site, fixed) in &store.write_sites {
                    if !*fixed {
                        bring(site, "materializer".to_string());
                    }
                }
                for site in &store.materializer {
                    bring(site, "materializer".to_string());
                }
            }
            for (site, shape) in &store.not_idempotent {
                bring(site, format!("not-idempotent:{shape}"));
            }
            for site in &store.read_then_push {
                bring(site, "read-then-push".to_string());
            }
        }
        brought.sort();
        brought.dedup();
        let mut other_dynamic: Vec<String> = Vec::new();
        if store.label_metadata {
            other_dynamic.push("labelMetadata".to_string());
        }
        other_dynamic.extend(store.links.iter().map(|names| format!("link: {names}")));
        other_dynamic.extend(store.spaces.iter().map(|names| format!("space: {names}")));
        sites.sort();
        let detail = self.detail();
        let store = &self.store;
        Record {
            handles: detail
                .handles
                .iter()
                .map(|handle| handle.at.line())
                .collect(),
            edges: detail
                .edges
                .iter()
                .filter(|edge| edge.fixed)
                .map(WriteRec::to_string)
                .collect(),
            envelopes: detail
                .edges
                .iter()
                .filter(|edge| !edge.fixed)
                .map(WriteRec::to_string)
                .collect(),
            detail,
            calls: store.calls.values().cloned().collect(),
            other_dynamic,
            outputs: store.outputs.clone(),
            tier,
            not_idempotent: store
                .not_idempotent
                .values()
                .map(|shape| shape.to_string())
                .collect(),
            read_then_push: store.read_then_push.len(),
            sites,
            brought,
            reads: normal_form(&store.entries, store),
            envelope: normal_form(&store.envelope, store),
            static_reads: store.static_reads.len(),
            dynamic_reads: store.dynamic_reads.values().cloned().collect(),
            writes: store.writes.iter().cloned().collect(),
            write_sites: (
                store.write_sites.len(),
                store.write_sites.values().filter(|fixed| **fixed).count(),
            ),
            widenings: store
                .widenings
                .iter()
                .map(|(cause, _, _)| cause.clone())
                .collect(),
            direct_widenings: store
                .direct
                .iter()
                .map(|(cause, _, _)| cause.clone())
                .collect(),
            dynamic_keys: store.dynamic_keys.len(),
            untyped: store.untyped.len(),
        }
    }
}

/// The paths of a value that hold a reference the body was given (FA
/// §3.8, §6.5): the path, whether the reference is `passes`, and the
/// entries it names.
fn references(
    store: &Store,
    val: &Val,
    path: &mut Vec<Seg>,
    depth: u32,
    found: &mut Vec<(Vec<Seg>, bool, Vec<RefName>)>,
) {
    let reference = |proj: &Proj| {
        !proj.dynamic
            && store.entries.get(&proj.key()).is_some_and(|classes| {
                classes.contains(&Class::Identity) || classes.contains(&Class::Resolved)
            })
    };
    let name = |proj: &Proj| RefName {
        input: proj.input.clone(),
        path: proj.path.clone(),
        resolved: matches!(proj.resolved, Some((length, true)) if length == proj.path.len())
            && store
                .entries
                .get(&proj.key())
                .is_some_and(|classes| classes.contains(&Class::Resolved)),
    };
    let sorted = |mut names: Vec<RefName>| {
        names.sort_by_key(|name| display_path(&name.input, &name.path));
        names.dedup();
        names
    };
    match val {
        Val::Proj(proj) if reference(proj) => {
            found.push((
                path.clone(),
                !proj.path.contains(&Seg::Star),
                vec![name(proj)],
            ));
        }
        Val::Alts(members) if members.iter().all(|member| matches!(member, Val::Built(_))) => {
            // Alternatives the body built: a path holds the reference of
            // the alternative that was taken, so the references of all of
            // them are what it is one of.
            let mut each = Vec::new();
            for member in members {
                references(store, member, path, depth + 1, &mut each);
            }
            let mut merged: Vec<(Vec<Seg>, bool, Vec<RefName>)> = Vec::new();
            for (at, passes, names) in each {
                match merged.iter_mut().find(|(other, _, _)| *other == at) {
                    Some((_, other_passes, other_names)) => {
                        *other_passes = false;
                        other_names.extend(names);
                        *other_names = sorted(std::mem::take(other_names));
                    }
                    None => merged.push((at, passes, names)),
                }
            }
            found.extend(merged);
        }
        Val::Alts(members) => {
            let mut names = Vec::new();
            for member in members {
                match member {
                    Val::Proj(proj) if reference(proj) => names.push(name(proj)),
                    _ => return,
                }
            }
            found.push((path.clone(), false, sorted(names)));
        }
        Val::Built(built) if depth < 6 => {
            let (fields, bag, spreads) = {
                let built = built.borrow();
                (
                    built.fields.clone(),
                    built.bag.clone(),
                    built.spreads.clone(),
                )
            };
            for (key, member) in &fields {
                path.push(Seg::Key(key.clone()));
                references(store, member, path, depth + 1, found);
                path.pop();
            }
            // A record the body built and spread into this one holds its
            // members at the same paths, on the runs that spread it.
            for spread in &spreads {
                let records: Vec<&Val> = match spread {
                    Val::Alts(members) => members.iter().collect(),
                    other => vec![other],
                };
                for record in records {
                    if matches!(record, Val::Built(_)) {
                        references(store, record, path, depth + 1, found);
                    }
                }
            }
            // Which member of a bag is at a position is a choice the
            // body made.
            let members: Vec<Proj> = bag.iter().flat_map(Val::projections).collect();
            let every = !bag.is_empty()
                && bag
                    .iter()
                    .all(|member| matches!(member, Val::Proj(_) | Val::Alts(_)))
                && members.iter().all(reference);
            if every {
                let mut at = path.clone();
                at.push(Seg::Star);
                // A bag of one projection whose path has no `*` passes
                // it on; alternatives, or a member of a collection, are
                // one of several (FA §3.8).
                let passes = matches!(bag.as_slice(), [Val::Proj(proj)] if !proj.path.contains(&Seg::Star));
                found.push((at, passes, sorted(members.iter().map(name).collect())));
            }
        }
        _ => {}
    }
}

/// The entries of a record on one formal input, each with its path below
/// the input: the static ones, those of the read envelopes, and an
/// `identity` entry at each handle the body reads through.
fn entries_on(record: &Record, input: &str) -> Vec<(Vec<Seg>, Class)> {
    let detail = &record.detail;
    detail
        .entries
        .iter()
        .chain(&detail.envelope)
        .filter(|entry| entry.input == input)
        .map(|entry| (entry.path.clone(), entry.class))
        .collect()
}

/// The deepest nesting of bindings whose handler is analyzed for what a
/// copy holds (FA §8.5).
const MAX_BOUND: u32 = 3;

/// The entries in the normal form of FA §2.3.
fn normal_entries(entries: &BTreeMap<PathKey, BTreeSet<Class>>, store: &Store) -> Vec<Entry> {
    let mut found: Vec<Entry> = normal_map(entries, store)
        .into_iter()
        .flat_map(|((input, path), classes)| {
            classes.into_iter().map(move |class| Entry {
                input: input.clone(),
                path: path.clone(),
                class,
            })
        })
        .collect();
    found.sort_by_key(Entry::to_string);
    found
}

/// The entries in the normal form of FA §2.3, as lines.
fn normal_form(entries: &BTreeMap<PathKey, BTreeSet<Class>>, store: &Store) -> Vec<String> {
    let kept = normal_map(entries, store);
    let mut lines: Vec<String> = kept
        .iter()
        .filter(|(_, classes)| !classes.is_empty())
        .map(|((input, path), classes)| {
            let classes: Vec<&str> = classes.iter().map(|class| class.label()).collect();
            format!("{} : {}", display_path(input, path), classes.join(", "))
        })
        .collect();
    lines.sort();
    lines
}

fn normal_map(
    entries: &BTreeMap<PathKey, BTreeSet<Class>>,
    store: &Store,
) -> BTreeMap<PathKey, BTreeSet<Class>> {
    let mut kept = entries.clone();
    // A `value` entry removes the `value`, `shape`, and `enumeration`
    // entries at or below it in the same cell.
    let values: Vec<PathKey> = entries
        .iter()
        .filter(|(_, classes)| classes.contains(&Class::Value))
        .map(|(key, _)| key.clone())
        .collect();
    for (input, path) in &values {
        for ((other_input, other_path), classes) in kept.iter_mut() {
            let below = other_input == input
                && other_path.starts_with(path)
                && !other_path[path.len()..].contains(&Seg::Hop);
            if below {
                classes.remove(&Class::Shape);
                classes.remove(&Class::Enumeration);
                if other_path.len() > path.len() {
                    classes.remove(&Class::Value);
                }
            }
        }
    }
    // A `shape` entry that only a test the type decides recorded is
    // removed when another entry is at or below its path.
    for key in &store.decided {
        if store.tested.contains(key) {
            continue;
        }
        let other = [&store.entries, &store.envelope].iter().any(|entries| {
            entries.iter().any(|((input, path), classes)| {
                *input == key.0
                    && path.starts_with(&key.1)
                    && (path.len() > key.1.len()
                        || classes
                            .iter()
                            .any(|class| !matches!(class, Class::Shape | Class::LabelMetadata)))
            })
        });
        if other {
            if let Some(classes) = kept.get_mut(key) {
                classes.remove(&Class::Shape);
            }
        }
    }
    kept
}

/// The formal-input name of each parameter of a body (FA §1.2).
pub(crate) fn parameter_names(kind: BodyKind, function: FunctionLike<'_, '_>) -> Vec<String> {
    function
        .params()
        .items
        .iter()
        .enumerate()
        .map(|(index, parameter)| match (kind, index) {
            (BodyKind::Handler | BodyKind::Action | BodyKind::InlineHandler, 0) => {
                "event".to_string()
            }
            (BodyKind::Handler, 1) => "state".to_string(),
            _ => match &parameter.pattern {
                BindingPattern::BindingIdentifier(identifier) => identifier.name.to_string(),
                _ => format!("arg{index}"),
            },
        })
        .collect()
}

/// Whether a body is one the analysis runs on (FA §1.2).
pub fn is_analyzed(body: &Body) -> bool {
    match body.kind {
        BodyKind::Handler
        | BodyKind::Action
        | BodyKind::InlineHandler
        | BodyKind::Lift
        | BodyKind::Assert
        | BodyKind::AuthoredFunction => true,
        BodyKind::Computed => !matches!(body.promotion, Some(Promotion::Promoted { .. })),
        BodyKind::Pattern | BodyKind::ElementCallback => false,
    }
}

/// The start of the function of each body of module `module`, with the
/// index of the body in `bodies`.
pub fn body_functions<'a>(
    resolver: &Resolver<'_, 'a>,
    module: usize,
    bodies: &[Body],
) -> Vec<(usize, u32)> {
    let Some(parsed) = resolver.parsed(module) else {
        return Vec::new();
    };
    let mut starts: Vec<(u32, u32)> = Vec::new();
    for node in parsed.semantic.nodes().iter() {
        match node.kind() {
            AstKind::ArrowFunctionExpression(arrow) => {
                starts.push((arrow.span.start, arrow.span.end))
            }
            AstKind::Function(function) => starts.push((function.span.start, function.span.end)),
            _ => {}
        }
    }
    let mut found = Vec::new();
    for (index, body) in bodies.iter().enumerate() {
        // The function of the body: the outermost one inside its span.
        let (from, to) = body.span;
        let function = starts
            .iter()
            .filter(|(start, end)| from <= *start && *end <= to)
            .min_by_key(|(start, end)| (*start, u32::MAX - *end))
            .copied();
        if let Some((start, _)) = function {
            found.push((index, start));
        }
    }
    found
}

/// The record of each body of module `module` that the analysis runs on,
/// with the index of the body in `bodies`.
pub fn analyze_module<'a>(
    resolver: &Resolver<'_, 'a>,
    module: usize,
    bodies: &[Body],
) -> Vec<(usize, Record)> {
    let mut records = Vec::new();
    for (index, start) in body_functions(resolver, module, bodies) {
        let body = &bodies[index];
        if !is_analyzed(body) {
            continue;
        }
        if let Some(record) = analyze_body(resolver, module, body.kind, start, 0) {
            records.push((index, record));
        }
    }
    records
}

/// The record of the body of kind `kind` whose function starts at `start`
/// in module `module`.
fn analyze_body<'a>(
    resolver: &Resolver<'_, 'a>,
    module: usize,
    kind: BodyKind,
    start: u32,
    depth: u32,
) -> Option<Record> {
    let mut analyzer = Analyzer {
        resolver,
        functions: HashMap::new(),
        frames: Vec::new(),
        store: Store::default(),
        cond: 0,
        returned: false,
        active: Vec::new(),
        closures: Vec::new(),
        root: (module, (start, start)),
        computation: !matches!(
            kind,
            BodyKind::Handler
                | BodyKind::Action
                | BodyKind::InlineHandler
                | BodyKind::AuthoredFunction
        ),
        handler: kind != BodyKind::AuthoredFunction,
        depth,
        calls_in_text: Vec::new(),
        reached: RefCell::new(BTreeMap::new()),
    };
    let function = analyzer.function_at(module, start)?;
    let span = function.span();
    analyzer.root = (module, (span.start, span.end));
    analyzer.frames.push(Frame {
        module,
        env: HashMap::new(),
        span: (span.start, span.end),
    });
    let arguments = parameter_names(kind, function)
        .into_iter()
        .map(Proj::root)
        .collect();
    let result = analyzer.call_function(module, span.start, arguments, false);
    // What an expression body returns leaves the body.
    if let Some(expression) = function.expression_body() {
        analyzer.leaves(expression, &result);
    }
    analyzer.outputs(&result);
    analyzer.store.outputs.sort();
    Some(analyzer.finish())
}

/// The footprint of every body of the program `files`.
pub fn footprints(files: &[crate::program::SourceFile]) -> Vec<BodyFootprint> {
    crate::program::footprints(files)
}
