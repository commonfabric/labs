/**
 * The TypeScript (and TSX/JS) language for the pager. It handles named files in
 * that language family. The selection layer also uses it for filename-free
 * transformed compiler output. Highlighting, structure, incremental editing
 * and the semantic layer all live in the neighboring {@link ./parse.ts} and
 * {@link ./semantics.ts}; this module only adapts them to the {@link Language}
 * contract.
 */

import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createHighlighter,
  highlightDocument,
  highlightLineEditLocally,
  parseDocument,
} from "./parse.ts";
import { createDiffSemantics, createSemantics } from "./semantics.ts";

export const typeScriptLanguage: Language = {
  id: "typescript",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
    ],
    filenames: [],
    filenamePatterns: [],
    aliases: ["ts", "javascript", "js"],
    interpreters: ["deno", "node", "nodejs", "bun"],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: (text, fileName) => parseDocument(text, fileName),

  highlightLines: (text, fileName) => highlightDocument(text, fileName),

  highlightFullFileOnDiffEdit: true,

  highlightDiffLineEditLocally: highlightLineEditLocally,

  createHighlighter: (text, fileName) => createHighlighter(text, fileName),

  hunkStructure: (ctx) => remapStructure(ctx),

  // The semantic factories already return `Semantics | undefined`, matching the
  // interface, so they are the methods directly.
  createSemantics,

  createDiffSemantics,
};
