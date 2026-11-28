/**
 * The `lean-toolchain` file of a Lean project, which names the Lean release
 * that Elan, Lean's toolchain manager, installs for the project. Its one line
 * is a channel, such as `stable` or `v4.26.0`, optionally after the repository
 * that publishes it and a `:`, as in `leanprover/lean4:v4.26.0`. The language
 * colors the repository as a type name and the channel as a string. It has no
 * structure tree and no semantic layer.
 */

import type { Line, TokenClass } from "../../model.ts";
import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { createRecoloringHighlighter, linesFromClasses } from "../classes.ts";

/** The toolchain name on the first line other than white space. */
const TOOLCHAIN = /^\s*(?:(?<origin>[^\s:]+)(?<colon>:))?(?<channel>\S*)/d;

/** Colors `text`, one display line per source line. */
function toolchainLines(text: string): Line[] {
  const classes = new Array<TokenClass | undefined>(text.length);
  const { origin, colon, channel } = TOOLCHAIN.exec(text)?.indices?.groups ??
    {};
  if (origin !== undefined) classes.fill("typeName", ...origin);
  if (colon !== undefined) classes.fill("punctuation", ...colon);
  if (channel !== undefined) classes.fill("string", ...channel);
  return linesFromClasses(text, classes);
}

export const leanToolchainLanguage: Language = {
  id: "lean-toolchain",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [],
    filenames: ["lean-toolchain"],
    filenamePatterns: [],
    aliases: [],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  parseDocument: (text) => ({
    text,
    lines: toolchainLines(text),
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  }),

  highlightLines: (text) => toolchainLines(text),

  createHighlighter: (text) =>
    createRecoloringHighlighter(text, toolchainLines),

  hunkStructure: () => [],
};
