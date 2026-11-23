import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import {
  createHighlighter,
  highlightLines,
  parseDocument,
  prepareGrammar,
  type TreeSitterGrammar,
} from "../treesitter/adapter.ts";
import { cGrammar, cppGrammar } from "./c-family.ts";

/** A C-family language: its names, and the grammar that parses it. */
function cFamilyLanguage(
  id: string,
  grammar: TreeSitterGrammar,
  extensions: readonly string[],
  aliases: readonly string[],
  filenamePatterns: readonly RegExp[] = [],
): Language {
  return {
    id,
    commentLinesAreInert: true,
    input: { kind: "text", decoder: utf8Decoder },
    metadata: {
      extensions,
      filenames: [],
      filenamePatterns,
      aliases,
      interpreters: [],
      signatures: [],
      sharedExtensions: [],
    },
    prepare: () => prepareGrammar(grammar),
    parseDocument: (text) => parseDocument(grammar, text),
    highlightLines: (text) => highlightLines(grammar, text),
    highlightFullFileOnDiffEdit: true,
    createHighlighter: (text) => createHighlighter(grammar, text),
    hunkStructure: (ctx) => remapStructure(ctx),
  };
}

/**
 * C for the pager, with lossless syntax highlighting for direct files, diffs,
 * and live edits, and a structure tree of functions, file-level declarations,
 * named types, type aliases, and macros.
 */
export const cLanguage: Language = cFamilyLanguage("c", cGrammar, [], [], [
  // Extensions compare without case, and an uppercase `.C` is C++.
  /\.c$/,
]);

/**
 * C++ for the pager, as C is, with classes, namespaces, and `using` aliases in
 * its structure tree as well. `.tcc` holds template definitions that a header
 * includes, and an uppercase `.C` is C++ source, as compilers read it.
 */
export const cppLanguage: Language = cFamilyLanguage(
  "cpp",
  cppGrammar,
  [
    ".cc",
    ".cxx",
    ".cpp",
    ".c++",
    ".hh",
    ".hxx",
    ".hpp",
    ".h++",
    ".tcc",
  ],
  ["c++", "cxx"],
  [/\.C$/],
);

/** CUDA C++ for the pager, on the C++ language's grammar and query, which
 * color CUDA's qualifiers as keywords. */
export const cudaLanguage: Language = cFamilyLanguage(
  "cuda",
  cppGrammar,
  [".cu", ".cuh"],
  [],
);

/**
 * A `.h` header, which C and C++ both write, in a mode that claims neither
 * dialect. It parses with the C++ grammar, which reads the declarations C
 * headers usually make as well as C++'s, but not C that uses one of C++'s
 * keywords as a name. An explicit `c` or `cpp` language names a header's
 * dialect.
 */
export const cFamilyHeaderLanguage: Language = cFamilyLanguage(
  "c-family-header",
  cppGrammar,
  [".h"],
  ["h"],
);
