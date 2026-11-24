/**
 * The plain-text language for input whose syntax `cf view` cannot select from a
 * filename, a shebang, or a signature such as an XML declaration. It remains
 * last in the language registry and is the registry's fallback.
 *
 * It also claims, by name, the files that hold prose, logs, captured output,
 * checksums, versions, process and port records, and SSH host keys, keys, and
 * certificates, so that content that happens to start with a shebang or an XML
 * declaration does not select another language. It claims logs and captured
 * error output only when they do not open with a JSON object.
 */

import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import {
  createPlainTextHighlighter,
  plainTextDocument,
  plainTextLines,
} from "./plain-text.ts";

/** Whether the first character of `text` other than white space does not open
 * a JSON object. */
function opensWithoutObject(text: string): boolean {
  return !/^\s*\{/.test(text);
}

export const plainTextLanguage: Language = {
  id: "plain-text",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [
      ".txt",
      ".stdout",
      ".out",
      ".sha256",
      ".sha512",
      ".pid",
      ".pids",
      ".port",
      ".pem",
      ".crt",
      ".key",
      ".gitkeep",
      ".nojekyll",
    ],
    filenames: [
      "LICENSE",
      "NOTICE",
      "AUTHORS",
      "CONTRIBUTORS",
      "COPYING",
      "CNAME",
      ".nvmrc",
      "protocol-version",
      "known_hosts",
      "ssh_known_hosts",
      "github-known-hosts",
      // The version of Bazel a repository builds with.
      ".bazelversion",
    ],
    filenamePatterns: [
      /^(?:LICENSE|NOTICE)\..+$/i,
      /^(?:\w+_)?(?:SHA\d+|MD5)SUMS$/i,
      /^(?:[A-Z\d]+_)*VERSION$/,
      /^\.[a-z]+-version$/,
    ],
    aliases: ["text", "plaintext"],
    interpreters: [],
    signatures: [],
    // Structured logs whose records are JSON objects use these extensions too.
    sharedExtensions: [
      { extension: ".log", content: opensWithoutObject },
      { extension: ".stderr", content: opensWithoutObject },
    ],
  },

  parseDocument: (text) => plainTextDocument(text),

  highlightLines: (text) => plainTextLines(text),

  createHighlighter: (text) => createPlainTextHighlighter(text),

  hunkStructure: () => [],
};
