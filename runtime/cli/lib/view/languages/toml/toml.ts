import "@tree-sitter-grammars/tree-sitter-toml/package.json" with {
  type: "json",
};

import type { TreeSitterGrammar } from "../treesitter/adapter.ts";

/**
 * Capture names are token classes. Order carries meaning: the narrowest
 * capture over a character colors it, and between captures of the same extent
 * the earliest pattern wins.
 */
const HIGHLIGHT_QUERY = `
(comment) @comment

(string) @string
(escape_sequence) @string
[(integer) (float)] @number
(boolean) @boolean
[
  (offset_date_time) (local_date_time) (local_date) (local_time)
] @number

(table [(bare_key) (quoted_key) (dotted_key)] @interfaceName)
(table_array_element [(bare_key) (quoted_key) (dotted_key)] @interfaceName)
(pair [(bare_key) (quoted_key) (dotted_key)] @propertyName)

"=" @operator
["[" "]" "[[" "]]" "{" "}"] @bracket
["," "."] @punctuation
`;

/** Nodes whose keys head a table. */
const TABLES = new Set(["table", "table_array_element"]);

/**
 * TOML for the pager, on the shared Tree-sitter adapter: the highlight query
 * that names a token class for each piece of syntax, and the rule that makes
 * each table and each key it sets a structure entry. Loading, coloring,
 * incremental editing, and the structure walk are the adapter's.
 *
 * The grammar package supplies the compiled parser. Its own highlight query is
 * not used, because its capture names are not the pager's token classes.
 */
export const tomlGrammar: TreeSitterGrammar = {
  id: "toml",

  wasmUrl: () =>
    import.meta.resolve(
      "@tree-sitter-grammars/tree-sitter-toml/tree-sitter-toml.wasm",
    ),

  highlightQuery: HIGHLIGHT_QUERY,

  structureEntry(node) {
    const table = TABLES.has(node.type);
    if (
      !table && (node.type !== "pair" || node.parent!.type === "inline_table")
    ) {
      return undefined;
    }
    // The grammar requires a table's or a pair's key, which comes first.
    const key = node.namedChildren[0]!;
    const name = key.text;
    return {
      kind: table ? "object" : "variable",
      label: node.type === "table_array_element"
        ? `[[${name}]]`
        : table
        ? `[${name}]`
        : name,
      name,
      nameOffset: key.startIndex,
    };
  },
};
