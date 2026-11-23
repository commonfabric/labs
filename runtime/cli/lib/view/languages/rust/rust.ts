import "tree-sitter-rust/package.json" with { type: "json" };

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
[(line_comment (doc_comment)) (block_comment (doc_comment))] @docComment
[(inner_doc_comment_marker) (outer_doc_comment_marker)] @docComment
[(shebang) (line_comment) (block_comment)] @comment

[(string_literal) (raw_string_literal) (char_literal)] @string
[(integer_literal) (float_literal)] @number (boolean_literal) @boolean

; Declared names are matched by the keyword before them, which also finds the
; name of an item the parser could not finish.
(["fn" "macro_rules!"] . (identifier) @functionName)
(["enum" "mod" "struct" "trait" "type" "union"] .
  [(identifier) (type_identifier)] @interfaceName)
(enum_variant name: (identifier) @propertyName)

(_ function: [(identifier) @callName (scoped_identifier name: (identifier) @callName)
  (field_expression field: (field_identifier) @callName)])
(macro_invocation
  macro: [(identifier) @callName (scoped_identifier name: (identifier) @callName)]
  "!" @callName)
(attribute . [(identifier) @callName (scoped_identifier name: (identifier) @callName)])
(tuple_struct_pattern
  type: [(identifier) @callName (scoped_identifier name: (identifier) @callName)])

(parameter pattern: [(identifier) @parameter (_ (identifier) @parameter)])
(closure_parameters [(identifier) @parameter (_ (identifier) @parameter)])
(metavariable) @parameter

[(const_item name: (identifier) @binding) (static_item name: (identifier) @binding)]
; A capitalized name in a pattern is a constant or a variant, not a binding.
([
  (_ pattern: (identifier) @binding) (reference_pattern (identifier) @binding)
  (match_pattern . (identifier) @binding) (mut_pattern (identifier) @binding)
  (ref_pattern (identifier) @binding) (tuple_pattern (identifier) @binding)
  (slice_pattern (identifier) @binding) (captured_pattern (identifier) @binding)
  (tuple_struct_pattern (identifier) @binding) (or_pattern (identifier) @binding)
  (field_pattern (shorthand_field_identifier) @binding)
] (#match? @binding "^[^A-Z]"))

[(field_identifier) (shorthand_field_identifier)] @propertyName
(label) @propertyName (label (identifier) @propertyName)
(lifetime) @typeName (lifetime (identifier) @typeName)
(type_identifier) @typeName
((_ path: [(identifier) @typeName (scoped_identifier name: (identifier) @typeName)])
  (#match? @typeName "^[A-Z]"))
[(primitive_type) (never_type) (fragment_specifier)] @typeKeyword
(abstract_type "impl" @typeKeyword) (dynamic_type "dyn" @typeKeyword)

(impl_item "for" @keyword) (for_lifetimes "for" @keyword)
(higher_ranked_trait_bound "for" @keyword)
(visibility_modifier "in" @keyword) (pointer_type "const" @keyword)
[
  "const" "enum" "extern" "fn" "impl" "let" "macro_rules!" "mod" "static"
  "struct" "trait" "type" "union" "use"
] @storageKeyword
[
  "break" "continue" "else" "for" "if" "in" "loop" "match" "return" "try"
  "while" "yield"
] @controlKeyword
[
  "as" "async" "await" "default" "dyn" "gen" "move" "pub" "raw" "ref" "unsafe"
  "where" "_" (crate) (mutable_specifier) (self) (super)
] @keyword

(type_arguments ["<" ">"] @punctuation) (type_parameters ["<" ">"] @punctuation)
(bracketed_type ["<" ">"] @punctuation) (for_lifetimes ["<" ">"] @punctuation)
(closure_parameters "|" @punctuation)
[
  "!" "!=" "#" "$" "%" "%=" "&" "&&" "&=" "*" "*=" "+" "+=" "-" "-=" "->"
  ".." "..." "..=" "/" "/=" "<" "<<" "<<=" "<=" "=" "==" "=>" ">" ">=" ">>"
  ">>=" "?" "@" "^" "^=" "|" "|=" "||"
] @operator

["(" ")" "[" "]" "{" "}"] @bracket
["," ":" "::" ";" "."] @punctuation

(identifier) @identifier
`;

/** The structure kind and label keyword of each declaration named by its own
 * field. A function in the declaration list of an implementation or a trait is
 * a method. */
const NAMED_ITEMS: Record<string, [StructureKind, string]> = {
  function_item: ["function", "fn"],
  function_signature_item: ["function", "fn"],
  struct_item: ["class", "struct"],
  enum_item: ["class", "enum"],
  union_item: ["class", "union"],
  trait_item: ["interface", "trait"],
  type_item: ["typeAlias", "type"],
  associated_type: ["typeAlias", "type"],
  mod_item: ["object", "mod"],
  macro_definition: ["function", "macro_rules!"],
  const_item: ["variable", "const"],
  static_item: ["variable", "static"],
  enum_variant: ["variable", ""],
  field_declaration: ["variable", ""],
};

/** Items whose declaration lists hold methods. */
const METHOD_OWNERS = new Set(["impl_item", "trait_item"]);

/** An entry labeled with its keyword, if any, and its name, or undefined when
 * the item has no name yet. */
function namedEntry(
  kind: StructureKind,
  keyword: string,
  name: SyntaxNode | null,
): StructureEntry | undefined {
  return !name?.text || name.text === "_" ? undefined : {
    kind,
    label: `${keyword} ${name.text}`.trimStart(),
    name: name.text,
    nameOffset: name.startIndex,
  };
}

/** The entry for an implementation, indexed under the first type name in the
 * implementing type that is not one of the implementation's parameters. */
function implEntry(node: SyntaxNode): StructureEntry {
  const trait = node.childForFieldName("trait");
  const type = node.childForFieldName("type");
  const not = node.children.some((child) => child.type === "!") ? "!" : "";
  const label = ["impl", trait && `${not}${trait.text} for`, type?.text]
    .filter(Boolean).join(" ").replace(/\s+/g, " ");
  const parameters = node.childForFieldName("type_parameters")?.namedChildren
    .map((parameter) => parameter.childForFieldName("name")?.text);
  const name = type?.descendantsOfType("type_identifier")
    .find((part) => !parameters?.includes(part.text)) ?? null;
  return { kind: "class", ...namedEntry("class", "", name), label };
}

/**
 * Rust for the pager, on the shared Tree-sitter adapter: the highlight query
 * that names a token class for each piece of syntax, and the rule that turns
 * an item, a method, a variant, or a named field into a structure entry.
 * Loading, coloring, incremental editing, and the structure walk are the
 * adapter's.
 *
 * The compiled parser is the official Tree-sitter Rust grammar's. Its own
 * highlight query is not used, because the pager tells a declared name from a
 * called one and a control keyword from a declaring one.
 */
export const rustGrammar: TreeSitterGrammar = {
  id: "rust",

  wasmUrl: () => import.meta.resolve("tree-sitter-rust/tree-sitter-rust.wasm"),

  highlightQuery: HIGHLIGHT_QUERY,

  // Items, members, and fields, including the items a function body declares
  // in its blocks and those that error recovery holds inside an error node.
  structureParents: new Set([
    "source_file",
    "declaration_list",
    "mod_item",
    "impl_item",
    "trait_item",
    "foreign_mod_item",
    "struct_item",
    "union_item",
    "enum_item",
    "enum_variant_list",
    "enum_variant",
    "field_declaration_list",
    "function_item",
    "block",
    "expression_statement",
    "unsafe_block",
    "ERROR",
  ]),

  structureEntry(node) {
    if (node.type === "impl_item") return implEntry(node);
    const item = NAMED_ITEMS[node.type];
    if (item === undefined) return undefined;
    const [kind, keyword] = item;
    const owner = node.parent?.parent?.type ?? "";
    const method = keyword === "fn" && METHOD_OWNERS.has(owner);
    return namedEntry(
      method ? "method" : kind,
      keyword,
      node.childForFieldName("name"),
    );
  },
};
