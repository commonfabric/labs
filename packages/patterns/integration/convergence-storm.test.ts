/**
 * Scoped-link / convergence coverage — multi-runtime, in-process, no browser.
 *
 * The original reader-blackout investigation exposed a write-side identity
 * defect: putting a live `PerUser` cell into shared `PerSpace` state stored a
 * scope-generic link, so another session resolved the link into its own empty
 * user partition.
 *
 * If that scoped field is required, its absent target correctly makes the
 * element and containing array fail schema validation. Callers that want the
 * remaining message fields while the target is unavailable must declare the
 * field optional. The minimal cases pin that distinction, plus the PerSpace
 * control where every reader resolves the same target.
 *
 * The storm fixture uses the optional declaration and checks observer
 * convergence under sustained writes. The independent B3 writer-integration
 * gap remains covered separately.
 */

import { assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { debugStr } from "@commonfabric/data-model";
import { experimentalOptionsFromEnv } from "@commonfabric/runner";
import {
  type CommitRejection,
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";
import { serverExecutionOnStepSkip } from "../../../tasks/server-execution-on-skips.ts";

// The RAW env posture, read only to key the skip guard below (testing.md
// §2): the `opposite` lane sets EXPERIMENTAL_SERVER_EXECUTION explicitly
// to the inverse of the first-party default; the `default` lanes leave it
// unset and resolve the constant. This value is therefore undefined on the default lane — NOT the
// resolved posture. The test's runtime posture is not taken from here:
// `MultiRuntimeHarness` resolves it env-else-first-party-default and picks
// its backend accordingly.
const SERVER_EXECUTION_FROM_ENV = experimentalOptionsFromEnv(Deno.env.get)
  .serverExecution;

/**
 * The ON arm's STEP-level skip guard (tasks/server-execution-on-skips.ts):
 * a step listed there for this file is skipped ONLY when this process runs
 * the ON posture, loudly (the entry's reason is printed), and only while
 * the entry exists — the OFF arm and an unlisted step always run. Never a
 * silent filter: the test topology declares the entry's leaf unavailable,
 * and the validator requires this file to name each listed step and call
 * this guard.
 *
 * The registry is EMPTY, so this guard is inert everywhere today. Note the
 * key: it is the RAW env, while the on-skips module asks callers to resolve
 * env-else-first-party-default (as runtime-client's host now does). Inert
 * today for exactly that reason — undefined on the default lane — and a
 * future entry for this file would fail LOUD there (a red lane, never a
 * silent skip), which is when the key gets converted.
 */
function onArmStepSkip(step: string): { ignore: boolean } {
  if (SERVER_EXECUTION_FROM_ENV !== true) return { ignore: false };
  const entry = serverExecutionOnStepSkip(
    "patterns",
    "integration/convergence-storm.test.ts",
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

const ROOT_PATH = join(import.meta.dirname!, "..");
const fixture = (name: string): string =>
  join(import.meta.dirname!, "fixtures", name, "main.tsx");

type Msg = { author: string; body: string; n: number };

async function messages(session: MultiRuntimeSession): Promise<Msg[]> {
  return ((await session.read(["messages"])) as Msg[] | undefined) ?? [];
}

const bodies = (list: Msg[]): string[] => list.map((m) => m.body).sort();

function summarize(list: Msg[]): Record<string, number> {
  const by: Record<string, number> = {};
  for (const m of list) by[m.author] = (by[m.author] ?? 0) + 1;
  return by;
}

/**
 * Alice makes one fully-settled post and a different identity reads the list.
 */
function minimalCase(
  title: string,
  fixtureName: string,
  observerBodies: string[],
) {
  describe(title, () => {
    let harness: MultiRuntimeHarness;
    let alice: MultiRuntimeSession;
    let observer: MultiRuntimeSession;

    beforeAll(async () => {
      harness = await MultiRuntimeHarness.create({
        programPath: fixture(fixtureName),
        rootPath: ROOT_PATH,
        sessions: ["min-alice", "min-observer"],
      });
      [alice, observer] = harness.sessions;
      await harness.settle();
    });

    afterAll(async () => {
      await harness?.dispose();
    });

    it("applies the element schema for a second session", async () => {
      await alice.send("post", { author: "alice", body: "alice-0", n: 0 });
      await harness.settle(5);

      const aliceView = await messages(alice);
      const observerView = await messages(observer);
      assertEquals(
        bodies(aliceView),
        ["alice-0"],
        "author's own read is broken — different failure than the repro targets",
      );
      assertEquals(
        bodies(observerView),
        observerBodies,
        debugStr`observer sees $quote,long${observerView}`,
      );
    });
  });
}

// A required PerUser-cell link resolves to an absent target for the observer.
// The property does not match, so neither does its element or containing array.
minimalCase(
  "required PerUser-cell link in elements",
  "convergence-chat-noderived",
  [],
);

// Control — B1 sidestepped: the linked cell is PerSpace, so every session
// resolves the same partition. (Green independent of the B2 fix.)
minimalCase(
  "control: PerSpace-scoped link in elements",
  "convergence-chat-spacelink",
  ["alice-0"],
);

// An optional field may be omitted when its PerUser target is unavailable, so
// the remaining message object and array still match.
minimalCase(
  "control: optional PerUser-cell link in elements",
  "convergence-chat-optlink",
  ["alice-0"],
);

// The optional-field model exercised at storm scale: a non-writing participant
// fully converges under sustained concurrent writes. Writer convergence is a
// separate, still-open concern
// (B3 — the interleaving writer keeps only its own appends); it is pinned by
// deliberately-red tests in the follow-up B3 PR, so this test deliberately
// asserts only the reader/observer guarantee.
describe("convergence storm — observer converges with optional scoped links", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;
  let bob: MultiRuntimeSession;
  let observer: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: fixture("convergence-chat"),
      rootPath: ROOT_PATH,
      sessions: ["storm-alice", "storm-bob", "storm-observer"],
      // Fills the per-commit rejection record the cost assertion below reads.
      recordRejections: true,
    });
    [alice, bob, observer] = harness.sessions;
    await harness.settle();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it(
    "a non-writing session sees every concurrently-posted message",
    onArmStepSkip(
      "a non-writing session sees every concurrently-posted message",
    ),
    async () => {
      const K = 20;
      const storm = async (session: MultiRuntimeSession, author: string) => {
        const sent: string[] = [];
        for (let n = 0; n < K; n++) {
          const body = `${author}-${n}`;
          // idle:false stacks sends into a deep optimistic pipeline — the
          // multiplayer contention shape (each browser tab pipelines commits).
          await session.send("post", { author, body, n }, undefined, {
            idle: false,
          });
          sent.push(body);
        }
        return sent;
      };
      const [fromAlice, fromBob] = await Promise.all([
        storm(alice, "alice"),
        storm(bob, "bob"),
      ]);
      const sent = [...fromAlice, ...fromBob];

      await harness.settle(20);

      // The observer never posts, so it has no local pendings of its own — it
      // reflects purely what the runtime materializes from durable state. It must
      // see all 2*K messages (delivery + reader convergence), the guarantee B2
      // restores.
      const observerView = await messages(observer);
      assertEquals(
        bodies(observerView),
        [...sent].sort(),
        `observer missed messages: sent=${sent.length} ` +
          `landed=${observerView.length} ` +
          debugStr`observer=$quote,long${summarize(observerView)}`,
      );

      // What the storm cost, as opposed to whether it converged. This fixture
      // derives a value from the whole message list, and that derivation's
      // commit is a compare-and-set over the list, so it loses races and is
      // refused; how often is a race and not worth asserting. What holds
      // exactly is that the posts never pay for it. A post is
      // `messages.push(...)`, which records a mergeable `append` and drops its
      // own read of the array, so no commit that wrote the list is ever among
      // the refused.
      const messagesDoc = (await alice.link(["messages"])).id;
      const refused = (await Promise.all(
        harness.sessions.map((session) => session.rejections()),
      )).flat();
      assertEquals(
        refused
          .filter((rejection) => rejection.writes.includes(messagesDoc))
          .map((rejection) => rejection.message),
        [],
        "a commit that wrote the message list was refused, so the appends " +
          "are contending rather than merging",
      );
    },
  );
});

/**
 * What a storm of concurrent appends costs, as opposed to whether it
 * converges. The describes above assert that every message arrives; this one
 * asserts what the sessions threw away getting them there.
 *
 * `MultiRuntimeSession.rejections()` carries one record per refused commit,
 * naming what the commit wrote and what refused it, which is what lets this
 * assert something exact rather than bound a count.
 */
describe("convergence storm — what the storm costs", () => {
  const K = 10;

  /**
   * Two sessions post `K` messages apiece into `fixtureName`, pipelined, while
   * a third only observes. Answers with every commit the three had refused
   * while that ran.
   */
  async function stormRefusals(
    fixtureName: string,
  ): Promise<CommitRejection[]> {
    const harness = await MultiRuntimeHarness.create({
      programPath: fixture(fixtureName),
      rootPath: ROOT_PATH,
      sessions: ["cost-alice", "cost-bob", "cost-observer"],
      // Fills the per-commit rejection record this assertion reads.
      recordRejections: true,
    });
    try {
      const [alice, bob] = harness.sessions;
      await harness.settle();
      await Promise.all(
        harness.sessions.map((session) => session.clearRejections()),
      );
      const post = async (session: MultiRuntimeSession, author: string) => {
        for (let n = 0; n < K; n++) {
          // idle:false stacks the sends into a pipeline, as the storm above
          // does: settling each one in turn hides the contention.
          await session.send(
            "post",
            {
              author,
              body: `${author}-${n}`,
              n,
            },
            undefined,
            { idle: false },
          );
        }
      };
      await Promise.all([post(alice, "alice"), post(bob, "bob")]);
      await harness.settle(20);
      const refused = await Promise.all(
        harness.sessions.map((session) => session.rejections()),
      );
      return refused.flat();
    } finally {
      await harness.dispose();
    }
  }

  it("refuses no commit at all when nothing derives from the list", async () => {
    // A post is `messages.push(...)`, which records a mergeable `append` and
    // drops its own read of the array, so two sessions appending at once
    // depend on nothing in common. This fixture carries no value derived from
    // the whole list, which is the other thing that reads it, so the cost is
    // none — not a small number, but zero across all three sessions.
    const refused = await stormRefusals("convergence-chat-plain");
    assertEquals(
      refused.map((rejection) => rejection.message),
      [],
      "a storm of mergeable appends refused a commit, so an append has " +
        "stopped merging or something now reads the list on the write path",
    );
  });
});
