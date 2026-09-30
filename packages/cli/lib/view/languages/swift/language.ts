import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createHighlighter,
  highlightLines,
  parseDocument,
  prepareGrammar,
} from "../treesitter/adapter.ts";
import { swiftGrammar } from "./swift.ts";

/**
 * The Swift language for the pager. It provides lossless syntax highlighting
 * for direct files, diffs, and live edits, and a structure tree of types,
 * functions, initializers, and properties. Swift has no semantic layer.
 */
export const swiftLanguage: Language = {
  id: "swift",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    // Package manifests, including the `Package@swift-5.9.swift` form that
    // targets one compiler version, are Swift source under this extension. A
    // module's textual interface is Swift declarations.
    extensions: [".swift", ".swiftinterface"],
    filenames: [],
    filenamePatterns: [],
    aliases: [],
    interpreters: [
      "swift",
      // `xcrun swift` runs the shebang's own file with the selected
      // toolchain's Swift. The launcher runs other tools too, so the word after
      // it is part of the claim.
      ["xcrun", "swift"],
    ],
    sharedExtensions: [],
  },

  prepare: () => prepareGrammar(swiftGrammar),

  parseDocument: (text) => parseDocument(swiftGrammar, text),

  highlightLines: (text) => highlightLines(swiftGrammar, text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createHighlighter(swiftGrammar, text),

  hunkStructure: (ctx) => remapStructure(ctx),
};
