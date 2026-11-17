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

import { dirname, join, relative, resolve } from "@std/path";
import type {
  PatternIndexClient,
  PatternIndexLineage,
  PatternIndexProgramFile,
  PatternIndexPublishResponse,
  PatternIndexVersionSummary,
} from "@commonfabric/pattern-index/client";
import { lineageForEntry } from "./pattern-versions.ts";
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
): Promise<{ lineage: PatternIndexLineage; rows: HistoryRow[] }> {
  const lineage = await requireLineage(client, entry);
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
): Promise<PatternIndexLineage> => {
  const lineage = await lineageForEntry(client, entry);
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
          : ` (published as ${lineage.published.displayName})`
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
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, contents: string) => Promise<void>;
}

/** What `cf pattern rollback` did. */
export interface RollbackReport {
  /** The version restored. */
  restored: number;

  /** The new version it was kept as. */
  version: PatternIndexPublishResponse;

  /** The files written over, relative to the working directory. */
  written: string[];
}

/**
 * The directory a program's file names are rooted at: the entry's path
 * with its program name taken off.
 */
const programRoot = (entry: string, main: string): string => {
  const path = resolve(entry);
  if (!path.endsWith(main)) {
    throw new PatternHistoryError(
      `${entry} is not where this version's entry ${main} lives; run this on the entry file it was deployed from.`,
    );
  }
  return path.slice(0, path.length - main.length);
};

/** The files of `program` that differ from disk under `root`. */
const differing = async (
  files: readonly PatternIndexProgramFile[],
  root: string,
  read: (path: string) => Promise<string>,
): Promise<PatternIndexProgramFile[]> => {
  const out: PatternIndexProgramFile[] = [];
  for (const file of files) {
    const now = await read(join(root, file.name)).catch(() => undefined);
    if (now !== file.contents) out.push(file);
  }
  return out;
};

/**
 * Restores version `spec` of `entry`'s lineage: in the index as its newest
 * version, then over the files on disk.
 *
 * @throws PatternHistoryError when there is nothing to restore, or when the
 *   files on disk hold edits no version keeps and `force` is not set.
 */
export async function rollbackEntry(
  entry: string,
  spec: string,
  options: { force?: boolean },
  deps: RollbackDeps,
): Promise<RollbackReport> {
  const { client } = deps;
  const lineage = await requireLineage(client, entry);
  const { versions } = await client.listVersions({
    lineageId: lineage.lineageId,
  });
  const target = findVersion(versions, spec);
  if (target.head) {
    throw new PatternHistoryError(
      `v${target.seq} is already the current version of ${entry}.`,
    );
  }
  const head = versions.find((v) => v.head);
  if (head !== undefined && !options.force) {
    const current = await client.getVersion({
      versionId: head.versionId,
      includeSource: true,
    });
    if (current.program !== undefined) {
      const root = programRoot(entry, current.program.main);
      const edited = await differing(
        current.program.files,
        root,
        deps.readTextFile,
      );
      if (edited.length > 0) {
        throw new PatternHistoryError(
          `${
            edited.map((f) => relative(Deno.cwd(), join(root, f.name))).join(
              ", ",
            )
          } ha${
            edited.length === 1 ? "s" : "ve"
          } edits that no version keeps; deploy first so they are kept (cf piece setsrc), or pass --force to lose them.`,
        );
      }
    }
  }
  const restored = await client.getVersion({
    versionId: target.versionId,
    includeSource: true,
  });
  if (restored.program === undefined) {
    throw new PatternHistoryError(
      `The index returned no source for v${target.seq}.`,
    );
  }
  const root = programRoot(entry, restored.program.main);
  const version = await client.rollback({
    lineageId: lineage.lineageId,
    toVersionId: target.versionId,
  });
  const changed = await differing(
    restored.program.files,
    root,
    deps.readTextFile,
  );
  const written: string[] = [];
  for (const file of changed) {
    const path = join(root, file.name);
    await Deno.mkdir(dirname(path), { recursive: true });
    await deps.writeTextFile(path, file.contents);
    written.push(relative(Deno.cwd(), path));
  }
  return { restored: target.seq, version, written };
}

/** The rollback as lines for a person. */
export const rollbackLines = (
  entry: string,
  report: RollbackReport,
): string[] => [
  `Restored v${report.restored} of ${entry} as v${report.version.seq ?? "?"}${
    report.written.length === 0
      ? "; the files on disk already matched it."
      : `, writing ${report.written.join(", ")}.`
  }`,
  `Running pieces still have the old source: cf piece setsrc --cell <piece> ${
    shellWord(entry)
  } deploys it.`,
];
