/**
 * The commit-message block of `git show` / `git log -p` output, and rewriting it
 * back to the commit. Git prints a commit's message indented four spaces, after
 * the `commit`/`Author`/`Date` header and before the diff. `cf view` lets the
 * message of the HEAD commit be edited in place; saving amends that commit.
 */

import { basename, dirname, isAbsolute, join, relative } from "@std/path";

import { spliceAll } from "@commonfabric/utils/arrays";

import {
  decodeLanguageInput,
  readOnlyReasonFor,
} from "./languages/language.ts";
import type { DecodedLanguageSource } from "./languages/decoder.ts";

/** The indent git puts before every commit-message line. */
export const MESSAGE_INDENT = "    ";

// An object id is 40 hex characters in a SHA-1 repository and 64 in a SHA-256
// one; Git accepts abbreviated ids with a minimum length of four characters.
const OBJECT_ID = "[0-9a-f]{4,64}";
const COMMIT_RE = new RegExp(`^commit (${OBJECT_ID})\\b`);
const ONELINE_COMMIT_RE = new RegExp(`^(${OBJECT_ID})\\s+\\S`);
// The subject text of a compact one-line header: everything after the hash.
const ONELINE_SUBJECT_RE = new RegExp(`^${OBJECT_ID}\\s+(\\S.*)$`);
const EMAIL_COMMIT_RE = new RegExp(
  `^From (${OBJECT_ID}) Mon Sep 17 00:00:00 2001$`,
);

const withoutTransportCR = (line: string): string =>
  line.endsWith("\r") ? line.slice(0, -1) : line;

const emailCommitAt = (
  lines: readonly string[],
  index: number,
): RegExpExecArray | null => {
  const match = EMAIL_COMMIT_RE.exec(withoutTransportCR(lines[index] ?? ""));
  if (!match) return null;
  const headers: string[] = [];
  for (let next = index + 1; next < lines.length; next++) {
    const line = withoutTransportCR(lines[next]);
    if (line === "") break;
    headers.push(line);
  }
  return headers.some((line) => /^From: .+<[^<>]*>$/.test(line)) &&
      headers.some((line) => /^Date: .+/.test(line)) &&
      headers.some((line) => /^Subject: .+/.test(line))
    ? match
    : null;
};

export interface CommitMessage {
  /** The commit hash, as printed after `commit `. */
  readonly sha: string;

  /** First 0-based line index of the indented message. */
  readonly start: number;

  /** Last such index, inclusive. */
  readonly end: number;
}

export interface CommitHeader {
  /** The commit hash, as printed after `commit `. */
  readonly sha: string;

  /** The 0-based line index of the `commit` header. */
  readonly line: number;
}

/** Locate commit headers independently of whether they have a message body. */
export function findCommitHeaders(lines: readonly string[]): CommitHeader[] {
  const headers: CommitHeader[] = [];
  let sawContent = false;
  let sawEmailPatch = false;
  let format: "standard" | "compact" | "email" | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const text = withoutTransportCR(line);
    let match: RegExpExecArray | null = null;
    if (format === "standard") match = COMMIT_RE.exec(text);
    else if (format === "compact") match = ONELINE_COMMIT_RE.exec(text);
    else if (format === "email" && sawEmailPatch) {
      match = emailCommitAt(lines, index);
    } else if (!sawContent) {
      match = COMMIT_RE.exec(text);
      if (match) format = "standard";
      else {
        match = emailCommitAt(lines, index);
        if (match) format = "email";
        else {
          match = ONELINE_COMMIT_RE.exec(text);
          if (match) format = "compact";
        }
      }
    }
    if (match) {
      headers.push({ sha: match[1], line: index });
      sawContent = true;
      sawEmailPatch = false;
      continue;
    }
    if (format === "email" && text.startsWith("diff --git ")) {
      sawEmailPatch = true;
    }
    if (text.trim().length > 0) sawContent = true;
  }
  return headers;
}

/** Locate syntactically possible email headers for assigning file diffs to
 * commits. Email message text can contain a complete envelope, so callers
 * validate these candidates against the blobs named by each diff. An empty
 * result means the input is not email-formatted commit output. */
export function findCommitHeaderCandidates(
  lines: readonly string[],
): CommitHeader[] {
  const headers = findCommitHeaders(lines);
  if (
    headers.length === 0 ||
    !EMAIL_COMMIT_RE.test(withoutTransportCR(lines[headers[0].line] ?? ""))
  ) {
    return [];
  }
  const candidates: CommitHeader[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = emailCommitAt(lines, index);
    if (match) candidates.push({ sha: match[1], line: index });
  }
  return candidates;
}

/**
 * Locate each commit's indented message region. Every message line begins with
 * the four-space indent (a blank message line is four spaces); the run ends at
 * the first line without it — the blank line before the diff, the next commit,
 * or the end of the input.
 */
export function findCommitMessages(lines: readonly string[]): CommitMessage[] {
  const out: CommitMessage[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = COMMIT_RE.exec(withoutTransportCR(lines[i]));
    if (!m) continue;
    // Skip the header lines (Author, Date, Merge, …) to the blank separator.
    let j = i + 1;
    while (
      j < lines.length && withoutTransportCR(lines[j]) !== "" &&
      !withoutTransportCR(lines[j]).startsWith(MESSAGE_INDENT)
    ) {
      j++;
    }
    if (j < lines.length && withoutTransportCR(lines[j]) === "") j++;
    const start = j;
    while (
      j < lines.length &&
      withoutTransportCR(lines[j]).startsWith(MESSAGE_INDENT)
    ) j++;
    if (j > start) out.push({ sha: m[1], start, end: j - 1 });
  }
  return out;
}

/** The region containing `row`, or null when `row` is in no message. */
export function messageAt(
  messages: readonly CommitMessage[],
  row: number,
): CommitMessage | null {
  for (const m of messages) {
    if (row >= m.start && row <= m.end) return m;
  }
  return null;
}

/** The message text of a region: each line stripped of its four-space indent
 * and joined with newlines. */
export function extractMessage(
  lines: readonly string[],
  msg: CommitMessage,
): string {
  const body: string[] = [];
  for (let i = msg.start; i <= msg.end; i++) {
    const line = withoutTransportCR(lines[i] ?? "");
    body.push(
      line.startsWith(MESSAGE_INDENT) ? line.slice(4) : line.trimStart(),
    );
  }
  return body.join("\n");
}

/**
 * Each commit's subject line, keyed by hash. The subject is the first line of
 * the indented message (standard `git show` / `git log -p`), the text after the
 * hash on a compact one-line header, or the `Subject:` header of a
 * `git format-patch` email — whichever the input carries. Absent for a commit
 * whose subject cannot be found.
 */
export function commitSubjects(lines: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of findCommitMessages(lines)) {
    const first = withoutTransportCR(lines[m.start] ?? "").trim();
    if (first.length > 0 && !out.has(m.sha)) out.set(m.sha, first);
  }
  // The compact and email formats have no indented body; their subject rides the
  // header itself, so fill only the commits the message scan did not cover.
  for (const header of findCommitHeaders(lines)) {
    if (out.has(header.sha)) continue;
    const subject = inlineSubject(lines, header);
    if (subject.length > 0) out.set(header.sha, subject);
  }
  return out;
}

/** The subject a header carries inline: the text after the hash on a compact
 * (`git log --oneline`) header, or the `Subject:` header of a `git format-patch`
 * email with its `[PATCH …]` prefix removed. Empty when neither shape applies. */
function inlineSubject(
  lines: readonly string[],
  header: CommitHeader,
): string {
  const line = withoutTransportCR(lines[header.line] ?? "");
  const compact = ONELINE_SUBJECT_RE.exec(line);
  if (compact) return compact[1];
  if (!EMAIL_COMMIT_RE.test(line)) return "";
  // The email envelope runs to the first blank line; the Subject may wrap onto
  // continuation lines (leading whitespace), which join with a single space.
  let subject: string | null = null;
  for (let i = header.line + 1; i < lines.length; i++) {
    const h = withoutTransportCR(lines[i]);
    if (h === "") break;
    if (subject !== null) {
      if (/^\s/.test(h)) subject += ` ${h.trim()}`;
      else break; // a later header ends the Subject
    } else {
      const m = /^Subject:\s*(.*)$/.exec(h);
      if (m) subject = m[1];
    }
  }
  return subject === null ? "" : subject.replace(/^\[[^\]]*\]\s*/, "").trim();
}

/** Whether `sha` names the same commit as `head` (either may be abbreviated). */
export function sameCommit(sha: string, head: string): boolean {
  const n = Math.min(sha.length, head.length);
  return n >= 4 && sha.slice(0, n) === head.slice(0, n);
}

/**
 * Runs the git operations the message editor needs. Injected so tests can drive
 * the editor without a real repository; {@link realGit} is the production one.
 */
export interface GitRunner {
  /** The current commit's full hash, or null (not a repo, or git failed). */
  headSha(): string | null;

  /** The symbolic ref checked out at HEAD, or `HEAD` when detached. */
  headRef?(): string | null;

  /** Resolve an abbreviated commit name to its full object id. */
  resolveCommit?(sha: string): string | null;

  /** Whether the old and new blob names in one file diff belong to a commit
   * and its first parent. Paths use Git's repository-relative form. */
  commitMatchesDiff?(
    commit: string,
    oldPath: string | undefined,
    newPath: string | undefined,
    oldObject: string,
    newObject: string,
  ): boolean;

  /** Read a file's blob from `commit`, addressed by its absolute workspace
   * path. A path absent from the commit returns null. */
  fileAtCommit(commit: string, path: string): string | null;

  /** Apply only the change from `before` to `after` to `committed`. */
  applyFileChanges(
    committed: string,
    before: string,
    after: string,
    path: string,
  ): string;

  /** Amend HEAD with each file's exact contents. A null message preserves the
   * existing commit message byte for byte. Merge the change from the current
   * HEAD into the real index, preserving staged changes that do not conflict.
   * Other staged paths stay in the real index. An empty map changes no files.
   * When provided, `expectedWorkspace` contains the working files that
   * must remain unchanged while commit hooks run. Returns the status and amended
   * object; throws on failure. */
  amendCommit(
    message: string | null,
    files: ReadonlyMap<string, string>,
    expectedHead: string,
    expectedRef?: string | null,
    expectedWorkspace?: ReadonlyMap<string, string>,
  ): { status: string; head: string };
}

export function realGit(cwd: string): GitRunner {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const runBytes = (
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
    commandCwd = cwd,
  ): Uint8Array => {
    const r = new Deno.Command("git", {
      args: [...args],
      cwd: commandCwd,
      env,
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    if (!r.success) {
      const err = decoder.decode(r.stderr).trim();
      throw new Error(err || `git ${args[0] ?? "command"} failed`);
    }
    return r.stdout;
  };
  const run = (
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
    commandCwd = cwd,
  ): string => decoder.decode(runBytes(args, env, commandCwd));

  let cachedRoot: string | null = null;
  const repoRoot = (): string => {
    if (cachedRoot !== null) return cachedRoot;
    const root = run(["rev-parse", "--show-toplevel"]).trim();
    if (!root) throw new Error("git repository root is unavailable");
    try {
      cachedRoot = Deno.realPathSync(root);
    } catch {
      cachedRoot = root;
    }
    return cachedRoot;
  };
  const repoPath = (path: string): string => {
    if (!isAbsolute(path)) {
      throw new Error(`git amend path is not absolute: ${path}`);
    }
    const root = repoRoot();
    let lexicalRoot: string | null = null;
    let ancestor = dirname(path);
    for (;;) {
      try {
        if (Deno.realPathSync(ancestor) === root) {
          lexicalRoot = ancestor;
        }
      } catch {
        // Keep looking for the repository ancestor.
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    if (lexicalRoot === null) {
      throw new Error(`git amend path is outside the repository: ${path}`);
    }
    const rel = relative(lexicalRoot, path);
    if (
      rel === "" || rel === ".." || rel.startsWith("../") ||
      rel.startsWith("..\\") || isAbsolute(rel)
    ) {
      throw new Error(`git amend path is outside the repository: ${path}`);
    }
    let canonicalPath: string;
    try {
      canonicalPath = Deno.realPathSync(path);
    } catch {
      canonicalPath = join(Deno.realPathSync(dirname(path)), basename(path));
    }
    const canonicalRel = relative(root, canonicalPath);
    if (
      canonicalRel === "" || canonicalRel === ".." ||
      canonicalRel.startsWith("../") || canonicalRel.startsWith("..\\") ||
      isAbsolute(canonicalRel)
    ) {
      throw new Error(`git amend path is outside the repository: ${path}`);
    }
    return Deno.build.os === "windows" ? rel.replaceAll("\\", "/") : rel;
  };

  interface ObjectEntry {
    mode: string;
    object: string;
  }
  interface IndexEntry extends ObjectEntry {
    assumeUnchanged: boolean;
    skipWorktree: boolean;
  }
  const indexEntry = (
    path: string,
    env?: Readonly<Record<string, string>>,
  ): IndexEntry | null => {
    const raw = run(
      ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", path],
      env,
      repoRoot(),
    );
    const entries = raw.split("\0").filter((entry) => entry.length > 0);
    if (entries.length === 0) return null;
    if (entries.length !== 1) {
      throw new Error(`git index has unmerged entries for ${path}`);
    }
    const match = entries[0].match(/^([0-7]{6}) ([0-9a-f]+) ([0-3])\t/);
    if (!match || match[3] !== "0") {
      throw new Error(`git index has an unmerged entry for ${path}`);
    }
    const verboseTag = run(
      ["--literal-pathspecs", "ls-files", "-v", "-z", "--", path],
      env,
      repoRoot(),
    )[0] ?? "";
    const statusTag = run(
      ["--literal-pathspecs", "ls-files", "-t", "-z", "--", path],
      env,
      repoRoot(),
    )[0] ?? "";
    return {
      mode: match[1],
      object: match[2],
      assumeUnchanged: verboseTag !== verboseTag.toUpperCase(),
      skipWorktree: statusTag === "S",
    };
  };
  const treeEntry = (commit: string, path: string): ObjectEntry | null => {
    const raw = run(
      ["--literal-pathspecs", "ls-tree", "-z", commit, "--", path],
      undefined,
      repoRoot(),
    );
    const entries = raw.split("\0").filter((entry) => entry.length > 0);
    if (entries.length === 0) return null;
    if (entries.length !== 1) {
      throw new Error(`git tree has more than one entry for ${path}`);
    }
    const match = entries[0].match(/^([0-7]{6}) (?:blob|commit) ([0-9a-f]+)\t/);
    if (!match) throw new Error(`git tree entry is invalid for ${path}`);
    return { mode: match[1], object: match[2] };
  };
  const readFilteredBlob = (
    object: string,
    path: string,
  ): DecodedLanguageSource => {
    const decoded = decodeLanguageInput(
      path,
      runBytes(
        ["cat-file", "--filters", `--path=${path}`, object],
        undefined,
        repoRoot(),
      ),
    );
    const readOnlyReason = readOnlyReasonFor(decoded.language);
    if (readOnlyReason !== undefined) {
      throw new Error(readOnlyReason);
    }
    return decoded.source;
  };
  const setIndexEntry = (
    path: string,
    entry: IndexEntry | null,
    env?: Readonly<Record<string, string>>,
  ): void => {
    if (entry === null) {
      run(
        [
          "--literal-pathspecs",
          "update-index",
          "--force-remove",
          "--",
          path,
        ],
        env,
        repoRoot(),
      );
      return;
    }
    run(
      [
        "--literal-pathspecs",
        "update-index",
        "--no-assume-unchanged",
        "--no-skip-worktree",
        "--",
        path,
      ],
      env,
      repoRoot(),
    );
    run(
      [
        "update-index",
        "--add",
        "--cacheinfo",
        `${entry.mode},${entry.object},${path}`,
      ],
      env,
      repoRoot(),
    );
    const flags = [
      ...(entry.assumeUnchanged ? ["--assume-unchanged"] : []),
      ...(entry.skipWorktree ? ["--skip-worktree"] : []),
    ];
    if (flags.length > 0) {
      run(
        ["--literal-pathspecs", "update-index", ...flags, "--", path],
        env,
        repoRoot(),
      );
    }
  };
  const applyFileChanges = (
    committed: string,
    before: string,
    after: string,
    path: string,
  ): string => {
    if (before === after) return committed;
    if (committed === before) return after;
    const tempDir = Deno.makeTempDirSync({ prefix: "cf-view-merge-" });
    const committedPath = join(tempDir, "committed");
    const beforePath = join(tempDir, "before");
    const afterPath = join(tempDir, "after");
    try {
      Deno.writeTextFileSync(committedPath, committed);
      Deno.writeTextFileSync(beforePath, before);
      Deno.writeTextFileSync(afterPath, after);
      interface TextChange {
        oldStart: number;
        oldCount: number;
        newStart: number;
        newCount: number;
        oldLines: string[];
        newLines: string[];
      }
      const changesBetween = (from: string, to: string): TextChange[] => {
        const diff = new Deno.Command("git", {
          args: [
            "diff",
            "--no-index",
            "--text",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--unified=0",
            "--",
            from,
            to,
          ],
          cwd: repoRoot(),
          stdout: "piped",
          stderr: "piped",
        }).outputSync();
        if (diff.code === 0) return [];
        if (diff.code !== 1) {
          const error = decoder.decode(diff.stderr).trim();
          throw new Error(error || `Could not compare pager edits for ${path}`);
        }
        const changes: TextChange[] = [];
        let current: TextChange | null = null;
        for (const line of decoder.decode(diff.stdout).split("\n")) {
          const header = line.match(
            /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
          );
          if (header) {
            const oldCount = header[2] === undefined ? 1 : Number(header[2]);
            const newCount = header[4] === undefined ? 1 : Number(header[4]);
            current = {
              oldStart: oldCount === 0
                ? Number(header[1])
                : Number(header[1]) - 1,
              oldCount,
              newStart: newCount === 0
                ? Number(header[3])
                : Number(header[3]) - 1,
              newCount,
              oldLines: [],
              newLines: [],
            };
            changes.push(current);
            continue;
          }
          if (current && line.startsWith("-")) {
            current.oldLines.push(line.slice(1));
          } else if (current && line.startsWith("+")) {
            current.newLines.push(line.slice(1));
          }
        }
        if (
          changes.some((change) =>
            change.oldLines.length !== change.oldCount ||
            change.newLines.length !== change.newCount
          )
        ) {
          throw new Error(`Could not parse pager edits for ${path}`);
        }
        return changes;
      };
      const mergeNonOverlappingChanges = (): string => {
        const workspaceChanges = changesBetween(committedPath, beforePath);
        const pagerChanges = changesBetween(beforePath, afterPath);
        const conflicts = (pager: TextChange, workspace: TextChange) => {
          const pagerEnd = pager.oldStart + pager.oldCount;
          const workspaceEnd = workspace.newStart + workspace.newCount;
          if (pager.oldCount === 0) {
            if (
              workspace.oldCount > 0 && workspace.newCount === 0 &&
              pager.oldStart === workspace.newStart
            ) {
              return true;
            }
            return workspace.newCount > 0 &&
              pager.oldStart > workspace.newStart &&
              pager.oldStart < workspaceEnd;
          }
          if (workspace.newCount === 0) {
            return workspace.newStart > pager.oldStart &&
              workspace.newStart < pagerEnd;
          }
          return pager.oldStart < workspaceEnd &&
            workspace.newStart < pagerEnd;
        };
        const mapBoundary = (
          position: number,
          side: "start" | "end",
        ): number => {
          let delta = 0;
          for (const change of workspaceChanges) {
            const newEnd = change.newStart + change.newCount;
            const oldEnd = change.oldStart + change.oldCount;
            if (position < change.newStart) return position - delta;
            if (position === change.newStart) {
              return change.newCount === 0 && side === "start"
                ? oldEnd
                : change.oldStart;
            }
            if (position < newEnd) {
              throw new Error(
                `Pager edits overlap workspace changes in ${path}; no commit was amended.`,
              );
            }
            if (position === newEnd) return oldEnd;
            delta += change.newCount - change.oldCount;
          }
          return position - delta;
        };
        const mapped = pagerChanges.map((change, originalIndex) => {
          if (
            workspaceChanges.some((workspace) => conflicts(change, workspace))
          ) {
            throw new Error(
              `Pager edits overlap workspace changes in ${path}; no commit was amended.`,
            );
          }
          return {
            ...change,
            originalIndex,
            mappedStart: mapBoundary(change.oldStart, "start"),
            mappedEnd: mapBoundary(
              change.oldStart + change.oldCount,
              "end",
            ),
          };
        });
        const splitLines = (text: string): string[] => {
          if (text === "") return [];
          const body = text.endsWith("\n") ? text.slice(0, -1) : text;
          return body === "" ? [""] : body.split("\n");
        };
        const lines = splitLines(committed);
        for (
          const change of [...mapped].sort((a, b) =>
            b.mappedStart - a.mappedStart ||
            b.originalIndex - a.originalIndex
          )
        ) {
          const found = lines.slice(change.mappedStart, change.mappedEnd);
          if (
            found.length !== change.oldLines.length ||
            found.some((line, index) => line !== change.oldLines[index])
          ) {
            throw new Error(
              `Pager edits overlap committed changes in ${path}; no commit was amended.`,
            );
          }
          spliceAll(
            lines,
            change.mappedStart,
            change.mappedEnd - change.mappedStart,
            change.newLines,
          );
        }
        const finalNewline = before.endsWith("\n") === after.endsWith("\n")
          ? committed.endsWith("\n")
          : after.endsWith("\n");
        return lines.join("\n") + (finalNewline ? "\n" : "");
      };
      const result = new Deno.Command("git", {
        args: [
          "merge-file",
          "-p",
          "-L",
          "committed version",
          "-L",
          "pager baseline",
          "-L",
          "pager version",
          committedPath,
          beforePath,
          afterPath,
        ],
        cwd: repoRoot(),
        stdout: "piped",
        stderr: "piped",
      }).outputSync();
      if (result.code > 0 && result.code < 128) {
        return mergeNonOverlappingChanges();
      }
      if (!result.success) {
        const error = decoder.decode(result.stderr).trim();
        throw new Error(error || `Could not apply pager edits to ${path}`);
      }
      return decoder.decode(result.stdout);
    } finally {
      try {
        Deno.removeSync(tempDir, { recursive: true });
      } catch {
        // Temporary merge files are removed when possible.
      }
    }
  };

  return {
    headSha() {
      try {
        return run(["rev-parse", "HEAD"]).trim() || null;
      } catch {
        return null;
      }
    },
    headRef() {
      try {
        return run(["rev-parse", "--symbolic-full-name", "HEAD"]).trim() ||
          null;
      } catch {
        return null;
      }
    },
    resolveCommit(sha) {
      if (!new RegExp(`^${OBJECT_ID}$`).test(sha)) return null;
      try {
        return run(["rev-parse", "--verify", `${sha}^{commit}`]).trim() || null;
      } catch {
        return null;
      }
    },
    commitMatchesDiff(commit, oldPath, newPath, oldObject, newObject) {
      const objectName = new RegExp(`^${OBJECT_ID}$`);
      if (!objectName.test(oldObject) || !objectName.test(newObject)) {
        return false;
      }
      try {
        const resolved = run([
          "rev-parse",
          "--verify",
          `${commit}^{commit}`,
        ]).trim();
        const [, parent] = run([
          "rev-list",
          "--parents",
          "-n",
          "1",
          resolved,
        ]).trim().split(" ");
        const oldEntry = parent && oldPath ? treeEntry(parent, oldPath) : null;
        const newEntry = newPath ? treeEntry(resolved, newPath) : null;
        const matches = (
          printed: string,
          entry: ObjectEntry | null,
        ): boolean =>
          /^0+$/.test(printed)
            ? entry === null
            : entry !== null && sameCommit(printed, entry.object);
        return matches(oldObject, oldEntry) && matches(newObject, newEntry);
      } catch {
        return false;
      }
    },
    fileAtCommit(commit, path) {
      const rel = repoPath(path);
      const entry = treeEntry(commit, rel);
      return entry ? readFilteredBlob(entry.object, rel).text : null;
    },
    applyFileChanges,
    amendCommit(
      message,
      files,
      expectedHead,
      expectedRef,
      expectedWorkspace,
    ) {
      const root = repoRoot();
      let referenceStorage = "files";
      try {
        referenceStorage = run(
          ["config", "--get", "extensions.refStorage"],
          undefined,
          root,
        ).trim().toLowerCase() || "files";
      } catch {
        // Repositories using loose and packed refs omit this extension.
      }
      if (referenceStorage !== "files" && referenceStorage !== "reftable") {
        throw new Error(
          `Git reference storage '${referenceStorage}' cannot be amended safely; no commit was amended.`,
        );
      }
      const fileBackedRefs = referenceStorage === "files";
      const oldHead = run(["rev-parse", "HEAD"], undefined, root).trim();
      if (!sameCommit(expectedHead, oldHead)) {
        throw new Error(
          "HEAD moved before the amend began; no commit was amended.",
        );
      }
      const targetRef = run(
        ["rev-parse", "--symbolic-full-name", "HEAD"],
        undefined,
        root,
      ).trim();
      if (expectedRef && targetRef !== expectedRef) {
        throw new Error(
          "HEAD now names a different branch; no commit was amended.",
        );
      }
      const tempDir = Deno.makeTempDirSync({ prefix: "cf-view-amend-" });
      const tempIndex = join(tempDir, "index");
      const tempEnv = { GIT_INDEX_FILE: tempIndex };
      const referenceJournal = join(tempDir, "reference-transactions");
      const hookProxyMarker = crypto.randomUUID();
      const installHookProxy = (): string => {
        let configuredHooksPath: string | null = null;
        try {
          const value = run(
            ["config", "--null", "--path", "--get", "core.hooksPath"],
            undefined,
            root,
          );
          configuredHooksPath = value.endsWith("\0")
            ? value.slice(0, -1)
            : value;
        } catch {
          // No configured hooks path uses the repository's hooks directory.
        }
        let hooksPath: string | null;
        if (configuredHooksPath === null) {
          hooksPath = run(
            [
              "rev-parse",
              "--path-format=absolute",
              "--git-path",
              "hooks",
            ],
            undefined,
            root,
          ).trim();
        } else if (configuredHooksPath === "") {
          hooksPath = null;
        } else {
          hooksPath = isAbsolute(configuredHooksPath)
            ? configuredHooksPath
            : join(root, configuredHooksPath);
        }

        const shellQuote = (value: string): string => {
          const shellPath = Deno.build.os === "windows"
            ? value.replaceAll("\\", "/")
            : value;
          return `'${shellPath.replaceAll("'", `'"'"'`)}'`;
        };
        const proxyStart = `'cfview.hookProxyStart'='${hookProxyMarker}'`;
        const proxyEnd = `'cfview.hookProxyEnd'='${hookProxyMarker}'`;
        const stripProxyConfig = `cf_view_proxy_start=${shellQuote(proxyStart)}
cf_view_proxy_end=${shellQuote(proxyEnd)}
case "\${GIT_CONFIG_PARAMETERS-}" in
  *"$cf_view_proxy_start"*"$cf_view_proxy_end"*) ;;
  *) exit 1 ;;
esac
cf_view_config_prefix=\${GIT_CONFIG_PARAMETERS%%"$cf_view_proxy_start"*}
cf_view_config_after_start=\${GIT_CONFIG_PARAMETERS#*"$cf_view_proxy_start"}
cf_view_config_suffix=\${cf_view_config_after_start#*"$cf_view_proxy_end"}
GIT_CONFIG_PARAMETERS=$cf_view_config_prefix$cf_view_config_suffix
export GIT_CONFIG_PARAMETERS
`;
        const sourceGitDir = run(
          [
            "rev-parse",
            "--path-format=absolute",
            "--absolute-git-dir",
          ],
          undefined,
          root,
        ).replace(/\r?\n$/, "");
        const normalizeForeignHooksPath = Deno.build.os === "windows"
          ? `hooks_path=$(printf '%s\\n' "$hooks_path" | sed 's|\\\\|/|g')
`
          : "";
        const foreignHookRoute = (name: string): string =>
          `current_git_dir=$(git rev-parse --path-format=absolute --absolute-git-dir 2>/dev/null) || exit 1
if test "$current_git_dir" != ${shellQuote(sourceGitDir)}; then
  ${stripProxyConfig}
  hooks_path=$(git config --path --get core.hooksPath)
  config_status=$?
  if test "$config_status" -eq 1; then
    hooks_path=$(git rev-parse --path-format=absolute --git-path hooks) || exit 1
  elif test "$config_status" -ne 0; then
    exit "$config_status"
  elif test -z "$hooks_path"; then
    exit 0
  fi
  ${normalizeForeignHooksPath}case "$hooks_path" in
    /*|[A-Za-z]:/*) ;;
    *)
      hook_root=$(git rev-parse --show-toplevel 2>/dev/null) ||
        hook_root=$(git rev-parse --absolute-git-dir) || exit 1
      hooks_path="$hook_root/$hooks_path"
      ;;
  esac
  foreign_hook="$hooks_path/${name}"
  if test -x "$foreign_hook"; then
    exec "$foreign_hook" "$@"
  fi
  exit 0
fi
`;
        const hookNames = [
          "applypatch-msg",
          "pre-applypatch",
          "post-applypatch",
          "pre-commit",
          "pre-merge-commit",
          "prepare-commit-msg",
          "commit-msg",
          "post-commit",
          "pre-rebase",
          "post-checkout",
          "post-merge",
          "pre-push",
          "pre-receive",
          "update",
          "proc-receive",
          "post-receive",
          "post-update",
          "push-to-checkout",
          "pre-auto-gc",
          "post-rewrite",
          "sendemail-validate",
          "fsmonitor-watchman",
          "p4-changelist",
          "p4-prepare-changelist",
          "p4-post-changelist",
          "p4-pre-submit",
          "post-index-change",
        ];
        const missingRefObject = "0".repeat(oldHead.length);
        const captureTarget = (variable: string): string =>
          `${variable}=$(git rev-parse --verify ${
            shellQuote(targetRef)
          } 2>/dev/null) || ${variable}=${missingRefObject}\n`;
        const recordTargetTransition =
          `if test "$cf_view_target_before" != "$cf_view_target_after"; then\n` +
          `  printf '%s %s %s\\n' "$cf_view_target_before" "$cf_view_target_after" ${
            shellQuote(targetRef)
          } >> ${shellQuote(referenceJournal)} || exit 1\n` +
          `fi\n`;
        const proxyPath = join(tempDir, "hooks");
        Deno.mkdirSync(proxyPath);
        for (const name of hookNames) {
          const original = hooksPath === null ? null : join(hooksPath, name);
          const runOriginal = original === null
            ? ""
            : `if test -x ${shellQuote(original)}; then
  ${shellQuote(original)} "$@"
  status=$?
fi
`;
          const wrapper = join(proxyPath, name);
          Deno.writeTextFileSync(
            wrapper,
            `#!/bin/sh
${foreignHookRoute(name)}${
              captureTarget("cf_view_target_before")
            }${stripProxyConfig}status=0
${runOriginal}${
              captureTarget("cf_view_target_after")
            }${recordTargetTransition}exit "$status"
`,
          );
          Deno.chmodSync(wrapper, 0o755);
        }

        const original = hooksPath === null
          ? null
          : join(hooksPath, "reference-transaction");
        const wrapper = join(proxyPath, "reference-transaction");
        const payloadPrefix = `${referenceJournal}.payload`;
        const runOriginal = original === null
          ? ""
          : `if test -x ${shellQuote(original)}; then
  ${shellQuote(original)} "$@" < "$payload"
status=$?
fi
`;
        Deno.writeTextFileSync(
          wrapper,
          `#!/bin/sh
${foreignHookRoute("reference-transaction")}payload=${
            shellQuote(payloadPrefix)
          }.$$
cat > "$payload" || exit 1
status=0
if test "\${1-}" = committed; then
  cat "$payload" >> ${shellQuote(referenceJournal)} || exit 1
fi
${captureTarget("cf_view_target_before")}${stripProxyConfig}${runOriginal}${
            captureTarget("cf_view_target_after")
          }${recordTargetTransition}rm -f "$payload"
exit "$status"
`,
        );
        Deno.chmodSync(wrapper, 0o755);
        return proxyPath;
      };
      let hookProxy: string;
      try {
        hookProxy = installHookProxy();
      } catch (error) {
        try {
          Deno.removeSync(tempDir, { recursive: true });
        } catch {
          // Temporary content cleanup is best effort.
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not prepare Git hooks for the amend; no commit was amended: ${detail}`,
        );
      }
      const prepared: Array<{
        path: string;
        commit: ObjectEntry;
        before: IndexEntry | null;
        after: IndexEntry | null;
      }> = [];
      let contentNumber = 0;
      const tempFile = (contents: Uint8Array): string => {
        const path = join(tempDir, `content-${contentNumber++}`);
        Deno.writeFileSync(path, contents);
        return path;
      };
      const hash = (
        contents: string,
        repoPath: string,
        encode: (text: string) => Uint8Array,
      ): string => {
        const contentPath = tempFile(encode(contents));
        return run(
          ["hash-object", "-w", `--path=${repoPath}`, contentPath],
          undefined,
          root,
        ).trim();
      };
      const mergeIndex = (
        path: string,
        indexed: string,
        original: string,
        amended: string,
      ): string => {
        if (indexed === original) return amended;
        if (indexed === amended || amended === original) return indexed;
        const result = new Deno.Command("git", {
          args: [
            "merge-file",
            "-p",
            "-L",
            "staged version",
            "-L",
            "current HEAD",
            "-L",
            "pager version",
            tempFile(encoder.encode(indexed)),
            tempFile(encoder.encode(original)),
            tempFile(encoder.encode(amended)),
          ],
          cwd: root,
          stdout: "piped",
          stderr: "piped",
        }).outputSync();
        if (result.code > 0 && result.code < 128) {
          throw new Error(
            `Pager edits conflict with staged changes in ${path}; no commit was amended.`,
          );
        }
        if (!result.success) {
          const error = decoder.decode(result.stderr).trim();
          throw new Error(error || `Could not merge staged changes in ${path}`);
        }
        return decoder.decode(result.stdout);
      };
      let committedHead: string | null = null;
      let publishedRef: string | null = null;
      let publishedLogRef: string | null = null;
      let rollbackHead: string | null = null;
      let refUpdated = false;
      let indexLock: string | null = null;
      let ownsIndexLock = false;
      let preparedIndex: string | null = null;
      const referenceLocks: string[] = [];
      const releaseReferenceLocks = (): string[] => {
        const errors: string[] = [];
        for (let index = referenceLocks.length - 1; index >= 0; index--) {
          try {
            Deno.removeSync(referenceLocks[index]);
            referenceLocks.splice(index, 1);
          } catch (error) {
            const lock = referenceLocks[index];
            const quarantine = join(
              dirname(lock),
              `.cf-view-lock-${crypto.randomUUID()}`,
            );
            try {
              Deno.renameSync(lock, quarantine);
              referenceLocks.splice(index, 1);
              errors.push(`${error}; moved the lock to ${quarantine}`);
            } catch (renameError) {
              errors.push(`${error}; could not move the lock: ${renameError}`);
            }
          }
        }
        return errors;
      };
      const sameIndexEntry = (
        a: IndexEntry | null,
        b: IndexEntry | null,
      ): boolean =>
        a === null || b === null
          ? a === b
          : a.mode === b.mode && a.object === b.object &&
            a.assumeUnchanged === b.assumeUnchanged &&
            a.skipWorktree === b.skipWorktree;
      try {
        for (const [absolute, contents] of files) {
          const path = repoPath(absolute);
          const headEntry = treeEntry(oldHead, path);
          if (!headEntry) {
            throw new Error(`git commit does not contain ${path}`);
          }
          const before = indexEntry(path);
          if (
            before !== null &&
            (Number.parseInt(before.mode, 8) & 0o170000) !==
              (Number.parseInt(headEntry.mode, 8) & 0o170000)
          ) {
            throw new Error(
              `Pager edits conflict with a staged file type change in ${path}; no commit was amended.`,
            );
          }
          const headBlob = readFilteredBlob(headEntry.object, path);
          const indexedBlob = before === null
            ? null
            : readFilteredBlob(before.object, path);
          const after = before === null || indexedBlob === null ? null : {
            mode: before.mode,
            object: hash(
              mergeIndex(
                path,
                indexedBlob.text,
                headBlob.text,
                contents,
              ),
              path,
              indexedBlob.encode,
            ),
            assumeUnchanged: before.assumeUnchanged,
            skipWorktree: before.skipWorktree,
          };
          prepared.push({
            path,
            commit: {
              mode: headEntry.mode,
              object: hash(contents, path, headBlob.encode),
            },
            before,
            after,
          });
        }

        run(["read-tree", oldHead], tempEnv, root);
        for (const file of prepared) {
          run(
            [
              "update-index",
              "--add",
              "--cacheinfo",
              `${file.commit.mode},${file.commit.object},${file.path}`,
            ],
            tempEnv,
            root,
          );
        }
        const expectedTree = run(["write-tree"], tempEnv, root).trim();
        const commitMessageBytes = (raw: Uint8Array): Uint8Array => {
          for (let index = 0; index + 1 < raw.length; index++) {
            if (raw[index] === 10 && raw[index + 1] === 10) {
              return raw.slice(index + 2);
            }
          }
          return new Uint8Array();
        };
        const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
          a.length === b.length && a.every((byte, index) => byte === b[index]);
        const oldCommitBytes = runBytes(
          ["cat-file", "commit", oldHead],
          undefined,
          root,
        );
        const oldCommit = decoder.decode(oldCommitBytes);
        const commitLineage = (raw: string) => {
          const separator = raw.indexOf("\n\n");
          const header = separator < 0 ? raw : raw.slice(0, separator);
          const lines = header.split("\n");
          return {
            author: lines.find((line) => line.startsWith("author ")) ?? "",
            encoding: lines.find((line) =>
              line.startsWith("encoding ")
            )?.slice(9) ??
              "UTF-8",
            parents: lines.filter((line) => line.startsWith("parent ")),
          };
        };
        const oldLineage = commitLineage(oldCommit);
        const oldMessage = commitMessageBytes(oldCommitBytes);
        const hasOriginalLineage = (object: string): boolean => {
          try {
            const lineage = commitLineage(
              run(["cat-file", "commit", object], undefined, root),
            );
            return lineage.author === oldLineage.author &&
              lineage.parents.length === oldLineage.parents.length &&
              lineage.parents.every((parent, index) =>
                parent === oldLineage.parents[index]
              );
          } catch {
            return false;
          }
        };
        const replacementMessage = message === null
          ? null
          : message.length === 0
          ? ""
          : message.endsWith("\n")
          ? message
          : `${message}\n`;
        const expectedMessage = replacementMessage === null
          ? oldMessage
          : encoder.encode(replacementMessage);
        const commitEncoding = replacementMessage === null
          ? oldLineage.encoding
          : "UTF-8";
        const messageFile = join(tempDir, `content-${contentNumber++}`);
        Deno.writeFileSync(messageFile, expectedMessage);
        const reflogAction = `cf-view-amend-${crypto.randomUUID()}`;
        const commitOutput = run(
          [
            "-c",
            "core.logAllRefUpdates=always",
            "-c",
            `core.abbrev=${oldHead.length}`,
            "-c",
            "color.ui=false",
            "-c",
            "color.status=false",
            "-c",
            `i18n.commitEncoding=${commitEncoding}`,
            "-c",
            `cfview.hookProxyStart=${hookProxyMarker}`,
            "-c",
            `core.hooksPath=${hookProxy}`,
            "-c",
            `cfview.hookProxyEnd=${hookProxyMarker}`,
            "commit",
            "--amend",
            "--no-quiet",
            "--allow-empty",
            "--allow-empty-message",
            "--cleanup=verbatim",
            "-F",
            messageFile,
          ],
          { ...tempEnv, GIT_REFLOG_ACTION: reflogAction },
          root,
        );
        const markedRefs = new Set(
          run(
            ["reflog", "show", "--all", "--format=%H%x00%gD%x00%gs"],
            undefined,
            root,
          ).split("\n").flatMap((line) => {
            const [, selector, subject] = line.split("\0");
            const suffix = selector?.lastIndexOf("@{") ?? -1;
            return suffix > 0 && subject?.startsWith(`${reflogAction}:`)
              ? [selector.slice(0, suffix)]
              : [];
          }),
        );
        markedRefs.add(targetRef);
        markedRefs.add("HEAD");
        interface ReflogTransition {
          ref: string;
          old: string;
          object: string;
          marked: boolean;
          sequence: number;
        }
        const readFileReflogTransitions = (
          ref: string,
        ): ReflogTransition[] => {
          try {
            const logPath = run(
              [
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                `logs/${ref}`,
              ],
              undefined,
              root,
            ).trim();
            return Deno.readTextFileSync(logPath).split("\n").flatMap(
              (line, sequence): ReflogTransition[] => {
                const tab = line.indexOf("\t");
                if (tab < 0) return [];
                const [old, object] = line.slice(0, tab).split(" ");
                if (!old || !object) return [];
                return [{
                  ref,
                  old,
                  object,
                  marked: line.slice(tab + 1).startsWith(`${reflogAction}:`),
                  sequence,
                }];
              },
            );
          } catch {
            return [];
          }
        };
        const readPublicReflogTransitions = (
          ref: string,
        ): ReflogTransition[] => {
          try {
            const newestFirst = run(
              ["reflog", "show", ref, "--format=%H%x00%gD%x00%gs"],
              undefined,
              root,
            ).split("\n").flatMap((line) => {
              const [object, selector, subject] = line.split("\0");
              const suffix = selector?.lastIndexOf("@{") ?? -1;
              const ordinal = suffix > 0 && selector.endsWith("}")
                ? Number(selector.slice(suffix + 2, -1))
                : Number.NaN;
              return object && Number.isSafeInteger(ordinal)
                ? [{ object, subject: subject ?? "", ordinal }]
                : [];
            }).sort((a, b) => a.ordinal - b.ordinal);
            return newestFirst.map((entry, index) => ({
              ref,
              old: newestFirst[index + 1]?.object ?? oldHead,
              object: entry.object,
              marked: entry.subject.startsWith(`${reflogAction}:`),
              sequence: newestFirst.length - index - 1,
            })).reverse();
          } catch {
            return [];
          }
        };
        const readReflogTransitions = fileBackedRefs
          ? readFileReflogTransitions
          : readPublicReflogTransitions;
        const transactionTransitions = (() => {
          try {
            return Deno.readTextFileSync(referenceJournal).split("\n").flatMap(
              (line, sequence): ReflogTransition[] => {
                const first = line.indexOf(" ");
                const second = line.indexOf(" ", first + 1);
                if (first < 0 || second < 0) return [];
                const old = line.slice(0, first);
                const object = line.slice(first + 1, second);
                const ref = line.slice(second + 1);
                return old && object && ref
                  ? [{ ref, old, object, marked: true, sequence }]
                  : [];
              },
            );
          } catch {
            return [];
          }
        })();
        const markerTip = (
          refTransitions: readonly ReflogTransition[],
          anchor: ReflogTransition,
        ): string => {
          let tip = anchor.object;
          const start = refTransitions.findIndex((entry) =>
            entry.sequence === anchor.sequence
          );
          for (let index = start + 1; index < refTransitions.length; index++) {
            const next = refTransitions[index];
            if (!next?.marked) break;
            if (
              next.old !== tip &&
              !(next.old === next.object && /^0+$/.test(next.object))
            ) break;
            tip = next.object;
          }
          return tip;
        };
        const transitions = transactionTransitions.length > 0
          ? transactionTransitions
          : [...markedRefs].flatMap(readReflogTransitions);
        const missingObject = "0".repeat(oldHead.length);
        const refObject = (ref: string): string => {
          try {
            return run(["rev-parse", ref], undefined, root).trim();
          } catch {
            return missingObject;
          }
        };
        const symbolicHead = (): string | null => {
          try {
            return run(
              ["rev-parse", "--symbolic-full-name", "HEAD"],
              undefined,
              root,
            ).trim();
          } catch {
            return null;
          }
        };
        const currentRef = symbolicHead();
        const currentHead = refObject("HEAD");
        const anchored = transitions.filter((entry) =>
          entry.marked && entry.old === oldHead &&
          hasOriginalLineage(entry.object)
        );
        const targetEntries = anchored.filter((entry) =>
          entry.ref === targetRef
        );
        const namedEntries = anchored.filter((entry) => entry.ref !== "HEAD");
        const candidates = targetEntries.length > 0
          ? targetEntries
          : namedEntries.length > 0
          ? namedEntries
          : anchored.filter((entry) =>
            entry.ref === "HEAD" &&
            (currentRef === "HEAD" ||
              (currentRef === targetRef && entry.object === oldHead))
          );
        const uniqueCandidates = [...new Map(
          candidates.map((entry) => [
            `${entry.ref}\0${entry.object}\0${entry.sequence}`,
            entry,
          ]),
        ).values()];
        const published = uniqueCandidates.length === 1
          ? uniqueCandidates[0]
          : null;
        publishedLogRef = published?.ref ?? null;
        publishedRef = published?.ref === "HEAD" && currentRef !== "HEAD"
          ? targetRef
          : published?.ref ?? null;
        committedHead = published?.object ?? null;
        if (published) {
          const refTransitions = transitions.filter((entry) =>
            entry.ref === publishedLogRef
          );
          rollbackHead = markerTip(refTransitions, published);
        }
        if (!published && uniqueCandidates.length === 0) {
          const resolvedTarget = refObject(targetRef);
          const targetHead = resolvedTarget === missingObject
            ? null
            : resolvedTarget;
          const summaryObjects = new Set(
            [...commitOutput.matchAll(/ ([0-9a-f]{40}|[0-9a-f]{64})\]/g)]
              .map((match) => match[1]),
          );
          if (
            targetHead !== null && summaryObjects.has(targetHead) &&
            hasOriginalLineage(targetHead) &&
            (targetRef !== "HEAD" || currentRef === "HEAD")
          ) {
            publishedLogRef = targetRef;
            publishedRef = targetRef;
            committedHead = targetHead;
            rollbackHead = targetHead;
          }
        }
        refUpdated = publishedRef !== null && committedHead !== null;
        if (!refUpdated) {
          throw new Error(
            uniqueCandidates.length > 1
              ? "Git published more than one possible amended commit."
              : "Git did not publish the amended commit.",
          );
        }
        if (committedHead === null || publishedRef === null) {
          throw new Error("Git did not publish the amended commit.");
        }
        if (!hasOriginalLineage(committedHead)) {
          throw new Error(
            "HEAD changed before Git created the amended commit; no commit was amended.",
          );
        }
        const referenceLockPaths = fileBackedRefs
          ? [
            `${
              run(
                [
                  "rev-parse",
                  "--path-format=absolute",
                  "--git-path",
                  publishedRef,
                ],
                undefined,
                root,
              ).trim()
            }.lock`,
            `${
              run(
                [
                  "rev-parse",
                  "--path-format=absolute",
                  "--git-path",
                  "HEAD",
                ],
                undefined,
                root,
              ).trim()
            }.lock`,
          ]
          : [
            join(
              run(
                [
                  "rev-parse",
                  "--path-format=absolute",
                  "--git-common-dir",
                ],
                undefined,
                root,
              ).trim(),
              "reftable",
              "tables.list.lock",
            ),
            join(
              run(["rev-parse", "--absolute-git-dir"], undefined, root).trim(),
              "reftable",
              "tables.list.lock",
            ),
          ];
        for (const lock of [...new Set(referenceLockPaths)].sort()) {
          try {
            Deno.mkdirSync(dirname(lock), { recursive: true });
            Deno.openSync(lock, { write: true, createNew: true }).close();
            referenceLocks.push(lock);
          } catch {
            throw new Error(
              "The checked-out Git reference is locked; no commit was amended.",
            );
          }
        }
        const lockedRef = symbolicHead();
        const lockedHead = refObject("HEAD");
        const lockedPublished = refObject(publishedRef);
        if (lockedPublished !== rollbackHead) {
          const lockedTransitions = readReflogTransitions(
            publishedLogRef ?? publishedRef,
          );
          const anchor = lockedTransitions.find((entry) =>
            entry.marked && entry.old === oldHead &&
            entry.object === committedHead
          );
          if (anchor) {
            const lockedTip = markerTip(lockedTransitions, anchor);
            if (lockedTip === lockedPublished) rollbackHead = lockedTip;
          }
          if (lockedPublished === committedHead) {
            rollbackHead = committedHead;
          }
        }
        if (
          currentRef !== targetRef || currentHead !== committedHead ||
          lockedRef !== targetRef || lockedHead !== committedHead ||
          lockedPublished !== committedHead
        ) {
          throw new Error(
            "HEAD changed during the amend; no commit was amended.",
          );
        }
        const committedTree = run(
          ["rev-parse", `${committedHead}^{tree}`],
          undefined,
          root,
        ).trim();
        if (committedTree !== expectedTree) {
          throw new Error(
            "A commit hook changed the amended tree; no commit was amended.",
          );
        }
        const rawCommit = runBytes(
          ["cat-file", "commit", committedHead],
          undefined,
          root,
        );
        const committedMessage = commitMessageBytes(rawCommit);
        if (!sameBytes(committedMessage, expectedMessage)) {
          throw new Error(
            "A commit hook changed the amended message; no commit was amended.",
          );
        }
        const finalRef = run(
          ["rev-parse", "--symbolic-full-name", "HEAD"],
          undefined,
          root,
        ).trim();
        const finalHead = run(["rev-parse", "HEAD"], undefined, root).trim();
        if (finalRef !== targetRef || finalHead !== committedHead) {
          throw new Error(
            "HEAD changed before the amend completed; no commit was amended.",
          );
        }
        for (const [path, expected] of expectedWorkspace ?? []) {
          let actual: string;
          try {
            actual = Deno.readTextFileSync(path);
          } catch {
            throw new Error(
              `${path} could not be read after commit hooks ran; no commit was amended.`,
            );
          }
          if (actual !== expected) {
            throw new Error(
              `${path} changed while commit hooks ran; no commit was amended.`,
            );
          }
        }

        if (prepared.length > 0) {
          const realIndex = run(
            ["rev-parse", "--path-format=absolute", "--git-path", "index"],
            undefined,
            root,
          ).trim();
          indexLock = `${realIndex}.lock`;
          try {
            Deno.openSync(indexLock, {
              write: true,
              createNew: true,
            }).close();
            ownsIndexLock = true;
          } catch {
            throw new Error(
              "The Git index is locked; no commit was amended.",
            );
          }
          preparedIndex = Deno.makeTempFileSync({
            dir: dirname(realIndex),
            prefix: "cf-view-index-",
          });
          Deno.copyFileSync(realIndex, preparedIndex);
          const realIndexEnv = { GIT_INDEX_FILE: preparedIndex };
          for (const file of prepared) {
            if (
              !sameIndexEntry(indexEntry(file.path, realIndexEnv), file.before)
            ) {
              throw new Error(
                `The Git index changed for ${file.path} during the amend; no staged changes were overwritten.`,
              );
            }
            setIndexEntry(file.path, file.after, realIndexEnv);
          }
          Deno.copyFileSync(preparedIndex, indexLock);
          Deno.renameSync(indexLock, realIndex);
          ownsIndexLock = false;
        }
        const releaseErrors = releaseReferenceLocks();
        return {
          status: releaseErrors.length === 0
            ? "Amended the commit"
            : `Amended the commit; could not release Git reference locks: ${
              releaseErrors.join("; ")
            }`,
          head: committedHead,
        };
      } catch (error) {
        const rollbackErrors = releaseReferenceLocks();
        if (
          refUpdated && committedHead !== null && publishedRef !== null &&
          rollbackHead !== null
        ) {
          try {
            run(
              [
                "update-ref",
                "-m",
                "cf view: restore HEAD after failed amend",
                publishedRef,
                oldHead,
                rollbackHead,
              ],
              undefined,
              root,
            );
          } catch (rollbackError) {
            rollbackErrors.push(String(rollbackError));
          }
        }
        if (ownsIndexLock && indexLock !== null) {
          try {
            Deno.removeSync(indexLock);
            ownsIndexLock = false;
          } catch (rollbackError) {
            rollbackErrors.push(String(rollbackError));
          }
        }
        const suffix = rollbackErrors.length > 0
          ? `; rollback failed: ${rollbackErrors.join("; ")}`
          : "";
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${detail}${suffix}`);
      } finally {
        if (preparedIndex !== null) {
          try {
            Deno.removeSync(preparedIndex);
          } catch {
            // Temporary index cleanup is best effort.
          }
        }
        try {
          Deno.removeSync(tempDir, { recursive: true });
        } catch {
          // Temporary content cleanup is best effort.
        }
      }
    },
  };
}
