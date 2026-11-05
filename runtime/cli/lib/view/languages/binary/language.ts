import type { Language } from "../language.ts";
import { rawBytesDecoder, Utf8BinaryProbe } from "../decoder.ts";
import {
  createPlainTextHighlighter,
  plainTextLines,
} from "../plain-text/plain-text.ts";
import type { Document } from "../../model.ts";
import {
  binaryLineCount,
  binaryLinesFrom,
  MAX_BINARY_VIEW_BYTES,
  renderBinaryLines,
} from "./binary.ts";

const BINARY_EXTENSIONS = [
  ".bin",
  ".db",
  ".db-shm",
  ".db-wal",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".sqlite",
  ".sqlite-shm",
  ".sqlite-wal",
  ".sqlite3",
  ".sqlite3-shm",
  ".sqlite3-wal",
  ".tar",
  ".tgz",
  ".ttf",
  ".webm",
  ".woff",
  ".woff2",
  ".zst",
  ".zstd",
] as const;

const READ_ONLY_REASON =
  "Binary data is shown as a hex dump and cannot be edited.";

export const binaryLanguage: Language = {
  id: "binary",

  input: {
    kind: "bytes",
    decoder: rawBytesDecoder,
    readOnlyReason: READ_ONLY_REASON,
    createDetector: () => new Utf8BinaryProbe(),
    previewByteLimit: MAX_BINARY_VIEW_BYTES,
    renderLines: (raw, extent) => renderBinaryLines(raw, extent),
    renderByteStream: binaryLinesFrom,
    renderedByteLineCount: binaryLineCount,
  },

  metadata: {
    extensions: BINARY_EXTENSIONS,
    filenames: [],
    filenamePatterns: [],
    aliases: ["bytes"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: binarySourceDocument,

  highlightLines: (raw) => plainTextLines(raw),

  renderLineTopology: "independent",

  defaultViewMode: "rendered",

  allowsEmptyInput: true,

  createHighlighter: (raw) => createPlainTextHighlighter(raw),

  hunkStructure: () => [],
};

/** Retain opaque bytes without allocating source rows. */
function binarySourceDocument(raw: string): Document {
  return {
    text: raw,
    lines: [],
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  };
}
