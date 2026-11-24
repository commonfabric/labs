import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { shellGrammar } from "../shell/shell.ts";
import { prepareGrammar } from "../treesitter/adapter.ts";
import { dockerfileDocument, dockerfileLines } from "./dockerfile.ts";

/**
 * The Dockerfile language for the pager, which reads the syntax of BuildKit's
 * Dockerfile frontend. It provides syntax highlighting for direct files,
 * diffs, and live edits, with the shell form of commands colored as shell, and
 * a structure tree of build stages and the variables they set. It has no
 * semantic layer.
 *
 * `Dockerfile.x86_64` and other names that add a dot and a suffix to
 * `Dockerfile` or `Containerfile`, in any case, select it, apart from the ignore files that
 * BuildKit pairs with such names, such as `Dockerfile.build.dockerignore`, and
 * names whose last suffix is an extension that another language claims.
 */
export const dockerfileLanguage: Language = {
  id: "dockerfile",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".dockerfile", ".containerfile"],
    filenames: ["Dockerfile", "dockerfile", "Containerfile", "containerfile"],
    filenamePatterns: [
      /^(?:Dockerfile|Containerfile)(?!.*\.(?:docker|container)ignore$)\../i,
    ],
    aliases: ["docker", "containerfile"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  prepare: () => prepareGrammar(shellGrammar),

  parseDocument: (text) => dockerfileDocument(text),

  highlightLines: (text) => dockerfileLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) =>
    createRecoloringHighlighter(text, dockerfileLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
