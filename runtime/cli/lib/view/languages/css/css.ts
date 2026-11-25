import "tree-sitter-css/package.json" with { type: "json" };

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
; CSS has no line comments. The grammar reads \`//\` and the rest of its line as
; one, which a browser does not, so that text is left uncolored.
(comment) @comment

(string_value) @string
(attribute_selector (plain_value) @string)
((call_expression
  (function_name) @callName
  (arguments (plain_value) @string))
  (#match? @callName "^[uU][rR][lL]$"))
[(integer_value) (float_value) (color_value)] @number

; The grammar reads \`14px/1.5\` in a \`font\` shorthand as the number \`14\` and
; then the value \`px/1.5\`, so a value that follows a number and starts with a
; unit and a slash is colored as the size it continues.
(_ [(integer_value) (float_value)] . ((plain_value) @number
  (#match? @number "^[a-zA-Z%]+/")))

; A custom property's name where a value refers to it, as in \`var(--gap)\`, or
; where \`@property\` registers it.
([(plain_value) (keyword_query)] @identifier (#match? @identifier "^--"))

; The name an at-rule such as \`@layer\` or \`@container\` declares.
(at_rule (keyword_query) @interfaceName)

; A keyword value, such as \`none\` or \`flex\`, is a constant, as the literals
; beside it are.
[(plain_value) (keyword_query)] @boolean

(pseudo_class_selector ":" @keyword (class_name) @keyword)
(pseudo_element_selector "::" @keyword (tag_name) @keyword)
(tag_name) @typeName
(class_selector "." @interfaceName)
(id_selector "#" @interfaceName)
(class_selector (class_name) @interfaceName)
[(id_name) (keyframes_name) (namespace_name)] @interfaceName
[(nesting_selector) (universal_selector)] @operator
[(attribute_name) (property_name) (feature_name)] @propertyName
(function_name) @callName

[
  "@media" "@import" "@charset" "@namespace" "@supports" "@keyframes" "@scope"
  (at_keyword) (important) (important_value) (from) (to)
] @keyword
; These words are keywords only where the grammar reads them in a query or a
; selector. That leaves them uncolored inside most longer words it cannot parse,
; such as the \`or\` in \`! important\`.
(binary_query ["and" "or"] @keyword)
(unary_query ["not" "only"] @keyword)
(selector_query "selector" @keyword)
(arguments "of" @keyword)
(scope_statement "to" @keyword)

[
  ">" "~" "+" "-" "*" "/" "|" "=" "~=" "^=" "|=" "*=" "$="
] @operator

["(" ")" "[" "]" "{" "}"] @bracket
["," ";" ":"] @punctuation
`;

/** Nodes holding a block of rules that a media or other condition applies
 * to. */
const CONDITIONS = new Set([
  "media_statement",
  "supports_statement",
  "scope_statement",
]);

/** The text of `node` up to `end`, without its comments, and with each run of
 * white space read as one space. */
function label(node: SyntaxNode, end = node.endIndex): string {
  const source = node.text.slice(0, end - node.startIndex);
  const comments = source.includes("/*")
    ? node.descendantsOfType("comment")
    : [];
  let text = "";
  let from = 0;
  for (const comment of comments) {
    const start = comment.startIndex - node.startIndex;
    if (start >= source.length) break;
    text += source.slice(from, start) + " ";
    from = comment.endIndex - node.startIndex;
  }
  return (text + source.slice(from)).replace(/\s+/g, " ").trim();
}

/** The text of an at-rule from its keyword to the block it applies to or the
 * semicolon that ends it. */
function prelude(node: SyntaxNode): string {
  const block = node.namedChildren.find((child) =>
    child.type === "block" || child.type === "keyframe_block_list"
  );
  return label(node, block?.startIndex ?? node.endIndex).replace(/ ?;$/, "");
}

/**
 * CSS for the pager, on the shared Tree-sitter adapter: the highlight query
 * that names a token class for each piece of syntax, and the rule that makes
 * each rule set, at-rule, and custom property declaration a structure entry.
 * Loading, coloring, incremental editing, and the structure walk are the
 * adapter's.
 *
 * Selectors color element names as type names and class and ID names as the
 * names a rule declares styles for. A custom property's declaration is a
 * definition, so the info card on a `var(--name)` reference finds it.
 *
 * The grammar package supplies the compiled parser. Its own highlight query is
 * not used, because its capture names are not the pager's token classes.
 */
export const cssGrammar: TreeSitterGrammar = {
  id: "css",

  wasmUrl: () => import.meta.resolve("tree-sitter-css/tree-sitter-css.wasm"),

  highlightQuery: HIGHLIGHT_QUERY,

  // Error recovery can hold a rule set or a declaration inside an error node.
  structureParents: new Set([
    "stylesheet",
    "block",
    "rule_set",
    "at_rule",
    "keyframes_statement",
    "keyframe_block_list",
    "keyframe_block",
    "ERROR",
    ...CONDITIONS,
  ]),

  structureEntry(node): StructureEntry | undefined {
    switch (node.type) {
      case "rule_set": {
        // Error recovery can supply an empty selector, which names nothing.
        const selectors = label(node.firstNamedChild!);
        return selectors === ""
          ? undefined
          : { kind: "object", label: selectors };
      }
      case "declaration": {
        const property = node.firstNamedChild!;
        if (!property.text.startsWith("--")) return undefined;
        return {
          kind: "variable",
          label: property.text,
          name: property.text,
          nameOffset: property.startIndex,
        };
      }
      case "import_statement":
      case "namespace_statement":
        return { kind: "import", label: prelude(node) };
      case "keyframes_statement":
      case "at_rule": {
        const [keyword, name] = node.namedChildren;
        const at = keyword!.text.toLowerCase();
        return at === "@property" && name?.text.startsWith("--")
          ? {
            kind: "variable",
            label: prelude(node),
            name: name.text,
            nameOffset: name.startIndex,
          }
          : {
            kind: at === "@container" ? "control" : "object",
            label: prelude(node),
          };
      }
      default:
        return CONDITIONS.has(node.type)
          ? { kind: "control", label: prelude(node) }
          : undefined;
    }
  },
};
