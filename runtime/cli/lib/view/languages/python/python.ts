/**
 * Python for the pager, on the shared Tree-sitter adapter. This module holds
 * the two things that are particular to Python: the highlight query that names
 * a token class for each piece of syntax, and the rule that turns a class or
 * function definition into a structure entry. Loading, coloring, incremental
 * editing, and the structure walk are the adapter's.
 *
 * The grammar package supplies the compiled parser. Its own highlight query is
 * not used: the pager colors more finely than that query describes, telling a
 * declared name from a called one, a control keyword from a declaring one, and
 * giving each bracket its nesting depth.
 */

import "tree-sitter-python/package.json" with { type: "json" };

import type { SyntaxNode, TreeSitterGrammar } from "../treesitter/adapter.ts";

/**
 * Capture names are token classes. Order carries meaning: the narrowest
 * capture over a character colors it, and between captures of the same extent
 * the earliest pattern wins.
 */
const HIGHLIGHT_QUERY = `
(comment) @comment

((string) @template (#match? @template "^[A-Za-z]*[fFtT][A-Za-z]*[^A-Za-z]"))
(string) @string
(escape_sequence) @string
(interpolation ["{" "}"] @punctuation)

; A string the parser could not find the end of keeps its opening quote.
(ERROR (string_start) @string)

[(integer) (float)] @number
[(true) (false)] @boolean
[(none) (ellipsis)] @keyword

(function_definition name: (identifier) @functionName)
(class_definition name: (identifier) @interfaceName)
(call function: (identifier) @callName)
(call function: (attribute attribute: (identifier) @callName))
(decorator (identifier) @callName)
(decorator (attribute attribute: (identifier) @callName))
(type) @typeName
(type (generic_type (identifier) @typeName))
(attribute attribute: (identifier) @propertyName)
(keyword_argument name: (identifier) @propertyName)
(parameters (identifier) @parameter)
(parameters (list_splat_pattern (identifier) @parameter))
(parameters (dictionary_splat_pattern (identifier) @parameter))
(lambda_parameters (identifier) @parameter)
(default_parameter name: (identifier) @parameter)
(typed_parameter (identifier) @parameter)
(typed_default_parameter name: (identifier) @parameter)

["and" "in" "is" "not" "or" "is not" "not in"] @operator
[
  "-" "-=" "!=" "*" "**" "**=" "*=" "/" "//" "//=" "/=" "&" "&=" "%" "%=" "^"
  "^=" "+" "+=" "->" "<" "<<" "<<=" "<=" "<>" "=" ":=" "==" ">" ">=" ">>" ">>="
  "|" "|=" "~" "@" "@="
] @operator

["class" "def" "del" "global" "lambda" "nonlocal" "type"] @storageKeyword
[
  "break" "case" "continue" "elif" "else" "except" "finally" "for" "if" "match"
  "pass" "raise" "return" "try" "while" "with" "yield"
] @controlKeyword
["as" "assert" "async" "await" "from" "import"] @keyword

["(" ")" "[" "]" "{" "}"] @bracket
["," ":" ";" "."] @punctuation

(identifier) @identifier
`;

/** A definition's own node, or the decorated definition that introduces it. */
function definitionExtent(node: SyntaxNode): SyntaxNode {
  const parent = node.parent;
  return parent !== null && parent.type === "decorated_definition"
    ? parent
    : node;
}

/** Whether the nearest enclosing definition is a class rather than a function. */
function declaredInClass(node: SyntaxNode): boolean {
  for (let scope = node.parent; scope !== null; scope = scope.parent) {
    if (scope.type === "class_definition") return true;
    if (scope.type === "function_definition") return false;
  }
  return false;
}

export const pythonGrammar: TreeSitterGrammar = {
  id: "python",

  wasmUrl: () =>
    import.meta.resolve("tree-sitter-python/tree-sitter-python.wasm"),

  highlightQuery: HIGHLIGHT_QUERY,

  structureEntry(node) {
    if (
      node.type !== "function_definition" && node.type !== "class_definition"
    ) {
      return undefined;
    }
    const name = node.childForFieldName("name");
    const asynchronous = node.child(0)?.type === "async";
    const keyword = node.type === "class_definition"
      ? "class"
      : asynchronous
      ? "async def"
      : "def";
    return name === null ? undefined : {
      kind: node.type === "class_definition"
        ? "class"
        : declaredInClass(node)
        ? "method"
        : "function",
      label: `${keyword} ${name.text}`,
      name: name.text,
      nameOffset: name.startIndex,
      extent: definitionExtent(node),
    };
  },
};
