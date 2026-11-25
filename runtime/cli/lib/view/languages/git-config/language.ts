import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { gitConfigDocument, gitConfigLines } from "./gitconfig.ts";

/**
 * The Git configuration language for the pager, which covers `.gitmodules`,
 * user and system Git configuration, the configuration of one worktree, other
 * files whose names end in `.gitconfig`, and Git LFS configuration. It provides
 * syntax highlighting for direct files, diffs, and live edits, and a structure
 * tree of sections and the variables each one sets. It has no semantic layer.
 */
export const gitConfigLanguage: Language = {
  id: "git-config",

  commentLinesAreInert: true,

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".gitconfig"],
    filenames: [".gitmodules", "gitconfig", "config.worktree", ".lfsconfig"],
    filenamePatterns: [],
    aliases: ["gitconfig", "gitmodules"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: (text) => gitConfigDocument(text),

  highlightLines: (text) => gitConfigLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) =>
    createRecoloringHighlighter(text, gitConfigLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
