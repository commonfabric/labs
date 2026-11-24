import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { gitAttributesDocument, gitAttributesLines } from "./gitattributes.ts";

/**
 * The Git attributes language for the pager, which covers the `.gitattributes`
 * files that give paths in a repository their attributes. It provides syntax
 * highlighting for direct files, diffs, and live edits, and a structure tree
 * of the file's patterns and macro definitions. It has no semantic layer.
 */
export const gitAttributesLanguage: Language = {
  id: "gitattributes",

  commentLinesAreInert: true,

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [],
    filenames: [".gitattributes"],
    filenamePatterns: [],
    aliases: [],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: (text) => gitAttributesDocument(text),

  highlightLines: (text) => gitAttributesLines(text),

  createHighlighter: (text) =>
    createRecoloringHighlighter(text, gitAttributesLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
