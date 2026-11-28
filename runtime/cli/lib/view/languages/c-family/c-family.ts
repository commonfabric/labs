import "tree-sitter-c/package.json" with { type: "json" };
import "tree-sitter-cpp/package.json" with { type: "json" };

import type { StructureKind } from "../../model.ts";
import type {
  StructureEntry,
  SyntaxNode,
  TreeSitterGrammar,
} from "../treesitter/adapter.ts";

/** CUDA's qualifiers, which the C++ grammar reads as names. */
const CUDA_QUALIFIER =
  "^__(global|device|host|shared|constant|managed|grid_constant|noinline|forceinline|launch_bounds)__$";
const CUDA_QUALIFIER_PATTERN = new RegExp(CUDA_QUALIFIER);

/**
 * The patterns both grammars accept: the C++ grammar extends the C grammar, so
 * every C node type is a C++ node type. Capture names are token classes. Order
 * carries meaning: the narrowest capture over a character colors it, and
 * between captures of the same extent the earliest pattern wins, so the
 * generic name patterns come last.
 */
const C_QUERY = `
((comment) @docComment
  (#match? @docComment "^(///([^/]|$)|//!|/[*][*][^*/]|/[*]!)"))
(comment) @comment

[(string_literal) (char_literal) (system_lib_string)] @string
(number_literal) @number
[(true) (false)] @boolean
(null) @keyword

[
  "#include" "#define" "#if" "#ifdef" "#ifndef" "#elif" "#elifdef"
  "#elifndef" "#else" "#endif" "defined" (preproc_directive)
] @keyword
(preproc_def name: (identifier) @binding)
(preproc_function_def name: (identifier) @functionName)
(preproc_params (identifier) @parameter)

; A type keyword is a name only where the parser recovered from syntax it could
; not read, such as a qualifier a dialect adds before a function's type.
((identifier) @typeKeyword
  (#any-of? @typeKeyword
    "void" "char" "short" "int" "long" "float" "double" "signed" "unsigned"))
((identifier) @keyword
  (#any-of? @keyword "inline" "static" "extern" "const" "volatile"))
[(primitive_type) (sized_type_specifier)] @typeKeyword

; A named type with a body declares its name, and a type name in a declarator
; is the name a typedef declares.
(_ name: (type_identifier) @interfaceName body: (_))
(_ declarator: (type_identifier) @interfaceName)

(function_declarator declarator: [(identifier) (field_identifier)] @functionName)
(call_expression
  function: [
    (identifier) @callName
    (field_expression field: (field_identifier) @callName)
  ])
; A parameter's name, behind up to two pointers or arrays, and a function
; pointer's.
(parameter_declaration
  declarator: [
    (identifier) @parameter
    (_ declarator: (identifier) @parameter)
    (_ declarator: (_ declarator: (identifier) @parameter))
    (function_declarator
      declarator: (parenthesized_declarator
        (pointer_declarator declarator: (identifier) @parameter)))
  ])
; Any other name in a declarator is a value the declaration binds, behind
; however many pointers and arrays.
(_ declarator: (identifier) @binding)
(enumerator name: (identifier) @binding)
[(field_identifier) (statement_identifier)] @propertyName

[
  (storage_class_specifier) (type_qualifier) (attribute_specifier)
  (ms_call_modifier) (ms_pointer_modifier)
] @keyword
[
  "sizeof" "offsetof" "_Alignof" "alignof" "__alignof" "__alignof__"
  "_alignof" "_Alignas" "alignas" "_Generic" "asm" "__asm" "__asm__"
  "__volatile__" "__attribute" "__declspec" "__extension__"
] @keyword
["struct" "union" "enum" "typedef"] @storageKeyword
[
  "if" "else" "for" "while" "do" "switch" "case" "default" "break"
  "continue" "return" "goto"
] @controlKeyword

(conditional_expression ":" @operator)
[
  "!" "!=" "%" "%=" "&" "&&" "&=" "*" "*=" "+" "++" "+=" "-" "--" "-="
  "->" "/" "/=" "<" "<<" "<<=" "<=" "=" "==" ">" ">=" ">>" ">>=" "?" "^"
  "^=" "|" "|=" "||" "~"
] @operator
["(" ")" "[" "]" "{" "}"] @bracket
["," ";" "." ":" "..." "[[" "]]"] @punctuation

(type_identifier) @typeName
(identifier) @identifier
`;

/**
 * The C++ grammar's further patterns, ahead of the shared ones so that a
 * declared or called name takes its class before the generic patterns there.
 * Compiling a pattern that constrains a node's parent costs the C++ grammar
 * far more than it costs C's, so the patterns share parents and alternatives
 * where they can.
 */
const CPP_QUERY = `
(this) @keyword
(auto) @typeKeyword
(raw_string_literal) @string
(raw_string_literal ["(" ")"] @string)

; CUDA's qualifiers, which the C++ grammar reads as names, and the casts, which
; it reads as calls of templates.
([(type_identifier) (field_identifier) (identifier)] @keyword
  (#match? @keyword "${CUDA_QUALIFIER}"))
((identifier) @keyword
  (#any-of? @keyword
    "static_cast" "dynamic_cast" "reinterpret_cast" "const_cast"))

(namespace_definition name: (namespace_identifier) @interfaceName)
(nested_namespace_specifier (namespace_identifier) @interfaceName)
(alias_declaration name: (type_identifier) @interfaceName)

; A name qualified by one or two scopes, as in Fd::Close and
; std::chrono::now.
(function_declarator
  declarator: [
    (template_function name: (identifier) @functionName)
    (qualified_identifier
      name: [
        (identifier) @functionName
        (qualified_identifier name: (identifier) @functionName)
      ])
  ])
(destructor_name (identifier) @functionName)
(template_function name: (identifier) @callName)
(template_method name: (field_identifier) @callName)
(call_expression
  function: (qualified_identifier
    name: [
      (identifier) @callName
      (qualified_identifier name: (identifier) @callName)
    ]))
; A reference parameter's name, as in T& x, T&& x, and T*& x.
(parameter_declaration
  declarator: [
    (reference_declarator
      [(identifier) @parameter (_ declarator: (identifier) @parameter)])
    (_ declarator: (reference_declarator (identifier) @parameter))
  ])
(variadic_declarator (identifier) @parameter)
(optional_parameter_declaration
  declarator: [
    (identifier) @parameter
    (_ declarator: (identifier) @parameter)
    (_ declarator: (_ declarator: (identifier) @parameter))
    (reference_declarator (identifier) @parameter)
    (_ declarator: (reference_declarator (identifier) @parameter))
  ])
(structured_binding_declarator (identifier) @binding)
(reference_declarator (identifier) @binding)
(namespace_identifier) @typeName

(linkage_specification "extern" @keyword)
(default_method_clause "default" @keyword)

[(access_specifier) (virtual_specifier)] @keyword
["class" "namespace" "template" "typename" "using" "concept"] @storageKeyword
[
  "virtual" "friend" "explicit" "mutable" "noexcept" "constinit" "consteval"
  "operator" "new" "delete" "requires" "static_assert" "decltype" "inline"
] @keyword
(attribute name: (identifier) @keyword)
["try" "catch" "throw" "co_await" "co_return" "co_yield"] @controlKeyword
(template_argument_list ["<" ">"] @punctuation)
(template_parameter_list ["<" ">"] @punctuation)
[
  "<=>" "->*" ".*" "and" "or" "not" "xor" "bitand" "bitor" "compl" "and_eq"
  "or_eq" "xor_eq" "not_eq"
] @operator
"::" @punctuation
`;

/** Declarator wrappers that hold the declared name. */
const DECLARATOR_WRAPPERS = new Set([
  "init_declarator",
  "pointer_declarator",
  "array_declarator",
  "reference_declarator",
  "parenthesized_declarator",
  "attributed_declarator",
]);

/** Declarators that name nothing a structure entry can list: an error the
 * parser recovered from, and a structured binding's several names. */
const NAMELESS = new Set(["ERROR", "structured_binding_declarator"]);

/** A declared name and whether it names a function rather than a value. */
interface Declared {
  readonly name: SyntaxNode;
  readonly isFunction: boolean;
}

/**
 * The name a declarator declares, found through the pointers, arrays,
 * references, and parentheses around it. A function declarator makes it a
 * function, unless it applies to a parenthesized pointer, as in a function
 * pointer `int (*handler)(int)`, which declares a value. A conversion
 * operator, such as `operator bool() const`, is a function.
 */
function declared(declarator: SyntaxNode): Declared | undefined {
  let isFunction = false;
  let node: SyntaxNode | null = declarator;
  while (node !== null && !NAMELESS.has(node.type)) {
    if (node.type === "function_declarator") {
      node = node.childForFieldName("declarator");
      isFunction = node?.type !== "parenthesized_declarator" ||
        !node.namedChildren.some((child) =>
          DECLARATOR_WRAPPERS.has(child.type)
        );
    } else if (DECLARATOR_WRAPPERS.has(node.type)) {
      // A wrapper with no declarator field holds its declarator beside
      // modifiers, such as `__cdecl`, attributes, and comments.
      node = node.childForFieldName("declarator") ??
        node.namedChildren.find((child) =>
          !child.isExtra && !child.type.startsWith("ms_") &&
          child.type !== "attribute_declaration"
        ) ?? null;
    } else {
      const conversion = ownName(node).type === "operator_cast";
      return { name: node, isFunction: isFunction || conversion };
    }
  }
  return undefined;
}

/** The unqualified name inside a qualified, templated, or nested one, which a
 * definition is indexed under: `Close` for `FileDescriptor::Close`, `foo`
 * for `foo<int>`, and `c` for the namespace `a::b::c`. */
function ownName(name: SyntaxNode): SyntaxNode {
  if (name.type === "nested_namespace_specifier") {
    return ownName(name.lastNamedChild!);
  }
  const inner = name.childForFieldName("name");
  return inner === null ? name : ownName(inner);
}

/** The source text from `node`'s start to `end`, without its comments and
 * with each run of white space a single space, as a label shows it. */
function plainText(node: SyntaxNode, end = node.endIndex): string {
  let text = "";
  let from = node.startIndex;
  for (const comment of node.descendantsOfType("comment")) {
    if (comment.startIndex >= end) break;
    text += node.text.slice(
      from - node.startIndex,
      comment.startIndex - node.startIndex,
    );
    from = comment.endIndex;
  }
  text += node.text.slice(
    from - node.startIndex,
    Math.max(from, end) - node.startIndex,
  );
  return text.replace(/\s+/g, " ").trim();
}

/** A declared name's text, in which a conversion operator is named by its
 * type, as `operator const char*`, without its parameters. */
function nameText(name: SyntaxNode): string {
  const inner = name.childForFieldName("name");
  if (name.type === "qualified_identifier" && inner !== null) {
    const scope = name.childForFieldName("scope");
    return `${scope === null ? "" : plainText(scope)}::${nameText(inner)}`;
  }
  if (name.type !== "operator_cast") return plainText(name);
  // The parameter list, when the declaration has one yet, follows the pointers
  // and references of the type converted to.
  let declarator = name.childForFieldName("declarator");
  while (
    declarator?.type.startsWith("abstract_") === true &&
    declarator.type !== "abstract_function_declarator"
  ) {
    declarator = declarator.childForFieldName("declarator") ??
      declarator.lastNamedChild;
  }
  return plainText(
    name,
    declarator?.type === "abstract_function_declarator"
      ? declarator.childForFieldName("parameters")!.startIndex
      : name.endIndex,
  );
}

/** An entry under a declared name, or none for a name that error recovery
 * left empty, as in `namespace a:: {`. */
function entry(
  kind: StructureKind,
  label: string,
  name: SyntaxNode,
): StructureEntry | undefined {
  const own = ownName(name);
  const text = nameText(own);
  return text
    ? { kind, label, name: text, nameOffset: own.startIndex }
    : undefined;
}

/** The outermost of the template headers around a node, or the node. */
function withTemplates(node: SyntaxNode): SyntaxNode {
  let outer = node;
  while (outer.parent?.type === "template_declaration") outer = outer.parent;
  return outer;
}

/** Whether a declaration is a member of a class, through any preprocessor
 * conditionals and template headers around it. */
function isMember(node: SyntaxNode): boolean {
  let parent = node.parent;
  while (
    parent !== null &&
    (parent.type.startsWith("preproc_") ||
      parent.type === "template_declaration")
  ) {
    parent = parent.parent;
  }
  return parent?.type === "field_declaration_list";
}

/**
 * The entry for the function, value, or type alias one declarator of a
 * declaration declares; a member of a class or a qualified name is a method.
 * A function definition with no type outside a class, such as Google Test's
 * `TEST_F(Suite, Name) {`, is a macro's expansion, and its label is the whole
 * declarator, which tells those definitions apart.
 */
function declarationEntry(
  node: SyntaxNode,
  declarator: SyntaxNode,
): StructureEntry | undefined {
  const found = declared(declarator);
  // The C++ grammar reads CUDA's qualifiers before a member as a declaration
  // of their own, which declares nothing.
  if (found === undefined || CUDA_QUALIFIER_PATTERN.test(found.name.text)) {
    return undefined;
  }
  const { name, isFunction } = found;
  const text = nameText(name);
  if (node.type === "type_definition") {
    return entry("typeAlias", `typedef ${text}`, name);
  }
  if (!isFunction) return entry("variable", text, name);
  const member = isMember(node) || name.type === "qualified_identifier";
  const macro = !member && node.type === "function_definition" &&
    node.childForFieldName("type") === null;
  const label = macro ? plainText(declarator) : `${text}()`;
  return entry(member ? "method" : "function", label, name);
}

/** The declarations that may declare several names, each an entry. */
const DECLARATIONS = new Set([
  "declaration",
  "field_declaration",
  "type_definition",
]);

/** The node types a declaration's declarator can have. A name or a qualified
 * name can also be the declaration's type, which comes first. */
const DECLARATORS = new Set([
  ...DECLARATOR_WRAPPERS,
  "function_declarator",
  "identifier",
  "field_identifier",
  "type_identifier",
  "qualified_identifier",
  "destructor_name",
  "operator_cast",
]);

/** The fields of a declaration that hold something other than a declarator:
 * its type, and a value it gives a name. */
const NON_DECLARATOR_FIELDS = ["type", "value", "default_value"];

/** Whether a node is one of its declaration's declarators. */
function isDeclarator(node: SyntaxNode | null): boolean {
  const declaration = node?.parent ?? null;
  return node !== null && declaration !== null &&
    DECLARATIONS.has(declaration.type) && DECLARATORS.has(node.type) &&
    NON_DECLARATOR_FIELDS.every((field) => {
      const other = declaration.childForFieldName(field);
      return other === null || !node.equals(other);
    });
}

/** The nearest sibling of a node that is not a comment, in one direction. */
function neighbor(node: SyntaxNode, next: boolean): SyntaxNode | null {
  let sibling = next ? node.nextNamedSibling : node.previousNamedSibling;
  while (sibling?.isExtra === true) {
    sibling = next ? sibling.nextNamedSibling : sibling.previousNamedSibling;
  }
  return sibling;
}

/** The entry for one of a declaration's declarators, covering the whole
 * declaration when it is the only one. */
function declaratorEntry(node: SyntaxNode): StructureEntry | undefined {
  if (!isDeclarator(node)) return undefined;
  const declaration = node.parent!;
  const found = declarationEntry(declaration, node);
  const only = !isDeclarator(neighbor(node, false)) &&
    !isDeclarator(neighbor(node, true));
  return found && only ? { ...found, extent: declaration } : found;
}

/** The node types a structure entry can be found inside: the top of a file,
 * namespace, linkage, and preprocessor-conditional bodies, templates, and the
 * types whose members are entries. A function's body holds none. */
const STRUCTURE_PARENTS = new Set([
  "translation_unit",
  "declaration_list",
  "linkage_specification",
  "namespace_definition",
  "template_declaration",
  "preproc_if",
  "preproc_ifdef",
  "preproc_elif",
  "preproc_elifdef",
  "preproc_else",
  "declaration",
  "field_declaration",
  "type_definition",
  "struct_specifier",
  "union_specifier",
  "class_specifier",
  "field_declaration_list",
  "friend_declaration",
  "ERROR",
]);

/**
 * The structure entry a C or C++ node declares, covering the template headers
 * before it: a function or method, a declared value or field, a named type
 * with a body, a type alias, a macro, or a namespace.
 */
function structureEntry(node: SyntaxNode): StructureEntry | undefined {
  const found = declaredEntry(node);
  return found && { ...found, extent: withTemplates(found.extent ?? node) };
}

function declaredEntry(node: SyntaxNode): StructureEntry | undefined {
  const name = node.childForFieldName("name");
  switch (node.type) {
    case "function_definition": {
      const declarator = node.childForFieldName("declarator");
      return declarator === null
        ? undefined
        : declarationEntry(node, declarator);
    }
    case "struct_specifier":
    case "union_specifier":
    case "class_specifier":
    case "enum_specifier": {
      if (node.childForFieldName("body") === null) return undefined;
      // The keywords before the name or the body, such as `struct` or
      // `enum class`.
      const before = name ?? node.childForFieldName("body")!;
      const keyword = node.children.filter((child) =>
        !child.isNamed && child.endIndex <= before.startIndex
      ).map((child) => child.type).join(" ");
      if (name !== null) {
        return entry("class", `${keyword} ${plainText(name)}`, name);
      }
      // A nameless type's members are its own when the type declares a name,
      // as in `typedef struct { int x; } point_t;`, and the enclosing type's
      // when it is an anonymous member.
      return isDeclarator(neighbor(node, true))
        ? { kind: "class", label: keyword }
        : undefined;
    }
    case "namespace_definition":
      return name === null
        ? { kind: "object", label: "namespace" }
        : entry("object", `namespace ${plainText(name)}`, name);
    // The grammar requires the name of an alias and of a macro.
    case "alias_declaration":
      return entry("typeAlias", `using ${name!.text}`, name!);
    case "preproc_def":
      return entry("variable", `#define ${name!.text}`, name!);
    case "preproc_function_def":
      return entry("function", `#define ${name!.text}()`, name!);
    default:
      return declaratorEntry(node);
  }
}

/**
 * C for the pager, on the shared Tree-sitter adapter with the official C
 * grammar: the highlight query that names a token class for each piece of
 * syntax, and the rule that makes each function, file-level or member
 * declaration, named type, type alias, and macro a structure entry.
 */
export const cGrammar: TreeSitterGrammar = {
  id: "c",
  wasmUrl: () => import.meta.resolve("tree-sitter-c/tree-sitter-c.wasm"),
  highlightQuery: C_QUERY,
  structureParents: STRUCTURE_PARENTS,
  structureEntry,
};

/**
 * C++ for the pager, on the official C++ grammar, which C++, CUDA, and headers
 * whose dialect is not known all use. It parses the declarations C headers
 * usually make, though not C that uses one of C++'s keywords as a name. CUDA's
 * qualifiers are keywords wherever this grammar is used. Classes, namespaces,
 * and `using` aliases are structure entries besides C's.
 */
export const cppGrammar: TreeSitterGrammar = {
  id: "cpp",
  wasmUrl: () => import.meta.resolve("tree-sitter-cpp/tree-sitter-cpp.wasm"),
  highlightQuery: CPP_QUERY + C_QUERY,
  structureParents: STRUCTURE_PARENTS,
  structureEntry,
};
