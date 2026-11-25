/**
 * The JSON, JSONC, and JSON Lines languages for the pager. Coloring and
 * structure live in {@link ./json.ts}; this module adapts them to the
 * {@link Language} contract. JSON Lines uses the same tokenizer with fresh
 * lexical state for each record.
 *
 * The JSON language also claims the surveyed JSON-shaped names that no `.json`
 * suffix announces: web manifests, TLDraw documents, Deno lock files, editor
 * workspace files, Swift package resolutions and their per-platform copies,
 * Xcode string catalogs, CPU profiles, Firebase project aliases, and the
 * `.cfg`, `.conf`, `.config`, and `.lock` files whose source shows a JSON
 * object.
 *
 * JSON has no semantic layer (no types or cross-file definitions to resolve),
 * so it omits `createSemantics`/`createDiffSemantics`. A single JSON or JSONC
 * value contributes a node tree of object keys. One-record JSON Lines input
 * can contribute the same structure, while multi-record input has no
 * cross-record structure. Diff-hunk navigation reuses the generic
 * {@link remapStructure} the TypeScript language also uses.
 */

import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createJsonHighlighter,
  createJsonLinesHighlighter,
  jsonDocument,
  jsonHighlightLines,
  jsonLinesDocument,
  jsonLinesHighlightLines,
} from "./json.ts";

/**
 * Whether `text` opens a JSON object, which is the evidence a `.cfg`, `.conf`,
 * `.config`, or `.lock` file gives for JSON. TLC configuration opens with a
 * directive or a `\*` comment, an INI section header opens with `[`, XML opens
 * with `<`, and a lock record with no syntax of its own is often empty, so only
 * an opening brace selects JSON.
 */
function opensWithObject(text: string): boolean {
  return /^\s*\{/.test(text);
}

export const jsonLanguage: Language = {
  id: "json",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [
      ".json",
      ".jsonc",
      ".webmanifest",
      ".tldr",
      ".code-workspace",
      ".xcstrings",
      ".cpuprofile",
    ],
    filenames: ["deno.lock", "Package.resolved", ".firebaserc"],
    filenamePatterns: [/\.jsonc?\.example$/i, /^Package\.resolved\.[\w-]+$/],
    aliases: ["jsonc"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [
      { extension: ".cfg", content: opensWithObject },
      { extension: ".config", content: opensWithObject },
      { extension: ".conf", content: opensWithObject },
      { extension: ".lock", content: opensWithObject },
    ],
  },

  parseDocument: (text) => jsonDocument(text),

  highlightLines: (text) => jsonHighlightLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createJsonHighlighter(text),

  hunkStructure: (ctx) => remapStructure(ctx),
};

/** JSON Lines and NDJSON with lexical state isolated to each record. */
export const jsonLinesLanguage: Language = {
  id: "json-lines",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".jsonl", ".ndjson"],
    filenames: [],
    filenamePatterns: [],
    aliases: ["jsonl", "ndjson"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: (text) => jsonLinesDocument(text),

  highlightLines: (text) => jsonLinesHighlightLines(text),

  createHighlighter: (text) => createJsonLinesHighlighter(text),

  hunkStructure: (ctx) => remapStructure(ctx),
};
