import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createHighlighter,
  highlightLines,
  parseDocument,
  prepareGrammar,
} from "../treesitter/adapter.ts";
import { kotlinGrammar } from "./kotlin.ts";

/**
 * The Kotlin language for the pager. It provides lossless syntax highlighting
 * for direct files, diffs, and live edits, and a structure tree of types,
 * objects, functions, constructors, and properties. Kotlin has no semantic
 * layer.
 */
export const kotlinLanguage: Language = {
  id: "kotlin",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    // Gradle build and settings scripts, such as `build.gradle.kts`, are
    // Kotlin scripts under the `.kts` extension.
    extensions: [".kt", ".kts"],
    filenames: [],
    filenamePatterns: [],
    aliases: ["kt"],
    interpreters: ["kotlin"],
    sharedExtensions: [],
  },

  prepare: () => prepareGrammar(kotlinGrammar),

  parseDocument: (text) => parseDocument(kotlinGrammar, text),

  highlightLines: (text) => highlightLines(kotlinGrammar, text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createHighlighter(kotlinGrammar, text),

  hunkStructure: (ctx) => remapStructure(ctx),
};
