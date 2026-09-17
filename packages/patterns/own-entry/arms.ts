/**
 * The boards `measure-start.ts` can build, one per arm. Each files topics
 * through `addTopic`, publishes them as `topics`, and files topics that take a
 * `mention` event and publish `referencedBy` and `shortName`, which is what
 * the checks read.
 *
 * `current` is `packages/patterns/topics/main.tsx` as it stands. Every other
 * arm is a generated copy of those sources; `make-arms.ts` lists each arm's
 * edits, and `arms/<arm>/` holds the result.
 */

// deno-lint-ignore no-explicit-any
type Json = any;

export interface Arm {
  /** Which sources the arm's board and topic were copied from. */
  base: "topics" | "collection-naming";

  /** What the arm does differently, for the record. */
  what: string;

  /** The board's source, relative to `packages/patterns`. */
  board: string;

  /** The board's argument, when it takes one. */
  boardArgument?: Json;

  /** The board outputs the build holds live: what the arm's topics read. */
  demand: string[];

  /** The inputs of a topic's argument the replay roots a query at. */
  replayInputs: string[];

  /** The schema the checks read a topic's result under. */
  checkSchema: Json;

  /** What the checks report of a topic's result, read under `checkSchema`. */
  checks: (value: Json) => Json;
}

const referenceRows = {
  type: "object",
  properties: {
    referencedBy: { type: "array", items: { type: "unknown" } },
    shortName: { type: "string" },
  },
};

const copyRows = {
  type: "object",
  properties: {
    referencedBy: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          shortName: { type: "string" },
        },
      },
    },
    shortName: { type: "string" },
    collectionName: { type: "string" },
  },
};

const countAndName = (value: Json) => ({
  referencedBy: Array.isArray(value?.referencedBy)
    ? value.referencedBy.length
    : value?.referencedBy,
  shortName: value?.shortName,
});

const copiesAndName = (value: Json) => ({
  ...countAndName(value),
  firstBacklink: Array.isArray(value?.referencedBy)
    ? value.referencedBy[0]
    : undefined,
  collectionName: value?.collectionName,
});

const TABLES = ["boardCrossrefs", "boardNames", "mentionable"];
const TABLE_DEMAND = ["crossrefs", "namesTable", "mentionable", "topicCount"];

export const ARMS: Record<string, Arm> = {
  current: {
    base: "topics",
    what: "the sources as they stand: each topic reads both board tables",
    board: "topics/main.tsx",
    demand: TABLE_DEMAND,
    replayInputs: TABLES,
    checkSchema: referenceRows,
    checks: countAndName,
  },
  "q2-unread": {
    base: "topics",
    what: "both tables wired and declared; no computation reads either",
    board: "own-entry/arms/q2-unread/main.tsx",
    demand: TABLE_DEMAND,
    replayInputs: TABLES,
    checkSchema: referenceRows,
    checks: countAndName,
  },
  "q2-read-one": {
    base: "topics",
    what: "the lifts declare the whole table as today and read row 0 only",
    board: "own-entry/arms/q2-read-one/main.tsx",
    demand: TABLE_DEMAND,
    replayInputs: TABLES,
    checkSchema: referenceRows,
    checks: countAndName,
  },
  "q3-index": {
    base: "topics",
    what:
      "the board indexes one entry per topic by name; the topic looks its " +
      "own up with `lookup`, and holds its name as a stored value",
    board: "own-entry/arms/q3-index/main.tsx",
    demand: [...TABLE_DEMAND, "ownEntries", "entryIndex"],
    replayInputs: ["boardEntryIndex", "mentionable"],
    checkSchema: referenceRows,
    checks: countAndName,
  },
  "q4-handed": {
    base: "topics",
    what: "the create mints each topic's entry document and hands the topic " +
      "that document; a board lift fills it",
    board: "own-entry/arms/q4-handed/main.tsx",
    demand: [...TABLE_DEMAND, "entriesWritten"],
    replayInputs: ["ownEntry", "mentionable"],
    checkSchema: referenceRows,
    checks: countAndName,
  },
  "q6-copies": {
    base: "topics",
    what: "the handed entry carries the mentioning topics' titles and names " +
      "as copies rather than references",
    board: "own-entry/arms/q6-copies/main.tsx",
    demand: [...TABLE_DEMAND, "entriesWritten"],
    replayInputs: ["ownEntry", "mentionable"],
    checkSchema: copyRows,
    checks: copiesAndName,
  },
  "q7-board-name": {
    base: "topics",
    what:
      "the copies arm, plus one reference to the board, through which the " +
      "topic reads the collection's declared name",
    board: "own-entry/arms/q7-board-name/main.tsx",
    demand: [...TABLE_DEMAND, "entriesWritten"],
    replayInputs: ["ownEntry", "board", "mentionable"],
    checkSchema: copyRows,
    checks: copiesAndName,
  },
};
