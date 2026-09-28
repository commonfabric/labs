import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createHighlighter,
  highlightLines,
  parseDocument,
  prepareGrammar,
} from "../treesitter/adapter.ts";
import { tomlGrammar } from "./toml.ts";

/**
 * The TOML language for the pager, which covers Gradle version catalogs,
 * Cargo manifests and lock files, and tool configuration. It provides lossless
 * syntax highlighting for direct files, diffs, and live edits, and a structure
 * tree of tables and the keys they set. TOML has no semantic layer.
 */
export const tomlLanguage: Language = {
  id: "toml",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".toml"],
    filenames: ["Cargo.lock"],
    filenamePatterns: [],
    aliases: [],
    interpreters: [],
    sharedExtensions: [],
  },

  prepare: () => prepareGrammar(tomlGrammar),

  parseDocument: (text) => parseDocument(tomlGrammar, text),

  highlightLines: (text) => highlightLines(tomlGrammar, text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createHighlighter(tomlGrammar, text),

  hunkStructure: (ctx) => remapStructure(ctx),
};
