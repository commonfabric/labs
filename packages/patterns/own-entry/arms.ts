/**
 * The boards `measure-start.ts` can build, one per arm. Each board files
 * topics through `addTopic`, publishes them as `topics`, and files topics that
 * take a `mention` event. Each topic publishes what it shows about itself as
 * `referencedBy` and `shortName`, which is what the checks read.
 */

// deno-lint-ignore no-explicit-any
type Json = any;

export interface Arm {
  /** Which sources the arm's board and topic were copied from. */
  base: "topics" | "collection-naming";

  /** The board's source, relative to `packages/patterns`. */
  board: string;

  /** The board's argument, when it takes one. */
  boardArgument?: Json;

  /** The inputs of a topic's argument the replay roots a query at. */
  replayInputs: string[];

  /** The schema the checks read a topic's result under. */
  checkSchema: Json;

  /** What the checks report of a topic's result, read under `checkSchema`. */
  checks: (value: Json) => Json;
}

const referencesAndName = {
  type: "object",
  properties: {
    referencedBy: { type: "array", items: { type: "unknown" } },
    shortName: { type: "string" },
  },
};

const countAndName = (value: Json) => ({
  referencedBy: Array.isArray(value?.referencedBy)
    ? value.referencedBy.length
    : value?.referencedBy,
  shortName: value?.shortName,
});

export const ARMS: Record<string, Arm> = {
  current: {
    base: "topics",
    board: "topics/main.tsx",
    replayInputs: ["boardCrossrefs", "boardNames", "mentionable"],
    checkSchema: referencesAndName,
    checks: countAndName,
  },
};
