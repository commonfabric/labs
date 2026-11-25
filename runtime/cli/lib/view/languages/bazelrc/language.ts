import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { bazelrcDocument, bazelrcLines } from "./bazelrc.ts";

/**
 * The language of Bazel's rc files, which set the options each Bazel command
 * runs with. It provides syntax highlighting for direct files, diffs, and live
 * edits, and a structure tree of the files a file imports and the
 * configurations it defines. It has no semantic layer.
 */
export const bazelrcLanguage: Language = {
  id: "bazelrc",

  commentLinesAreInert: true,

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    // `.bazelrc` itself, and named rc files such as `user.bazelrc`.
    extensions: [".bazelrc"],
    filenames: [],
    filenamePatterns: [],
    aliases: [],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: (text) => bazelrcDocument(text),

  highlightLines: (text) => bazelrcLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createRecoloringHighlighter(text, bazelrcLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
