/**
 * `cf pattern history` and `cf pattern rollback`: the private versions the
 * index keeps of a person's patterns (see `pattern-versions.ts`), read back
 * and restored. History is the owner's alone; nobody else, admins included,
 * can list it.
 *
 * Rollback puts an old version back in two places: the index, where it
 * becomes the lineage's newest version, and the files on disk, which the
 * person edits next. It never runs over edits that are not kept as a
 * version, since nothing could bring those back.
 */

import {
  dirname,
  join,
  normalize,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import type {
  PatternIndexClient,
  PatternIndexLineage,
  PatternIndexProgramFile,
  PatternIndexPublishResponse,
  PatternIndexVersionSummary,
} from "@commonfabric/pattern-index/client";
import { lineageForEntry, type SlotSources } from "./pattern-versions.ts";
import { shellWord } from "./shell-quote.ts";

/** A refusal phrased for the person, with nothing written. */
export class PatternHistoryError extends Error {
  override name = "PatternHistoryError";
}

/** One version as `cf pattern history` reports it. */
export interface HistoryRow {
  seq: number;
  versionId: string;
  createdAt: string;
  visibility: PatternIndexVersionSummary["visibility"];
  share: PatternIndexVersionSummary["share"];
  current: boolean;

  /** The version number whose source a rollback restored. */
  rolledBackFrom?: number;
}

/** The versions kept for `entry`, newest first. */
export async function entryHistory(
  client: Pick<PatternIndexClient, "listLineages" | "listVersions">,
  entry: string,
  sources: SlotSources,
): Promise<{ lineage: PatternIndexLineage; rows: HistoryRow[] }> {
  const lineage = await requireLineage(client, entry, sources);
  const { versions } = await client.listVersions({
    lineageId: lineage.lineageId,
  });
  const seqOf = new Map(versions.map((v) => [v.versionId, v.seq]));
  return {
    lineage,
    rows: versions.map((version) => {
      const from = version.rolledBackFrom === undefined
        ? undefined
        : seqOf.get(version.rolledBackFrom);
      return {
        seq: version.seq,
        versionId: version.versionId,
        createdAt: version.createdAt,
        visibility: version.visibility,
        share: version.share,
        current: version.head,
        ...(from === undefined ? {} : { rolledBackFrom: from }),
      };
    }),
  };
}

const requireLineage = async (
  client: Pick<PatternIndexClient, "listLineages">,
  entry: string,
  sources: SlotSources,
): Promise<PatternIndexLineage> => {
  const lineage = await lineageForEntry(client, entry, sources);
  if (lineage === undefined) {
    throw new PatternHistoryError(
      `No versions of ${entry} are kept yet: deploying it (cf piece new or cf piece setsrc) keeps one each time.`,
    );
  }
  return lineage;
};

/** Where a version stands, in a few words. */
export const standing = (
  version: Pick<HistoryRow, "visibility" | "share">,
): string => {
  if (version.visibility !== "private") return version.visibility;
  switch (version.share) {
    case "pending":
      return "private, being checked to share";
    case "held":
      return "private, held by the privacy check";
    case "error":
      return "private, the check to share failed";
    case "public_elsewhere":
      return "private, the same source is already shared by someone else";
    default:
      return "private";
  }
};

/** The history as lines for a person. */
export const historyLines = (entry: string, rows: HistoryRow[]): string[] => [
  `Versions of ${entry}, newest first:`,
  ...rows.map((row) =>
    `  ${`v${row.seq}`.padEnd(5)} ${
      row.createdAt.slice(0, 16).replace("T", " ")
    }  ${standing(row)}${row.current ? "  (current)" : ""}${
      row.rolledBackFrom === undefined
        ? ""
        : `  restores v${row.rolledBackFrom}`
    }`
  ),
  `Restore one with: cf pattern rollback ${shellWord(entry)} <version>`,
];

/** Your lineages as lines for a person. */
export const lineageLines = (
  lineages: readonly PatternIndexLineage[],
): string[] =>
  lineages.length === 0
    ? [
      "No patterns of yours are kept yet: deploying one with cf piece new or cf piece setsrc keeps a version each time.",
    ]
    : lineages.map((lineage) =>
      `${lineage.name ?? lineage.description}: ${lineage.versions} version${
        lineage.versions === 1 ? "" : "s"
      }, newest v${lineage.head.seq} ${standing(lineage.head)}${
        lineage.published === undefined
          ? ` (shown as ${lineage.pseudonym})`
          : ` (published under your name${
            lineage.published.displayName === undefined
              ? ""
              : `, ${lineage.published.displayName}`
          })`
      }`
    );

/**
 * The version `spec` names among `versions`: `3` or `v3` by number, else a
 * version id.
 */
export const findVersion = (
  versions: readonly PatternIndexVersionSummary[],
  spec: string,
): PatternIndexVersionSummary => {
  const number = spec.match(/^v?(\d+)$/i);
  const found = number === null
    ? versions.find((v) => v.versionId === spec)
    : versions.find((v) => v.seq === Number(number[1]));
  if (found === undefined) {
    throw new PatternHistoryError(
      `There is no version ${spec}; cf pattern history lists them.`,
    );
  }
  return found;
};

export interface RollbackDeps {
  client: Pick<
    PatternIndexClient,
    "listLineages" | "listVersions" | "getVersion" | "rollback"
  >;
  sources: SlotSources;
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, contents: string) => Promise<void>;
}

/** What `cf pattern rollback` did. */
export interface RollbackReport {
  /** The version restored. */
  restored: number;

  /**
   * The new version it was kept as; absent when it restored the current
   * version's files, which keeps no new one.
   */
  version?: PatternIndexPublishResponse;

  /** The files written over, relative to the working directory. */
  written: string[];
}

const programRoot = (entry: string, main: string): string => {
  const path = resolve(entry);
  if (!path.endsWith(main) || normalize(main) !== main) {
    throw new PatternHistoryError(
      `${entry} is not where this version's entry ${main} lives; run this on the entry file it was deployed from.`,
    );
  }
  return path.slice(0, path.length - main.length);
};

/**
 * Where `name`, a program file's name, lives under `root`.
 *
 * @throws PatternHistoryError for a name that reaches outside `root`; the
 *   index serves the names, and a rollback writes only inside the project.
 */
const diskPath = (root: string, name: string): string => {
  const path = join(root, name);
  if (!path.startsWith(join(root, SEPARATOR))) {
    throw new PatternHistoryError(
      `This version names a file outside the pattern's directory (${name}); nothing was restored.`,
    );
  }
  return path;
};

/** The files of `files` whose contents on disk under `root` differ. */
const differing = async (
  files: readonly PatternIndexProgramFile[],
  root: string,
  read: (path: string) => Promise<string>,
): Promise<PatternIndexProgramFile[]> => {
  const out: PatternIndexProgramFile[] = [];
  for (const file of files) {
    const now = await read(diskPath(root, file.name)).catch(() => undefined);
    if (now !== file.contents) out.push(file);
  }
  return out;
};

/**
 * The files a restore would write over that hold something no version
 * keeps: a file of the current version that differs from it on disk, and a
 * file only the restored version has that exists on disk with other
 * contents.
 */
const unkept = async (
  current: readonly PatternIndexProgramFile[],
  restoring: readonly PatternIndexProgramFile[],
  root: string,
  read: (path: string) => Promise<string>,
): Promise<string[]> => {
  const inCurrent = new Set(current.map((file) => file.name));
  const edited = (await differing(current, root, read)).map((f) => f.name);
  for (const file of restoring) {
    if (inCurrent.has(file.name)) continue;
    const now = await read(diskPath(root, file.name)).catch(() => undefined);
    if (now !== undefined && now !== file.contents) edited.push(file.name);
  }
  return edited.map((name) => relative(Deno.cwd(), diskPath(root, name)));
};

/**
 * Restores version `spec` of `entry`'s lineage: over the files on disk,
 * then in the index as its newest version, so a write that fails leaves the
 * index where it was. Restoring the current version only writes its files
 * back, which `force` must allow since it loses what differs.
 *
 * @throws PatternHistoryError when there is nothing to restore, when a file
 *   it would write over holds something no version keeps and `force` is
 *   not set, or when the index serves a file outside the pattern's directory.
 */
export async function rollbackEntry(
  entry: string,
  spec: string,
  options: { force?: boolean },
  deps: RollbackDeps,
): Promise<RollbackReport> {
  const { client } = deps;
  const lineage = await requireLineage(client, entry, deps.sources);
  const { versions } = await client.listVersions({
    lineageId: lineage.lineageId,
  });
  const target = findVersion(versions, spec);
  const restored = await client.getVersion({
    versionId: target.versionId,
    includeSource: true,
  });
  if (restored.program === undefined) {
    throw new PatternHistoryError(
      `The index returned no source for v${target.seq}; nothing was restored.`,
    );
  }
  const root = programRoot(entry, restored.program.main);
  const changed = await differing(
    restored.program.files,
    root,
    deps.readTextFile,
  );
  if (target.head && changed.length === 0) {
    throw new PatternHistoryError(
      `v${target.seq} is already the current version of ${entry}, and the files match it.`,
    );
  }
  if (!options.force) {
    const head = versions.find((v) => v.head);
    const current = head === undefined || head.versionId === target.versionId
      ? restored
      : await client.getVersion({
        versionId: head.versionId,
        includeSource: true,
      });
    if (current.program === undefined) {
      throw new PatternHistoryError(
        `The index returned no source for the current version, so whether ${entry} has edits no version keeps cannot be told; pass --force to restore anyway.`,
      );
    }
    const lost = await unkept(
      current.program.files,
      restored.program.files,
      root,
      deps.readTextFile,
    );
    if (lost.length > 0) {
      throw new PatternHistoryError(
        `${lost.join(", ")} ha${
          lost.length === 1 ? "s" : "ve"
        } edits that no version keeps; deploy first so they are kept (cf piece setsrc), or pass --force to lose them.`,
      );
    }
  }
  const written: string[] = [];
  for (const file of changed) {
    const path = diskPath(root, file.name);
    await Deno.mkdir(dirname(path), { recursive: true });
    await deps.writeTextFile(path, file.contents);
    written.push(relative(Deno.cwd(), path));
  }
  const version = target.head ? undefined : await client.rollback({
    lineageId: lineage.lineageId,
    toVersionId: target.versionId,
  });
  return {
    restored: target.seq,
    ...(version === undefined ? {} : { version }),
    written,
  };
}

/** The rollback as lines for a person. */
export const rollbackLines = (
  entry: string,
  report: RollbackReport,
): string[] => [
  `Restored v${report.restored} of ${entry}${
    report.version === undefined ? "" : ` as v${report.version.seq ?? "?"}`
  }${
    report.written.length === 0
      ? "; the files on disk already matched it."
      : `, writing ${report.written.join(", ")}.`
  }`,
  `Running pieces still have the old source: cf piece setsrc --cell <piece> ${
    shellWord(entry)
  } deploys it.`,
];
