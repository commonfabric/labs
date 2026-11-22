import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { dotenvDocument, dotenvLines } from "./dotenv.ts";

/** Source whose first line other than blank lines and comments sets a
 * variable, which is the evidence a `.env` file gives for dotenv. The name it
 * requires starts with a letter or an underscore and holds no punctuation
 * other than `.` and `-`, which is stricter than what the scanner colors as a
 * name. */
const ASSIGNMENT_FIRST =
  /^(?:[^\S\n]*(?:#[^\n]*)?\n)*[^\S\n]*(?:export[^\S\n]+)?[A-Za-z_][\w.-]*[^\S\n]*=/;

/**
 * The dotenv language for the pager, which covers the environment files that
 * programs, Docker Compose, and shell scripts read variables from, and the
 * example copies of them that projects commit. It provides syntax
 * highlighting for direct files, diffs, and live edits, and a structure tree
 * of the variables the file sets. It has no semantic layer.
 */
export const dotenvLanguage: Language = {
  id: "dotenv",

  commentLinesAreInert: true,

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [],
    filenames: [],
    filenamePatterns: [
      // `.env`, and the variants such as `.env.local` and `.env.example`.
      /^\.env(?:\..+)?$/i,
      // The example copy of a file such as `config.env` or `deploy-env`.
      /(?:^|[._-])env\.(?:example|sample|template|dist)$/i,
    ],
    aliases: [],
    interpreters: [],
    signatures: [],
    // Ansible Vault files and Skip's app configuration, which follows Xcode's
    // `//` comment syntax, also use `.env`.
    sharedExtensions: [{ extension: ".env", content: ASSIGNMENT_FIRST }],
  },

  parseDocument: (text) => dotenvDocument(text),

  highlightLines: (text) => dotenvLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createRecoloringHighlighter(text, dotenvLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
