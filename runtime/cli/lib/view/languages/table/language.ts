/**
 * The comma-separated, tab-separated, and numeric `.dat` table languages for
 * the pager. Coloring lives in {@link ./table.ts}; this module gives each
 * family its dialect and adapts it to the {@link Language} contract. They
 * provide syntax highlighting for direct files, diffs, and live edits. They
 * have no structure tree and no semantic layer.
 */

import type { Language, LanguageMetadata } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import {
  readsAsNumber,
  type TableDialect,
  tableDocument,
  tableLines,
} from "./table.ts";

/** RFC 4180: comma-separated fields, any of which may be quoted. */
const CSV: TableDialect = { separator: ",", quoted: true, commentStarts: "" };

/** Tab-separated fields, which cannot hold a tab or a line break, so they are
 * never quoted. A line that starts with `#` is a comment. */
const TSV: TableDialect = {
  separator: "\t",
  quoted: false,
  commentStarts: "#",
};

/** The data files gnuplot and PGFPlots read: fields separated by spaces and
 * tabs, and comment lines that start with `#` or `%`. */
const DAT: TableDialect = { quoted: false, commentStarts: "#%" };

/**
 * Whether the first line of `text` other than blank lines and comments, or the
 * next such line, is a row of two or more numbers, read as the `.dat` dialect
 * reads a record. That is the evidence a `.dat` file gives for a numeric
 * table: `.dat` names data of every kind, and a single number is as likely to
 * be a counter or a process identifier.
 */
function opensWithNumericRow(text: string): boolean {
  const isSpace = (at: number) => text[at] === " " || text[at] === "\t";
  let contentLines = 0;
  for (let at = 0; at < text.length && contentLines < 2;) {
    const lineFeed = text.indexOf("\n", at);
    const end = lineFeed < 0 ? text.length : lineFeed;
    const lineEnd = text[end - 1] === "\r" ? end - 1 : end;
    while (at < lineEnd && isSpace(at)) at++;
    if (at === lineEnd || DAT.commentStarts.includes(text[at])) {
      at = end + 1;
      continue;
    }
    contentLines++;
    let numbers = 0;
    for (let field = at; field < lineEnd; numbers++) {
      while (at < lineEnd && !isSpace(at)) at++;
      if (!readsAsNumber(text.slice(field, at))) {
        numbers = 0;
        break;
      }
      while (at < lineEnd && isSpace(at)) at++;
      field = at;
    }
    if (numbers >= 2) return true;
    at = end + 1;
  }
  return false;
}

/** The parts of a language that differ between the table families. */
function tableLanguage(
  id: string,
  dialect: TableDialect,
  commentLinesAreInert: boolean,
  metadata: Partial<LanguageMetadata>,
): Language {
  const color = (text: string) => tableLines(text, dialect);
  return {
    id,

    commentLinesAreInert,

    input: { kind: "text", decoder: utf8Decoder },

    metadata: {
      extensions: [],
      filenames: [],
      filenamePatterns: [],
      aliases: [],
      interpreters: [],
      signatures: [],
      sharedExtensions: [],
      ...metadata,
    },

    parseDocument: (text) => tableDocument(text, dialect),

    highlightLines: color,

    // A quoted field can span lines, so an earlier line can decide how a later
    // one is read.
    highlightFullFileOnDiffEdit: dialect.quoted,

    createHighlighter: (text) => createRecoloringHighlighter(text, color),

    hunkStructure: () => [],
  };
}

export const csvLanguage: Language = tableLanguage("csv", CSV, false, {
  extensions: [".csv"],
});

// The format defines no comments, so a line that starts with `#` can be a row
// of data, and a diff counts it.
export const tsvLanguage: Language = tableLanguage("tsv", TSV, false, {
  extensions: [".tsv"],
});

export const datLanguage: Language = tableLanguage("dat", DAT, true, {
  sharedExtensions: [{ extension: ".dat", content: opensWithNumericRow }],
});
