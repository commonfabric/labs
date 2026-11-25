import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { linkerScriptDocument, linkerScriptLines } from "./linker-script.ts";

/**
 * The GNU linker script language for the pager, which covers the scripts
 * that lay out a kernel, a virtual dynamic shared object, or other binary
 * whose layout `ld`'s default script does not give. It provides syntax
 * highlighting for direct files, diffs, and live edits, and a structure tree
 * of the `SECTIONS`, `MEMORY`, `PHDRS`, and `VERSION` blocks, what each one
 * declares, and the symbols the script assigns. It has no semantic layer.
 */
export const linkerScriptLanguage: Language = {
  id: "linker-script",

  commentLinesAreInert: true,

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    // `.lds.S` and `.ld.S` name scripts run through the C preprocessor first.
    // Assembly source also ends in `.S`, so this language comes ahead of any
    // language that claims it.
    extensions: [".ld", ".lds", ".lds.S", ".ld.S"],
    filenames: [],
    filenamePatterns: [],
    aliases: ["ld", "lds", "linkerscript"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: (text, fileName) => linkerScriptDocument(text, fileName),

  highlightLines: (text, fileName) => linkerScriptLines(text, fileName),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text, fileName) =>
    createRecoloringHighlighter(
      text,
      (next) => linkerScriptLines(next, fileName),
    ),

  hunkStructure: (ctx) => remapStructure(ctx),
};
