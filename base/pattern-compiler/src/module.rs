//! The model of one module: its imports, its module-scope definitions, and
//! its exports (`language-subset.md` §3).
//!
//! The model is plain data. It holds no reference into the syntax tree, so a
//! later stage can keep it after the tree is gone.

use std::collections::HashMap;

use oxc_ast::ast::{
    BindingPattern, Declaration, ExportDefaultDeclarationKind, Expression,
    ImportDeclarationSpecifier, ImportOrExportKind, ModuleExportName, Statement,
    VariableDeclarationKind,
};
use oxc_semantic::Scoping;
use oxc_span::GetSpan;
use oxc_syntax::symbol::SymbolId;
use serde::Serialize;

use crate::api::{api_value, ApiValue, Builder};
use crate::parse::Parsed;
use crate::syntax::{offsets, unwrap};

/// The directive that marks a module as imported TypeScript (§5.5).
pub const IMPORTED_DIRECTIVE: &str = "use typescript";

/// Whether a module is checked against the subset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModuleTier {
    /// A module in the subset.
    Subset,
    /// A module that begins with `"use typescript";` (tier I).
    Imported,
}

/// What an import specifier names (§3.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpecifierKind {
    /// `commonfabric`.
    CommonFabric,
    /// `commonfabric/<name>`.
    CommonFabricSubpath,
    /// A relative path to another module of the program.
    Relative,
    /// A pinned `cf:` specifier.
    Pinned,
    /// Anything else, which the subset refuses.
    Other,
}

impl SpecifierKind {
    pub fn of(specifier: &str) -> Self {
        if specifier == "commonfabric" {
            SpecifierKind::CommonFabric
        } else if specifier
            .strip_prefix("commonfabric/")
            .is_some_and(|name| !name.is_empty())
        {
            SpecifierKind::CommonFabricSubpath
        } else if specifier.starts_with("./") || specifier.starts_with("../") {
            SpecifierKind::Relative
        } else if specifier.starts_with("cf:") {
            SpecifierKind::Pinned
        } else {
            SpecifierKind::Other
        }
    }

    pub fn is_api(self) -> bool {
        matches!(
            self,
            SpecifierKind::CommonFabric | SpecifierKind::CommonFabricSubpath
        )
    }
}

/// The name an import binding or a re-export takes from the other module.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportedName {
    Named(String),
    Default,
    Namespace,
}

/// One binding an import declaration introduces.
#[derive(Debug, Clone, Serialize)]
pub struct ImportBinding {
    pub local: String,
    pub imported: ImportedName,
    /// Whether the binding is imported as a type, by `import type` or by a
    /// `type` modifier on the binding.
    pub type_only: bool,
    #[serde(skip)]
    pub symbol: SymbolId,
    pub span: (u32, u32),
}

/// One import declaration.
#[derive(Debug, Clone, Serialize)]
pub struct Import {
    pub specifier: String,
    pub kind: SpecifierKind,
    /// Whether the declaration is `import type`.
    pub type_only: bool,
    /// Whether the declaration has a binding clause at all. `import "x"` has
    /// none.
    pub has_clause: bool,
    pub bindings: Vec<ImportBinding>,
    pub span: (u32, u32),
}

/// The syntactic form of a frozen-data initializer, for the rules that can
/// be decided from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DataForm {
    Array,
    Object,
    Map,
    Set,
    RegExp,
    /// A call, an immediately invoked function included.
    Call,
    /// A string, number, boolean, bigint, or template literal, or `null`.
    Primitive,
    Other,
}

/// What a module-scope name is defined as (§3.1, §3.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DefKind {
    /// A builder definition: `pattern(...)`, `lift(...)`, or `handler(...)`.
    Pattern,
    Lift,
    Handler,
    /// An authored function: a function declaration, or a `const` whose
    /// initializer is a function written in place.
    Function,
    /// A frozen-data constant.
    FrozenData,
    /// An ambient `declare const`, which emits nothing.
    Ambient,
    /// A `let` or `var`, which the subset refuses.
    Mutable,
    /// A class, which the subset refuses.
    Class,
    /// A type alias or an interface.
    Type,
    /// An `enum` or a `namespace`, which the subset refuses.
    Other,
}

impl DefKind {
    pub fn of_builder(builder: Builder) -> Option<Self> {
        match builder {
            Builder::Pattern => Some(DefKind::Pattern),
            Builder::Lift => Some(DefKind::Lift),
            Builder::Handler => Some(DefKind::Handler),
            _ => None,
        }
    }
}

/// One module-scope definition.
#[derive(Debug, Clone, Serialize)]
pub struct Def {
    /// The bound name, or `default` for `export default <expression>`.
    pub name: String,
    #[serde(skip)]
    pub symbol: Option<SymbolId>,
    pub kind: DefKind,
    /// The form of the initializer, for a frozen-data constant.
    pub form: Option<DataForm>,
    pub exported: bool,
    /// The span of the declaration's name, or of the expression for a
    /// default export.
    pub span: (u32, u32),
}

/// What an export refers to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportTarget {
    /// A definition of this module, by its index in [`ModuleModel::defs`].
    Def(usize),
    /// A binding this module imported and exports again, by its indexes in
    /// [`ModuleModel::imports`] and in that import's bindings.
    Import(usize, usize),
    /// `export { name } from "specifier"`.
    From {
        specifier: String,
        name: ImportedName,
    },
    /// A name this model did not resolve.
    Unresolved,
}

/// One exported name.
#[derive(Debug, Clone, Serialize)]
pub struct Export {
    pub name: String,
    pub target: ExportTarget,
    pub type_only: bool,
}

/// A module-scope binding: an import or a definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Binding {
    /// Indexes into [`ModuleModel::imports`] and that import's bindings.
    Import(usize, usize),
    /// An index into [`ModuleModel::defs`].
    Def(usize),
}

/// The model of one module.
#[derive(Debug, Clone, Serialize)]
pub struct ModuleModel {
    pub tier: ModuleTier,
    pub imports: Vec<Import>,
    pub defs: Vec<Def>,
    pub exports: Vec<Export>,
    /// The specifiers of `export * from "..."`.
    pub star_exports: Vec<String>,
    #[serde(skip)]
    bindings: HashMap<SymbolId, Binding>,
}

/// A reference to a value `commonfabric` exports, resolved through its
/// import.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiRef {
    /// The exported name.
    pub name: String,
    /// `None` for `commonfabric`, and the name after the slash for
    /// `commonfabric/<name>`.
    pub subpath: Option<String>,
    /// Whether the reference is written with the exported name itself, and
    /// not through an import alias or a namespace import.
    pub direct: bool,
}

impl ApiRef {
    /// The classification of the value. Every export of a subpath module is
    /// a pure function or a constant (`builtin-inventory.md`, "Pure
    /// functions and constants").
    pub fn value(&self) -> ApiValue {
        match self.subpath {
            None => api_value(&self.name),
            Some(_) => ApiValue::Pure,
        }
    }
}

impl ModuleModel {
    /// Builds the model of a parsed module.
    pub fn build(parsed: &Parsed<'_>) -> Self {
        let tier = match parsed.program.directives.first() {
            Some(directive) if directive.directive.as_str() == IMPORTED_DIRECTIVE => {
                ModuleTier::Imported
            }
            _ => ModuleTier::Subset,
        };
        let mut model = ModuleModel {
            tier,
            imports: Vec::new(),
            defs: Vec::new(),
            exports: Vec::new(),
            star_exports: Vec::new(),
            bindings: HashMap::new(),
        };
        for statement in &parsed.program.body {
            if let Statement::ImportDeclaration(declaration) = statement {
                model.add_import(declaration);
            }
        }
        let scoping = parsed.semantic.scoping();
        for statement in &parsed.program.body {
            model.add_statement(scoping, statement);
        }
        // An export list can name a definition written after it, so the
        // lists are resolved once every definition is known.
        for statement in &parsed.program.body {
            if let Statement::ExportNamedDeclaration(declaration) = statement {
                model.add_export_list(declaration);
            }
        }
        model
    }

    /// The module-scope binding a symbol is, if it is one.
    pub fn binding(&self, symbol: SymbolId) -> Option<Binding> {
        self.bindings.get(&symbol).copied()
    }

    /// The definition a symbol is bound to, if the symbol is a module-scope
    /// definition of this module.
    pub fn def_of(&self, symbol: SymbolId) -> Option<&Def> {
        match self.binding(symbol)? {
            Binding::Def(index) => self.defs.get(index),
            Binding::Import(..) => None,
        }
    }

    /// The `commonfabric` export a symbol denotes, if it is imported from
    /// that module by name.
    pub fn api_ref(&self, symbol: SymbolId) -> Option<ApiRef> {
        let Binding::Import(import, binding) = self.binding(symbol)? else {
            return None;
        };
        let import = &self.imports[import];
        if !import.kind.is_api() {
            return None;
        }
        let binding = &import.bindings[binding];
        let ImportedName::Named(name) = &binding.imported else {
            return None;
        };
        Some(ApiRef {
            name: name.clone(),
            subpath: subpath_of(&import.specifier),
            direct: *name == binding.local,
        })
    }

    /// The `commonfabric` module a symbol denotes as a whole, if it is a
    /// namespace import of one. The result is the subpath, as in [`ApiRef`].
    pub fn api_namespace(&self, symbol: SymbolId) -> Option<Option<String>> {
        let Binding::Import(import, binding) = self.binding(symbol)? else {
            return None;
        };
        let import = &self.imports[import];
        if !import.kind.is_api() || import.bindings[binding].imported != ImportedName::Namespace {
            return None;
        }
        Some(subpath_of(&import.specifier))
    }

    fn add_import(&mut self, declaration: &oxc_ast::ast::ImportDeclaration<'_>) {
        let specifier = declaration.source.value.as_str().to_string();
        let type_only = declaration.import_kind == ImportOrExportKind::Type;
        let index = self.imports.len();
        let mut bindings = Vec::new();
        for specifier in declaration.specifiers.iter().flatten() {
            let (local, imported, binding_type_only) = match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(named) => (
                    &named.local,
                    ImportedName::Named(export_name(&named.imported).to_string()),
                    named.import_kind == ImportOrExportKind::Type,
                ),
                ImportDeclarationSpecifier::ImportDefaultSpecifier(default) => {
                    (&default.local, ImportedName::Default, false)
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(namespace) => {
                    (&namespace.local, ImportedName::Namespace, false)
                }
            };
            let Some(symbol) = local.symbol_id.get() else {
                continue;
            };
            self.bindings
                .insert(symbol, Binding::Import(index, bindings.len()));
            bindings.push(ImportBinding {
                local: local.name.as_str().to_string(),
                imported,
                type_only: type_only || binding_type_only,
                symbol,
                span: offsets(local.span),
            });
        }
        self.imports.push(Import {
            kind: SpecifierKind::of(&specifier),
            specifier,
            type_only,
            has_clause: declaration.specifiers.is_some(),
            bindings,
            span: offsets(declaration.span),
        });
    }

    fn add_statement(&mut self, scoping: &Scoping, statement: &Statement<'_>) {
        match statement {
            Statement::ExportNamedDeclaration(export) => {
                if let Some(declaration) = &export.declaration {
                    self.add_declaration(scoping, declaration, true);
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                let (kind, symbol, span) = match &export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => (
                        Some(DefKind::Function),
                        function.id.as_ref().and_then(|id| id.symbol_id.get()),
                        function.span,
                    ),
                    ExportDefaultDeclarationKind::ClassDeclaration(class) => (
                        Some(DefKind::Class),
                        class.id.as_ref().and_then(|id| id.symbol_id.get()),
                        class.span,
                    ),
                    ExportDefaultDeclarationKind::TSInterfaceDeclaration(interface) => (
                        Some(DefKind::Type),
                        interface.id.symbol_id.get(),
                        interface.span,
                    ),
                    expression => {
                        let expression = expression.to_expression();
                        match unwrap(expression) {
                            // `export default name` exports a binding that is
                            // defined elsewhere in the module.
                            Expression::Identifier(_) => (None, None, expression.span()),
                            inner => {
                                let (kind, _) = self.initializer_kind(scoping, inner);
                                (Some(kind), None, expression.span())
                            }
                        }
                    }
                };
                let target = match kind {
                    Some(kind) => {
                        let index = self.push_def(Def {
                            name: "default".to_string(),
                            symbol,
                            kind,
                            form: None,
                            exported: true,
                            span: offsets(span),
                        });
                        ExportTarget::Def(index)
                    }
                    None => match &export.declaration {
                        ExportDefaultDeclarationKind::Identifier(identifier) => {
                            self.target_of_reference(identifier)
                        }
                        _ => ExportTarget::Unresolved,
                    },
                };
                self.exports.push(Export {
                    name: "default".to_string(),
                    target,
                    type_only: false,
                });
            }
            Statement::ExportAllDeclaration(export) => match &export.exported {
                None => self
                    .star_exports
                    .push(export.source.value.as_str().to_string()),
                Some(name) => self.exports.push(Export {
                    name: export_name(name).to_string(),
                    target: ExportTarget::From {
                        specifier: export.source.value.as_str().to_string(),
                        name: ImportedName::Namespace,
                    },
                    type_only: export.export_kind == ImportOrExportKind::Type,
                }),
            },
            other => {
                if let Some(declaration) = other.as_declaration() {
                    self.add_declaration(scoping, declaration, false);
                }
            }
        }
    }

    fn add_declaration(
        &mut self,
        scoping: &Scoping,
        declaration: &Declaration<'_>,
        exported: bool,
    ) {
        match declaration {
            Declaration::VariableDeclaration(variable) => {
                for declarator in &variable.declarations {
                    let (kind, form) = if variable.declare {
                        (DefKind::Ambient, None)
                    } else if variable.kind != VariableDeclarationKind::Const {
                        (DefKind::Mutable, None)
                    } else {
                        match &declarator.init {
                            Some(init) => {
                                let (kind, form) = self.initializer_kind(scoping, unwrap(init));
                                (kind, form)
                            }
                            None => (DefKind::FrozenData, None),
                        }
                    };
                    let mut names = Vec::new();
                    bound_names(&declarator.id, &mut names);
                    for (name, symbol, span) in names {
                        self.push_named_def(Def {
                            name,
                            symbol,
                            kind,
                            form,
                            exported,
                            span,
                        });
                    }
                }
            }
            Declaration::FunctionDeclaration(function) => {
                // An overload signature and its implementation share one
                // symbol, and the implementation defines it.
                if let Some(id) = &function.id {
                    let symbol = id.symbol_id.get();
                    let known = symbol.is_some_and(|symbol| self.bindings.contains_key(&symbol));
                    if !known {
                        self.push_named_def(Def {
                            name: id.name.as_str().to_string(),
                            symbol,
                            kind: DefKind::Function,
                            form: None,
                            exported,
                            span: offsets(id.span),
                        });
                    }
                }
            }
            Declaration::ClassDeclaration(class) => {
                if let Some(id) = &class.id {
                    self.push_named_def(Def {
                        name: id.name.as_str().to_string(),
                        symbol: id.symbol_id.get(),
                        kind: DefKind::Class,
                        form: None,
                        exported,
                        span: offsets(id.span),
                    });
                }
            }
            Declaration::TSTypeAliasDeclaration(alias) => self.push_type_def(&alias.id, exported),
            Declaration::TSInterfaceDeclaration(interface) => {
                self.push_type_def(&interface.id, exported);
            }
            Declaration::TSEnumDeclaration(declaration) => {
                self.push_named_def(Def {
                    name: declaration.id.name.as_str().to_string(),
                    symbol: declaration.id.symbol_id.get(),
                    kind: DefKind::Other,
                    form: None,
                    exported,
                    span: offsets(declaration.id.span),
                });
            }
            Declaration::TSModuleDeclaration(_)
            | Declaration::TSGlobalDeclaration(_)
            | Declaration::TSImportEqualsDeclaration(_) => {}
        }
    }

    fn push_type_def(&mut self, id: &oxc_ast::ast::BindingIdentifier<'_>, exported: bool) {
        let symbol = id.symbol_id.get();
        // A second interface of one name merges into the first.
        if symbol.is_some_and(|symbol| self.bindings.contains_key(&symbol)) {
            return;
        }
        self.push_named_def(Def {
            name: id.name.as_str().to_string(),
            symbol,
            kind: DefKind::Type,
            form: None,
            exported,
            span: offsets(id.span),
        });
    }

    fn push_def(&mut self, def: Def) -> usize {
        let index = self.defs.len();
        if let Some(symbol) = def.symbol {
            self.bindings.insert(symbol, Binding::Def(index));
        }
        self.defs.push(def);
        index
    }

    fn push_named_def(&mut self, def: Def) {
        let exported = def.exported;
        let name = def.name.clone();
        let type_only = def.kind == DefKind::Type;
        let index = self.push_def(def);
        if exported {
            self.exports.push(Export {
                name,
                target: ExportTarget::Def(index),
                type_only,
            });
        }
    }

    fn add_export_list(&mut self, declaration: &oxc_ast::ast::ExportNamedDeclaration<'_>) {
        let list_type_only = declaration.export_kind == ImportOrExportKind::Type;
        for specifier in &declaration.specifiers {
            let type_only = list_type_only || specifier.export_kind == ImportOrExportKind::Type;
            let name = export_name(&specifier.exported).to_string();
            let target = match &declaration.source {
                Some(source) => ExportTarget::From {
                    specifier: source.value.as_str().to_string(),
                    name: match export_name(&specifier.local) {
                        "default" => ImportedName::Default,
                        local => ImportedName::Named(local.to_string()),
                    },
                },
                None => match &specifier.local {
                    ModuleExportName::IdentifierReference(identifier) => {
                        self.target_of_reference(identifier)
                    }
                    _ => ExportTarget::Unresolved,
                },
            };
            self.exports.push(Export {
                name,
                target,
                type_only,
            });
        }
    }

    fn target_of_reference(
        &self,
        identifier: &oxc_ast::ast::IdentifierReference<'_>,
    ) -> ExportTarget {
        // A name can be both a value and a type, as a constant and an
        // interface of one name are. An export list exports both, and the
        // value is what an importing module's value import needs, so the
        // name is looked up among the definitions with values first.
        let name = identifier.name.as_str();
        if let Some(index) = self
            .defs
            .iter()
            .position(|def| def.name == name && def.kind != DefKind::Type)
            .or_else(|| self.defs.iter().position(|def| def.name == name))
        {
            return ExportTarget::Def(index);
        }
        for (import_index, import) in self.imports.iter().enumerate() {
            if let Some(binding_index) = import
                .bindings
                .iter()
                .position(|binding| binding.local == name)
            {
                return ExportTarget::Import(import_index, binding_index);
            }
        }
        ExportTarget::Unresolved
    }

    /// The kind of definition an initializer makes (§3.2). `init` has its
    /// type-only wrappers removed.
    fn initializer_kind(
        &self,
        scoping: &Scoping,
        init: &Expression<'_>,
    ) -> (DefKind, Option<DataForm>) {
        match init {
            Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
                (DefKind::Function, None)
            }
            Expression::ClassExpression(_) => (DefKind::Class, None),
            Expression::CallExpression(call) => {
                let builder =
                    self.api_ref_of_callee(scoping, &call.callee)
                        .and_then(|api| match api.value() {
                            ApiValue::Builder(builder) => DefKind::of_builder(builder),
                            _ => None,
                        });
                match builder {
                    Some(kind) => (kind, None),
                    None => (DefKind::FrozenData, Some(DataForm::Call)),
                }
            }
            Expression::ArrayExpression(_) => (DefKind::FrozenData, Some(DataForm::Array)),
            Expression::ObjectExpression(_) => (DefKind::FrozenData, Some(DataForm::Object)),
            Expression::RegExpLiteral(_) => (DefKind::FrozenData, Some(DataForm::RegExp)),
            Expression::NewExpression(new) => {
                let form = match unwrap(&new.callee) {
                    Expression::Identifier(callee) if symbol_of(scoping, callee).is_none() => {
                        match callee.name.as_str() {
                            "Map" => DataForm::Map,
                            "Set" => DataForm::Set,
                            "RegExp" => DataForm::RegExp,
                            _ => DataForm::Other,
                        }
                    }
                    _ => DataForm::Other,
                };
                (DefKind::FrozenData, Some(form))
            }
            Expression::StringLiteral(_)
            | Expression::NumericLiteral(_)
            | Expression::BooleanLiteral(_)
            | Expression::BigIntLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::TemplateLiteral(_) => (DefKind::FrozenData, Some(DataForm::Primitive)),
            _ => (DefKind::FrozenData, Some(DataForm::Other)),
        }
    }

    /// The `commonfabric` export a callee denotes: an imported name, or a
    /// member of a namespace import. The callee is resolved through its
    /// symbol, so a local binding of the same name is not an API reference.
    pub fn api_ref_of_callee(&self, scoping: &Scoping, callee: &Expression<'_>) -> Option<ApiRef> {
        match unwrap(callee) {
            Expression::Identifier(identifier) => self.api_ref(symbol_of(scoping, identifier)?),
            Expression::StaticMemberExpression(member) => {
                let Expression::Identifier(object) = unwrap(&member.object) else {
                    return None;
                };
                let subpath = self.api_namespace(symbol_of(scoping, object)?)?;
                Some(ApiRef {
                    name: member.property.name.as_str().to_string(),
                    subpath,
                    direct: false,
                })
            }
            _ => None,
        }
    }
}

/// The symbol a reference resolves to, or `None` for a reference to a
/// global.
pub fn symbol_of(
    scoping: &Scoping,
    identifier: &oxc_ast::ast::IdentifierReference<'_>,
) -> Option<SymbolId> {
    scoping
        .get_reference(identifier.reference_id.get()?)
        .symbol_id()
}

fn subpath_of(specifier: &str) -> Option<String> {
    specifier
        .strip_prefix("commonfabric/")
        .map(|name| name.to_string())
}

fn export_name<'e>(name: &'e ModuleExportName<'_>) -> &'e str {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.as_str(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.as_str(),
        ModuleExportName::StringLiteral(literal) => literal.value.as_str(),
    }
}

/// Every name a binding pattern binds, with its symbol and the span of the
/// name.
fn bound_names(
    pattern: &BindingPattern<'_>,
    out: &mut Vec<(String, Option<SymbolId>, (u32, u32))>,
) {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => out.push((
            identifier.name.as_str().to_string(),
            identifier.symbol_id.get(),
            offsets(identifier.span),
        )),
        BindingPattern::ObjectPattern(object) => {
            for property in &object.properties {
                bound_names(&property.value, out);
            }
            if let Some(rest) = &object.rest {
                bound_names(&rest.argument, out);
            }
        }
        BindingPattern::ArrayPattern(array) => {
            for element in array.elements.iter().flatten() {
                bound_names(element, out);
            }
            if let Some(rest) = &array.rest {
                bound_names(&rest.argument, out);
            }
        }
        BindingPattern::AssignmentPattern(assignment) => bound_names(&assignment.left, out),
    }
}
