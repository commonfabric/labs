/**
 * Browser tests of `topics-browser-measurement.ts`, against a seeded board in a
 * real shell. The decisions that need no page are tested in
 * `packages/patterns/test/topics-browser-measurement-core.test.ts`, which a
 * plain `deno test` runs.
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Identity } from "@commonfabric/identity";
import { env, type Page } from "@commonfabric/integration";
import type { RuntimeClient } from "@commonfabric/runtime-client";

import {
  seedIdentity,
  seedTopicBoard,
  type TopicBoardFixture,
  topicTitle,
} from "./topic-board-fixture.ts";
import { BoardSession } from "./topic-board-session.ts";
import {
  formatTopicsSample,
  measureTopicsReads,
  prepareTopicsProgram,
  timeTopicsOperation,
  type TopicsProgram,
  type TopicsSample,
} from "./topics-browser-measurement.ts";
import {
  readTopicsBrowserPosture,
  type TopicsBrowserPosture,
} from "./topics-browser-posture.ts";
import { waitForPieceView } from "./topics-navigation-helpers.ts";

/** The page globals the client-replacement cases read and write. */
type ReplacementGlobal = typeof globalThis & {
  /** The shell's debugging globals. */
  commonfabric?: { rt?: RuntimeClient };

  /** The client a replacement took out of `commonfabric.rt`. */
  __cfReplacedClient?: RuntimeClient;

  /** Telemetry markers the replaced client delivered, and how to stop counting. */
  __cfReplacedClientMarkers?: { count: number; stop: () => void };
};

describe("topics-browser-measurement", () => {
  let fixture: TopicBoardFixture;
  let identity: Identity;
  let posture: TopicsBrowserPosture;
  let program: TopicsProgram;
  let session: BoardSession;

  // The smallest board on which every named lift runs: the newest of two topics
  // cites the other, so the pivot has a row to build and a backlink to find.
  beforeAll(async () => {
    posture = await readTopicsBrowserPosture(env.API_URL, env.FRONTEND_URL);
    program = await prepareTopicsProgram();
    identity = await seedIdentity(
      `topics browser measurement ${crypto.randomUUID()}`,
    );
    fixture = await seedTopicBoard({
      apiUrl: new URL(env.API_URL),
      spaceName: env.SPACE_NAME,
      identity,
      topicCount: 2,
      crossrefsPerTopic: 1,
      citingTopics: 1,
    });
    session = await BoardSession.open({ fixture, identity });
    await session.load();
    await session.signIn();
    await session.showBoard();
  });

  afterAll(async () => {
    await session?.close();
  });

  /** Runs `check`, printing `sample` to stderr when a check fails. */
  function checkSample(sample: TopicsSample, check: () => void): void {
    try {
      check();
    } catch (error) {
      console.error(formatTopicsSample(sample).join("\n"));
      throw error;
    }
  }

  /** Tokens of the samples `page` still holds. */
  async function samplesLeftInPage(
    page: Page = session.page,
  ): Promise<string[]> {
    return await page.evaluate(() =>
      Object.keys(
        (globalThis as typeof globalThis & {
          __cfTopicsSamples?: Record<string, unknown>;
        }).__cfTopicsSamples ?? {},
      )
    );
  }

  /**
   * Stands a client that answers only `idle()` in for `page`'s runtime
   * client, as a replaced runtime would appear to a sample in progress. The
   * shell's own views keep the client they hold.
   */
  async function replaceRuntimeClient(
    page: Page = session.page,
  ): Promise<void> {
    await page.evaluate(() => {
      const scope = globalThis as ReplacementGlobal;
      scope.__cfReplacedClient = scope.commonfabric!.rt;
      scope.commonfabric!.rt = {
        idle: () => Promise.resolve(),
      } as unknown as RuntimeClient;
    });
  }

  /**
   * Puts `page`'s own runtime client back after {@link replaceRuntimeClient},
   * leaving its telemetry and read accounting as they are.
   */
  async function restoreRuntimeClient(
    page: Page = session.page,
  ): Promise<void> {
    await page.evaluate(() => {
      const scope = globalThis as ReplacementGlobal;
      scope.__cfReplacedClientMarkers?.stop();
      delete scope.__cfReplacedClientMarkers;
      if (scope.__cfReplacedClient === undefined) return;
      scope.commonfabric!.rt = scope.__cfReplacedClient;
      delete scope.__cfReplacedClient;
    });
  }

  /**
   * Delivers one `scheduler.run.complete` marker to the page's telemetry,
   * carrying a read sample so the samplers count it as a run, and `src` when
   * one is given. Omitting `src` is the shape a run of something other than an
   * authored module takes.
   */
  async function deliverRun(src: string | undefined): Promise<void> {
    await session.page.evaluate((src: string | undefined) => {
      const client = (globalThis as typeof globalThis & {
        commonfabric?: { rt?: unknown };
      }).commonfabric!.rt! as { emit: (e: string, m: unknown) => void };
      client.emit("telemetry", {
        type: "scheduler.run.complete",
        ...(src === undefined ? {} : { src }),
        durationMs: 1,
        reads: {
          proxyAccesses: 1,
          linkResolutions: 0,
          distinctDocuments: 1,
          registeredDependencies: 1,
        },
      });
    }, { args: [src] });
  }

  /** Index of the seeded topic `pieceId` addresses. */
  function topicIndexOf(pieceId: string): number {
    return fixture.topics.findIndex((topic) =>
      topic.fid === pieceId.replace(/^of:/, "")
    );
  }

  /**
   * Opens the topmost topic in `on`, waiting for both topics' titles on its
   * page, and returns its index.
   */
  async function openTopmostTopic(on: BoardSession = session): Promise<number> {
    const pieceId = await on.openTopic((opened) => {
      const index = topicIndexOf(opened);
      return [topicTitle(index), topicTitle(1 - index)];
    });
    return topicIndexOf(pieceId);
  }

  /**
   * Returns `on` to the board through the shell's own navigation, so one
   * runtime serves the whole sequence.
   */
  async function returnToBoard(on: BoardSession = session): Promise<void> {
    await on.page.evaluate(
      async (spaceName: string, pieceId: string) => {
        await globalThis.app.setView({ spaceName, pieceId });
      },
      { args: [fixture.spaceName, fixture.boardId] },
    );
    await waitForPieceView(on.page, fixture.spaceName, fixture.boardId);
    await on.showBoard();
  }

  /**
   * Opens a browser on the seeded board and signs in, running `beforeSignIn`
   * against the page first, then waits for the board's cards.
   */
  async function openFreshSession(
    beforeSignIn?: (page: Page) => Promise<void>,
  ): Promise<BoardSession> {
    const fresh = await BoardSession.open({ fixture, identity });
    await fresh.load();
    await beforeSignIn?.(fresh.page);
    await fresh.signIn();
    await fresh.showBoard();
    return fresh;
  }

  describe("measureTopicsReads()", () => {
    it("returns a run with reads of each named lift, attributed to its own implementation, over opening a topic and returning to the board", async () => {
      // The implementation each row carries is the graph's own text for the
      // action counted there. Checking its parameters against the lift's
      // declaration here pins each row to its lift, independently of how the
      // helper located and confirmed the lift.

      const sample = await measureTopicsReads(session.page, {
        label: "open topic and return",
        posture,
        program,
        operation: async () => {
          await openTopmostTopic();
          await returnToBoard();
        },
      });

      checkSample(sample, () => {
        expect(
          sample.lifts.map((lift) => [
            lift.name,
            lift.implementation?.split(" =>")[0],
          ]),
        ).toEqual([
          ["crossrefTable", "({ sources })"],
          ["backlinksOf", "({ table, self })"],
          ["presentCommentCountOf", "({ comments })"],
          [
            "lastActivityOf",
            "({ comments, links, createdAt, bodyUpdatedAt, titleUpdatedAt })",
          ],
        ]);
        expect(
          sample.lifts.filter((lift) =>
            lift.runs === 0 || lift.proxyAccesses === 0
          )
            .map((lift) => lift.name),
        ).toEqual([]);
        expect(sample.graph.before.nodes).toBeGreaterThan(0);
        expect(sample.graph.before.edges).toBeGreaterThan(0);
        expect(sample.graph.after.nodes).toBeGreaterThan(0);
        expect(sample.graph.after.edges).toBeGreaterThan(0);
      });
    });

    it("throws for an operation that demands nothing", async () => {
      await expect(
        measureTopicsReads(session.page, {
          label: "undemanded",
          posture,
          program,
          operation: () => Promise.resolve(),
        }),
      ).rejects.toThrow(
        "undemanded: the measured operation completed no run carrying an " +
          "authored source location; declare `mayRunNothing` for an " +
          "operation that may",
      );
      expect(await samplesLeftInPage()).toEqual([]);
    });

    it("returns a sample recording a zero for an operation declared to run nothing", async () => {
      // The declaration permits a zero; it does not assert one. The case below
      // checks the other half, that an operation which does run is attributed
      // as usual under the same declaration.

      const sample = await measureTopicsReads(session.page, {
        label: "undemanded, declared",
        posture,
        program,
        operation: () => Promise.resolve(),
        mayRunNothing: true,
      });

      checkSample(sample, () => {
        expect(sample.mayRunNothing).toBe(true);
        expect(sample.lifts.map((lift) => lift.runs)).toEqual([0, 0, 0, 0]);
        expect(sample.remaining.runs).toBe(0);
        expect(sample.graph.after.nodes).toBeGreaterThan(0);
      });
    });

    it("attributes the runs of an operation that does run, under the same declaration", async () => {
      // A browser of its own, in which no other case has opened a topic: an
      // operation already run in a page can run nothing, which is the very
      // thing the declaration permits, and this case is about the other
      // half — that declaring it does not suppress runs it does complete.

      const fresh = await openFreshSession();
      try {
        const sample = await measureTopicsReads(fresh.page, {
          label: "open topic and return, declared",
          posture,
          program,
          operation: async () => {
            await openTopmostTopic(fresh);
            await returnToBoard(fresh);
          },
          mayRunNothing: true,
        });

        checkSample(sample, () => {
          expect(sample.mayRunNothing).toBe(true);
          expect(
            sample.lifts.filter((lift) => lift.runs === 0).map((lift) =>
              lift.name
            ),
          ).toEqual([]);
        });
      } finally {
        await fresh.close();
      }
    });

    it("throws for a run whose source location cannot be parsed, even under the declaration", async () => {
      // The declaration waives a run that carries no source location. It must
      // not waive one that carries a location this helper cannot read: that is
      // a measurement it cannot place, and zeroing it would be the
      // misattribution the position checks exist to catch.
      //
      // The run is made unreadable at its source: a marker is delivered to the
      // page's telemetry carrying a `src` that `parseSrc()` rejects, alongside
      // the read sample that makes it a counted run.

      await expect(
        measureTopicsReads(session.page, {
          label: "unparseable",
          posture,
          program,
          operation: () => deliverRun("not a source location"),
          mayRunNothing: true,
        }),
      ).rejects.toThrow("carried no source location to attribute them by");
      expect(await samplesLeftInPage()).toEqual([]);
    });

    it("counts a run carrying no source location apart, and waives it only when declared", async () => {
      // The branch that tells the two apart, driven with the one marker shape
      // that reaches it. Without this the counter is only ever read as zero:
      // the declared-to-run-nothing case completes no run at all, and the
      // unparseable case above delivers a `src`.

      const sample = await measureTopicsReads(session.page, {
        label: "no source location",
        posture,
        program,
        operation: () => deliverRun(undefined),
        mayRunNothing: true,
      });

      checkSample(sample, () => {
        expect(sample.runsWithoutSource).toBe(1);
        // Counted apart for reporting, and still part of `remaining`, which
        // is every run the sample could not place against a named lift.
        expect(sample.remaining.runs).toBe(1);
        expect(sample.lifts.map((lift) => lift.runs)).toEqual([0, 0, 0, 0]);
      });

      // The same run undeclared: the waiver is what admits it.
      await expect(
        measureTopicsReads(session.page, {
          label: "no source location, undeclared",
          posture,
          program,
          operation: () => deliverRun(undefined),
        }),
      ).rejects.toThrow(
        "completed no run carrying an authored source location",
      );
      expect(await samplesLeftInPage()).toEqual([]);
    });

    it("throws the operation's own error and leaves no sample in the page", async () => {
      const failure = new Error("the operation failed on purpose");
      await expect(
        measureTopicsReads(session.page, {
          label: "failing",
          posture,
          program,
          operation: () => Promise.reject(failure),
        }),
      ).rejects.toBe(failure);
      expect(await samplesLeftInPage()).toEqual([]);
    });

    it("throws naming pattern coverage for a page whose worker collects it", async () => {
      // The page asks for coverage the way the integration harness does, with
      // the flag its worker reads when signing in constructs it.

      const fresh = await openFreshSession(async (page) => {
        await page.evaluate(() => {
          globalThis.localStorage.setItem("patternCoverage", "true");
        });
      });
      try {
        await expect(
          measureTopicsReads(fresh.page, {
            label: "coverage on",
            posture,
            program,
            operation: async () => {
              await openTopmostTopic(fresh);
              await returnToBoard(fresh);
            },
          }),
        ).rejects.toThrow("The page's worker collects pattern coverage");
        expect(await samplesLeftInPage(fresh.page)).toEqual([]);
      } finally {
        await fresh.close();
      }
    });

    it("throws when the runtime client is replaced during the operation, after turning telemetry and read accounting off on the client it enabled them on", async () => {
      // A browser of its own, so that opening a topic runs work whichever
      // cases ran first. What the replaced client reports is read before any
      // cleanup: a listener on it counts the telemetry markers that work
      // delivers, and its graph snapshot says whether any run of the work kept
      // a read sample, since a run without accounting clears its node's.

      const fresh = await openFreshSession();
      try {
        await expect(
          measureTopicsReads(fresh.page, {
            label: "replaced client",
            posture,
            program,
            operation: () => replaceRuntimeClient(fresh.page),
          }),
        ).rejects.toThrow("The runtime client was replaced");
        expect(await samplesLeftInPage(fresh.page)).toEqual([]);

        const runCounts = await fresh.page.evaluate(async () => {
          const scope = globalThis as ReplacementGlobal;
          const client = scope.__cfReplacedClient!;
          const counter = { count: 0, stop: () => {} };
          const listener = () => {
            counter.count++;
          };
          client.on("telemetry", listener);
          counter.stop = () => client.off("telemetry", listener);
          scope.__cfReplacedClientMarkers = counter;
          const graph = await client.getGraphSnapshot();
          return Object.fromEntries(
            graph.nodes.map((node) => [node.id, node.stats?.runCount ?? 0]),
          );
        });
        await openTopmostTopic(fresh);
        await returnToBoard(fresh);
        const reported = await fresh.page.evaluate(
          async (runCounts: Record<string, number>) => {
            const scope = globalThis as ReplacementGlobal;
            const graph = await scope.__cfReplacedClient!.getGraphSnapshot();
            const ran = graph.nodes.filter((node) =>
              (node.stats?.runCount ?? 0) > (runCounts[node.id] ?? 0)
            );
            return {
              ran: ran.length,
              withReadSample: ran.filter((node) =>
                node.stats?.lastRunReads !== undefined
              ).length,
              markers: scope.__cfReplacedClientMarkers!.count,
            };
          },
          { args: [runCounts] },
        );

        expect(reported.ran).toBeGreaterThan(0);
        expect(reported.withReadSample).toBe(0);
        expect(reported.markers).toBe(0);
      } finally {
        await restoreRuntimeClient(fresh.page);
        await fresh.close();
      }
    });
  });

  describe("timeTopicsOperation()", () => {
    it("returns a sample with accounting turned off, delivering no run marker to telemetry a caller left on", async () => {
      // A browser of its own, in which no other case has opened a topic, so
      // the timed interval runs work in the worker whichever cases ran first.
      // An operation already run in a page can run nothing, and a count of
      // delivered markers over it would be zero whatever the sampler did.

      const fresh = await openFreshSession();
      try {
        await fresh.page.evaluate(async () => {
          const scope = globalThis as typeof globalThis & {
            commonfabric?: { rt?: RuntimeClient };
            __cfLeftOnRuns?: { count: number; stop: () => void };
          };
          const rt = scope.commonfabric!.rt!;
          const counter = { count: 0, stop: () => {} };
          const listener: Parameters<typeof rt.on<"telemetry">>[1] = (
            marker,
          ) => {
            if (marker.type === "scheduler.run.complete") counter.count++;
          };
          rt.on("telemetry", listener);
          counter.stop = () => rt.off("telemetry", listener);
          scope.__cfLeftOnRuns = counter;
          await rt.setTelemetryEnabled(true);
          await rt.setReadStatsEnabled(true);
        });
        const sample = await timeTopicsOperation(fresh.page, {
          label: "open topic and return, timed",
          posture,
          operation: async () => {
            await openTopmostTopic(fresh);
            await returnToBoard(fresh);
          },
        });
        const delivered = await fresh.page.evaluate(() => {
          const scope = globalThis as typeof globalThis & {
            __cfLeftOnRuns?: { count: number; stop: () => void };
          };
          scope.__cfLeftOnRuns!.stop();
          return scope.__cfLeftOnRuns!.count;
        });

        checkSample(sample, () => {
          expect(sample.readAccounting).toBe(false);
          expect(sample.accountingTurnedOff).toBe(true);
          expect(sample.mayRunNothing).toBe(false);
          expect(sample.workerRuns).toBeGreaterThan(0);
          expect(delivered).toBe(0);
          expect(sample.elapsedMs).toBeGreaterThan(0);
          expect(sample.graph.after.nodes).toBeGreaterThan(0);
        });
      } finally {
        await fresh.close();
      }
    });

    it("throws for an operation that runs nothing in the worker", async () => {
      await expect(
        timeTopicsOperation(session.page, {
          label: "idle",
          posture,
          operation: () => Promise.resolve(),
        }),
      ).rejects.toThrow("idle: the timed operation ran nothing in the worker");
      expect(await samplesLeftInPage()).toEqual([]);
    });

    it("throws the operation's own error, ends the interval, and leaves no sample in the page", async () => {
      const failure = new Error("the operation failed on purpose");
      const interval = { started: 0, ended: 0 };
      await expect(
        timeTopicsOperation(session.page, {
          label: "failing, timed",
          posture,
          operation: () => Promise.reject(failure),
          interval: {
            start: () => interval.started++,
            end: () => interval.ended++,
          },
        }),
      ).rejects.toBe(failure);
      expect(interval).toEqual({ started: 1, ended: 1 });
      expect(await samplesLeftInPage()).toEqual([]);
    });

    it("throws when the runtime client is replaced during the operation", async () => {
      try {
        await expect(
          timeTopicsOperation(session.page, {
            label: "replaced client, timed",
            posture,
            operation: () => replaceRuntimeClient(),
          }),
        ).rejects.toThrow("The runtime client was replaced");
      } finally {
        await restoreRuntimeClient();
      }
      expect(await samplesLeftInPage()).toEqual([]);
    });

    it("returns a sample recording the declaration for an operation declared to run nothing", async () => {
      const sample = await timeTopicsOperation(session.page, {
        label: "idle, declared",
        posture,
        operation: () => Promise.resolve(),
        mayRunNothing: true,
      });

      expect(sample.mayRunNothing).toBe(true);
    });
  });
});
