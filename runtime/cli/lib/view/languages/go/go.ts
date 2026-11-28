import "tree-sitter-go/package.json" with { type: "json" };

import type {
  StructureEntry,
  SyntaxNode,
  TreeSitterGrammar,
} from "../treesitter/adapter.ts";

/**
 * Capture names are token classes. Order carries meaning: the narrowest
 * capture over a character colors it, and between captures of the same extent
 * the earliest pattern wins.
 */
const HIGHLIGHT_QUERY = `
; A directive to the Go toolchain, such as a \`//go:build\` constraint, as
; \`go/ast\` recognizes one.
((comment) @keyword
  (#match? @keyword "^//(line |extern |export |[a-z0-9]+:[a-z0-9])"))
; The comments between \`import "C"\` and the declaration before it, which
; include the preamble that cgo compiles as C.
((comment)+ @keyword . (import_declaration
  (import_spec path: (interpreted_string_literal) @string))
  (#eq? @string "\\"C\\""))
(comment) @comment

[(interpreted_string_literal) (raw_string_literal) (rune_literal)] @string

[(int_literal) (float_literal) (imaginary_literal)] @number
[(true) (false)] @boolean
[(nil) (iota)] @keyword

(package_clause (package_identifier) @interfaceName)
(type_spec name: (type_identifier) @interfaceName)
(type_alias name: (type_identifier) @interfaceName)
(type_parameter_declaration name: (identifier) @typeName)
; A type switch's case reads \`nil\` as a type.
((type_identifier) @keyword (#eq? @keyword "nil"))
(type_identifier) @typeName
(function_declaration name: (identifier) @functionName)
(method_declaration name: (field_identifier) @functionName)
(method_elem name: (field_identifier) @functionName)
(call_expression function: (identifier) @callName)
(call_expression
  function: (selector_expression field: (field_identifier) @callName))
(field_identifier) @propertyName
(parameter_declaration name: (identifier) @parameter)
(variadic_parameter_declaration name: (identifier) @parameter)
; The grammar gives the comma between two names the name field as well.
(const_spec (identifier) @binding)
(var_spec (identifier) @binding)
(short_var_declaration left: (expression_list (identifier) @binding))
(range_clause left: (expression_list (identifier) @binding) ":=")
(receive_statement left: (expression_list (identifier) @binding) ":=")
(type_switch_statement alias: (expression_list (identifier) @binding))
(import_spec name: (_) @binding)
(label_name) @identifier

(type_switch_statement "type" @keyword)
["const" "func" "interface" "struct" "type" "var"] @storageKeyword
["chan" "map"] @typeKeyword
[
  "break" "case" "continue" "default" "defer" "else" "fallthrough" "for" "go"
  "goto" "if" "range" "return" "select" "switch"
] @controlKeyword
["import" "package"] @keyword

[
  "-" "--" "-=" ":=" "!" "!=" "..." "*" "*=" "/" "/=" "&" "&&" "&=" "&^" "&^="
  "%" "%=" "^" "^=" "+" "++" "+=" "<-" "<" "<<" "<<=" "<=" "=" "==" ">" ">="
  ">>" ">>=" "|" "|=" "||" "~"
] @operator

["(" ")" "[" "]" "{" "}"] @bracket
["," ";" "." ":"] @punctuation

[(identifier) (package_identifier)] @identifier
`;

/** An entry declaring `name`, or none when error recovery left it out. */
function named(
  kind: StructureEntry["kind"],
  keyword: string,
  name: SyntaxNode | null | undefined,
): StructureEntry | undefined {
  return name?.text
    ? {
      kind,
      label: `${keyword} ${name.text}`,
      name: name.text,
      nameOffset: name.startIndex,
    }
    : undefined;
}

/**
 * The entry for a constant, variable, or field declaration, labeled with every
 * name it binds and declaring the first that is not blank. An embedded field
 * binds no name, and is labeled with its type.
 */
function specEntry(spec: SyntaxNode, keyword: string): StructureEntry {
  // The grammar gives the comma between two names the name field as well.
  const names = spec.childrenForFieldName("name").filter((name) =>
    name.isNamed
  );
  const declared = names.find((name) => name.text !== "_");
  const tag = spec.childForFieldName("tag");
  const label = names.length > 0
    ? `${keyword}${names.map((name) => name.text).join(", ")}`
    : spec.text.slice(0, (tag?.startIndex ?? spec.endIndex) - spec.startIndex)
      .trim();
  return declared === undefined ? { kind: "variable", label } : {
    kind: "variable",
    label,
    name: declared.text,
    nameOffset: declared.startIndex,
  };
}

/** The structure kind of a declared type, from the type it is defined as. */
function typeKind(spec: SyntaxNode): StructureEntry["kind"] {
  switch (spec.childForFieldName("type")?.type) {
    case "struct_type":
      return "class";
    case "interface_type":
      return "interface";
    default:
      return "typeAlias";
  }
}

/**
 * Go for the pager, on the shared Tree-sitter adapter: the highlight query that
 * names a token class for each piece of syntax, and the rule that makes the
 * package clause, each type, function, and method, each constant and variable
 * declared at package level, and each field and method a type declares a
 * structure entry. Loading, coloring, incremental editing, and the structure
 * walk are the adapter's.
 *
 * The grammar package supplies the compiled parser. Its own highlight query is
 * not used, because its capture names are not the pager's token classes.
 */
export const goGrammar: TreeSitterGrammar = {
  id: "go",

  wasmUrl: () => import.meta.resolve("tree-sitter-go/tree-sitter-go.wasm"),

  highlightQuery: HIGHLIGHT_QUERY,

  // Declarations inside a function body are local, and error recovery can hold
  // a declaration inside an error node.
  structureParents: new Set([
    "source_file",
    "type_declaration",
    "type_spec",
    "type_alias",
    "struct_type",
    "field_declaration_list",
    "interface_type",
    "const_declaration",
    "var_declaration",
    "var_spec_list",
    "ERROR",
  ]),

  structureEntry(node) {
    const name = () => node.childForFieldName("name");
    switch (node.type) {
      case "package_clause":
        return named(
          "object",
          "package",
          node.namedChildren.find((part) => part.type === "package_identifier"),
        );
      case "type_spec":
      case "type_alias":
        return named(typeKind(node), "type", name());
      case "function_declaration":
        return named("function", "func", name());
      case "method_declaration": {
        const receiver = node.childForFieldName("receiver")?.namedChildren
          .find((part) => part.type === "parameter_declaration")
          ?.childForFieldName("type");
        return named("method", `func (${receiver?.text ?? ""})`, name());
      }
      case "method_elem":
        return named("method", "func", name());
      case "field_declaration":
        return specEntry(node, "");
      case "const_spec":
        return specEntry(node, "const ");
      case "var_spec":
        return specEntry(node, "var ");
      default:
        return undefined;
    }
  },
};
