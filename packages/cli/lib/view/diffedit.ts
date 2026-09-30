/**
 * The editable source for a diff view. A diff edits the new side of the files it
 * touches: context and added lines are editable past their marker, lines can be
 * added (a new line becomes an added line) and removed. A removed line can be
 * resurrected intact; its text and the marker column remain protected.
 *
 * Re-highlighting on each keystroke rebuilds the diff document from the edited
 * text. The save map (which hunks verified, and each file's captured new-side
 * content) is fixed at construction against the pristine files: an in-flight
 * edit makes the diff stop matching disk, which is exactly why it must not be
 * recomputed from the edited text.
 */

import type { Document, Line, Span, ViewMode } from "./model.ts";
import { cpLen } from "./ansi.ts";
import {
  buildDiffDocument,
  type DiffEdit,
  type DiffFileLanguages,
  diffLanguages,
  type DiffWorkspace,
  type WorkspaceCache,
} from "./diffdoc.ts";
import {
  type DiffFile,
  type DiffHunk,
  type DiffLine,
  type DiffModel,
  parseDiff,
} from "./diff.ts";
import type { DiffCountFileContext } from "./diffcounts.ts";
import {
  type CommitHeader,
  type CommitMessage,
  extractMessage,
  findCommitHeaderCandidates,
  findCommitHeaders,
  findCommitMessages,
  type GitRunner,
  MESSAGE_INDENT,
  messageAt,
  sameCommit,
} from "./commitmsg.ts";
import type { Highlighter, Language } from "./languages/language.ts";
import { canRenderDiffLines } from "./languages/language.ts";
import { plainTextLanguage } from "./languages/plain-text/language.ts";
import type { LineEndingProvenance } from "./editbuffer.ts";
import type {
  EditableSource,
  EditPolicy,
  ExpandResult,
  HunkRoom,
  RevertScope,
} from "./editsource.ts";
import { shortName } from "./editsource.ts";

export function diffSource(
  ws: DiffWorkspace,
  edit: DiffEdit,
  cache?: WorkspaceCache,
  git?: GitRunner,
): EditableSource {
  const files = [...edit.fileText.keys()];
  const expectedFiles = new Map(edit.fileText);
  // The HEAD commit at open is the commit represented by the `git show` output.
  // After this pager amends it, `expectedHead` follows the new commit while the
  // displayed header continues to name the original object.
  const shownHead = git?.headSha() ?? null;
  const shownRef = git?.headRef?.() ?? null;
  let expectedHead = shownHead;
  const renderedView =
    edit.languages.some(({ oldLanguage, newLanguage }) =>
        canRenderDiffLines(oldLanguage) || canRenderDiffLines(newLanguage)
      )
      ? {
        render: (source: Document) =>
          reparse(ws, edit, source.text, cache, completeFiles, "rendered"),
      }
      : {};
  const resolvedCommits = new Map<string, string | null>();
  const matchesShownHead = (sha: string): boolean => {
    if (!shownHead) return false;
    if (!git?.resolveCommit) return sameCommit(sha, shownHead);
    if (!resolvedCommits.has(sha)) {
      resolvedCommits.set(sha, git.resolveCommit(sha));
    }
    return resolvedCommits.get(sha) === shownHead;
  };

  // The HEAD commit's message region in the given lines, or null. The regions
  // shift as the diff is edited, so they are re-derived from the current text.
  const editableMessage = (lines: readonly string[]): CommitMessage | null => {
    if (!shownHead) return null;
    for (const m of findCommitMessages(lines)) {
      if (matchesShownHead(m.sha)) return m;
    }
    return null;
  };
  const representedCommit = (
    lines: readonly string[],
  ): { sha: string } | null => {
    if (!shownHead) return null;
    for (const commit of findCommitHeaders(lines)) {
      if (matchesShownHead(commit.sha)) return { sha: commit.sha };
    }
    return null;
  };

  // Save reads the hunks' current new-side file ranges, which expanding context
  // grows, so keep a mutable copy that expand and save share. A hunk is writable
  // only when its new side identifies one current workspace range. Historical
  // hunks in `git log -p` can repeat that range and must not write it again.
  const saveHunks = mutableHunks(
    edit,
    hunkCommitOwners(edit.sourceText ?? "", git),
  );
  const completeFiles: DiffHighlightFiles = {
    fileText: expectedFiles,
    hunks: saveHunks,
  };
  let countContextText: string | undefined;
  let countContexts: readonly DiffCountFileContext[] = [];
  const diffCountContexts = (text: string) => {
    if (text !== countContextText) {
      countContextText = text;
      countContexts = buildDiffCountContexts(ws, edit, text);
    }
    return countContexts;
  };

  // No file on disk backs this diff (nothing resolved or verified): read-only.
  // A deletion of an entire file has no new-side lines, but its empty workspace
  // file still fixes the removed lines' insertion point exactly.
  if (
    edit.lines.size === 0 && !saveHunks.some((h) => canResurrect(h)) &&
    !editableMessage((edit.sourceText ?? "").split("\n"))
  ) {
    return {
      label: null,
      isDiff: true,
      diffCountContexts,
      editable: false,
      reason:
        "This diff doesn't match any file on disk, so there is nothing to edit.",
      parse: (text) => reparse(ws, edit, text, cache),
      ...renderedView,
      save: () => "Nothing to save — this diff matches no file on disk.",
    };
  }

  // Editability is decided against the current diff structure. Re-parsing the
  // whole buffer on each edit key is wasteful, so memoize the parse and the
  // message scan by the text they came from; the several guard calls within one
  // keystroke reuse them.
  let memoText: string | null = null;
  let memoModel: DiffModel | null = null;
  let memoCommits: readonly CommitHeader[] = [];
  let memoMessages: readonly CommitMessage[] = [];
  const classify = (
    lines: readonly string[],
  ): {
    model: DiffModel | null;
    commits: readonly CommitHeader[];
    messages: readonly CommitMessage[];
  } => {
    const text = lines.join("\n");
    if (text !== memoText) {
      memoText = text;
      memoModel = parseDiff(text);
      memoCommits = findCommitHeaders(lines);
      memoMessages = findCommitMessages(lines);
    }
    return {
      model: memoModel,
      commits: memoCommits,
      messages: memoMessages,
    };
  };

  const commitAt = (
    commits: readonly CommitHeader[],
    row: number,
  ): CommitHeader | null => {
    let owner: CommitHeader | null = null;
    for (const commit of commits) {
      if (commit.line > row) break;
      owner = commit;
    }
    return owner;
  };

  const kindOf = (
    lines: readonly string[],
    row: number,
  ): "hunk" | "removed" | "message" | null => {
    const { model, messages } = classify(lines);
    const diffKind = editableHunkRegion(
      model,
      saveHunks,
      lines[row] ?? "",
      row,
    );
    if (diffKind) return diffKind;
    if (shownHead) {
      const m = messageAt(messages, row);
      if (m && matchesShownHead(m.sha)) return "message";
    }
    return null;
  };

  const parsedHunkAt = (
    lines: readonly string[],
    row: number,
  ): { model: DiffModel; hunk: DiffHunk } | null => {
    const model = classify(lines).model;
    if (!model) return null;
    const parsed = hunkAt(model, row)?.hunk;
    return parsed && row > parsed.headerLine ? { model, hunk: parsed } : null;
  };

  const policy: EditPolicy = {
    editStart: (lines, row) => {
      const kind = kindOf(lines, row);
      if (kind === "hunk") {
        return editableStart(
          classify(lines).model,
          saveHunks,
          lines[row] ?? "",
          row,
        );
      }
      // A message line is editable past its four-space indent.
      return kind === "message" ? MESSAGE_INDENT.length : null;
    },
    notEditableMessage: (lines, row) => {
      if (!shownHead) return null;
      const commit = commitAt(classify(lines).commits, row);
      return commit && !matchesShownHead(commit.sha)
        ? "This line belongs to a commit other than HEAD and cannot be edited."
        : null;
    },
    regionKind: kindOf,
    hunkAt: parsedHunkAt,
    hasUtf8Bom: (lines, row) =>
      editableHunkInfo(classify(lines).model, saveHunks, row)
        ?.newFileHasUtf8Bom,
    insertPrefix: "+",
    messageIndent: MESSAGE_INDENT,
  };

  return {
    label: files.length === 0
      ? null
      : files.length === 1
      ? shortName(files[0])
      : `${files.length} files`,
    isDiff: true,
    diffCountContexts,
    editable: true,
    policy,
    logicalEnd: (lines, row) =>
      diffLogicalEnd(classify(lines).model, lines, row),
    parse: (text, lineEndings) =>
      reparse(ws, edit, text, cache, completeFiles, "source", lineEndings),
    ...renderedView,
    // Live highlighting recolors the lines an edit changes and reuses the seed
    // (buildDiffDocument's colors, including the file/hunk headers and the
    // workspace-file syntax highlighting) for the rest. Languages whose color
    // can cross lines re-highlight the complete file. The full parse on
    // pause restores workspace-verified spans across the edit.
    createHighlighter: (text, seed, lineEndings) =>
      createDiffHighlighter(
        text,
        seed,
        edit.oldFileLines,
        (text, model) => editedLanguages(edit.languages, text, model, ws),
        completeFiles,
        lineEndings,
      ),
    dirtyLabels: (original, current) =>
      [
        ...collectFileOutputs(
          current,
          expectedFiles,
          saveHunks,
          diffLineEndingProvenance(current, expectedFiles, saveHunks),
          changedHunkIndices(original, current),
        ).keys(),
      ].map(shortName),
    revert: (original, current, cursorLine, scope, lineEndings) =>
      revert(
        original,
        current,
        cursorLine,
        scope,
        lineEndings,
        diffLineEndingProvenance(original, expectedFiles, saveHunks),
      ),
    expandContext: (current, baseline, cursorLine, up) =>
      expandContext(ws, cache, saveHunks, current, baseline, cursorLine, up),
    expandRoom: (current) => expandRoom(ws, cache, saveHunks, current),
    lineEndingProvenance: (text) =>
      diffLineEndingProvenance(text, expectedFiles, saveHunks),
    save: (text, lineEndings, baseline, options) => {
      if (!lineEndings || lineEndings.length !== text.split("\n").length) {
        throw new Error("Edited diff row provenance is incomplete.");
      }
      const changedHunks = baseline === undefined
        ? undefined
        : changedHunkIndices(baseline, text);
      const amendedHunks = new Set(
        [...changedHunks ?? []].filter((index) => {
          const sha = saveHunks[index]?.commitSha;
          return sha !== null && sha !== undefined && matchesShownHead(sha);
        }),
      );
      const changes = collectFileOutputs(
        text,
        expectedFiles,
        saveHunks,
        lineEndings,
        changedHunks,
      );
      const advancedHunks = changes.size === 0
        ? []
        : planSavedHunkRanges(text, saveHunks, changedHunks);
      const pending = options?.amendCommit === false || baseline === undefined
        ? null
        : pendingAmend(
          editableMessage,
          representedCommit,
          amendedHunks.size > 0,
          baseline,
          text,
        );
      let replacementMessage: string | null = null;
      if (pending && baseline !== undefined) {
        const currentLines = text.split("\n");
        const baselineLines = baseline.split("\n");
        const message = editableMessage(currentLines);
        const baselineMessage = editableMessage(baselineLines);
        const messageChanged = message === null || baselineMessage === null
          ? message !== baselineMessage
          : extractMessage(currentLines, message) !==
            extractMessage(baselineLines, baselineMessage);
        if (messageChanged) {
          replacementMessage = message === null
            ? ""
            : extractMessage(currentLines, message);
        }
      }
      const commit = pending ? representedCommit(text.split("\n")) : null;
      const commitFiles = new Map<string, string>();
      if (pending) {
        if (
          !git || !commit || !expectedHead || !shownHead ||
          baseline === undefined
        ) {
          throw new Error("No commit to amend.");
        }
        const live = git.headSha();
        if (!live || !sameCommit(expectedHead, live)) {
          throw new Error(
            "HEAD has moved since this diff was shown; the commit was not amended.",
          );
        }
        const liveRef = git.headRef?.() ?? null;
        if (shownRef !== null && liveRef !== shownRef) {
          throw new Error(
            "HEAD now names a different branch; the commit was not amended.",
          );
        }
        const commitBase = new Map<string, string>();
        const amendedPaths = new Set(
          [...amendedHunks].flatMap((index) => {
            const path = saveHunks[index]?.absPath;
            return path === null || path === undefined ? [] : [path];
          }),
        );
        for (const path of amendedPaths) {
          const committed = git.fileAtCommit(expectedHead, path);
          if (committed === null) {
            throw new Error(`The shown commit does not contain ${path}.`);
          }
          commitBase.set(path, committed);
        }
        const pagerFiles = collectFileOutputs(
          text,
          expectedFiles,
          saveHunks,
          lineEndings,
          amendedHunks,
        );
        for (const path of amendedPaths) {
          const committed = commitBase.get(path);
          const before = expectedFiles.get(path);
          const after = pagerFiles.get(path);
          if (
            committed === undefined || before === undefined ||
            after === undefined
          ) {
            throw new Error(
              `Could not rebuild ${path} for the amended commit.`,
            );
          }
          commitFiles.set(
            path,
            git.applyFileChanges(committed, before, after, path),
          );
        }
      }

      const writes = [...changes].flatMap(([path, contents]) => {
        const before = ws.read(path);
        if (before === null) {
          throw new Error(`Could not read ${path}; no files were saved.`);
        }
        const expected = expectedFiles.get(path);
        if (expected === undefined) {
          throw new Error(`No saved baseline exists for ${path}.`);
        }
        if (before !== expected && before !== contents) {
          throw new Error(
            `${path} changed after this view opened; no files were saved.`,
          );
        }
        return before === contents ? [] : [{ path, before, contents }];
      });
      const attempted: typeof writes = [];
      try {
        for (const write of writes) {
          attempted.push(write);
          writeWorkspaceFile(ws, write.path, write.contents);
        }

        let amended: string | null = null;
        if (pending && git && expectedHead) {
          const result = git.amendCommit(
            replacementMessage,
            commitFiles,
            expectedHead,
            shownRef,
            changes,
          );
          amended = result.status;
          expectedHead = result.head;
        }
        for (const [path, contents] of changes) {
          expectedFiles.set(path, contents);
          cache?.delete(path);
        }
        for (const { hunk, newStart, newCount } of advancedHunks) {
          hunk.newStart = newStart;
          hunk.newCount = newCount;
        }
        return saveStatus(writes.length, amended);
      } catch (error) {
        const rollbackErrors: string[] = [];
        for (const write of attempted.reverse()) {
          try {
            const live = ws.read(write.path);
            if (live === write.before) continue;
            if (live !== write.contents) {
              rollbackErrors.push(
                `${write.path} changed again and was not restored`,
              );
              continue;
            }
            writeWorkspaceFile(ws, write.path, write.before);
          } catch (rollbackError) {
            rollbackErrors.push(String(rollbackError));
          }
        }
        const detail = error instanceof Error ? error.message : String(error);
        const suffix = rollbackErrors.length > 0
          ? `; restoring files failed: ${rollbackErrors.join("; ")}`
          : "";
        throw new Error(`${detail}${suffix}`);
      }
    },
    pendingAmend: (baseline, current) =>
      pendingAmend(
        editableMessage,
        representedCommit,
        [...changedHunkIndices(baseline, current)].some((index) => {
          const sha = saveHunks[index]?.commitSha;
          return sha !== null && sha !== undefined && matchesShownHead(sha);
        }),
        baseline,
        current,
      ),
    baselineAfterSave: (baseline, current, options) =>
      options?.amendCommit === false
        ? baselineWithCurrentHunks(baseline, current)
        : current,
  };
}

function buildDiffCountContexts(
  ws: DiffWorkspace,
  edit: DiffEdit,
  text: string,
): readonly DiffCountFileContext[] {
  const model = parseDiff(text);
  if (!model) return [];
  const raw = text.split("\n");
  const decided = editedLanguages(edit.languages, text, model, ws);
  return model.files.map((file, fileIndex) => {
    const languages = decided[fileIndex];
    const oldLines = edit.oldFileLines[fileIndex] ?? undefined;
    const newText = oldLines
      ? reconstructNewSide(file, oldLines, raw, model.lines)
      : undefined;
    const newLines = newText === undefined
      ? undefined
      : languages.newLanguage.highlightLines(
        newText,
        file.newPath ?? file.oldPath,
      );
    return { languages, oldLines, newLines };
  });
}

function reconstructNewSide(
  file: DiffFile,
  oldLines: readonly Line[],
  raw: readonly string[],
  diffLines: readonly DiffLine[],
): string {
  const lines = oldLines.map((line) => line.text);
  const oldTrailingNewline = lines.length > 1 && lines.at(-1) === "";
  const oldLineCount = lines.length === 1 && lines[0] === ""
    ? 0
    : lines.length - (oldTrailingNewline ? 1 : 0);
  let trailingNewline = oldTrailingNewline;
  const hunks = [...file.hunks].sort((a, b) =>
    sideStart(b.oldStart, b.oldCount) - sideStart(a.oldStart, a.oldCount) ||
    b.headerLine - a.headerLine
  );
  for (const hunk of hunks) {
    const replacement: string[] = [];
    for (let i = hunk.headerLine + 1; i <= hunk.endLine; i++) {
      const kind = diffLines[i]?.kind;
      if (kind === "ctx" || kind === "add") {
        let text = (raw[i] ?? "").slice(1);
        if (raw[hunk.headerLine]?.endsWith("\r") && text.endsWith("\r")) {
          text = text.slice(0, -1);
        }
        replacement.push(text);
      }
    }
    const start = sideStart(hunk.oldStart, hunk.oldCount);
    if (start + hunk.oldCount === oldLineCount) {
      const oldNoNewline = hunkSideHasNoNewline(hunk, "old", raw, diffLines);
      const newNoNewline = hunkSideHasNoNewline(hunk, "new", raw, diffLines);
      if (oldNoNewline || newNoNewline) trailingNewline = !newNoNewline;
      else if (oldLineCount === 0 && hunk.newCount > 0) trailingNewline = true;
    }
    lines.splice(
      start,
      hunk.oldCount,
      ...replacement,
    );
  }
  if (trailingNewline && lines.at(-1) !== "") lines.push("");
  if (!trailingNewline && lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

function hunkSideHasNoNewline(
  hunk: DiffHunk,
  side: "old" | "new",
  raw: readonly string[],
  diffLines: readonly DiffLine[],
): boolean {
  for (let i = hunk.headerLine + 1; i <= hunk.endLine; i++) {
    const kind = diffLines[i]?.kind;
    const belongs = kind === "ctx" || side === "old" && kind === "del" ||
      side === "new" && kind === "add";
    if (
      belongs &&
      raw[i + 1]?.replace(/\r$/u, "") === "\\ No newline at end of file"
    ) {
      return true;
    }
  }
  return false;
}

/** The commit a save would amend when changed text represents HEAD. */
function pendingAmend(
  editableMessage: (lines: readonly string[]) => CommitMessage | null,
  representedCommit: (lines: readonly string[]) => { sha: string } | null,
  commitContentsChanged: boolean,
  baseline: string,
  current: string,
): { sha: string; subject: string } | null {
  if (baseline === current) return null;
  const curLines = current.split("\n");
  const baseLines = baseline.split("\n");
  const msg = editableMessage(curLines);
  const baseMsg = editableMessage(baseLines);
  const messageChanged = msg === null || baseMsg === null
    ? msg !== baseMsg
    : extractMessage(curLines, msg) !== extractMessage(baseLines, baseMsg);
  if (!messageChanged && !commitContentsChanged) return null;
  if (!msg) {
    // Every line of the region was deleted, so there is no region left to read
    // the new message from. The message the save would write is empty, and the
    // caller refuses an empty subject.
    if (baseMsg) return { sha: baseMsg.sha, subject: "" };
    const commit = representedCommit(curLines);
    return commit && representedCommit(baseLines)
      ? { sha: commit.sha, subject: "(empty commit message)" }
      : null;
  }
  const newText = extractMessage(curLines, msg);
  // The subject is the first non-blank line — git strips leading blanks — so an
  // all-blank message reports an empty subject, which the caller refuses.
  const subject = newText.split("\n").find((l) => l.trim() !== "") ?? "";
  return { sha: msg.sha, subject };
}

/** The hunks whose rendered text changed between the last save and now. */
function changedHunkIndices(original: string, current: string): Set<number> {
  if (original === current) return new Set();
  const before = parseDiff(original);
  const after = parseDiff(current);
  if (!before || !after) return new Set();
  const bodies = (model: DiffModel, text: string): string[] => {
    const raw = text.split("\n");
    return model.files.flatMap((file) =>
      file.hunks.map((hunk) =>
        raw.slice(hunk.headerLine, hunk.endLine + 1).join("\n")
      )
    );
  };
  const beforeBodies = bodies(before, original);
  const afterBodies = bodies(after, current);
  return new Set(
    afterBodies.flatMap((body, index) =>
      beforeBodies[index] === body ? [] : [index]
    ),
  );
}

/** Build the clean baseline after saving only workspace-backed hunk edits.
 * Commit-message text stays as it was before the save, so an edited message
 * remains dirty and can still be amended or cancelled separately. */
function baselineWithCurrentHunks(original: string, current: string): string {
  const before = parseDiff(original);
  const after = parseDiff(current);
  if (!before || !after) return original;
  const hunks = (model: DiffModel) =>
    model.files.flatMap((file) =>
      file.hunks.map((hunk) => ({
        path: file.newPath ?? file.oldPath,
        hunk,
      }))
    );
  const beforeHunks = hunks(before);
  const afterHunks = hunks(after);
  if (
    beforeHunks.length !== afterHunks.length ||
    beforeHunks.some((entry, index) => entry.path !== afterHunks[index]?.path)
  ) {
    return original;
  }
  const baselineLines = original.split("\n");
  const currentLines = current.split("\n");
  for (let index = beforeHunks.length - 1; index >= 0; index--) {
    const beforeHunk = beforeHunks[index].hunk;
    const afterHunk = afterHunks[index].hunk;
    baselineLines.splice(
      beforeHunk.headerLine,
      beforeHunk.endLine - beforeHunk.headerLine + 1,
      ...currentLines.slice(afterHunk.headerLine, afterHunk.endLine + 1),
    );
  }
  return baselineLines.join("\n");
}

/**
 * Restore the cursor's hunk, the cursor's file, or the whole diff to its
 * original form. The edited and original diffs hold the same files and hunks in
 * the same document order (an edit or a context expansion never adds, removes,
 * or reorders them), so the cursor's file and hunk are matched to the original
 * by that order — which stays correct even when a path repeats across commits
 * (`git log -p`) or a hunk's start line has shifted from a context expansion.
 * The original supplies the replacement lines. Returns the new full text and
 * where to leave the cursor, or null when there is nothing to restore.
 */
function revert(
  original: string,
  current: string,
  cursorLine: number,
  scope: RevertScope,
  currentLineEndings: readonly (LineEndingProvenance | undefined)[] = [],
  baselineLineEndings: readonly (LineEndingProvenance | undefined)[] = [],
): {
  text: string;
  cursorLine: number;
  lineEndings: readonly (LineEndingProvenance | undefined)[];
} | null {
  if (original === current) return null;
  const baseLines = original.split("\n");
  const retainedBaselineLineEndings = retainBaselineLineEndings(
    original,
    current,
    baselineLineEndings,
    currentLineEndings,
  );
  if (scope === "all") {
    return {
      text: original,
      cursorLine: Math.min(cursorLine, baseLines.length - 1),
      lineEndings: retainedBaselineLineEndings,
    };
  }
  if (scope === "message") {
    return revertMessage(
      baseLines,
      current.split("\n"),
      cursorLine,
      retainedBaselineLineEndings,
      currentLineEndings,
    );
  }
  const cur = parseDiff(current);
  const base = parseDiff(original);
  if (!cur || !base) return null;
  const curLines = current.split("\n");
  const fileIdx = cur.files.findIndex((f) =>
    cursorLine >= f.headerLine && cursorLine <= f.endLine
  );
  if (fileIdx < 0) return null;
  const curFile = cur.files[fileIdx];
  const baseFile = base.files[fileIdx];
  if (
    !baseFile ||
    (baseFile.newPath ?? baseFile.oldPath) !==
      (curFile.newPath ?? curFile.oldPath)
  ) {
    return null;
  }

  const splice = (cs: number, ce: number, bs: number, be: number) => {
    return {
      text: [
        ...curLines.slice(0, cs),
        ...baseLines.slice(bs, be + 1),
        ...curLines.slice(ce + 1),
      ].join("\n"),
      cursorLine: cs,
      lineEndings: [
        ...currentLineEndings.slice(0, cs),
        ...retainedBaselineLineEndings.slice(bs, be + 1),
        ...currentLineEndings.slice(ce + 1),
      ],
    };
  };

  // Reverting a whole file, or a cursor that sits on the file headers.
  const hunkIdx = scope === "chunk"
    ? curFile.hunks.findIndex((h) =>
      cursorLine >= h.headerLine && cursorLine <= h.endLine
    )
    : -1;
  if (scope === "file" || hunkIdx < 0) {
    return splice(
      curFile.headerLine,
      curFile.endLine,
      baseFile.headerLine,
      baseFile.endLine,
    );
  }
  const curHunk = curFile.hunks[hunkIdx];
  const baseHunk = baseFile.hunks[hunkIdx];
  if (!baseHunk) return null;
  return splice(
    curHunk.headerLine,
    curHunk.endLine,
    baseHunk.headerLine,
    baseHunk.endLine,
  );
}

/** Carry saved provenance for old-side rows that remain visible in a diff. */
function retainBaselineLineEndings(
  baseline: string,
  current: string,
  baselineLineEndings: readonly (LineEndingProvenance | undefined)[],
  currentLineEndings: readonly (LineEndingProvenance | undefined)[],
): Array<LineEndingProvenance | undefined> {
  const retained = baseline.split("\n").map((_, index) =>
    baselineLineEndings[index]
  );
  const baselineModel = parseDiff(baseline);
  const currentModel = parseDiff(current);
  if (!baselineModel || !currentModel) return retained;
  for (const [fileIndex, baselineFile] of baselineModel.files.entries()) {
    const currentFile = currentModel.files[fileIndex];
    if (!currentFile) continue;
    for (const [hunkIndex, baselineHunk] of baselineFile.hunks.entries()) {
      const currentHunk = currentFile.hunks[hunkIndex];
      if (!currentHunk) continue;
      const byOldLine = new Map<number, LineEndingProvenance>();
      for (
        let row = currentHunk.headerLine + 1;
        row <= currentHunk.endLine;
        row++
      ) {
        const oldLine = currentModel.lines[row]?.oldLine;
        const ending = currentLineEndings[row];
        if (oldLine !== undefined && ending !== undefined) {
          byOldLine.set(oldLine, ending);
        }
      }
      for (
        let row = baselineHunk.headerLine + 1;
        row <= baselineHunk.endLine;
        row++
      ) {
        if (retained[row] !== undefined) continue;
        const oldLine = baselineModel.lines[row]?.oldLine;
        if (oldLine !== undefined) retained[row] = byOldLine.get(oldLine);
      }
    }
  }
  return retained;
}

/** Restore the commit message the cursor is in to its original text. The
 * messages are matched to the original by document order (like files and
 * hunks), so a `git log -p` with several commits reverts the right one. */
function revertMessage(
  baseLines: readonly string[],
  curLines: readonly string[],
  cursorLine: number,
  baselineLineEndings: readonly (LineEndingProvenance | undefined)[] = [],
  currentLineEndings: readonly (LineEndingProvenance | undefined)[] = [],
): {
  text: string;
  cursorLine: number;
  lineEndings: readonly (LineEndingProvenance | undefined)[];
} | null {
  const curMsgs = findCommitMessages(curLines);
  const idx = curMsgs.findIndex((m) =>
    cursorLine >= m.start && cursorLine <= m.end
  );
  if (idx < 0) return null;
  const cur = curMsgs[idx];
  const base = findCommitMessages(baseLines)[idx];
  if (!base) return null;
  return {
    text: [
      ...curLines.slice(0, cur.start),
      ...baseLines.slice(base.start, base.end + 1),
      ...curLines.slice(cur.end + 1),
    ].join("\n"),
    cursorLine: cur.start,
    lineEndings: [
      ...currentLineEndings.slice(0, cur.start),
      ...baselineLineEndings.slice(base.start, base.end + 1),
      ...currentLineEndings.slice(cur.end + 1),
    ],
  };
}

/** What a hunk's file offers around it: the workspace file's lines, and how far
 * the hunk's new-side range could grow each way. Null when the hunk has no
 * backing file to read. */
function hunkFooting(
  ws: DiffWorkspace,
  cache: WorkspaceCache | undefined,
  hunks: MutableHunk[],
  file: DiffModel["files"][number],
  index: number,
): {
  fileLines: string[];
  fileLineEndings: FileLineEnding[];
  fileHasTrailingNewline: boolean;
  range: MutableHunk;
  downFrom: number;
  room: HunkRoom;
} | null {
  if (file.newPath === undefined) return null;
  const absPath = ws.resolve(file.newPath);
  if (!absPath) return null;
  const content = cache?.get(absPath)?.fileText ?? ws.read(absPath);
  if (content === null) return null;
  const fileLines = content.split("\n");
  const fileLineEndings = fileContentLines(content).map((line) => line.ending);
  const fileLen = fileLines.length > 0 && fileLines[fileLines.length - 1] === ""
    ? fileLines.length - 1
    : fileLines.length;

  // File-range coordinates come from the save map (the original new-file range,
  // which an inserted line does not extend), not the display `@@` counts (which
  // an insert grows past the file range). Insertion positions and the global
  // index come from the parse. Clamp how far context may grow by the
  // neighboring hunks of the SAME file, so an expansion never overlaps another
  // hunk's file range — that would splice the two ranges into each
  // other (silently dropping edits or duplicating lines) and malform the diff.
  const range = hunks[index];
  if (!range) return null;
  const rangeStart = spliceStart(range);
  const rangeEnd = rangeStart + range.newCount;
  const sameFile = hunks.filter((hunk, otherIndex) =>
    otherIndex !== index && hunk.absPath === range.absPath
  );
  const prev = sameFile
    .filter((hunk) => spliceStart(hunk) + hunk.newCount <= rangeStart)
    .sort((a, b) =>
      spliceStart(b) + b.newCount - (spliceStart(a) + a.newCount)
    )[0] ??
    null;
  const next = sameFile
    .filter((hunk) => spliceStart(hunk) >= rangeEnd)
    .sort((a, b) => spliceStart(a) - spliceStart(b))[0] ?? null;
  const prevEnd = prev ? spliceStart(prev) + prev.newCount : 0;
  const downFrom = rangeEnd;
  const nextStart = next ? spliceStart(next) : fileLen;
  return {
    fileLines,
    fileLineEndings,
    fileHasTrailingNewline: content.endsWith("\n"),
    range,
    downFrom,
    room: {
      up: Math.max(0, rangeStart - prevEnd),
      down: Math.max(0, nextStart - downFrom),
      // Nothing left is the file running out only where the range reaches its
      // edge; otherwise it is the neighboring hunk in the way.
      atFileTop: rangeStart <= 0,
      atFileBottom: downFrom >= fileLen,
    },
  };
}

/** The hunk `line` sits in, with its file and its index across the whole diff. */
function hunkAt(model: DiffModel, line: number): {
  hunk: DiffHunk;
  file: DiffModel["files"][number];
  index: number;
} | null {
  let found = null;
  let gi = 0;
  for (const f of model.files) {
    for (const h of f.hunks) {
      if (line >= h.headerLine && line <= h.endLine) {
        found = { hunk: h, file: f, index: gi };
      }
      gi++;
    }
  }
  return found;
}

/** How much context each hunk of `current` could still reveal, keyed by the line
 * its header sits on. */
function expandRoom(
  ws: DiffWorkspace,
  cache: WorkspaceCache | undefined,
  hunks: MutableHunk[],
  current: string,
): ReadonlyMap<number, HunkRoom> {
  const out = new Map<number, HunkRoom>();
  const model = parseDiff(current);
  if (!model) return out;
  let gi = 0;
  for (const f of model.files) {
    for (const h of f.hunks) {
      const footing = hunkFooting(ws, cache, hunks, f, gi);
      if (footing) out.set(h.headerLine, footing.room);
      gi++;
    }
  }
  return out;
}

/**
 * Reveal more of the underlying file around the cursor's hunk. The extra lines
 * are read from the workspace file just above (or below) the hunk's current
 * new-side range and inserted as context, with the hunk header's counts grown to
 * match. The same expansion is applied to `baseline` and to the save map, so
 * revealing context does not register as an edit (dirtiness still reflects only
 * real changes), a later revert keeps it, and a save still writes the correct
 * file range.
 *
 * Which way to grow comes from `up` when it is given, and the call fails rather
 * than growing the other way when that side has run out — a caller that names an
 * edge is naming the one the user is looking at. Without it the boundary nearest
 * `cursorLine` grows, falling back to the other when that one has run out.
 *
 * Returns the new texts and where the cursor moves, or null when there is no
 * backing file or no more context that way.
 */
function expandContext(
  ws: DiffWorkspace,
  cache: WorkspaceCache | undefined,
  hunks: MutableHunk[],
  current: string,
  baseline: string,
  cursorLine: number,
  upIn?: boolean,
  amount = 10,
): ExpandResult | null {
  const model = parseDiff(current);
  if (!model) return null;
  const at = hunkAt(model, cursorLine);
  if (!at) return null;
  const footing = hunkFooting(ws, cache, hunks, at.file, at.index);
  if (!footing) return null;
  const {
    fileLines,
    fileLineEndings,
    fileHasTrailingNewline,
    range,
    downFrom,
    room,
  } = footing;
  const { up: upAvail, down: downAvail } = room;
  const target = at.hunk;
  const index = at.index;

  let up: boolean;
  if (upIn !== undefined) {
    up = upIn;
  } else {
    const mid = (target.headerLine + 1 + target.endLine) / 2;
    up = cursorLine <= mid;
    if (up && upAvail === 0) up = false; // nothing left above
    if (!up && downAvail === 0) up = true; // nothing left below
  }
  const k = Math.min(amount, up ? upAvail : downAvail);
  if (k <= 0) return null;

  const contextStart = up ? spliceStart(range) - k : downFrom;
  const revealedLines = fileLines.slice(contextStart, contextStart + k);
  const revealedLineEndings = fileLineEndings.slice(
    contextStart,
    contextStart + k,
  );
  const ctx = expansionBodyLines(revealedLines, target, range, up);
  const currentUsesCrlfTransport = current.split("\n")[target.headerLine]
    ?.endsWith("\r") === true;
  const revealsUnterminatedEof = !up && !fileHasTrailingNewline &&
    contextStart + k === fileLines.length;
  if (revealsUnterminatedEof) {
    appendNoNewlineMarker(ctx, currentUsesCrlfTransport);
  }
  const insertedLineEndings = expansionLineEndingProvenance(
    ctx,
    revealedLineEndings,
    currentUsesCrlfTransport,
  );
  // Which file lines those are, counting from one, while `range` still holds
  // where the hunk started — growing it upwards moves that.
  const revealed = up
    ? { from: spliceStart(range) - k + 1, to: spliceStart(range) }
    : { from: downFrom + 1, to: downFrom + k };

  // Insert at the parser's hunk boundary (one past its last body line), not a
  // re-scan, so a blank separator below the hunk (git log -p) is not absorbed.
  const baseHunks = parseDiff(baseline)?.files.flatMap((f) => f.hunks) ?? [];
  const baseHunk = baseHunks[index];
  if (!baseHunk) return null;
  const baseCtx = expansionBodyLines(revealedLines, baseHunk, range, up);
  if (revealsUnterminatedEof) {
    appendNoNewlineMarker(
      baseCtx,
      baseline.split("\n")[baseHunk.headerLine]?.endsWith("\r") === true,
    );
  }
  const text = applyExpansion(current, target, up, ctx, k);
  const newBaseline = applyExpansion(
    baseline,
    baseHunk,
    up,
    baseCtx,
    k,
  );
  if (text === null || newBaseline === null) return null;
  if (revealsUnterminatedEof) {
    hunks[index].oldNoTrailingNewline = true;
    hunks[index].newNoTrailingNewline = true;
  }
  const zeroCount = hunks[index].newCount === 0;
  hunks[index].newCount += k;
  if (zeroCount) {
    hunks[index].newStart += up ? 1 - k : 1;
  } else if (up) {
    hunks[index].newStart -= k;
  }
  // The revealed lines land just after the hunk header (up) or just after its
  // last body line (down), both in current-text coordinates.
  const insertedAt = up ? target.headerLine + 1 : target.endLine + 1;
  const insertedRows = ctx.length;
  // Those lines may have been the last between this hunk and its neighbor, in
  // which case the two now touch and the header between them describes nothing.
  // The header that goes is the one at the join: this hunk's own when the lines
  // came from above it, the next hunk's when they came from below.
  const joined = joinAdjacent(text, newBaseline, hunks, up ? index - 1 : index);
  const removedAt = joined ? (up ? insertedAt - 1 : insertedAt) : null;
  // Where a line of the old text ends up: down by the lines that went in above
  // it, and back up over a header that is no longer between them.
  const moved = (n: number) =>
    n + (n >= insertedAt ? insertedRows : 0) -
    (removedAt !== null && n > removedAt ? 1 : 0);
  // A cursor can rest on a hunk's header. When an upward reveal met the hunk
  // above and the two joined, that header is the one the join removed, so
  // `moved` would leave the cursor on its old line number — now the first
  // revealed line. Send it to the surviving header of the merged hunk instead,
  // the header of the hunk above, which the join kept.
  const mergedHeader = removedAt !== null && up
    ? model.files.flatMap((f) => f.hunks)[index - 1]?.headerLine
    : undefined;
  const cursorAfter = mergedHeader !== undefined && cursorLine === removedAt
    ? mergedHeader
    : moved(cursorLine);
  return {
    text: joined?.text ?? text,
    baseline: joined?.baseline ?? newBaseline,
    // The cursor stays on its own line. Revealing upwards puts the lines below
    // the hunk's header, so a cursor resting on that header does not move while
    // one in the body rides down ahead of them.
    cursorLine: cursorAfter,
    insertedAt,
    inserted: insertedRows,
    insertedLineEndings,
    up,
    removedAt,
    revealed,
  };
}

/** Render revealed file lines at one hunk boundary. Encoding BOMs are visible
 * markers on file line zero. When the old and new sides place that boundary at
 * different file lines, a removed/added pair carries their separate markers. */
function expansionBodyLines(
  lines: readonly string[],
  hunk: DiffHunk,
  range: MutableHunk,
  up: boolean,
): string[] {
  const oldStart = sideStart(hunk.oldStart, hunk.oldCount);
  const newStart = sideStart(hunk.newStart, hunk.newCount);
  const insertedOldStart = up
    ? oldStart - lines.length
    : oldStart + hunk.oldCount;
  const insertedNewStart = up
    ? newStart - lines.length
    : newStart + hunk.newCount;
  return lines.flatMap((line, offset) => {
    const oldLine = `${
      insertedOldStart + offset === 0 && range.oldFileHasUtf8Bom ? "\uFEFF" : ""
    }${line}`;
    const newLine = `${
      insertedNewStart + offset === 0 && range.newFileHasUtf8Bom ? "\uFEFF" : ""
    }${line}`;
    return oldLine === newLine
      ? [` ${newLine}`]
      : [`-${oldLine}`, `+${newLine}`];
  });
}

/** Attach each revealed workspace ending to its generated diff rows. */
function expansionLineEndingProvenance(
  lines: readonly string[],
  revealed: readonly FileLineEnding[],
  diffUsesCrlfTransport: boolean,
): Array<LineEndingProvenance | undefined> {
  let newSideIndex = 0;
  return lines.map((line) => {
    if (line[0] !== " " && line[0] !== "+" && line[0] !== "-") {
      return undefined;
    }
    const ending = revealed[newSideIndex];
    if (line[0] !== "-") newSideIndex++;
    if (ending === undefined) return undefined;
    return {
      ending,
      bodyCarriesCrlfEnding: ending === "\r\n" && !diffUsesCrlfTransport,
    };
  });
}

/** Add Git's marker after context that reaches an unterminated file end. */
function appendNoNewlineMarker(lines: string[], crlfDiff: boolean): void {
  if (lines.length === 0) return;
  const transport = crlfDiff ? "\r" : "";
  const marker = `\\ No newline at end of file${transport}`;
  const paired = lines.at(-1)?.startsWith("+") &&
    lines.at(-2)?.startsWith("-");
  if (paired) {
    const removed = `${lines[lines.length - 2]}${transport}`;
    const added = `${lines[lines.length - 1]}${transport}`;
    lines.splice(lines.length - 2, 2, removed, marker, added, marker);
    return;
  }
  lines[lines.length - 1] += transport;
  lines.push(marker);
}

/** Take the `@@` header off the second of two hunks and give its counts to the
 * first, leaving one hunk where there were two. Null when the text does not hold
 * them back to back with the same line transport. Anything between the first's
 * last line and the second's header would land inside the joined body. Mixed
 * transports need separate headers so each body retains its exact bytes. The
 * counts come from the parsed hunks rather than a re-read of the header line,
 * which the parse already read. */
function dropHeaderBetween(
  text: string,
  first: number,
): { text: string; removedAt: number } | null {
  const model = parseDiff(text);
  if (!model) return null;
  const all = model.files.flatMap((f) => f.hunks);
  const a = all[first];
  const b = all[first + 1];
  if (!a || !b || b.headerLine !== a.endLine + 1) return null;
  // The joined hunk starts where the first did and runs to the end of the
  // second, which is both counts together — they meet with nothing in between.
  // The first hunk's trailing context (its enclosing function) carries over.
  const lines = text.split("\n");
  const headerEnding = lines[a.headerLine]?.endsWith("\r") ? "\r" : "";
  const nextHeaderEnding = lines[b.headerLine]?.endsWith("\r") ? "\r" : "";
  if (headerEnding !== nextHeaderEnding) return null;
  const header = `@@ -${a.oldStart},${a.oldCount + b.oldCount} +${a.newStart},${
    a.newCount + b.newCount
  } @@${a.context ? ` ${a.context}` : ""}${headerEnding}`;
  const out = [
    ...lines.slice(0, a.headerLine),
    header,
    ...lines.slice(a.headerLine + 1, b.headerLine),
    ...lines.slice(b.headerLine + 1),
  ];
  return { text: out.join("\n"), removedAt: b.headerLine };
}

/** Join hunk `first` to the one after it when revealing context has left them
 * touching, in the diff, its baseline and the save map together. Null when they
 * still have file lines between them, are not the same file, or are not both
 * known to match it — joining an unverified hunk to a verified one would put
 * lines of unknown provenance into a range that a save writes, or stop the
 * verified one from being written at all. */
function joinAdjacent(
  text: string,
  baseline: string,
  hunks: MutableHunk[],
  first: number,
): { text: string; baseline: string } | null {
  const a = hunks[first];
  const b = hunks[first + 1];
  if (!a || !b || a.absPath === null || a.absPath !== b.absPath) return null;
  if ((a.commitSha ?? null) !== (b.commitSha ?? null)) return null;
  if (a.newStart + a.newCount !== b.newStart) return null; // a gap remains
  if (!isWritable(a) || !isWritable(b)) return null;
  const joined = dropHeaderBetween(text, first);
  const joinedBase = dropHeaderBetween(baseline, first);
  if (!joined || !joinedBase) return null;
  // Saving pairs the text's hunks with this map by position, so it loses an
  // entry exactly as the text loses a header.
  a.newCount += b.newCount;
  a.oldNoTrailingNewline ||= b.oldNoTrailingNewline;
  a.newNoTrailingNewline ||= b.newNoTrailingNewline;
  hunks.splice(first + 1, 1);
  return { text: joined.text, baseline: joinedBase.text };
}

/** Insert `ctx` context lines at the top or bottom of a parsed hunk and grow
 * its header counts by `k`. */
function applyExpansion(
  text: string,
  hunk: DiffHunk,
  up: boolean,
  ctx: string[],
  k: number,
): string | null {
  const lines = text.split("\n");
  const h = hunk.headerLine;
  const bodyEnd = hunk.endLine + 1;
  const headerEnding = lines[h].endsWith("\r") ? "\r" : "";
  const headerText = headerEnding ? lines[h].slice(0, -1) : lines[h];
  const m = headerText.match(
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/,
  );
  if (!m) return null;
  let oldStart = parseInt(m[1], 10);
  let oldCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
  let newStart = parseInt(m[3], 10);
  let newCount = m[4] !== undefined ? parseInt(m[4], 10) : 1;
  if (up) {
    oldStart += oldCount === 0 ? 1 - k : -k;
    newStart += newCount === 0 ? 1 - k : -k;
  } else {
    if (oldCount === 0) oldStart++;
    if (newCount === 0) newStart++;
  }
  oldCount += k;
  newCount += k;
  const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${
    m[5] ?? ""
  }${headerEnding}`;
  const out = up
    ? [...lines.slice(0, h), header, ...ctx, ...lines.slice(h + 1)]
    : [
      ...lines.slice(0, h),
      header,
      ...lines.slice(h + 1, bodyEnd),
      ...ctx,
      ...lines.slice(bodyEnd),
    ];
  return out.join("\n");
}

/**
 * An incremental highlighter for a diff. It recolors only the lines an edit
 * changes (found by a common prefix/suffix of the line arrays) and keeps `seed`
 * — the colors {@link buildDiffDocument} produced for the unedited text — for
 * every line the edit leaves alone. Edited removed lines use the complete old
 * file's spans. Other edited body lines use a marker-aware single-line parse
 * in the language of their file's side, which `languagesFor` decides for each
 * version of the diff, or which the diff's own paths and content decide
 * without it. A language can ask to
 * re-highlight complete files when its colors depend on preceding lines. The
 * headers stay in the unchanged prefix or suffix. When no seed is given, the
 * highlighter renders every line itself.
 */
export function createDiffHighlighter(
  initialText: string,
  seed?: readonly Line[],
  oldFileLines?: readonly (readonly Line[] | null)[],
  languagesFor: (
    text: string,
    model: DiffModel,
  ) => readonly DiffFileLanguages[] = diffLanguages,
  completeFiles?: DiffHighlightFiles,
  initialLineEndings?: readonly (LineEndingProvenance | undefined)[],
): Highlighter {
  let text = initialText;
  const completeHighlighters = new Map<string, Highlighter>();
  const initialRaw = initialText.split("\n");
  const initialModel = seed ? null : parseDiff(initialText);
  const languagesOf = (text: string, model: DiffModel | null) =>
    model ? languagesFor(text, model) : [];
  const initialLanguages = languagesOf(initialText, initialModel);
  let lines: Line[] = (seed ??
    initialRaw.map((line, index) =>
      diffLineRender(
        line,
        diffSideAt(initialModel, index, initialLanguages),
        oldLineSpansAt(initialModel, index, oldFileLines),
      )
    )).slice();
  if (!seed && initialModel) {
    rehighlightTouchedHunks(
      initialRaw,
      initialModel,
      lines,
      0,
      initialRaw.length,
      oldFileLines,
      initialLanguages,
      completeFiles,
      completeHighlighters,
      undefined,
      initialLineEndings,
    );
  }
  return {
    get lines() {
      return lines;
    },
    update(
      next: string,
      lineEndings?: readonly (LineEndingProvenance | undefined)[],
    ): readonly Line[] {
      if (next === text) return lines;
      const oldRaw = text.split("\n");
      const newRaw = next.split("\n");
      const oldHighlighted = lines;
      const minLen = Math.min(oldRaw.length, newRaw.length);
      let p = 0;
      while (p < minLen && oldRaw[p] === newRaw[p]) p++;
      let s = 0;
      while (
        s < minLen - p &&
        oldRaw[oldRaw.length - 1 - s] === newRaw[newRaw.length - 1 - s]
      ) {
        s++;
      }
      const localEdit = localDiffLineEdit(
        oldRaw,
        newRaw,
        oldHighlighted,
        p,
        s,
      );
      const model = parseDiff(next);
      const nextLanguages = languagesOf(next, model);
      const recolored = newRaw.slice(p, newRaw.length - s).map((l, i) =>
        diffLineRender(
          l,
          diffSideAt(model, p + i, nextLanguages),
          oldLineSpansAt(model, p + i, oldFileLines),
        )
      );
      lines = lines.slice(0, p).concat(
        recolored,
        lines.slice(oldRaw.length - s),
      );
      rehighlightTouchedHunks(
        newRaw,
        model,
        lines,
        p,
        newRaw.length - s,
        oldFileLines,
        nextLanguages,
        completeFiles,
        completeHighlighters,
        localEdit,
        lineEndings,
      );
      text = next;
      return lines;
    },
  };
}

interface DiffHighlightFiles {
  readonly fileText: ReadonlyMap<string, string>;
  readonly hunks: readonly MutableHunk[];
}

interface TouchedHunk {
  readonly hunk: DiffHunk;
  readonly info: MutableHunk | undefined;
}

interface CompleteHunk {
  readonly hunk: DiffHunk;
  readonly info: MutableHunk;
  readonly side: DiffSide;
}

/** One side of a diff file: its name, and the language it is read in. */
interface DiffSide {
  readonly fileName: string | undefined;
  readonly language: Language;
}

interface LocalDiffLineEdit {
  readonly newDiffLine: number;
  readonly before: Line;
  readonly after: string;
}

function localDiffLineEdit(
  oldRaw: readonly string[],
  newRaw: readonly string[],
  oldHighlighted: readonly Line[],
  changedStart: number,
  commonSuffix: number,
): LocalDiffLineEdit | undefined {
  const oldChanged = oldRaw.slice(
    changedStart,
    oldRaw.length - commonSuffix,
  );
  const newChanged = newRaw.slice(
    changedStart,
    newRaw.length - commonSuffix,
  );
  let beforeLine: number;
  let afterLine: number;
  if (
    oldChanged.length === 1 && newChanged.length === 1 &&
    (oldChanged[0][0] === "+" || oldChanged[0][0] === " ") &&
    oldChanged[0][0] === newChanged[0][0]
  ) {
    beforeLine = changedStart;
    afterLine = changedStart;
  } else if (
    oldChanged.length === 1 && newChanged.length === 2 &&
    oldChanged[0][0] === " " &&
    newChanged[0] === `-${oldChanged[0].slice(1)}` &&
    newChanged[1][0] === "+"
  ) {
    beforeLine = changedStart;
    afterLine = changedStart + 1;
  } else {
    return undefined;
  }

  const highlighted = oldHighlighted[beforeLine];
  const raw = oldRaw[beforeLine];
  if (!highlighted || !raw || raw.length === 0) return undefined;
  const marker = raw[0];
  const markerSpan = highlighted.spans[0];
  if (
    markerSpan?.col !== 0 || markerSpan.text !== marker ||
    markerSpan.text.length !== 1
  ) {
    return undefined;
  }
  return {
    newDiffLine: afterLine,
    before: {
      text: raw.slice(1),
      spans: highlighted.spans.slice(1).map((span) => ({
        ...span,
        col: span.col - 1,
      })),
    },
    after: newRaw[afterLine].slice(1),
  };
}

/**
 * Re-highlight touched sides with complete files when the language carries
 * lexical state across lines. A fragment remains the fallback for an unverified
 * hunk.
 */
function rehighlightTouchedHunks(
  rawLines: string[],
  model: DiffModel | null,
  lines: Line[],
  changedStart: number,
  changedEnd: number,
  oldFileLines: readonly (readonly Line[] | null)[] | undefined,
  languages: readonly DiffFileLanguages[],
  completeFiles?: DiffHighlightFiles,
  completeHighlighters?: Map<string, Highlighter>,
  localEdit?: LocalDiffLineEdit,
  lineEndings?: readonly (LineEndingProvenance | undefined)[],
): void {
  if (!model) return;
  const changedLast = Math.max(changedStart, changedEnd - 1);
  const statefulFiles: {
    fileIndex: number;
    oldSide: DiffSide;
    newSide: DiffSide;
    touched: TouchedHunk[];
  }[] = [];
  let hunkIndex = 0;
  for (const [fileIndex, file] of model.files.entries()) {
    const oldSide = diffFileSide(file, "old", languages[fileIndex]);
    const newSide = diffFileSide(file, "new", languages[fileIndex]);
    const touched: TouchedHunk[] = [];
    for (const hunk of file.hunks) {
      if (
        (oldSide.language.highlightFullFileOnDiffEdit ||
          newSide.language.highlightFullFileOnDiffEdit) &&
        changedLast >= hunk.headerLine && changedStart <= hunk.endLine
      ) {
        touched.push({ hunk, info: completeFiles?.hunks[hunkIndex] });
      }
      hunkIndex++;
    }
    if (touched.length > 0) {
      statefulFiles.push({ fileIndex, oldSide, newSide, touched });
    }
  }
  if (statefulFiles.length === 0) return;

  let fullNewFiles: Map<string, string> | undefined;
  let completeHunksByPath: Map<string, CompleteHunk[]> | undefined;
  const appliedNewPaths = new Set<string>();
  for (const { fileIndex, oldSide, newSide, touched } of statefulFiles) {
    if (oldSide.language.highlightFullFileOnDiffEdit) {
      const completeOld = oldFileLines?.[fileIndex];
      for (const { hunk } of touched) {
        if (completeOld) {
          applyCompleteHunkSide(
            rawLines,
            model,
            lines,
            hunk,
            "old",
            completeOld,
            oldSide,
          );
          continue;
        }
        rehighlightHunkSide(rawLines, model, lines, hunk, "old", oldSide);
      }
    }

    if (newSide.language.highlightFullFileOnDiffEdit) {
      const locallyHighlighted = localEdit !== undefined &&
        touched.some(({ hunk }) =>
          localEdit.newDiffLine > hunk.headerLine &&
          localEdit.newDiffLine <= hunk.endLine
        ) &&
        newSide.language.highlightDiffLineEditLocally?.(
          localEdit.before,
          localEdit.after,
        );
      if (locallyHighlighted && localEdit) {
        lines[localEdit.newDiffLine] = diffLineRender(
          rawLines[localEdit.newDiffLine],
          newSide,
          locallyHighlighted.spans,
        );
        continue;
      }
      const path = touched.find(({ info }) => info?.absPath && isWritable(info))
        ?.info?.absPath;
      const completeText = path && completeFiles
        ? (fullNewFiles ??= collectFileOutputs(
          rawLines.join("\n"),
          completeFiles.fileText,
          completeFiles.hunks,
          lineEndings ?? diffLineEndingProvenance(
            rawLines.join("\n"),
            completeFiles.fileText,
            completeFiles.hunks,
          ),
        )).get(path)
        : undefined;
      if (completeText !== undefined && path && completeFiles) {
        // Sections of `git log -p` output can read one file in different
        // languages, so each language highlights the complete file apart.
        const key = `${newSide.language.id}\0${path}`;
        if (appliedNewPaths.has(key)) continue;
        appliedNewPaths.add(key);
        let completeHighlighter = completeHighlighters?.get(key);
        let completeNew: readonly Line[];
        if (!completeHighlighter) {
          completeHighlighter = newSide.language.createHighlighter(
            completeText,
            newSide.fileName,
          );
          completeHighlighters?.set(key, completeHighlighter);
          completeNew = completeHighlighter.lines;
        } else {
          completeNew = completeHighlighter.update(completeText);
        }
        completeHunksByPath ??= indexCompleteHunks(
          model,
          completeFiles,
          languages,
        );
        applyCompleteNewFile(
          rawLines,
          model,
          lines,
          completeNew,
          completeHunksByPath.get(path) ?? [],
          newSide.language,
        );
      } else {
        for (const { hunk } of touched) {
          rehighlightHunkSide(rawLines, model, lines, hunk, "new", newSide);
        }
      }
    }
  }
}

function indexCompleteHunks(
  model: DiffModel,
  completeFiles: DiffHighlightFiles,
  languages: readonly DiffFileLanguages[],
): Map<string, CompleteHunk[]> {
  const byPath = new Map<string, CompleteHunk[]>();
  let index = 0;
  for (const [fileIndex, file] of model.files.entries()) {
    const side = diffFileSide(file, "new", languages[fileIndex]);
    for (const hunk of file.hunks) {
      const info = completeFiles.hunks[index++];
      if (!info?.absPath || !isWritable(info)) continue;
      const entries = byPath.get(info.absPath) ?? [];
      entries.push({ hunk, info, side });
      byPath.set(info.absPath, entries);
    }
  }
  return byPath;
}

/**
 * Recolor the new side of each hunk read in `language` from the complete new
 * file, which is `complete` once every hunk's edits are applied.
 */
function applyCompleteNewFile(
  rawLines: string[],
  model: DiffModel,
  lines: Line[],
  complete: readonly Line[],
  entries: readonly CompleteHunk[],
  language: Language,
): void {
  const ordered = [...entries].sort((a, b) =>
    spliceStart(a.info) - spliceStart(b.info)
  );
  let delta = 0;
  for (const { hunk, info, side } of ordered) {
    const start = spliceStart(info);
    if (side.language === language) {
      applyCompleteHunkSide(
        rawLines,
        model,
        lines,
        hunk,
        "new",
        complete,
        side,
        start + delta - spliceStart(hunk),
      );
    }
    delta += hunk.newCount - info.newCount;
  }
}

function applyCompleteHunkSide(
  rawLines: string[],
  model: DiffModel,
  lines: Line[],
  hunk: DiffHunk,
  side: "old" | "new",
  complete: readonly Line[],
  fileSide: DiffSide,
  lineOffset = 0,
): void {
  for (let line = hunk.headerLine + 1; line <= hunk.endLine; line++) {
    const entry = model.lines[line];
    const sourceLine = side === "old" ? entry?.oldLine : entry?.newLine;
    const included = side === "old"
      ? entry?.kind === "del"
      : entry?.kind === "ctx" || entry?.kind === "add";
    if (!included || sourceLine === undefined) continue;
    lines[line] = diffLineRender(
      rawLines[line],
      fileSide,
      complete[sourceLine + lineOffset]?.spans,
    );
  }
}

function rehighlightHunkSide(
  rawLines: string[],
  model: DiffModel,
  lines: Line[],
  hunk: DiffHunk,
  side: "old" | "new",
  fileSide: DiffSide,
): void {
  const fragment: { diffLine: number; code: string }[] = [];
  for (let line = hunk.headerLine + 1; line <= hunk.endLine; line++) {
    const kind = model.lines[line]?.kind;
    const included = side === "old"
      ? kind === "ctx" || kind === "del"
      : kind === "ctx" || kind === "add";
    if (included) {
      fragment.push({ diffLine: line, code: rawLines[line].slice(1) });
    }
  }
  const highlighted = fileSide.language.highlightLines(
    fragment.map((entry) => entry.code).join("\n"),
    fileSide.fileName,
  );
  for (let index = 0; index < fragment.length; index++) {
    const { diffLine } = fragment[index];
    if (side === "old" && model.lines[diffLine]?.kind === "ctx") continue;
    lines[diffLine] = diffLineRender(
      rawLines[diffLine],
      fileSide,
      highlighted[index]?.spans,
    );
  }
}

/**
 * Classify an editable hunk line as its editable new side or a removed line
 * that can be resurrected. A line belongs only when the hunk's new side matched
 * a file on disk. Structural lines, empty lines, unverified hunks, and text
 * outside a hunk are refused. Hunks are matched to the save map by document
 * order, as saving does, so a repeated file in `git log -p` and a context
 * expansion both stay in step.
 */
function editableHunkRegion(
  model: DiffModel | null,
  saveHunks: readonly MutableHunk[],
  lineText: string,
  row: number,
): "hunk" | "removed" | null {
  const info = editableHunkInfo(model, saveHunks, row);
  if (!info) return null;
  const c = lineText[0];
  if (c === "+" || c === " ") return "hunk";
  return c === "-" && canResurrect(info) ? "removed" : null;
}

/** The writable hunk containing a diff row. */
function editableHunkInfo(
  model: DiffModel | null,
  saveHunks: readonly MutableHunk[],
  row: number,
): MutableHunk | null {
  if (!model) return null;
  let gi = 0;
  for (const f of model.files) {
    for (const h of f.hunks) {
      if (row > h.headerLine && row <= h.endLine) {
        const info = saveHunks[gi];
        return info && isWritable(info) ? info : null;
      }
      gi++;
    }
  }
  return null; // outside every hunk
}

/** First editable column of the diff line at `row`, or null when its text is
 * protected. Removed lines are classified above so the editor can resurrect
 * them, but their old-side text remains uneditable. */
function editableStart(
  model: DiffModel | null,
  saveHunks: readonly MutableHunk[],
  lineText: string,
  row: number,
): number | null {
  const info = editableHunkInfo(model, saveHunks, row);
  if (!info || (lineText[0] !== "+" && lineText[0] !== " ")) {
    return null;
  }
  return info.newFileHasUtf8Bom === true &&
      model?.lines[row]?.newLine === 0 && lineText[1] === "\uFEFF"
    ? 2
    : 1;
}

/** The last source column before CRLF transport in editable diff text. */
function diffLogicalEnd(
  model: DiffModel | null,
  lines: readonly string[],
  row: number,
): number {
  const line = lines[row] ?? "";
  const length = [...line].length;
  if (!line.endsWith("\r")) return length;
  const hunk = model ? hunkAt(model, row)?.hunk : undefined;
  const noTrailingNewline = lines[row + 1]?.replace(/\r$/, "") ===
    "\\ No newline at end of file";
  if (
    hunk && row > hunk.headerLine && noTrailingNewline &&
    !lines[hunk.headerLine]?.endsWith("\r")
  ) {
    return length;
  }
  return row < lines.length - 1 ? length - 1 : length;
}

/**
 * Render one edited diff line: the marker keeps its diff color and row tint and
 * the code after it is highlighted in its file side's language, shifted one
 * column right. Mirrors how the diff document builder paints a line, so a live
 * edit re-colors correctly without rebuilding the whole diff.
 */
function diffLineRender(
  lineText: string,
  fileSide: DiffSide,
  oldSpans?: readonly Span[],
): Line {
  if (lineText.length === 0) return { text: "", spans: [] };
  // A hunk header carries its own color and its counts change when an edit
  // grows or shrinks the hunk, so color it the way the full parse does rather
  // than as a body line.
  if (/^@@ /.test(lineText)) {
    return {
      text: lineText,
      spans: [{ col: 0, text: lineText, cls: "diffHunk" }],
    };
  }
  const marker = lineText[0];
  const cls = marker === "+"
    ? "diffAdd"
    : marker === "-"
    ? "diffDel"
    : "whitespace";
  const spans: Span[] = [{ col: 0, text: marker, cls }];
  const code = lineText.slice(1);
  const oldText = oldSpans?.map((span) => span.text).join("");
  const useOld = oldText !== undefined &&
    (oldText === code || `${oldText}\r` === code);
  const content = useOld
    ? oldSpans
    : fileSide.language.highlightLines(code, fileSide.fileName)[0]?.spans;
  for (const s of content ?? []) {
    spans.push({ ...s, col: s.col + 1 });
  }
  if (useOld && oldText !== code) {
    spans.push({
      col: cpLen(oldText) + 1,
      text: code.slice(oldText.length),
      cls: "whitespace",
    });
  }
  const bg = marker === "+" ? "add" : marker === "-" ? "del" : undefined;
  return bg ? { text: lineText, spans, bg } : { text: lineText, spans };
}

/** Complete-old-file spans for a removed diff line. */
function oldLineSpansAt(
  model: DiffModel | null,
  line: number,
  oldFileLines?: readonly (readonly Line[] | null)[],
): readonly Span[] | undefined {
  const entry = model?.lines[line];
  if (!model || entry?.kind !== "del" || entry.oldLine === undefined) {
    return undefined;
  }
  return oldFileLines?.[diffFileIndexAt(model, line)]?.[entry.oldLine]?.spans;
}

/** The index of the diff file containing `line`, or -1 outside every file. */
function diffFileIndexAt(model: DiffModel, line: number): number {
  return model.files.findIndex((file) =>
    line >= file.headerLine && line <= file.endLine
  );
}

/**
 * The file side a diff line belongs to: the old side for a removed line, and
 * the new side otherwise. A line outside every file is plain text.
 */
function diffSideAt(
  model: DiffModel | null,
  line: number,
  languages: readonly DiffFileLanguages[],
): DiffSide {
  const fileIndex = model ? diffFileIndexAt(model, line) : -1;
  if (!model || fileIndex < 0) {
    return { fileName: undefined, language: plainTextLanguage };
  }
  return diffFileSide(
    model.files[fileIndex],
    model.lines[line]?.kind === "del" ? "old" : "new",
    languages[fileIndex],
  );
}

/**
 * One side of a diff file, named by that side's path and falling back to the
 * other side's path when the file is created or deleted.
 */
function diffFileSide(
  file: DiffFile,
  side: "old" | "new",
  { oldLanguage, newLanguage }: DiffFileLanguages,
): DiffSide {
  return side === "old"
    ? { fileName: file.oldPath ?? file.newPath, language: oldLanguage }
    : { fileName: file.newPath ?? file.oldPath, language: newLanguage };
}

export const _internal = {
  editableStart,
  pendingAmend,
  dropHeaderBetween,
  joinAdjacent,
  oldLineSpansAt,
  changedStatefulFileOutputs,
};

/**
 * The languages decided for a diff's files when it opened, while the edited
 * diff still parses into those files. An edited diff that parses into other
 * files decides its languages again, from its own paths and content and from
 * `ws`.
 */
function editedLanguages(
  decided: readonly DiffFileLanguages[],
  text: string,
  model: DiffModel,
  ws: DiffWorkspace,
): readonly DiffFileLanguages[] {
  return decided.length === model.files.length
    ? decided
    : diffLanguages(text, model, ws);
}

/**
 * Rebuild an edited diff's document, reading each file side in the language
 * `edit` decided for it.
 */
function reparse(
  ws: DiffWorkspace,
  edit: DiffEdit,
  text: string,
  cache?: WorkspaceCache,
  completeFiles?: DiffHighlightFiles,
  viewMode: ViewMode = "source",
  lineEndings?: readonly (LineEndingProvenance | undefined)[],
): Document {
  const model = parseDiff(text);
  // An edit keeps every line's marker, so the text still parses as a diff; if a
  // pathological edit breaks that, fall back to a plain parse so highlighting
  // still updates.
  if (!model) return plainTextLanguage.parseDocument(text);
  const languages = editedLanguages(edit.languages, text, model, ws);
  const build = (workspace: DiffWorkspace, buildCache?: WorkspaceCache) =>
    buildDiffDocument(
      text,
      model,
      workspace,
      buildCache,
      viewMode,
      languages,
    ).doc;
  if (!completeFiles) return build(ws, cache);
  const editedFiles = collectFileOutputs(
    text,
    completeFiles.fileText,
    completeFiles.hunks,
    lineEndings ?? diffLineEndingProvenance(
      text,
      completeFiles.fileText,
      completeFiles.hunks,
    ),
  );
  const statefulPaths = new Set<string>();
  let hunkIndex = 0;
  for (const [fileIndex, file] of model.files.entries()) {
    const { oldLanguage, newLanguage } = languages[fileIndex];
    const needsCompleteFile = oldLanguage.highlightFullFileOnDiffEdit ||
      newLanguage.highlightFullFileOnDiffEdit;
    for (const _hunk of file.hunks) {
      const path = completeFiles.hunks[hunkIndex++]?.absPath;
      if (needsCompleteFile && path) statefulPaths.add(path);
    }
  }
  const statefulEdits = changedStatefulFileOutputs(
    editedFiles,
    completeFiles.fileText,
    statefulPaths,
  );
  if (statefulEdits.size === 0) return build(ws, cache);
  // Reconstructed files make the edited new side the complete source used for
  // syntax highlighting and diff verification.
  const editedWorkspace: DiffWorkspace = {
    resolve: (path) => ws.resolve(path),
    read: (path) => {
      const edited = statefulEdits.get(path);
      return edited === undefined ? ws.read(path) : edited;
    },
    ...(ws.hasUtf8Bom
      ? { hasUtf8Bom: (path: string) => ws.hasUtf8Bom!(path) }
      : {}),
    ...(ws.readBlob
      ? { readBlob: (object: string) => ws.readBlob!(object) }
      : {}),
    ...(ws.blobHasUtf8Bom
      ? {
        blobHasUtf8Bom: (object: string) => ws.blobHasUtf8Bom!(object),
      }
      : {}),
    ...(ws.readBlobs
      ? {
        readBlobs: (objects: readonly string[]) => ws.readBlobs!(objects),
      }
      : {}),
  };
  const editedCache: WorkspaceCache = new Map(cache);
  for (const path of statefulEdits.keys()) editedCache.delete(path);
  return build(editedWorkspace, editedCache);
}

function writeWorkspaceFile(
  ws: DiffWorkspace,
  path: string,
  text: string,
): void {
  if (ws.write) {
    ws.write(path, text);
  } else {
    Deno.writeTextFileSync(path, text);
  }
}

function changedStatefulFileOutputs(
  editedFiles: ReadonlyMap<string, string>,
  baselines: ReadonlyMap<string, string>,
  statefulPaths: ReadonlySet<string>,
): Map<string, string> {
  return new Map(
    [...editedFiles].filter(([path, edited]) =>
      statefulPaths.has(path) && edited !== baselines.get(path)
    ),
  );
}

interface FileSplice {
  startIndex: number;
  newCount: number;
  newSide: string[];
  lineEndings: Array<LineEndingProvenance | undefined>;
  noTrailingNewline?: boolean;
  fallbackEnding: "\n" | "\r\n";
}

type FileLineEnding = "" | "\n" | "\r\n";

interface FileContentLine {
  text: string;
  ending: FileLineEnding;
}

/** Split file contents while keeping each line's exact newline separate. */
function fileContentLines(text: string): FileContentLine[] {
  if (text.length === 0) return [];
  const raw = text.split("\n");
  const trailingNewline = text.endsWith("\n");
  if (trailingNewline) raw.pop();
  return raw.map((line, index) => {
    const hasNewline = index < raw.length - 1 || trailingNewline;
    if (hasNewline && line.endsWith("\r")) {
      return { text: line.slice(0, -1), ending: "\r\n" };
    }
    return { text: line, ending: hasNewline ? "\n" : "" };
  });
}

/** Choose the closest newline style to a replaced file range. */
function nearbyLineEnding(
  lines: readonly FileContentLine[],
  start: number,
  count: number,
  fallback: Exclude<FileLineEnding, "">,
): Exclude<FileLineEnding, ""> {
  for (const line of lines.slice(start, start + count)) {
    if (line.ending !== "") return line.ending;
  }
  for (let index = start - 1; index >= 0; index--) {
    const ending = lines[index]?.ending;
    if (ending) return ending;
  }
  for (let index = start + count; index < lines.length; index++) {
    const ending = lines[index]?.ending;
    if (ending) return ending;
  }
  return fallback;
}

function nearbyProvenanceEnding(
  index: number,
  provenance: readonly (LineEndingProvenance | undefined)[],
  fallback: Exclude<FileLineEnding, "">,
): Exclude<FileLineEnding, ""> {
  for (let current = index - 1; current >= 0; current--) {
    const ending = provenance[current]?.ending;
    if (ending) return ending;
  }
  for (let current = index + 1; current < provenance.length; current++) {
    const ending = provenance[current]?.ending;
    if (ending) return ending;
  }
  return fallback;
}

function baselineLineProvenance(
  body: string,
  original: FileContentLine | undefined,
  diffUsesCrlfTransport: boolean,
): LineEndingProvenance | undefined {
  if (!original) return undefined;
  return {
    ending: original.ending,
    bodyCarriesCrlfEnding: !diffUsesCrlfTransport &&
      original.ending === "\r\n" &&
      body.endsWith("\r"),
  };
}

/** Give an edited diff row the newline carried by its baseline row. */
function reconstructedFileLine(
  body: string,
  provenance: LineEndingProvenance | undefined,
  needsEnding: boolean,
  nearbyEnding: Exclude<FileLineEnding, "">,
): FileContentLine {
  let text = body;
  let ending = provenance?.ending ?? "";
  if (provenance?.bodyCarriesCrlfEnding && text.endsWith("\r")) {
    text = text.slice(0, -1);
  } else if (!provenance && needsEnding && text.endsWith("\r")) {
    text = text.slice(0, -1);
    ending = "\r\n";
  }
  if (!needsEnding) ending = "";
  else if (ending === "") ending = nearbyEnding;
  return { text, ending };
}

/** A copy of {@link DiffHunkInfo} the diff source keeps mutable: expanding a
 * hunk's context grows the new-side file range it covers, and save reads the
 * current range. */
interface MutableHunk {
  absPath: string | null;
  newStart: number;
  newCount: number;
  verified: boolean;
  oldFileHasUtf8Bom?: boolean;
  newFileHasUtf8Bom?: boolean;
  oldNoTrailingNewline?: boolean;
  newNoTrailingNewline?: boolean;

  /** The nearest preceding commit header in the source text. */
  commitSha?: string | null;

  /** This is the first verified hunk that names its workspace range. */
  writable?: boolean;

  /** Removed lines have a workspace-verified insertion point. */
  resurrectable?: boolean;
}

function isWritable(hunk: MutableHunk): boolean {
  // The fallback keeps hand-built hunks in focused helper tests compatible.
  return hunk.writable ?? (hunk.verified && hunk.absPath !== null);
}

function canResurrect(hunk: MutableHunk): boolean {
  return hunk.resurrectable ?? (isWritable(hunk) && hunk.newCount > 0);
}

/** The zero-based workspace coordinate of a unified-diff new-side range. A
 * zero-count range names the line before its insertion point. */
function spliceStart(hunk: Pick<MutableHunk, "newStart" | "newCount">): number {
  return sideStart(hunk.newStart, hunk.newCount);
}

/** The zero-based file coordinate of either side of a unified-diff range. */
function sideStart(start: number, count: number): number {
  return count === 0 ? start : start - 1;
}

function rangesOverlap(a: MutableHunk, b: MutableHunk): boolean {
  const aStart = spliceStart(a);
  const bStart = spliceStart(b);
  const aEnd = aStart + a.newCount;
  const bEnd = bStart + b.newCount;
  if (a.newCount === 0) return aStart >= bStart && aStart <= bEnd;
  if (b.newCount === 0) return bStart >= aStart && bStart <= aEnd;
  return aStart < bEnd && bStart < aEnd;
}

/** Mark only workspace-anchored, non-overlapping ranges writable. Diff output
 * can repeat a file across historical commits. The first verified occurrence
 * represents the current workspace, while a later overlapping occurrence must
 * not overwrite edits made through the first. */
function mutableHunks(
  edit: DiffEdit,
  commitOwners: readonly (string | null)[] = [],
): MutableHunk[] {
  const claimed = new Map<string, MutableHunk[]>();
  return edit.hunks.map((hunk, index) => {
    const out: MutableHunk = {
      ...hunk,
      commitSha: commitOwners[index] ?? null,
    };
    const file = hunk.absPath === null
      ? undefined
      : edit.fileText.get(hunk.absPath);
    const anchored = hunk.verified && hunk.absPath !== null &&
      (hunk.newCount > 0 ||
        (hunk.newStart === 0 && hunk.newCount === 0 && file === ""));
    const prior = hunk.absPath === null ? [] : claimed.get(hunk.absPath) ?? [];
    out.writable = anchored &&
      !prior.some((other) => rangesOverlap(other, out));
    out.resurrectable = out.writable;
    if (out.writable && hunk.absPath !== null) {
      prior.push(out);
      claimed.set(hunk.absPath, prior);
    }
    return out;
  });
}

/** The commit header that owns each parsed hunk, in document order. */
function hunkCommitOwners(
  text: string,
  git?: GitRunner,
): (string | null)[] {
  const model = parseDiff(text);
  if (!model) return [];
  const lines = text.split("\n");
  const headers = findCommitHeaders(lines);
  const candidates = findCommitHeaderCandidates(lines);
  return model.files.flatMap((file) => {
    let owner: string | null = null;
    if (candidates.length > 0 && git?.commitMatchesDiff) {
      const firstHunk = file.hunks[0]?.headerLine ?? file.endLine + 1;
      const objects = lines.slice(file.headerLine, firstHunk).map((line) =>
        line.replace(/\r$/, "")
      ).map((line) =>
        /^index ([0-9a-f]{4,64})\.\.([0-9a-f]{4,64})(?:\s|$)/.exec(
          line,
        )
      ).find((match) => match !== null);
      if (objects) {
        for (let index = candidates.length - 1; index >= 0; index--) {
          const candidate = candidates[index];
          if (!candidate || candidate.line >= file.headerLine) continue;
          if (
            git.commitMatchesDiff(
              candidate.sha,
              file.oldPath,
              file.newPath,
              objects[1],
              objects[2],
            )
          ) {
            owner = candidate.sha;
            break;
          }
        }
      }
    } else {
      for (const header of headers) {
        if (header.line >= file.headerLine) break;
        owner = header.sha;
      }
    }
    return file.hunks.map(() => owner);
  });
}

function hunkNewSide(
  rawLines: readonly string[],
  model: DiffModel,
  hunk: DiffHunk,
  info: MutableHunk,
): {
  lines: string[];
  sourceRows: number[];
  noTrailingNewline?: boolean;
  fallbackEnding: "\n" | "\r\n";
} {
  const lines: string[] = [];
  const sourceRows: number[] = [];
  let noTrailingNewline: boolean | undefined;
  const crlfTransport = rawLines[hunk.headerLine]?.endsWith("\r") === true;
  let finalNewSideLine = -1;
  for (let line = hunk.headerLine + 1; line <= hunk.endLine; line++) {
    const kind = model.lines[line]?.kind;
    if (kind === "ctx" || kind === "add") finalNewSideLine = line;
  }
  for (let line = hunk.headerLine + 1; line <= hunk.endLine; line++) {
    const kind = model.lines[line]?.kind;
    if (kind === "ctx" || kind === "add") {
      let body = rawLines[line].slice(1);
      if (crlfTransport && body.endsWith("\r")) {
        body = body.slice(0, -1);
      }
      const sourceLine = model.lines[line]?.newLine;
      lines.push(
        sourceLine === 0 && info.newFileHasUtf8Bom === true
          ? body.replace(/^\uFEFF/, "")
          : body,
      );
      sourceRows.push(line);
    }
    if (
      kind === "meta" && line - 1 === finalNewSideLine &&
      (info.oldNoTrailingNewline || info.newNoTrailingNewline) &&
      rawLines[line].replace(/\r$/, "") === "\\ No newline at end of file"
    ) {
      noTrailingNewline = true;
    }
  }
  return {
    lines,
    sourceRows,
    noTrailingNewline,
    fallbackEnding: crlfTransport ? "\r\n" : "\n",
  };
}

/** Map editable diff rows to the exact endings of their workspace rows. */
function diffLineEndingProvenance(
  text: string,
  fileText: ReadonlyMap<string, string>,
  hunks: readonly MutableHunk[],
): Array<LineEndingProvenance | undefined> {
  const rawLines = text.split("\n");
  const provenance = rawLines.map(() => undefined) as Array<
    LineEndingProvenance | undefined
  >;
  const model = parseDiff(text);
  let hunkIndex = 0;
  for (const file of model?.files ?? []) {
    for (const hunk of file.hunks) {
      const info = hunks[hunkIndex++];
      if (!info?.absPath) continue;
      const base = fileText.get(info.absPath);
      if (base === undefined) continue;
      const fileLines = fileContentLines(base);
      if (
        spliceStart(info) + info.newCount === fileLines.length + 1 &&
        (base === "" || base.endsWith("\n"))
      ) {
        fileLines.push({ text: "", ending: "" });
      }
      const side = hunkNewSide(rawLines, model!, hunk, info);
      for (const [index, sourceRow] of side.sourceRows.entries()) {
        provenance[sourceRow] = baselineLineProvenance(
          side.lines[index],
          fileLines[spliceStart(info) + index],
          side.fallbackEnding === "\r\n",
        );
      }
    }
  }
  return provenance;
}

/**
 * Rebuild each changed file from the edited diff. The edited diff's hunks are
 * matched to the hunks recorded at open, in document order — robust to `git log
 * -p` repeating a file and its ranges across commits — and only the verified
 * ones are considered. Their captured content is known to be the hunk's new
 * side, so an unverified hunk is never used. For each, the current new side
 * (its context and added lines, markers stripped) replaces the file lines that
 * hunk covered, taken from the recorded `newStart`/`newCount`. Hunks apply high
 * line number first so earlier ranges do not shift.
 *
 * A hunk body is delimited by {@link parseDiff}, which consumes exactly the
 * lines the `@@` counts cover. Reusing that one classification keeps save in
 * step with the parser: a blank line inside the counted body is a context line
 * (an empty content line some tools emit unprefixed), not a terminator, so its
 * file line is carried to the new side instead of being dropped — which would
 * leave fewer new-side lines than `newCount` and truncate the file on save.
 * Inter-hunk text (`git log -p` commit metadata, a trailing separator) falls
 * outside the parsed body, so it is never absorbed.
 */
function collectFileOutputs(
  text: string,
  fileText: ReadonlyMap<string, string>,
  hunks: readonly MutableHunk[],
  lineEndings: readonly (LineEndingProvenance | undefined)[],
  changedHunks?: ReadonlySet<number>,
): Map<string, string> {
  const model = parseDiff(text);
  const rawLines = text.split("\n");
  const byFile = new Map<string, FileSplice[]>();
  let hunkIndex = 0;
  for (const file of model?.files ?? []) {
    for (const hunk of file.hunks) {
      const index = hunkIndex++;
      const info = hunks[index];
      const include = changedHunks === undefined || changedHunks.has(index);
      if (!include || !info || !isWritable(info) || !info.absPath) continue;
      const current = hunkNewSide(rawLines, model!, hunk, info);
      const list = byFile.get(info.absPath) ?? [];
      list.push({
        startIndex: spliceStart(info),
        newCount: info.newCount,
        newSide: current.lines,
        lineEndings: current.sourceRows.map((row) => lineEndings[row]),
        noTrailingNewline: current.noTrailingNewline,
        fallbackEnding: current.fallbackEnding,
      });
      byFile.set(info.absPath, list);
    }
  }

  const out = new Map<string, string>();
  for (const [path, splices] of byFile) {
    const base = fileText.get(path);
    if (base === undefined) continue;
    const fileLines = fileContentLines(base);
    const representedLineCount = Math.max(
      0,
      ...splices.map((splice) => splice.startIndex + splice.newCount),
    );
    if (
      representedLineCount === fileLines.length + 1 &&
      (base === "" || base.endsWith("\n"))
    ) {
      fileLines.push({ text: "", ending: "" });
    }
    const baseLineCount = fileLines.length;
    for (const h of [...splices].sort((a, b) => b.startIndex - a.startIndex)) {
      const ending = nearbyLineEnding(
        fileLines,
        h.startIndex,
        h.newCount,
        h.fallbackEnding,
      );
      const reachesEof = h.startIndex + h.newCount === baseLineCount;
      const replacement = h.newSide.map((body, index) => {
        const inherited = h.lineEndings[index];
        const finalFileLine = reachesEof && index === h.newSide.length - 1;
        const needsEnding = !finalFileLine
          ? true
          : h.noTrailingNewline === true
          ? false
          : inherited !== undefined
          ? inherited.ending !== ""
          : h.newCount > 0
          ? base.endsWith("\n")
          : true;
        return reconstructedFileLine(
          body,
          inherited,
          needsEnding,
          nearbyProvenanceEnding(index, h.lineEndings, ending),
        );
      });
      fileLines.splice(h.startIndex, h.newCount, ...replacement);
    }
    out.set(
      path,
      fileLines.map((line) => `${line.text}${line.ending}`).join(""),
    );
  }
  return out;
}

/**
 * Advance each writable hunk's workspace range to the file produced by this
 * save. A line insertion or deletion changes the edited hunk's size and shifts
 * every later hunk in the same file. The plan is built before any file or Git
 * change, then applied only after the whole save succeeds.
 */
function planSavedHunkRanges(
  text: string,
  hunks: readonly MutableHunk[],
  changedHunks?: ReadonlySet<number>,
): Array<{ hunk: MutableHunk; newStart: number; newCount: number }> {
  const parsed = parseDiff(text)?.files.flatMap((file) => file.hunks) ?? [];
  if (parsed.length !== hunks.length) {
    throw new Error("The edited diff no longer matches its saved hunk map.");
  }
  const saved = hunks.flatMap((hunk, index) => {
    const include = changedHunks === undefined || changedHunks.has(index);
    return include && isWritable(hunk) && hunk.absPath
      ? [{
        index,
        path: hunk.absPath,
        start: spliceStart(hunk),
        oldCount: hunk.newCount,
        newCount: parsed[index].newCount,
      }]
      : [];
  });

  return hunks.flatMap((hunk, index) => {
    if (!isWritable(hunk) || !hunk.absPath) return [];
    const own = saved.find((change) => change.index === index);
    const shift = saved.reduce(
      (total, change) =>
        change.path === hunk.absPath && change.start < spliceStart(hunk)
          ? total + change.newCount - change.oldCount
          : total,
      0,
    );
    const start = spliceStart(hunk) + shift;
    const newCount = own?.newCount ?? hunk.newCount;
    return [{
      hunk,
      newStart: newCount === 0 ? start : start + 1,
      newCount,
    }];
  });
}

function saveStatus(changed: number, amended: string | null): string {
  const saved = `Saved ${changed} ${changed === 1 ? "file" : "files"}`;
  return amended ? `${saved}; ${amended}` : saved;
}
