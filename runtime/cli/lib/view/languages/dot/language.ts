import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { dotDocument, dotLines } from "./dot.ts";

/**
 * The Graphviz DOT language for the pager. It provides syntax highlighting for
 * direct files, diffs, and live edits, and a structure tree of graphs,
 * subgraphs, and the nodes that node statements declare. It has no semantic
 * layer.
 */
export const dotLanguage: Language = {
  id: "dot",

  commentLinesAreInert: true,

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".dot", ".gv"],
    filenames: [],
    filenamePatterns: [],
    aliases: ["graphviz", "gv"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: (text) => dotDocument(text),

  highlightLines: (text) => dotLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createRecoloringHighlighter(text, dotLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
