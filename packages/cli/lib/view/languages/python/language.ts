/**
 * The Python language for the pager. It provides lossless syntax highlighting
 * for direct files, diffs, and live edits, and a structure tree of classes and
 * functions. Python has no semantic layer.
 */

import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createHighlighter,
  highlightLines,
  parseDocument,
  prepareGrammar,
} from "../treesitter/adapter.ts";
import { pythonGrammar } from "./python.ts";

export const pythonLanguage: Language = {
  id: "python",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".py", ".pyi", ".pyw"],
    filenames: [],
    filenamePatterns: [],
    aliases: ["py"],
    interpreters: [
      /^python(?:\d+(?:\.\d+)*)?$/,
      /^pypy(?:\d+(?:\.\d+)*)?$/,
      // `uv run` runs the shebang's own file as a Python script. The
      // launcher's other subcommands run something else, so the word after it
      // is part of the claim.
      ["uv", "run"],
    ],
    sharedExtensions: [],
  },

  prepare: () => prepareGrammar(pythonGrammar),

  parseDocument: (text) => parseDocument(pythonGrammar, text),

  highlightLines: (text) => highlightLines(pythonGrammar, text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createHighlighter(pythonGrammar, text),

  hunkStructure: (ctx) => remapStructure(ctx),
};
