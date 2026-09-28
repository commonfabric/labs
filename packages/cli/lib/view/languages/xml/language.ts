import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { xmlDocument, xmlLines } from "./xml.ts";

/**
 * The XML language for the pager, which covers Android manifests, resources,
 * and layouts, SVG images, and Apple property lists, entitlements, and privacy
 * manifests. It provides syntax highlighting for direct files, diffs, and live
 * edits, and a structure tree of elements. XML has no semantic layer.
 */
export const xmlLanguage: Language = {
  id: "xml",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [
      ".xml",
      ".svg",
      ".plist",
      ".entitlements",
      ".xcprivacy",
      ".xcworkspacedata",
    ],
    filenames: [],
    filenamePatterns: [],
    aliases: ["svg", "plist"],
    interpreters: [],
    sharedExtensions: [],
  },

  parseDocument: (text) => xmlDocument(text),

  highlightLines: (text) => xmlLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createRecoloringHighlighter(text, xmlLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
