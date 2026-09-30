import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createHighlighter,
  highlightLines,
  parseDocument,
  prepareGrammar,
} from "../treesitter/adapter.ts";
import { shellGrammar } from "./shell.ts";

/**
 * The shell language for the pager, which covers Bash and POSIX shell with
 * one grammar, since POSIX shell's syntax is a subset of what that grammar
 * parses. It provides lossless syntax highlighting for direct files, diffs,
 * and live edits, and a structure tree of functions. Git hooks, container
 * entry points, and other extensionless programs select it through their
 * shebang. Shell has no semantic layer.
 */
export const shellLanguage: Language = {
  id: "shell",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    // `.command` is a shell script that the macOS Finder opens in Terminal.
    extensions: [".sh", ".bash", ".command"],
    filenames: [
      ".bashrc",
      ".bash_profile",
      ".bash_login",
      ".bash_logout",
      ".profile",
    ],
    filenamePatterns: [],
    aliases: ["sh", "bash"],
    interpreters: ["sh", "bash", "dash", "ash"],
    sharedExtensions: [],
  },

  prepare: () => prepareGrammar(shellGrammar),

  parseDocument: (text) => parseDocument(shellGrammar, text),

  highlightLines: (text) => highlightLines(shellGrammar, text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createHighlighter(shellGrammar, text),

  hunkStructure: (ctx) => remapStructure(ctx),
};
