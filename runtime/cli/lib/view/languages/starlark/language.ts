import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createHighlighter,
  highlightLines,
  parseDocument,
  prepareGrammar,
} from "../treesitter/adapter.ts";
import { starlarkGrammar } from "./starlark.ts";

/**
 * The Starlark language for the pager, which covers Bazel's build files,
 * module and workspace files, and extension files. It provides lossless syntax
 * highlighting for direct files, diffs, and live edits, and a structure tree of
 * functions, of each single name assigned outside functions, and of the
 * targets that calls outside functions declare by a string `name` argument.
 * Starlark has no semantic layer.
 */
export const starlarkLanguage: Language = {
  id: "starlark",

  commentLinesAreInert: true,

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    // `.bazel` covers `BUILD.bazel`, `MODULE.bazel`, `REPO.bazel`, and
    // `WORKSPACE.bazel`.
    extensions: [".bzl", ".bazel", ".star"],
    filenames: ["BUILD", "WORKSPACE", "WORKSPACE.bzlmod"],
    // A build file that a Bazel repository rule adds to another repository,
    // such as `zlib.BUILD`. Meson's `meson.build` is not one.
    filenamePatterns: [/^.+\.BUILD$/],
    aliases: ["bazel", "bzl", "star"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  prepare: () => prepareGrammar(starlarkGrammar),

  parseDocument: (text) => parseDocument(starlarkGrammar, text),

  highlightLines: (text) => highlightLines(starlarkGrammar, text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createHighlighter(starlarkGrammar, text),

  hunkStructure: (ctx) => remapStructure(ctx),
};
