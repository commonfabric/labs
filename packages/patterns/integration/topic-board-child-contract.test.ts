/**
 * What a caller can observe about a topic it filed through the board, when the
 * board demands only what its card, its index row, its activity sort, its
 * crossref pivot, and its mention universe use, and names no verb.
 *
 * These cases make the move the design says a caller makes: survey the board,
 * resolve the row to the topic's own address, and read or call the topic
 * itself, where its own schema governs.
 *
 * Each `it()` guards a property of `addTopic`'s children: that the child is
 * wired to the board's mention pivot, that a body given at create is not
 * recorded as a body update, and that the board's index row tracks the child's
 * thread after the fact.
 */
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { debugStr } from "@commonfabric/data-model";
import { env } from "@commonfabric/integration";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { Identity } from "@commonfabric/identity";
import { join } from "@std/path";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { experimentalOptionsFromEnv } from "@commonfabric/runner";
import {
  initializePiecesController,
  type PieceController,
  type PiecesController,
} from "./pieces-controller.ts";
import { demandTopicBoard, topicAt } from "./topic-board-fixture.ts";
import { serverExecutionOnStepSkip } from "../../../tasks/server-execution-on-skips.ts";

const { API_URL, SPACE_NAME } = env;

// The RAW env posture, read only to key the skip guard below (testing.md
// §2): the `opposite` lane sets EXPERIMENTAL_SERVER_EXECUTION explicitly
// to the inverse of the first-party default; the `default` lanes leave it
// unset and resolve the constant. This value is therefore undefined on the default lane — NOT the
// resolved posture. The test's runtime posture is not taken from here: it is
// whatever the lane's toolshed publishes and `PiecesController` adopts.
const SERVER_EXECUTION_FROM_ENV = experimentalOptionsFromEnv(Deno.env.get)
  .serverExecution;

// The ON arm's STEP-level skip guard (tasks/server-execution-on-skips.ts):
// a step listed there for this file is skipped ONLY under the ON posture,
// loudly (its reason is printed), and only while the entry exists — the OFF
// arm and an unlisted step always run. The registry is EMPTY: no step of
// any file is listed today, so this guard is inert everywhere and stays
// wired on the pivot baseline case only so a future entry binds without
// re-plumbing. Note
// the key: it is the RAW env, while the on-skips module asks callers to
// resolve env-else-first-party-default (as runtime-client's host now
// does). Inert today for exactly that reason — undefined on the default
// lane — and a future entry for this file would fail LOUD there (a red
// lane, never a silent skip), which is when the key gets converted.
function onArmStepSkip(step: string): { ignore: boolean } {
  if (SERVER_EXECUTION_FROM_ENV !== true) return { ignore: false };
  const entry = serverExecutionOnStepSkip(
    "patterns",
    "integration/topic-board-child-contract.test.ts",
    step,
  );
  if (entry === undefined) return { ignore: false };
  console.warn(
    `[server-execution ON arm] patterns: ` +
      debugStr`SKIPPING STEP $quote,long${step}` +
      ` (until ${entry.phase}) — ${entry.reason}`,
  );
  return { ignore: true };
}

describe("topic-board-child-contract", () => {
  let cc: PiecesController;
  let board: PieceController;
  let releaseBoard: (() => void) | undefined;

  beforeAll(async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });
    await cc.ensureDefaultPattern();
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      {
        main: join(import.meta.dirname!, "..", "topics", "main.tsx"),
        root: join(import.meta.dirname!, ".."),
      },
    );
    board = await cc.create(program, { start: true });
    // Held live for the whole suite so each `addTopic` lands against an
    // up-to-date list, the same reason the seeding fixture holds it.
    releaseBoard = demandTopicBoard(board);

    // Index 0 is filed with a body; index 1 mentions it.
    await board.result.set(
      {
        title: "Cited topic",
        body: "    indented code\nline two\n",
        agentName: "Sol",
      },
      ["addTopic"],
    );
    await board.result.set(
      { title: "Citing topic", agentName: "Sol" },
      ["addTopic"],
    );
  });

  afterAll(async () => {
    releaseBoard?.();
    await cc?.dispose();
  });

  it("leaves the body-update stamps unset on a topic filed with a body", async () => {
    const cited = await topicAt(board, 0);
    // Verbatim, because trimming would corrupt whitespace-sensitive Markdown.
    expect(await cited.result.get(["body"])).toBe(
      "    indented code\nline two\n",
    );
    // Created-with is not an update: `createdBy` covers create authorship, so
    // the update stamps must still be untouched.
    expect(await cited.result.get(["bodyUpdatedAt"]) ?? 0).toBe(0);
    expect(
      (await cited.result.get(["bodyUpdatedBy", "name"])) ?? "",
    ).toBe("");
  });

  it("wires a filed topic to the board's pivot, so a sibling's mention becomes an inbound reference", async () => {
    const cited = await topicAt(board, 0);
    const citing = await topicAt(board, 1);

    expect((await cited.result.get(["referencedBy"]) as unknown[]).length)
      .toBe(0);

    await citing.result.set({ topic: cited.getCell() }, ["mention"]);

    // The edge exists only if `addTopic` handed this child the board's
    // `crossrefs` pivot.
    const inbound = await cited.result.get(["referencedBy"]) as {
      title: string;
    }[];
    expect(inbound.length).toBe(1);
    expect(inbound[0].title).toBe("Citing topic");

    // Mentioning is not symmetric.
    expect((await citing.result.get(["referencedBy"]) as unknown[]).length)
      .toBe(0);
  });

  it("carries the updated comment count on the board's index row", async () => {
    const cited = await topicAt(board, 0);
    const before = await board.result.get(["index", 0, "commentCount"]) ?? 0;

    await cited.result.set({ body: "a comment", agentName: "Sol" }, [
      "addComment",
    ]);

    // The row is built from the topic rather than copied from it, so a row
    // already handed out has to reflect a thread that grew afterwards.
    expect(await board.result.get(["index", 0, "commentCount"]))
      .toBe((before as number) + 1);
  });
});

/**
 * The board's mention pivot, exercised through a board and the topics it
 * created.
 *
 * `crossrefTable()` derives the whole reference graph once on the board, and
 * each topic reads its own row out of it. Testing that needs two things at the
 * same time: topics that are ON a board, so the pivot sees them, and
 * `mention` / `unmention` / `referencedBy` on those same topics. Here both
 * hold, because a caller files through the board and then addresses the
 * created topic by its own fid.
 */
describe("topic-board-pivot-contract", () => {
  let cc: PiecesController;
  let board: PieceController;
  let releaseBoard: (() => void) | undefined;
  let target: PieceController;
  let source: PieceController;
  let third: PieceController;

  beforeAll(async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });
    await cc.ensureDefaultPattern();
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      {
        main: join(import.meta.dirname!, "..", "topics", "main.tsx"),
        root: join(import.meta.dirname!, ".."),
      },
    );
    board = await cc.create(program, { start: true });
    releaseBoard = demandTopicBoard(board);

    for (const title of ["Graph target", "Graph source", "Graph third"]) {
      await board.result.set({ title, agentName: "Sol" }, ["addTopic"]);
    }
    target = await topicAt(board, 0);
    source = await topicAt(board, 1);
    third = await topicAt(board, 2);
  });

  afterAll(async () => {
    releaseBoard?.();
    await cc?.dispose();
  });

  /** Await a derived edge count rather than reading straight after `set()`.
   * A verb's completion says the event ran, not that the pivot has recomputed
   * and served its consequence — under server execution those are different
   * moments, and reading between them sees a transient count.
   *
   * Only ever awaited for a count the write is about to PRODUCE. An absence is
   * not a thing to wait for: "no edges yet" and "the edge has not arrived yet"
   * are the same observation, so a wait for zero cannot fail — it can only
   * hang, and `waitForCellValue` has no deadline of its own. Absences are read
   * with {@link edgesNow} after a positive signal has settled. */
  const awaitEdges = async (
    t: PieceController,
    key: "referencedBy" | "mentions",
    length: number,
  ): Promise<unknown[]> => {
    const cell = (await t.result.getCell()).key(key);
    return await waitForCellValue<unknown[]>(
      cc.runtime,
      cell,
      // A path that has produced nothing yet reads as undefined rather than as
      // an empty array, so the count has to treat the two alike.
      (v) => ((v ?? []) as unknown[]).length === length,
    );
  };

  /** The edges as they stand, with no waiting. Read only once something the
   * same write produces has already been awaited. */
  const edgesNow = async (
    t: PieceController,
    key: "referencedBy" | "mentions",
  ): Promise<unknown[]> => ((await t.result.get([key])) ?? []) as unknown[];

  /** Await the named topics APPEARING among `t`'s inbound edges, then hand
   * back the rows so the caller can pin the exact set.
   *
   * Waits on content rather than on a count, because `referencedBy` is served
   * from the board-wide pivot rather than written here: a count-wait cannot
   * tell a number that has not arrived from one that never will, and
   * `waitForCellValue` has no deadline, so a pivot serving the wrong number
   * hangs it. A content-wait resolves the moment the edge lands, and the
   * assertion after it still catches an extra row. */
  const awaitInbound = async (
    t: PieceController,
    ...titles: string[]
  ): Promise<{ title: string }[]> => {
    const cell = (await t.result.getCell()).key("referencedBy");
    return await waitForCellValue<{ title: string }[]>(
      cc.runtime,
      cell,
      (v) => {
        const rows = (v ?? []) as { title?: string }[];
        return titles.every((want) => rows.some((r) => r?.title === want));
      },
    );
  };

  /** The board's topic titles, in filing order. Asserted in place of a bare
   * count, because a count of four says nothing: a doubled topic and a
   * doubled pivot row over three topics are different defects, and only the
   * titles say which one happened. */
  const topicTitles = async (): Promise<string[]> => {
    const list = ((await board.result.get(["topics"])) ?? []) as unknown[];
    return await Promise.all(list.map(async (_, index) =>
      String(
        (await board.result.get(["topics", `${index}`, "title"])) ??
          "<untitled>",
      )
    ));
  };

  it({
    name:
      "builds one pivot row per topic, claiming no edges before any mention",
    ...onArmStepSkip(
      "builds one pivot row per topic, claiming no edges before any mention",
    ),
    fn: async () => {
      // Waits on the three topics this suite filed, which `addTopic` produces
      // directly, rather than on the pivot's row count: the pivot is
      // board-wide, and a count-wait on it would hang rather than fail if it
      // ever served a different number. The table is then asserted rather
      // than awaited, so an extra row still fails.
      const topics = (await board.result.getCell()).key("topics");
      await waitForCellValue<unknown[]>(
        cc.runtime,
        topics,
        (v) => ((v ?? []) as unknown[]).length === 3,
      );
      expect(await topicTitles()).toEqual([
        "Graph target",
        "Graph source",
        "Graph third",
      ]);
      // The pivot's rows are opaque through this projection — the demand
      // carries no title through a row's `topic` — so the row COUNT is the
      // observable here, and the clean titles above are what pin a wrong
      // count to the row side: four rows over exactly these three titles is
      // a duplicated row. The titles cannot name a duplicated TOPIC — one
      // present by the wait above leaves `topics` at four and hangs that
      // wait (it has no deadline); only a duplicate landing after the wait
      // matched would surface here as a doubled title.
      expect(((await board.result.get(["crossrefs"])) as unknown[]).length)
        .toBe(3);
      // The pivot has served three rows, so the topics behind them have
      // settled.
      expect((await edgesNow(target, "referencedBy")).length).toBe(0);
      expect((await edgesNow(target, "mentions")).length).toBe(0);
    },
  });

  // NOTE ON WHAT THIS CANNOT SEPARATE, because the distinction is easy to
  // assume from the wording: every topic here sits at exactly ONE index, so
  // this case cannot tell the identity check `mentionedBy()` makes when it
  // leaves a topic out of its own backlinks (`!equals(other, topic)` in
  // `packages/patterns/topics/main.tsx`) from a check by array position: both
  // pass it. Only a list naming one topic at two indices separates them, and
  // the board's pivot hands `mentionedBy()` the list `distinctByIdentity()`
  // returns, which names each topic once.
  // `assert_self_mention_inert_through_a_twin` in
  // `packages/patterns/topics/topics.test.tsx` hands `mentionedBy()` a
  // duplicated list directly. No case here builds a board listing one topic
  // twice; the "over a board listing one topic twice" group in
  // `topics-headless-fixture.test.ts` runs the board's lifts over one.
  it("records a self-mention without earning the topic an inbound edge", async () => {
    // Referencing yourself is not being referenced from somewhere else.
    await target.result.set({ topic: target.getCell() }, ["mention"]);
    await awaitEdges(target, "mentions", 1);
    expect((await edgesNow(target, "referencedBy")).length).toBe(0);
  });

  it("gives each mentioned topic its own inbound edge, and is not symmetric", async () => {
    await source.result.set({ topic: target.getCell() }, ["mention"]);
    await source.result.set({ topic: third.getCell() }, ["mention"]);
    await awaitEdges(source, "mentions", 2);

    expect((await awaitInbound(target, "Graph source")).length).toBe(1);
    expect((await awaitInbound(third, "Graph source")).length).toBe(1);
    // Mentioning is not mutual.
    expect((await edgesNow(source, "referencedBy")).length).toBe(0);
  });

  it("drops only the retracted edge on unmention, leaving the other standing", async () => {
    await source.result.set({ topic: target.getCell() }, ["unmention"]);
    await awaitEdges(source, "mentions", 1);

    expect((await edgesNow(target, "referencedBy")).length).toBe(0);
    // The edge that was not retracted survives as a reference, not a
    // flattened copy of the piece it names.
    expect((await awaitInbound(third, "Graph source")).length).toBe(1);
  });
});
