import "@binclusive/tree-sitter-swift-wasm/package.json" with { type: "json" };

import type { StructureKind } from "../../model.ts";
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
(shebang_line) @comment
(shebang_line ["#" "!"] @comment)
((comment) @docComment (#match? @docComment "^///([^/]|$)"))
((multiline_comment) @docComment (#match? @docComment "^/[*][*][^*/]"))
[(comment) (multiline_comment)] @comment

[(line_string_literal) (multi_line_string_literal) (raw_string_literal)] @string
(str_escaped_char) @string
(line_string_literal ["\\\\(" ")"] @punctuation)
(multi_line_string_literal ["\\\\(" ")"] @punctuation)
(raw_str_interpolation [(raw_str_interpolation_start) ")"] @punctuation)
(regex_literal) @regex
(regex_literal "#" @regex)

[
  (integer_literal) (hex_literal) (oct_literal) (bin_literal) (real_literal)
] @number
(boolean_literal) @boolean
[
  "nil" (self_expression) (super_expression) (special_literal)
  (wildcard_pattern)
] @keyword

; The grammar reads these two statements as bare names.
((simple_identifier) @controlKeyword
  (#any-of? @controlKeyword "defer" "fallthrough"))

; Declared names and callees are matched by the token beside them.
("func" . (simple_identifier) @functionName)
(
  ["actor" "class" "enum" "extension" "protocol" "struct" "typealias"]
  .
  [(type_identifier) (user_type)] @interfaceName
)
(attribute (user_type (type_identifier) @callName))
[
  "arch" "available" "canImport" "colorLiteral" "compiler" "fileLiteral"
  "imageLiteral" "keyPath" "os" "selector" "swift" "targetEnvironment"
  "unavailable"
] @callName
([
  (simple_identifier) @callName
  (prefix_expression (simple_identifier) @callName)
  (navigation_expression (navigation_suffix (simple_identifier) @callName))
] . (call_suffix))
(navigation_suffix suffix: (simple_identifier) @propertyName)
(value_argument_label (simple_identifier) @propertyName)
(statement_label) @propertyName
(parameter external_name: (simple_identifier) @propertyName)
(parameter name: (simple_identifier) @parameter)
(lambda_parameter (simple_identifier) @parameter)
(_ bound_identifier: (simple_identifier) @binding)
(type_identifier) @typeName
["some" "any"] @typeKeyword

["@" "#"] @operator
(type_parameters ["<" ">"] @punctuation)
(type_arguments ["<" ">"] @punctuation)
[
  "!" "!=" "!==" "%" "%=" "&" "&&" "*" "*=" "+" "++" "+=" "-" "--" "-=" "->"
  "..." "..<" "/" "/=" "<" "<<" "<=" "=" "==" "===" ">" ">=" ">>" "?" "??" "^"
  "|" "||" "~" (bang) (custom_operator)
] @operator

(enum_entry "case" @storageKeyword)
[
  "actor" "associatedtype" "class" "deinit" "enum" "extension" "func"
  "import" "init" "let" "macro" "operator" "precedencegroup" "protocol"
  "struct" "subscript" "typealias" "var"
] @storageKeyword
[
  "break" "case" "continue" "do" "for" "guard" "if" "repeat" "return" "switch" "while"
  "yield" (else) (default_keyword) (throw_keyword) (catch_keyword)
] @controlKeyword
[
  "as" "async" "await" "didSet" "in" "indirect" "infix" "is" "postfix"
  "prefix" "try" "willSet" (as_operator) (throws) (where_keyword)
  (getter_specifier) (setter_specifier) (modify_specifier)
  (visibility_modifier) (member_modifier) (function_modifier)
  (property_modifier) (parameter_modifier) (inheritance_modifier)
  (mutation_modifier) (ownership_modifier) (property_behavior_modifier)
  "#if" "#elseif" "#else" "#endif" (diagnostic)
] @keyword

["(" ")" "[" "]" "{" "}"] @bracket
["," ":" ";" "."] @punctuation

(simple_identifier) @identifier
`;

/** Bodies whose declarations are members of a type. */
const TYPE_BODIES = new Set(["class_body", "enum_class_body", "protocol_body"]);

/**
 * Returns an entry labeled with its declaring keyword and name, or undefined
 * when the declaration has no name yet. A dotted or generic type path, which
 * an extension may name, is indexed under the type's own name.
 */
function namedEntry(
  kind: StructureKind,
  keyword: string,
  declared: SyntaxNode | null,
): StructureEntry | undefined {
  const name = declared?.type === "user_type"
    ? declared.namedChildren.findLast((part) => part.type === "type_identifier")
    : declared;
  return !name?.text ? undefined : {
    kind,
    label: `${keyword} ${declared!.text}`,
    name: name.text,
    nameOffset: name.startIndex,
  };
}

/**
 * Returns the entry for a property declared on a type or at the top of a file,
 * under the first name it binds, or undefined for a local variable, which is
 * not structure.
 */
function propertyEntry(
  node: SyntaxNode,
  inType: boolean,
): StructureEntry | undefined {
  if (!inType && node.parent!.type !== "source_file") return undefined;
  // The grammar requires a property's pattern and binding keyword, and error
  // recovery inserts only missing tokens, never a missing pattern.
  const pattern = node.childForFieldName("name")!;
  const binding = [...node.namedChildren, ...pattern.namedChildren].find(
    (child) => child.type === "value_binding_pattern",
  );
  const name = pattern.descendantsOfType("simple_identifier")[0] ?? null;
  return namedEntry("variable", binding!.text, name);
}

/**
 * Swift for the pager, on the shared Tree-sitter adapter: the highlight query
 * that names a token class for each piece of syntax, and the rule that turns a
 * type, function, initializer, or type-level property declaration into a
 * structure entry. Loading, coloring, incremental editing, and the structure
 * walk are the adapter's.
 *
 * The grammar package supplies the compiled parser, byte for byte the
 * WebAssembly build attached to the upstream grammar's release. That grammar's
 * own highlight query is not used, because the pager tells a declared name from
 * a called one and a control keyword from a declaring one.
 */
export const swiftGrammar: TreeSitterGrammar = {
  id: "swift",

  wasmUrl: () =>
    import.meta.resolve(
      "@binclusive/tree-sitter-swift-wasm/tree-sitter-swift.wasm",
    ),

  highlightQuery: HIGHLIGHT_QUERY,

  structureEntry(node) {
    const name = () => node.childForFieldName("name");
    const inType = () => TYPE_BODIES.has(node.parent!.type);
    switch (node.type) {
      case "class_declaration":
        return namedEntry(
          "class",
          node.childForFieldName("declaration_kind")!.text,
          name(),
        );
      case "protocol_declaration":
        return namedEntry("interface", "protocol", name());
      case "typealias_declaration":
        return namedEntry("typeAlias", "typealias", name());
      case "function_declaration":
      case "protocol_function_declaration":
        return namedEntry(inType() ? "method" : "function", "func", name());
      case "init_declaration":
      case "deinit_declaration":
      case "subscript_declaration":
        return { kind: "method", label: node.type.replace("_declaration", "") };
      case "property_declaration":
      case "protocol_property_declaration":
        return propertyEntry(node, inType());
      default:
        return undefined;
    }
  },
};
