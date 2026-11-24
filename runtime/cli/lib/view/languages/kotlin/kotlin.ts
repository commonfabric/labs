import "@binclusive/tree-sitter-kotlin-wasm/package.json" with { type: "json" };

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
(shebang) @comment
((block_comment) @docComment (#match? @docComment "^/[*][*][^*/]"))
[(line_comment) (block_comment)] @comment

[(string_literal) (multiline_string_literal) (character_literal)] @string
(escape_sequence) @string
(interpolation ["$" "\${" "}"] @punctuation)

[(number_literal) (float_literal)] @number

; The grammar reads these literals, statements, and the \`::class\` reference
; as bare names. A pattern that tests a name's text costs as much as capturing
; every name, so one pattern names them all.
((identifier) @keyword
  (#any-of? @keyword "true" "false" "null" "break" "continue" "class"))
((label) @controlKeyword (#match? @controlKeyword "^(break|continue)@$"))
(label) @propertyName

; Declared names and callees are matched by the token beside them.
((identifier) @functionName . (function_value_parameters))
(
  ["class" "interface" "object" "typealias"]
  .
  (identifier) @interfaceName
)
(annotation (user_type (identifier) @callName))
(constructor_invocation (user_type (identifier) @callName))
(user_type (identifier) @typeName)
([
  (identifier) @callName
  (navigation_expression (identifier) @callName .)
] . [(value_arguments) (annotated_lambda) (type_arguments)])
(qualified_identifier (identifier) @identifier)
(["." "?." "::"] . (identifier) @propertyName)
(value_argument (identifier) @propertyName . "=")
(parameter (identifier) @parameter)
(class_parameter (identifier) @parameter)
(lambda_parameters (variable_declaration (identifier) @parameter))
(catch_block (identifier) @parameter)
(setter (identifier) @parameter)
(variable_declaration (identifier) @binding)
(enum_entry (identifier) @binding)
(type_parameter (identifier) @typeName)
(type_constraint (identifier) @typeName)
"dynamic" @typeKeyword

"@" @operator
(type_parameters ["<" ">"] @punctuation)
(type_arguments ["<" ">"] @punctuation)
[
  "!" "!!" "!=" "!==" "%" "%=" "&&" "*" "*=" "+" "++" "+=" "-" "--" "-=" "->"
  ".." "..<" "/" "/=" "<" "<=" "=" "==" "===" ">" ">=" "?:" "||"
] @operator

[
  "class" "companion" "constructor" "fun" "import" "init" "interface"
  "object" "package" "typealias" "val" "var"
] @storageKeyword
[
  "catch" "do" "else" "finally" "for" "if" "return" "return@" "throw" "try"
  "when" "while"
] @controlKeyword
[
  "as" "as?" "by" "get" "in" "!in" "is" "!is" "set" "super" "super@" "this"
  "this@" "where" (use_site_target) (class_modifier) (member_modifier)
  (visibility_modifier) (function_modifier) (property_modifier)
  (inheritance_modifier) (parameter_modifier) (platform_modifier)
  (variance_modifier) (reification_modifier) (type_modifiers) "file"
] @keyword

["(" ")" "[" "]" "{" "}"] @bracket
["," ":" ";" "." "?." "::" "?"] @punctuation

(identifier) @identifier
`;

/** Bodies whose declarations are members of a type. */
const TYPE_BODIES = new Set(["class_body", "enum_class_body"]);

/**
 * Returns an entry labeled with its declaring keyword and name, or undefined
 * when the declaration has no name yet.
 */
function namedEntry(
  kind: StructureEntry["kind"],
  keyword: string,
  name: SyntaxNode | null | undefined,
): StructureEntry | undefined {
  return !name?.text ? undefined : {
    kind,
    label: `${keyword} ${name.text}`,
    name: name.text,
    nameOffset: name.startIndex,
  };
}

/** The first child of `node` of one of these types. */
function childOfType(node: SyntaxNode, ...types: string[]) {
  return node.children.find((child) => types.includes(child.type));
}

/**
 * Returns the entry for a property declared on a type, in a primary
 * constructor, or at the top of a file, under the first name it binds, or
 * undefined for a local variable or a constructor parameter that declares no
 * property, neither of which is structure.
 */
function propertyEntry(node: SyntaxNode, inType: boolean) {
  const binding = childOfType(node, "val", "var");
  const local = node.type === "property_declaration" && !inType &&
    node.parent!.type !== "source_file";
  if (binding === undefined || local) return undefined;
  const declared = childOfType(
    node,
    "identifier",
    "variable_declaration",
    "multi_variable_declaration",
  );
  const name = declared?.descendantsOfType("identifier")[0];
  return namedEntry("variable", binding.type, name);
}

/**
 * Kotlin for the pager, on the shared Tree-sitter adapter: the highlight query
 * that names a token class for each piece of syntax, and the rule that turns a
 * type, object, function, constructor, initializer, or type-level property
 * declaration into a structure entry. Loading, coloring, incremental editing,
 * and the structure walk are the adapter's.
 *
 * The grammar package supplies the compiled parser, byte for byte the
 * WebAssembly build in the upstream npm package, which has no highlight query.
 */
export const kotlinGrammar: TreeSitterGrammar = {
  id: "kotlin",

  wasmUrl: () =>
    import.meta.resolve(
      "@binclusive/tree-sitter-kotlin-wasm/tree-sitter-kotlin.wasm",
    ),

  highlightQuery: HIGHLIGHT_QUERY,

  // The grammar misparses `catch` or `finally` on the line after a catch block.
  // A line comment, from a `//` outside strings, keeps its line break.
  insignificantLineBreaks:
    /(?<!^(?:[^"\n]|"(?:[^"\\\n]|\\.)*")*\/\/[^\n]*)\}\s*(?=(?:catch|finally)\b)/gm,

  structureEntry(node) {
    const inType = () => TYPE_BODIES.has(node.parent!.type);
    const field = (name = "name") => node.childForFieldName(name);
    switch (node.type) {
      case "class_declaration": {
        const keyword = childOfType(node, "class", "interface")!.type;
        const modifiers = childOfType(node, "modifiers")?.children
          .filter((modifier) => modifier.type === "class_modifier")
          .map((modifier) => `${modifier.text} `) ?? [];
        return namedEntry(
          keyword === "interface" ? "interface" : "class",
          modifiers.join("") + keyword,
          field(),
        );
      }
      case "object_declaration":
        return namedEntry("class", "object", field());
      case "companion_object":
        return namedEntry(
          "class",
          "companion object",
          childOfType(node, "identifier"),
        ) ?? { kind: "class", label: "companion object" };
      case "type_alias":
        return namedEntry("typeAlias", "typealias", field("type"));
      case "function_declaration":
        return namedEntry(inType() ? "method" : "function", "fun", field());
      case "secondary_constructor":
        return { kind: "method", label: "constructor" };
      case "anonymous_initializer":
        return { kind: "method", label: "init" };
      case "property_declaration":
      case "class_parameter":
        return propertyEntry(node, inType());
      default:
        return undefined;
    }
  },
};
