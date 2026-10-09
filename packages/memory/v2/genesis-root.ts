import type { FabricPlainObject } from "@commonfabric/api";
import { isFabricPlainObject } from "@commonfabric/data-model";
import { decodeTrustedMemoryBoundary, type GenesisRoot } from "../v2.ts";
import type { Engine } from "./engine.ts";
import { isSpaceKind } from "./space-kind.ts";

/** The immutable custom-root reservation in the durable genesis receipt. */
export function readGenesisRoot(engine: Engine): GenesisRoot | undefined {
  const commit = readGenesisReceipt(engine);
  if (commit === null) throw new Error("Invalid genesis receipt");
  if (commit?.genesisRoot === undefined) return undefined;
  if (!isGenesisRoot(commit.genesisRoot)) {
    throw new Error("Invalid genesis receipt");
  }
  return commit.genesisRoot;
}

/**
 * The kind the durable genesis receipt declares, or `undefined` when it
 * declares none. Only a receipt holding a commit whose `spaceKind` is a
 * well-formed kind declares one. Any other receipt declares none: one that
 * holds no commit, as a space's first write need not be a genesis commit, and
 * one whose `spaceKind` is malformed, which a server that did not hold the
 * field to the genesis rules could have kept.
 */
export function readSpaceKind(engine: Engine): string | undefined {
  const spaceKind = readGenesisReceipt(engine)?.spaceKind;
  return isSpaceKind(spaceKind) ? spaceKind : undefined;
}

/** Validate the generic root source before genesis can commit it. */
export function isGenesisRoot(value: unknown): value is GenesisRoot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  if (
    typeof root.cause !== "string" || root.cause.length === 0 ||
    root.cause.length > 512
  ) return false;
  if (root.source === undefined) {
    // A creator-placed root: nothing to create it from, so nothing to
    // create it with either.
    return root.sourceRoots === undefined && root.argument === undefined;
  }
  const validSource = (source: unknown) => {
    if (
      typeof source !== "string" ||
      !/^system:[a-zA-Z0-9_./-]+\.tsx?$/.test(source)
    ) return false;
    const path = source.slice("system:".length);
    return !path.startsWith("/") &&
      path.split("/").every((part) =>
        part !== ".." && part !== "." && part !== ""
      );
  };
  if (
    !validSource(root.source) ||
    (root.sourceRoots !== undefined &&
      (!Array.isArray(root.sourceRoots) ||
        !root.sourceRoots.every(validSource)))
  ) return false;
  return root.argument === undefined ||
    (root.argument !== null && typeof root.argument === "object" &&
      !Array.isArray(root.argument));
}

/**
 * Helper for {@link readGenesisRoot} and {@link readSpaceKind}, which returns
 * the commit a space's genesis receipt holds as it was submitted, `null` when
 * the receipt holds something else, or `undefined` for a space with no
 * history.
 */
function readGenesisReceipt(
  engine: Engine,
): FabricPlainObject | null | undefined {
  const row = engine.database.prepare(
    'SELECT original FROM "commit" WHERE seq = 1',
  ).get() as { original: string } | undefined;
  if (row === undefined) return undefined;
  let commit: ReturnType<typeof decodeTrustedMemoryBoundary>;
  // A receipt that does not decode holds no commit, which is the answer here.
  try {
    commit = decodeTrustedMemoryBoundary(row.original);
  } catch {
    return null;
  }
  return isFabricPlainObject(commit) &&
      Number.isInteger(commit.localSeq) &&
      isFabricPlainObject(commit.reads) &&
      Array.isArray(commit.reads.confirmed) &&
      Array.isArray(commit.reads.pending) &&
      Array.isArray(commit.operations)
    ? commit
    : null;
}
