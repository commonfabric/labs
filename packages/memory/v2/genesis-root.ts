import {
  type ClientCommit,
  decodeMemoryBoundary,
  type GenesisRoot,
} from "../v2.ts";
import type { Engine } from "./engine.ts";

/** The immutable custom-root reservation in the durable genesis receipt. */
export function readGenesisRoot(engine: Engine): GenesisRoot | undefined {
  const row = engine.database.prepare(
    'SELECT original FROM "commit" WHERE seq = 1',
  ).get() as { original: string } | undefined;
  return row === undefined
    ? undefined
    : (decodeMemoryBoundary(row.original) as unknown as ClientCommit)
      .genesisRoot;
}

/** Validate the generic root source before genesis can commit it. */
export function isGenesisRoot(value: unknown): value is GenesisRoot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const root = value as Record<string, unknown>;
  if (
    typeof root.source !== "string" || !root.source.startsWith("system:") ||
    typeof root.cause !== "string" || root.cause.length === 0 ||
    root.cause.length > 512
  ) return false;
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
