import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { firstContentLineMatches } from "../evidence.ts";
import { systemdDocument, systemdLines } from "./systemd.ts";

/** Source whose first line other than blank lines and comments heads one of
 * the sections a unit file holds, which is the evidence a `.conf` drop-in
 * gives for a unit. */
const UNIT_SECTION_FIRST = firstContentLineMatches(
  "#;",
  /[ \t]*\[(?:Unit|Install|Service|Socket|Timer|Mount|Automount|Swap|Path|Slice|Scope)\]/,
);

/**
 * The systemd unit language for the pager. It provides syntax highlighting for
 * direct files, diffs, and live edits, and a structure tree of sections and
 * the keys each one sets. It has no semantic layer.
 */
export const systemdLanguage: Language = {
  id: "systemd",

  commentLinesAreInert: true,

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    // The unit types that are written as unit files. Device units come from
    // udev, and scope units are created through systemd's bus interface.
    extensions: [
      ".service",
      ".socket",
      ".timer",
      ".target",
      ".mount",
      ".automount",
      ".swap",
      ".path",
      ".slice",
    ],
    filenames: [],
    filenamePatterns: [],
    aliases: ["systemd-unit"],
    interpreters: [],
    signatures: [],
    // A drop-in that adds to or overrides a unit's settings is a `.conf` file,
    // a suffix that INI, tmpfiles, and directive configuration also use.
    sharedExtensions: [{ extension: ".conf", content: UNIT_SECTION_FIRST }],
  },

  parseDocument: (text) => systemdDocument(text),

  highlightLines: (text) => systemdLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createRecoloringHighlighter(text, systemdLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
