/**
 * The YAML language for the pager. It provides syntax highlighting for direct
 * files, diffs, and live edits. YAML does not provide structure navigation or
 * a semantic layer.
 */

import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { firstContentLineMatches } from "../evidence.ts";
import {
  createYamlHighlighter,
  yamlDocument,
  yamlHighlightLines,
} from "./yaml.ts";

/**
 * The evidence a `.conf` file gives for YAML, as a Netdata collector's
 * configuration does: it does not open with a shebang, and its first line
 * other than blank lines and comments is a
 * document marker, or a key with no value on its line followed by an indented
 * line or by a sequence entry. Directive configuration, whose keys hold a value
 * on their own line, and INI, systemd, sysusers.d, and tmpfiles.d
 * configuration open in neither way.
 */
const YAML_LINE = firstContentLineMatches(
  "#",
  /(?:---[^\S\n]*(?:#[^\n]*)?(?:\n|$)|[A-Za-z_][\w.-]*:[^\S\n]*(?:#[^\n]*)?\n(?:[^\S\n]+\S|-[^\S\n]))/,
);

export const yamlLanguage: Language = {
  id: "yaml",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".yaml", ".yml"],
    filenames: [],
    filenamePatterns: [],
    aliases: ["yml"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [{
      extension: ".conf",
      content: (text) => !text.startsWith("#!") && YAML_LINE(text),
    }],
  },

  parseDocument: (text) => yamlDocument(text),

  highlightLines: (text) => yamlHighlightLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createYamlHighlighter(text),

  hunkStructure: () => [],
};
