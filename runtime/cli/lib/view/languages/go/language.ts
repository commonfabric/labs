/**
 * The Go languages for the pager: Go source, on the shared Tree-sitter
 * adapter, and the module and checksum files the Go command reads, on focused
 * scanners.
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
import { createRecoloringHighlighter } from "../classes.ts";
import { goGrammar } from "./go.ts";
import { goModDocument, goModLines } from "./mod.ts";
import { goSumDocument, goSumLines } from "./sum.ts";

/**
 * The Go language for the pager. It provides lossless syntax highlighting for
 * direct files, diffs, and live edits, and a structure tree of the package
 * clause, types, functions, methods, package-level constants and variables,
 * and the fields and methods each type declares. Go has no semantic layer.
 */
export const goLanguage: Language = {
  id: "go",

  commentLinesAreInert: true,

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".go"],
    filenames: [],
    filenamePatterns: [],
    aliases: ["golang"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  prepare: () => prepareGrammar(goGrammar),

  parseDocument: (text) => parseDocument(goGrammar, text),

  highlightLines: (text) => highlightLines(goGrammar, text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createHighlighter(goGrammar, text),

  hunkStructure: (ctx) => remapStructure(ctx),
};

/**
 * Go module and workspace files, `go.mod` and `go.work`, for the pager. It
 * provides syntax highlighting for direct files, diffs, and live edits, and a
 * structure tree of directives and the lines of their blocks.
 */
export const goModLanguage: Language = {
  id: "go-mod",

  commentLinesAreInert: true,

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [],
    filenames: ["go.mod", "go.work"],
    filenamePatterns: [],
    aliases: ["gomod", "gowork"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: (text) => goModDocument(text),

  highlightLines: (text) => goModLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createRecoloringHighlighter(text, goModLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};

/**
 * Go checksum files, `go.sum` and `go.work.sum`, for the pager. It provides
 * syntax highlighting for direct files, diffs, and live edits, and a structure
 * tree of the modules the file holds hashes for.
 */
export const goSumLanguage: Language = {
  id: "go-sum",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [],
    filenames: ["go.sum", "go.work.sum"],
    filenamePatterns: [],
    aliases: ["gosum"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: (text) => goSumDocument(text),

  highlightLines: (text) => goSumLines(text),

  createHighlighter: (text) => createRecoloringHighlighter(text, goSumLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
