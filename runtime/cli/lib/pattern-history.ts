/**
 * `cf pattern history` and `cf pattern rollback`: the private versions the
 * index keeps of a person's patterns (see `pattern-versions.ts`), read back
 * and restored. History is the owner's alone; nobody else, admins included,
 * can list it.
 *
 * Rollback puts an old version back in two places: the files on disk, which
 * the person edits next, and the index, where it becomes the lineage's
 * newest version. Unless told `force`, it refuses to write over edits no
 * version keeps, since nothing could bring those back.
 */

import {
  dirname,
  join,
  normalize,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import {
  type PatternIndexClient,
  PatternIndexError,
  type PatternIndexLineage,
  type PatternIndexLink,
  type PatternIndexProgramFile,
  type PatternIndexPublishResponse,
  type PatternIndexVersionSummary,
} from "@commonfabric/pattern-index/client";
import { decodeDataFile, encodeDataFile } from "@commonfabric/text/data-file";
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

  /** Its source's shared version number, and whether that is stable. */
  shared?: { number: number; stable: boolean };
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
        ...(version.shared === undefined ? {} : { shared: version.shared }),
      };
    }),
  };
}

export const requireLineage = async (
  client: Pick<PatternIndexClient, "listLineages">,
  entry: string,
  sources: SlotSources,
): Promise<PatternIndexLineage> => {
  const lineage = await lineageForEntry(client, entry, sources);
  if (lineage === undefined) {
    throw new PatternHistoryError(
      `No versions of ${entry} are kept yet: once this machine has joined an index that keeps them, each cf piece new or cf piece setsrc of it from this file keeps one (a deploy that follows an origin, or of someone else's pattern unchanged, keeps none).`,
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
    }${
      row.shared === undefined
        ? ""
        : `  shared #${row.shared.number} (${
          row.shared.stable ? "stable" : "beta"
        })`
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
      "No patterns of yours are kept yet: once this machine has joined an index that keeps them, each cf piece new or cf piece setsrc of your own pattern from a file keeps a version.",
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
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
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
  // A program's names are rooted (`/main.tsx`), so the suffix match below
  // ends at a path separator and `domain.tsx` cannot pass for `main.tsx`.
  if (
    !main.startsWith("/") || normalize(main) !== main || !path.endsWith(main)
  ) {
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

/**
 * What `readIfThere` returns for a file whose bytes no source package can
 * store: a text file that is not valid UTF-8. It equals no version's contents.
 */
const UNSTORABLE = Symbol("unstorable");

/**
 * The contents of `path` as a source package stores the file `name`, an image
 * as its `data:` URL among them (`decodeDataFile`), `UNSTORABLE` for bytes no
 * package can store, or `undefined` where there is no file. Any other failure
 * to read is thrown, so a file that could not be read is never taken for one
 * that is not there and written over.
 */
const readIfThere = async (
  read: (path: string) => Promise<Uint8Array>,
  path: string,
  name: string,
): Promise<string | typeof UNSTORABLE | undefined> => {
  let bytes: Uint8Array;
  try {
    bytes = await read(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw new PatternHistoryError(
      `${relative(Deno.cwd(), path)} could not be read (${
        error instanceof Error ? error.message : String(error)
      }); nothing was restored.`,
    );
  }
  try {
    return decodeDataFile(bytes, name);
  } catch {
    // Decoding fails only for a text file that is not valid UTF-8.
    return UNSTORABLE;
  }
};

/** The files of `files` whose contents on disk under `root` differ. */
const differing = async (
  files: readonly PatternIndexProgramFile[],
  root: string,
  read: (path: string) => Promise<Uint8Array>,
): Promise<PatternIndexProgramFile[]> => {
  const out: PatternIndexProgramFile[] = [];
  for (const file of files) {
    const now = await readIfThere(read, diskPath(root, file.name), file.name);
    if (now !== file.contents) out.push(file);
  }
  return out;
};

/**
 * Of the files a restore writes, `writing`, those that hold something no
 * version keeps: one of the current version's files that differs from it
 * on disk, or a file only the restored version has that exists on disk.
 * A file the restore leaves alone is never counted.
 */
const unkept = async (
  current: readonly PatternIndexProgramFile[],
  writing: readonly PatternIndexProgramFile[],
  root: string,
  read: (path: string) => Promise<Uint8Array>,
): Promise<string[]> => {
  const kept = new Map(current.map((file) => [file.name, file.contents]));
  const lost: string[] = [];
  for (const file of writing) {
    const path = diskPath(root, file.name);
    const now = await readIfThere(read, path, file.name);
    if (now !== undefined && now !== kept.get(file.name)) {
      lost.push(relative(Deno.cwd(), path));
    }
  }
  return lost;
};

/**
 * Refuses a write that a symbolic link would carry outside `root`: the
 * file itself a link, or a directory on its way that resolves elsewhere.
 * Run once the directories exist.
 */
const requireInside = async (root: string, path: string): Promise<void> => {
  const realRoot = await Deno.realPath(root);
  const realDir = await Deno.realPath(dirname(path));
  const link = await Deno.lstat(path).then(
    (info) => info.isSymlink,
    () => false,
  );
  if (
    link ||
    (realDir !== realRoot && !realDir.startsWith(join(realRoot, SEPARATOR)))
  ) {
    throw new PatternHistoryError(
      `${
        relative(Deno.cwd(), path)
      } is reached through a symbolic link; nothing more was restored.`,
    );
  }
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
    deps.readFile,
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
      changed,
      root,
      deps.readFile,
    );
    if (lost.length > 0) {
      throw new PatternHistoryError(
        `${lost.join(", ")} ha${
          lost.length === 1 ? "s" : "ve"
        } edits that no version keeps; deploy first so they are kept (cf piece setsrc), or pass --force to lose them.`,
      );
    }
  }
  // Every file is encoded before the first is written, so a version holding a
  // binary file whose contents are not a `data:` URL writes nothing.
  const bytes = changed.map((file) => {
    try {
      return encodeDataFile(file.contents, file.name);
    } catch (error) {
      throw new PatternHistoryError(
        `This version's ${file.name} cannot be written as a file (${
          error instanceof Error ? error.message : String(error)
        }); nothing was restored.`,
      );
    }
  });
  for (const file of changed) {
    const path = diskPath(root, file.name);
    await Deno.mkdir(dirname(path), { recursive: true });
    await requireInside(root, path);
  }
  const written: string[] = [];
  for (const [i, file] of changed.entries()) {
    const path = diskPath(root, file.name);
    await deps.writeFile(path, bytes[i]);
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

/** What `cf pattern stable` did. */
export type StableReport =
  | { status: "stable"; number: number; changed: boolean }
  | { status: "pending" };

/**
 * Makes the entry's newest shared version stable: what search and the
 * catalog show. It passed the privacy check when it was shared, so nothing
 * new is exposed. A share still being checked is made stable instead, so
 * an older version never becomes the findable one by being newest so far.
 * The numbers come from the lineage, as the index keeps them.
 */
export async function makeStable(
  client: Pick<PatternIndexClient, "listVersions" | "shareVersion">,
  lineage: PatternIndexLineage,
  entry: string,
): Promise<StableReport> {
  if (lineage.withdrawn === true) {
    throw new PatternHistoryError(
      `${entry} is not shared: cf pattern share shares it again, on beta.`,
    );
  }
  if (lineage.head.share === "pending") {
    await shareStable(client, lineage.head.versionId, entry);
    return { status: "pending" };
  }
  const latest = lineage.channels?.latest;
  if (latest === undefined) {
    throw new PatternHistoryError(
      `Nothing of ${entry} is shared yet: cf pattern share shares it on beta first.`,
    );
  }
  if (lineage.channels?.stable === latest) {
    return { status: "stable", number: latest, changed: false };
  }
  const { versions } = await client.listVersions({
    lineageId: lineage.lineageId,
  });
  const holder = versions.find((version) => version.shared?.number === latest);
  if (holder === undefined) {
    throw new PatternHistoryError(
      `The version shared as #${latest} of ${entry} is no longer kept: cf pattern share shares the current one, then cf pattern stable.`,
    );
  }
  await shareStable(client, holder.versionId, entry);
  return { status: "stable", number: latest, changed: true };
}

const shareStable = async (
  client: Pick<PatternIndexClient, "shareVersion">,
  versionId: string,
  entry: string,
): Promise<void> => {
  try {
    await client.shareVersion({ versionId, channel: "stable" });
  } catch (error) {
    if (error instanceof PatternIndexError && error.status === 409) {
      throw new PatternHistoryError(
        `A newer version of ${entry} was shared since this looked; run cf pattern stable again.`,
      );
    }
    throw error;
  }
};

/** `cf pattern stable`'s answer as a line. */
export const stableLine = (entry: string, report: StableReport): string =>
  report.status === "pending"
    ? `${entry} is still being checked; once it passes it is stable, and search and the catalog show it.`
    : report.changed
    ? `Shared version #${report.number} of ${entry} is stable: search and the catalog show it.`
    : `Shared version #${report.number} of ${entry} is stable already.`;

/** Which shared version a link names. */
export type LinkChannel = "stable" | "beta" | number;

/** What `cf pattern link` found. */
export interface LinkReport {
  /** The link: the lineage's pseudonym, with `@beta` or `@<n>`. */
  ref: string;

  /** What it names now. */
  link: PatternIndexLink;
}

/**
 * A link to the lineage's shared version on `channel`, checked with the
 * index (`getPattern {ref}`), so it is never one that opens nothing. Asked
 * for stable when nothing is stable yet, it gives beta.
 */
export async function patternLink(
  client: Pick<PatternIndexClient, "getPattern">,
  lineage: PatternIndexLineage,
  entry: string,
  channel: LinkChannel,
): Promise<LinkReport> {
  const tried: readonly LinkChannel[] = channel === "stable"
    ? ["stable", "beta"]
    : [channel];
  for (const each of tried) {
    const ref = each === "stable"
      ? lineage.pseudonym
      : `${lineage.pseudonym}@${each}`;
    try {
      const { link } = await client.getPattern({ ref });
      if (link !== undefined) return { ref, link };
    } catch (error) {
      if (!(error instanceof PatternIndexError && error.status === 404)) {
        throw error;
      }
    }
  }
  throw new PatternHistoryError(
    typeof channel === "number"
      ? `${entry} has no shared version #${channel}.`
      : `Nothing of ${entry} is shared yet, or its share is still being checked: cf pattern share shares it on beta.`,
  );
}

/** The link as a line: what it names, and whose name it shows. */
export const linkLine = (
  entry: string,
  lineage: Pick<PatternIndexLineage, "published">,
  { ref, link }: LinkReport,
): string =>
  `${ref}: ${entry}, ${
    link.channel === "number"
      ? `exactly shared version #${link.number}`
      : `${link.channel} (shared version #${link.number} now)`
  }. ${
    lineage.published === undefined
      ? "It names the pattern, not you."
      : "It shows your name, as the pattern is published under it."
  }`;
