import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { shellGrammar } from "../shell/shell.ts";
import { prepareGrammar } from "../treesitter/adapter.ts";
import { makeDocument, makeLines } from "./make.ts";

/**
 * The makefile language for the pager, which reads GNU make's syntax. It
 * provides syntax highlighting for direct files, diffs, and live edits, with
 * recipes and the other commands make hands to the shell colored as shell, and
 * a structure tree of the targets and variables the file defines. Programs
 * whose shebang runs `make` select it. It has no semantic layer.
 */
export const makeLanguage: Language = {
  id: "make",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".mk"],
    filenames: ["Makefile", "makefile", "GNUmakefile"],
    filenamePatterns: [],
    aliases: ["makefile", "mk"],
    interpreters: ["make", "gmake"],
    signatures: [],
    sharedExtensions: [],
  },

  prepare: () => prepareGrammar(shellGrammar),

  parseDocument: (text) => makeDocument(text),

  highlightLines: (text) => makeLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createRecoloringHighlighter(text, makeLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
