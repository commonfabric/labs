import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createHighlighter,
  highlightLines,
  parseDocument,
  prepareGrammar,
} from "../treesitter/adapter.ts";
import { cssGrammar } from "./css.ts";

/**
 * The CSS language for the pager. It provides lossless syntax highlighting for
 * direct files, diffs, and live edits, and a structure tree of rule sets,
 * at-rules, and custom property declarations. CSS has no semantic layer.
 */
export const cssLanguage: Language = {
  id: "css",

  commentLinesAreInert: true,

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".css"],
    filenames: [],
    filenamePatterns: [],
    aliases: [],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  prepare: () => prepareGrammar(cssGrammar),

  parseDocument: (text) => parseDocument(cssGrammar, text),

  highlightLines: (text) => highlightLines(cssGrammar, text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createHighlighter(cssGrammar, text),

  hunkStructure: (ctx) => remapStructure(ctx),
};
