import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createHighlighter,
  highlightLines,
  parseDocument,
  prepareGrammar,
} from "../treesitter/adapter.ts";
import { hclGrammar } from "./hcl.ts";

/**
 * The HCL language for the pager, which covers OpenTofu and Terraform
 * configuration, variable definitions files, backend configuration files, and
 * dependency lock files. It provides lossless syntax highlighting for direct
 * files, diffs, and live edits, and a structure tree of blocks and of the
 * attributes that define values, which are those at a file's top level and in
 * `locals` blocks. HCL has no semantic layer.
 */
export const hclLanguage: Language = {
  id: "hcl",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    // `.tofu` is a configuration file that OpenTofu reads in place of the
    // `.tf` file of the same name.
    extensions: [".tf", ".tofu", ".tfvars", ".tfbackend", ".hcl"],
    filenames: [],
    filenamePatterns: [],
    aliases: ["opentofu", "tofu", "terraform", "tf"],
    interpreters: [],
    signatures: [],
    sharedExtensions: [],
  },

  prepare: () => prepareGrammar(hclGrammar),

  parseDocument: (text) => parseDocument(hclGrammar, text),

  highlightLines: (text) => highlightLines(hclGrammar, text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) => createHighlighter(hclGrammar, text),

  hunkStructure: (ctx) => remapStructure(ctx),
};
