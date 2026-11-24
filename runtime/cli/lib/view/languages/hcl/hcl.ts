import "@tree-sitter-grammars/tree-sitter-hcl/package.json" with {
  type: "json",
};

import type { SyntaxNode, TreeSitterGrammar } from "../treesitter/adapter.ts";

/**
 * Capture names are token classes. Order carries meaning: the narrowest
 * capture over a character colors it, and between captures of the same extent
 * the earliest pattern wins.
 */
const HIGHLIGHT_QUERY = `
(comment) @comment

[(string_lit) (quoted_template) (heredoc_template)] @string

; The code inside a template's interpolations and directives is not part of
; the string around it.
[
  (template_interpolation) (template_if_intro) (template_else_intro)
  (template_if_end) (template_for_start) (template_for_end)
] @plain
[
  (template_interpolation_start) (template_interpolation_end)
  (template_directive_start) (template_directive_end)
] @punctuation
(strip_marker) @operator

(numeric_lit) @number
(legacy_index) @number
(bool_lit) @boolean
(null_lit) @keyword

(config_file (body (block . (identifier) @storageKeyword)))
(block (identifier) @interfaceName)
(block (string_lit (template_literal) @interfaceName))
(attribute (identifier) @propertyName)
(object_elem
  key: (expression (variable_expr (identifier) @propertyName) .))

((variable_expr (identifier) @keyword)
  (#any-of? @keyword
    "count" "data" "each" "local" "module" "path" "self" "terraform" "var"))

; The name a reference reaches a declaration by: \`x\` in \`var.x\`, \`web\` in
; \`aws_instance.web\`, and \`ami\` in \`data.aws_ami.ami\`. The attributes of
; \`count\`, \`each\`, \`path\`, \`self\`, and \`terraform\` are fixed, and name no
; declaration.
((_ (variable_expr (identifier) @keyword) . (get_attr (identifier) @propertyName))
  (#any-of? @keyword "count" "each" "path" "self" "terraform"))
((_ (variable_expr (identifier) @keyword) . (get_attr) .
  (get_attr (identifier) @identifier))
  (#eq? @keyword "data"))
(_ (variable_expr) . (get_attr (identifier) @identifier))
(get_attr (identifier) @propertyName)
(function_call (identifier) @callName)
(for_intro (identifier) @parameter)
(template_for_start (identifier) @parameter)

["for" "in" "if" "else" "endif" "endfor"] @controlKeyword

(conditional ["?" ":"] @operator)
(object_elem ":" @operator)
[
  "=" "=>" "!" "-" "+" "*" "/" "%" ">" ">=" "<" "<=" "==" "!=" "&&" "||"
  ".*" "[*]" (ellipsis)
] @operator

["(" ")" "[" "]" "{" "}"] @bracket
["," "." ":"] @punctuation

(variable_expr (identifier) @identifier)
`;

/** The name a label declares, which is its text without its quotes; an empty
 * label declares none. */
function labelName(label: SyntaxNode): SyntaxNode | undefined {
  return label.type === "identifier" ? label : label.namedChildren.find(
    (child) => child.type === "template_literal",
  );
}

/** Whether an attribute names a value that expressions elsewhere refer to:
 * one set in a file's top level, as variable definitions files do, or in a
 * `locals` block. */
function isDefinition(attribute: SyntaxNode): boolean {
  const body = attribute.parent;
  const owner = body?.type === "body" ? body.parent : null;
  return owner?.type === "config_file" ||
    (owner?.type === "block" && owner.firstNamedChild?.text === "locals");
}

/**
 * HCL for the pager, on the shared Tree-sitter adapter: the highlight query
 * that names a token class for each piece of syntax, and the rule that makes
 * each block, and each attribute that defines a value, a structure entry.
 * Loading, coloring, incremental editing, and the structure walk are the
 * adapter's.
 *
 * A block's type is a declaring keyword at a file's top level, where OpenTofu
 * gives each type its meaning, and a type name inside another block. OpenTofu's
 * reference namespaces, such as `var` and `local`, are keywords. A string's
 * interpolations and template directives are code inside the string.
 *
 * The grammar package supplies compiled parsers for HCL and for a Terraform
 * dialect of it, which have the same rules; the pager loads the HCL one.
 */
export const hclGrammar: TreeSitterGrammar = {
  id: "hcl",

  wasmUrl: () =>
    import.meta.resolve(
      "@tree-sitter-grammars/tree-sitter-hcl/tree-sitter-hcl.wasm",
    ),

  highlightQuery: HIGHLIGHT_QUERY,

  // Error recovery can hold a block or an attribute inside an error node.
  structureParents: new Set(["config_file", "body", "block", "ERROR"]),

  structureEntry(node) {
    if (node.type === "attribute") {
      if (!isDefinition(node)) return undefined;
      const key = node.firstNamedChild!;
      return {
        kind: "variable",
        label: key.text,
        name: key.text,
        nameOffset: key.startIndex,
      };
    }
    if (node.type !== "block") return undefined;
    // The grammar requires a block's type, which comes first; any labels
    // follow it, ahead of the block's body.
    const [type, ...rest] = node.namedChildren;
    const labels = rest.filter((child) =>
      child.type === "string_lit" || child.type === "identifier"
    );
    const label = [type!, ...labels].map((part) => part.text).join(" ");
    const last = labels.at(-1);
    const name = last === undefined ? undefined : labelName(last);
    return name === undefined
      ? { kind: "object", label }
      : { kind: "object", label, name: name.text, nameOffset: name.startIndex };
  },
};
