import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { propertiesDocument, propertiesLines } from "./properties.ts";

/**
 * The Java properties language for the pager, which covers Gradle's
 * `gradle.properties` and wrapper settings. It provides syntax highlighting
 * for direct files, diffs, and live edits, and a structure tree of the keys
 * the file sets. It has no semantic layer.
 */
export const propertiesLanguage: Language = {
  id: "properties",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".properties"],
    filenames: [],
    filenamePatterns: [],
    aliases: ["java-properties"],
    interpreters: [],
    sharedExtensions: [],
  },

  parseDocument: (text) => propertiesDocument(text),

  highlightLines: (text) => propertiesLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) =>
    createRecoloringHighlighter(text, propertiesLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
