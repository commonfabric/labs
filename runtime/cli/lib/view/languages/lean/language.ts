import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { leanDocument, leanLines } from "./lean.ts";

/**
 * The Lean 4 language for the pager. It provides syntax highlighting for
 * direct files, diffs, and live edits, and a structure tree of namespaces,
 * sections, and declarations. It has no semantic layer.
 */
export const leanLanguage: Language = {
  id: "lean",

  commentLinesAreInert: true,

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".lean"],
    filenames: [],
    filenamePatterns: [],
    aliases: ["lean4"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: (text) => leanDocument(text),

  highlightLines: (text) => leanLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createRecoloringHighlighter(text, leanLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
