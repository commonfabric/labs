import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { iniDocument, iniLines } from "./ini.ts";

/** Source whose first line other than blank lines and comments heads a
 * section, which is the evidence a `.cfg` file gives for INI. A section name
 * does not start the way a JSON array's first value does. */
const SECTION_FIRST =
  /^(?:[^\S\n]*(?:[;#][^\n]*)?\n)*[^\S\n]*\[(?!(?:true|false|null)\s*[,\]])[^\s[\]{}"\d-]/;

/**
 * The INI language for the pager, which covers Ansible configuration and
 * inventories and the configuration files of Python tools. It provides syntax
 * highlighting for direct files, diffs, and live edits, and a structure tree
 * of sections and the keys each one sets. It has no semantic layer.
 */
export const iniLanguage: Language = {
  id: "ini",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".ini"],
    filenames: [
      "ansible.cfg",
      ".ansible.cfg",
      "setup.cfg",
      ".codespellrc",
      ".coveragerc",
      ".flake8",
      ".pylintrc",
      "pylintrc",
    ],
    filenamePatterns: [],
    aliases: ["dosini", "cfg"],
    interpreters: [],
    signatures: [],
    // JSON configuration, which opens with `{`, and TLC configuration, which
    // opens with a directive or a `\*` comment, also use `.cfg`.
    sharedExtensions: [{ extension: ".cfg", content: SECTION_FIRST }],
  },

  parseDocument: (text) => iniDocument(text),

  highlightLines: (text) => iniLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createRecoloringHighlighter(text, iniLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
