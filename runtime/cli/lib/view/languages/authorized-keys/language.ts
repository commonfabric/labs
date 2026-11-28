import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import {
  authorizedKeysDocument,
  authorizedKeysLines,
} from "./authorized-keys.ts";

/**
 * The OpenSSH authorized keys language for the pager, which also covers
 * public key files. It provides syntax highlighting for direct files, diffs,
 * and live edits, and a structure tree of the keys the file lists, each named
 * by its comment. It has no semantic layer.
 */
export const authorizedKeysLanguage: Language = {
  id: "authorized-keys",

  commentLinesAreInert: true,

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".pub"],
    filenames: ["authorized_keys", "authorized_keys2"],
    filenamePatterns: [/[_.-]authorized_keys2?$/],
    aliases: ["ssh-authorized-keys", "ssh-public-key"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: (text) => authorizedKeysDocument(text),

  highlightLines: (text) => authorizedKeysLines(text),

  createHighlighter: (text) =>
    createRecoloringHighlighter(text, authorizedKeysLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
