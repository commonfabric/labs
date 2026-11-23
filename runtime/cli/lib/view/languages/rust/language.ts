import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createHighlighter,
  highlightLines,
  parseDocument,
  prepareGrammar,
} from "../treesitter/adapter.ts";
import { rustGrammar } from "./rust.ts";

/**
 * The Rust language for the pager. It provides lossless syntax highlighting
 * for direct files, diffs, and live edits, and a structure tree of items:
 * structures and unions and their named fields, enumerations and their
 * variants, traits, implementations, type aliases, modules, macros, functions,
 * methods, constants, and statics, including those declared directly in a
 * function body. Rust has no semantic layer.
 */
export const rustLanguage: Language = {
  id: "rust",

  commentLinesAreInert: true,

  docCommentsAreCode: true,

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".rs"],
    filenames: [],
    filenamePatterns: [],
    aliases: ["rs"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  prepare: () => prepareGrammar(rustGrammar),

  parseDocument: (text) => parseDocument(rustGrammar, text),

  highlightLines: (text) => highlightLines(rustGrammar, text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createHighlighter(rustGrammar, text),

  hunkStructure: (ctx) => remapStructure(ctx),
};
