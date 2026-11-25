import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { sqlDocument, sqlLines } from "./sql.ts";

/**
 * The SQL language for the pager, which covers the PostgreSQL, SQLite, and
 * MySQL scripts that schema migrations and tests run. It provides syntax
 * highlighting for direct files, diffs, and live edits, with a PostgreSQL
 * function's or block's dollar-quoted body colored as SQL, and a structure tree
 * of the statements that create things or alter tables, with the columns each
 * defines. It has no semantic layer.
 */
export const sqlLanguage: Language = {
  id: "sql",

  commentLinesAreInert: true,

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".sql"],
    filenames: [],
    filenamePatterns: [],
    aliases: [],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: (text) => sqlDocument(text),

  highlightLines: (text) => sqlLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createRecoloringHighlighter(text, sqlLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
