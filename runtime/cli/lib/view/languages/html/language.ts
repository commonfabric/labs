import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createHighlighter,
  highlightLines,
  parseDocument,
  prepareGrammar,
} from "../treesitter/adapter.ts";
import { htmlGrammar } from "./html.ts";

/**
 * The HTML language for the pager. It provides lossless syntax highlighting
 * for direct files, diffs, and live edits, with scripts colored as JavaScript
 * or JSON and style sheets as CSS, and a structure tree of elements. HTML has
 * no semantic layer.
 */
export const htmlLanguage: Language = {
  id: "html",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".html", ".htm"],
    filenames: [],
    filenamePatterns: [],
    aliases: [],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  prepare: () => prepareGrammar(htmlGrammar),

  parseDocument: (text) => parseDocument(htmlGrammar, text),

  highlightLines: (text) => highlightLines(htmlGrammar, text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createHighlighter(htmlGrammar, text),

  hunkStructure: (ctx) => remapStructure(ctx),
};
