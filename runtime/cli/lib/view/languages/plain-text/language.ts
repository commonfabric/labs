/**
 * The plain-text language for input whose syntax `cf view` cannot select from
 * a filename, a shebang, or a signature such as an XML declaration. It remains
 * last in the language registry and is the registry's fallback.
 */

import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import {
  createPlainTextHighlighter,
  plainTextDocument,
  plainTextLines,
} from "./plain-text.ts";

export const plainTextLanguage: Language = {
  id: "plain-text",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".txt"],
    filenames: ["LICENSE", "NOTICE"],
    filenamePatterns: [/^(?:LICENSE|NOTICE)\..+$/i],
    aliases: ["text", "plaintext"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: (text) => plainTextDocument(text),

  highlightLines: (text) => plainTextLines(text),

  createHighlighter: (text) => createPlainTextHighlighter(text),

  hunkStructure: () => [],
};
