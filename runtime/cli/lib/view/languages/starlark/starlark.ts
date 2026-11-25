/**
 * Starlark for the pager, on the shared Tree-sitter adapter. Starlark's syntax
 * is a subset of Python's, so the language runs on the Python grammar with the
 * Python highlight query. This module holds what is particular to Starlark:
 * coloring `load` as the statement it is, and the rule that makes functions,
 * the single names assigned outside functions, and the targets a build file
 * declares into structure entries.
 */

import type { SyntaxNode, TreeSitterGrammar } from "../treesitter/adapter.ts";
import { PYTHON_HIGHLIGHT_QUERY, pythonGrammar } from "../python/python.ts";

/**
 * Capture names are token classes. The pattern here precedes the Python
 * query's, so between captures of the same extent it wins.
 */
const HIGHLIGHT_QUERY = `
((call function: (identifier) @keyword) (#eq? @keyword "load"))
` + PYTHON_HIGHLIGHT_QUERY;

/** Whether a node is inside a function's body. */
function inFunction(node: SyntaxNode): boolean {
  for (let scope = node.parent; scope !== null; scope = scope.parent) {
    if (scope.type === "function_definition") return true;
  }
  return false;
}

/** The text of the string a call passes as its `name` argument, as a node,
 * when the call passes one. */
function targetName(call: SyntaxNode): SyntaxNode | undefined {
  const argument = call.childForFieldName("arguments")?.namedChildren.find(
    (child) =>
      child.type === "keyword_argument" &&
      child.childForFieldName("name")?.text === "name",
  );
  const value = argument?.childForFieldName("value");
  return value?.type === "string"
    ? value.namedChildren.find((child) => child.type === "string_content")
    : undefined;
}

export const starlarkGrammar: TreeSitterGrammar = {
  id: "starlark",

  wasmUrl: pythonGrammar.wasmUrl,

  highlightQuery: HIGHLIGHT_QUERY,

  // Every entry is a statement, or a call or assignment that is one.
  structureParents: new Set([
    "module",
    "expression_statement",
    "function_definition",
    "block",
    "if_statement",
    "elif_clause",
    "else_clause",
    "for_statement",
    "ERROR",
  ]),

  structureEntry(node) {
    if (node.type === "function_definition") {
      return pythonGrammar.structureEntry(node);
    }
    if (node.parent?.type !== "expression_statement" || inFunction(node)) {
      return undefined;
    }
    if (node.type === "assignment") {
      const left = node.childForFieldName("left");
      return left?.type !== "identifier" ? undefined : {
        kind: "variable",
        label: left.text,
        name: left.text,
        nameOffset: left.startIndex,
      };
    }
    if (node.type !== "call") return undefined;
    // A call outside any function that names what it creates declares a
    // build target, such as `go_library(name = "sync", ...)`.
    const name = targetName(node);
    const rule = node.childForFieldName("function");
    return name === undefined || rule === null ? undefined : {
      kind: "object",
      label: `${rule.text} ${name.text}`,
      name: name.text,
      nameOffset: name.startIndex,
    };
  },
};
