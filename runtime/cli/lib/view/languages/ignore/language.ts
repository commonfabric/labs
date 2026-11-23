/**
 * The ignore-file languages for the pager, one for each way of reading the
 * lines: Git's, which also covers `.denoignore` and Claude Code's
 * `.worktreeinclude`, both written in Git's syntax; Docker's, which Podman's
 * `.containerignore` shares; and Bazel's. Each provides syntax highlighting
 * for direct files, diffs, and live edits. None has a structure tree or a
 * semantic layer.
 */

import type { Language, LanguageMetadata } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { type IgnoreDialect, ignoreDocument, ignoreLines } from "./ignore.ts";

/** Builds the language that reads ignore files in `dialect`. */
function ignoreLanguage(
  id: string,
  dialect: IgnoreDialect,
  names: Pick<LanguageMetadata, "extensions" | "filenames">,
): Language {
  const lines = (text: string) => ignoreLines(text, dialect);
  return {
    id,
    commentLinesAreInert: true,
    input: { kind: "text", decoder: utf8Decoder },
    metadata: {
      ...names,
      filenamePatterns: [],
      aliases: [],
      interpreters: [],
      signatures: [],
      sharedExtensions: [],
    },
    parseDocument: (text) => ignoreDocument(text, dialect),
    highlightLines: lines,
    createHighlighter: (text) => createRecoloringHighlighter(text, lines),
    hunkStructure: () => [],
  };
}

/** Git ignore files, and the files written in their syntax. */
export const gitignoreLanguage = ignoreLanguage("gitignore", "git", {
  extensions: [],
  filenames: [".gitignore", ".denoignore", ".worktreeinclude"],
});

/**
 * Docker ignore files, including one named after its Dockerfile, such as
 * `Dockerfile.build.dockerignore`, and Podman's equivalent.
 */
export const dockerignoreLanguage = ignoreLanguage("dockerignore", "docker", {
  extensions: [".dockerignore", ".containerignore"],
  filenames: [],
});

/** Bazel's list of directories to leave out of a workspace. */
export const bazelignoreLanguage = ignoreLanguage("bazelignore", "bazel", {
  extensions: [],
  filenames: [".bazelignore"],
});
