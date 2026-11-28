import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { orgDocument, orgLines } from "./org.ts";

/**
 * The Org mode language for the pager. It provides syntax highlighting for
 * direct files, diffs, and live edits, with each source block colored as the
 * language it names, and a structure tree of headlines. A source block's
 * language loads its parser when the block is first colored. Org has no
 * semantic layer.
 */
export const orgLanguage: Language = {
  id: "org",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".org"],
    filenames: [],
    filenamePatterns: [],
    aliases: ["orgmode"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: (text) => orgDocument(text),

  highlightLines: (text) => orgLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createRecoloringHighlighter(text, orgLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
