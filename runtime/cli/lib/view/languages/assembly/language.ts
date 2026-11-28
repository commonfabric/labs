import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { assemblyDocument, assemblyLines } from "./assembly.ts";

/**
 * The assembly language for the pager, which covers the Go assembler's source
 * and GNU assembler source run through the C preprocessor. It provides syntax
 * highlighting for direct files, diffs, and live edits, and a structure tree
 * of functions, symbols, macros, and labels. It has no semantic layer.
 */
export const assemblyLanguage: Language = {
  id: "assembly",

  commentLinesAreInert: true,

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [],
    filenames: [],
    // `.S` is the suffix of source the C preprocessor reads first. A linker
    // script that it reads first is named `.lds.S`.
    filenamePatterns: [/\.s$(?<!\.lds\.s)/i],
    aliases: ["asm"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: (text) => assemblyDocument(text),

  highlightLines: (text) => assemblyLines(text),

  // A block comment can span lines.
  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createRecoloringHighlighter(text, assemblyLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
