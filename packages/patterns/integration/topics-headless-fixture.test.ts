/**
 * Checks the headless Topics fixture's data, its reach into the unmodified
 * Topics sources, and what the reached lifts compute over it, each against an
 * oracle computed outside the runtime: `mentionedBy` and the fixture's own
 * mention indices for backlinks, and plain arithmetic over the fixture's
 * comments and links for the aggregates.
 */

import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";

import { type Cell, parseLink } from "@commonfabric/runner";

import {
  buildTopicsFixture,
  type FixtureTopic,
  latestStamp,
  measureTopicsFixture,
  mentionersOf,
  pivotEntriesOf,
  type PivotRow,
  presentCommentCount,
  reachTopicsDerivations,
  resolveTopicsProgram,
  topicIndicesOf,
  TOPICS_LIFT_NAMES,
  type TopicsFixture,
  topicsFixtureModeOf,
  type TopicsLiftName,
  type TopicsMeasurement,
  type TopicsOperation,
} from "./topics-headless-fixture.ts";

/** How many inbound mentions each topic has, counting each source once. */
function inboundCounts(fixture: TopicsFixture): number[] {
  return fixture.topics.map((_, topic) => mentionersOf(fixture, topic).length);
}

/** The output `outputs` holds for `topic`, which the measurement must demand. */
function outputOf<T>(outputs: ReadonlyMap<number, T>, topic: number): T {
  const output = outputs.get(topic);
  if (output === undefined) {
    throw new Error(
      `The measurement demands no such output of topic ${topic}.`,
    );
  }
  return output;
}

/** The pivot's result `measurement` holds, which it must demand. */
function tableOf(measurement: TopicsMeasurement): Cell<PivotRow[]> {
  const { table } = measurement.outputs;
  if (table === undefined) {
    throw new Error("The measurement does not demand the pivot.");
  }
  return table;
}

/** Whether `measurement` holds the pivot, and which topics each output covers. */
function outputKeys(measurement: TopicsMeasurement): {
  pivot: boolean;
  backlinks: number[];
  commentCounts: number[];
  lastActivity: number[];
} {
  const { table, backlinks, commentCounts, lastActivity } = measurement.outputs;
  return {
    pivot: table !== undefined,
    backlinks: [...backlinks.keys()],
    commentCounts: [...commentCounts.keys()],
    lastActivity: [...lastActivity.keys()],
  };
}

/** How many of each lift's actions the scheduler holds once settled. */
function graphActionCounts(
  measurement: TopicsMeasurement,
): Record<TopicsLiftName, number> {
  const { graph, derivations } = measurement;
  const countOf = (lift: TopicsLiftName) =>
    graph.nodes.filter((node) => node.src === derivations.sources[lift]).length;
  return {
    crossrefTable: countOf("crossrefTable"),
    backlinksOf: countOf("backlinksOf"),
    presentCommentCountOf: countOf("presentCommentCountOf"),
    lastActivityOf: countOf("lastActivityOf"),
  };
}

/** Every mention entry in the fixture, repeats included. */
function mentionCount(fixture: TopicsFixture): number {
  return fixture.topics.reduce((sum, topic) => sum + topic.mentions.length, 0);
}

/**
 * Returns what `mentionedBy` returns for `topic`, by index, over the measured
 * board's distinct topics in the order of each one's first entry, which is the
 * list the pivot hands it.
 */
function mentionedByIndex(
  measurement: TopicsMeasurement,
  fixture: TopicsFixture,
  topic: number,
): number[] {
  const { seeded, derivations } = measurement;
  const distinct = [...new Set(fixture.board)];
  const entries = distinct.map((index) => seeded.topics[index]);
  const mentions = distinct.map((index) =>
    fixture.topics[index].mentions.map((target) => seeded.topics[target])
  );
  return derivations.mentionedBy(seeded.topics[topic], entries, mentions)
    .map((entry) => distinct[entries.indexOf(entry)]);
}

/** The latest stamp on a topic when edits and retractions are left out. */
function latestSendOrAddition(topic: FixtureTopic): number {
  return Math.max(
    topic.createdAt,
    topic.bodyUpdatedAt,
    topic.titleUpdatedAt,
    ...topic.comments.map((comment) => comment.sentAt),
    ...topic.links.map((link) => link.addedAt ?? 0),
  );
}

describe("topics-headless-fixture", () => {
  describe("buildTopicsFixture()", () => {
    it("returns no mentions for the `none` shape", () => {
      const fixture = buildTopicsFixture({
        topicCount: 6,
        mentions: { shape: "none" },
      });
      expect(mentionCount(fixture)).toBe(0);
      expect(inboundCounts(fixture)).toEqual([0, 0, 0, 0, 0, 0]);
    });

    it("returns `perSource` mentions from each topic and `perSource` inbound to each for the `low-degree` shape", () => {
      const fixture = buildTopicsFixture({
        topicCount: 6,
        mentions: { shape: "low-degree", perSource: 2 },
      });
      expect(mentionCount(fixture)).toBe(12);
      expect(inboundCounts(fixture)).toEqual([2, 2, 2, 2, 2, 2]);
      expect(fixture.topics[5].mentions).toEqual([0, 1]);
    });

    it("returns `perSource` mentions from each topic, landing on `perSource` + 1 topics, for the `high-degree` shape", () => {
      const fixture = buildTopicsFixture({
        topicCount: 6,
        mentions: { shape: "high-degree", perSource: 2 },
      });
      expect(mentionCount(fixture)).toBe(12);
      expect(inboundCounts(fixture)).toEqual([5, 5, 2, 0, 0, 0]);
    });

    it("returns `perSource` mentions of the first topic from each other topic, and none from the first topic, for the `single-bucket` shape", () => {
      const fixture = buildTopicsFixture({
        topicCount: 6,
        mentions: { shape: "single-bucket", perSource: 2 },
      });
      expect(mentionCount(fixture)).toBe(10);
      expect(inboundCounts(fixture)).toEqual([5, 0, 0, 0, 0, 0]);
      expect(fixture.topics[0].mentions).toEqual([]);
      expect(fixture.topics[3].mentions).toEqual([0, 0]);
    });

    it("returns one more mention each for a self-mention and a repeated mention", () => {
      const fixture = buildTopicsFixture({
        topicCount: 6,
        mentions: { shape: "low-degree", perSource: 2 },
        selfMention: 0,
        repeatedMention: 1,
      });
      expect(mentionCount(fixture)).toBe(14);
      expect(fixture.topics[0].mentions).toEqual([1, 2, 0]);
      expect(fixture.topics[1].mentions).toEqual([2, 3, 2]);
    });

    it("returns a board listing a duplicated topic again after every other entry", () => {
      const fixture = buildTopicsFixture({
        topicCount: 6,
        mentions: { shape: "none" },
        duplicateBoardEntry: 2,
      });
      expect(fixture.board).toEqual([0, 1, 2, 3, 4, 5, 2]);
    });

    it("returns equal fixtures for equal options", () => {
      const options = {
        topicCount: 8,
        mentions: { shape: "high-degree", perSource: 3 },
        commentsPerTopic: 7,
        linksPerTopic: 5,
        selfMention: 4,
        repeatedMention: 6,
        duplicateBoardEntry: 1,
      } as const;
      expect(buildTopicsFixture(options)).toEqual(buildTopicsFixture(options));
    });

    it("returns edited and retracted comments, and retracted and unstamped links, on every topic", () => {
      const fixture = buildTopicsFixture({
        topicCount: 6,
        mentions: { shape: "none" },
      });
      for (const topic of fixture.topics) {
        expect(topic.comments.some((c) => c.editedAt !== undefined)).toBe(true);
        expect(topic.comments.some((c) => c.removedAt !== undefined)).toBe(
          true,
        );
        expect(topic.links.some((l) => l.removedAt !== undefined)).toBe(true);
        expect(topic.links.some((l) => l.addedAt === undefined)).toBe(true);
      }
    });

    it("returns topics whose latest stamps are, in rotation, a comment retraction, a comment edit, and a link retraction", () => {
      const fixture = buildTopicsFixture({
        topicCount: 3,
        mentions: { shape: "none" },
      });
      const [retracted, edited, unlinked] = fixture.topics;
      for (const topic of fixture.topics) {
        expect(latestStamp(topic)).toBeGreaterThan(latestSendOrAddition(topic));
      }
      expect(retracted.comments.at(-1)?.removedAt).toBe(
        latestStamp(retracted),
      );
      expect(edited.comments.at(-1)?.editedAt).toBe(latestStamp(edited));
      expect(unlinked.links.at(-1)?.removedAt).toBe(latestStamp(unlinked));
    });

    it("throws for an option naming a topic index outside the fixture", () => {
      expect(() =>
        buildTopicsFixture({
          topicCount: 6,
          mentions: { shape: "none" },
          selfMention: 6,
        })
      ).toThrow(/`selfMention`/);
    });

    it("throws for more mentions per source than there are other topics", () => {
      expect(() =>
        buildTopicsFixture({
          topicCount: 6,
          mentions: { shape: "low-degree", perSource: 6 },
        })
      ).toThrow(/`mentions.perSource`/);
    });

    it("throws for a repeated mention on a topic that mentions nothing", () => {
      expect(() =>
        buildTopicsFixture({
          topicCount: 6,
          mentions: { shape: "single-bucket", perSource: 1 },
          repeatedMention: 0,
        })
      ).toThrow(/`repeatedMention`/);
    });
  });

  describe("topicsFixtureModeOf()", () => {
    // A measurement's `mode` is what labels every sample the probe writes, and
    // it is read back off the runtime rather than taken from what the caller
    // asked for. Each case here checks the runtime's own report as well, so a
    // pass cannot come from the two agreeing on a flag neither one set.

    it("returns `lazy-materialization-on` for a measurement given no mode", async () => {
      await using measurement = await measureTopicsFixture(
        buildTopicsFixture({ topicCount: 1, mentions: { shape: "none" } }),
        "topics-headless-fixture default mode",
      );
      const { experimental } = measurement.runtime;
      expect(experimental.lazyMaterialization).toBe(true);
      expect(experimental.serverExecution).toBe(false);
      expect(topicsFixtureModeOf(experimental)).toBe("lazy-materialization-on");
      expect(measurement.mode).toBe("lazy-materialization-on");
    });

    it("returns `lazy-materialization-off` for a measurement given that mode", async () => {
      await using measurement = await measureTopicsFixture(
        buildTopicsFixture({ topicCount: 1, mentions: { shape: "none" } }),
        "topics-headless-fixture lazy materialization off",
        { workload: "all-backlinks" },
        { mode: "lazy-materialization-off" },
      );
      const { experimental } = measurement.runtime;
      expect(experimental.lazyMaterialization).toBe(false);
      expect(experimental.serverExecution).toBe(false);
      expect(topicsFixtureModeOf(experimental)).toBe(
        "lazy-materialization-off",
      );
      expect(measurement.mode).toBe("lazy-materialization-off");
    });

    it("throws naming the flags when no mode holds them", () => {
      expect(() =>
        topicsFixtureModeOf({
          lazyMaterialization: true,
          serverExecution: true,
        })
      ).toThrow(
        /^No measurement mode runs with lazyMaterialization=true, serverExecution=true\.$/,
      );
    });
  });

  describe("reachTopicsDerivations()", () => {
    it("returns the four lifts, each with its authored source, and `mentionedBy` from the Topics sources", async () => {
      await using measurement = await measureTopicsFixture(
        buildTopicsFixture({ topicCount: 1, mentions: { shape: "none" } }),
        "topics-headless-fixture reach",
      );
      const { sources, mentionedBy } = measurement.derivations;
      expect(sources.crossrefTable).toMatch(
        /^cf:module\/[^/]+\/topics\/main\.tsx:\d+:\d+$/,
      );
      for (
        const name of [
          "backlinksOf",
          "presentCommentCountOf",
          "lastActivityOf",
        ] as const
      ) {
        expect(sources[name]).toMatch(
          /^cf:module\/[^/]+\/topics\/topic\.tsx:\d+:\d+$/,
        );
      }
      expect(new Set(Object.values(sources)).size).toBe(4);
      expect(typeof mentionedBy).toBe("function");
    });

    it("throws naming each symbol a Topics program does not define", async () => {
      // A board whose topic module defines two of the three topic lifts, and
      // whose entry module defines the pivot but exports no join.

      await using measurement = await measureTopicsFixture(
        buildTopicsFixture({ topicCount: 1, mentions: { shape: "none" } }),
        "topics-headless-fixture missing symbol",
      );
      const { runtime } = measurement;
      const stub = {
        main: "/topics/main.tsx",
        files: [
          {
            name: "/topics/main.tsx",
            contents: [
              `import { lift } from "commonfabric";`,
              `import { presentCount } from "./topic.tsx";`,
              `const crossrefTable = lift(`,
              `  ({ sources }: { sources: unknown[] }) => sources.length,`,
              `);`,
              `export const pivot = crossrefTable;`,
              `export const counted = presentCount;`,
            ].join("\n"),
          },
          {
            name: "/topics/topic.tsx",
            contents: [
              `import { lift } from "commonfabric";`,
              `const presentCommentCountOf = lift(`,
              `  ({ comments }: { comments: unknown[] }) => comments.length,`,
              `);`,
              `const lastActivityOf = lift(`,
              `  ({ createdAt }: { createdAt: number }) => createdAt,`,
              `);`,
              `export const presentCount = presentCommentCountOf;`,
              `export const activity = lastActivityOf;`,
            ].join("\n"),
          },
        ],
      };
      const reached = reachTopicsDerivations(runtime, stub);
      await expect(reached).rejects.toThrow(/`backlinksOf`, `mentionedBy`/);
      await expect(reachTopicsDerivations(runtime, stub)).rejects.not.toThrow(
        /`crossrefTable`|`presentCommentCountOf`|`lastActivityOf`/,
      );
      await expect(
        reachTopicsDerivations(runtime, await resolveTopicsProgram(runtime)),
      ).resolves.toBeDefined();
    });
  });

  describe("over a board with a self-mention and a repeated mention", () => {
    const SELF_MENTIONER = 0;
    const REPEATED_MENTIONER = 1;
    const fixture = buildTopicsFixture({
      topicCount: 6,
      mentions: { shape: "low-degree", perSource: 2 },
      selfMention: SELF_MENTIONER,
      repeatedMention: REPEATED_MENTIONER,
    });
    const topicIndices = fixture.topics.map((_, index) => index);
    let measurement: TopicsMeasurement;
    let aggregates: TopicsMeasurement;

    beforeAll(async () => {
      measurement = await measureTopicsFixture(
        fixture,
        "topics-headless-fixture oracle",
      );
      aggregates = await measureTopicsFixture(
        fixture,
        "topics-headless-fixture oracle aggregates",
        { workload: "aggregates" },
      );
    });
    afterAll(async () => {
      await measurement?.[Symbol.asyncDispose]();
      await aggregates?.[Symbol.asyncDispose]();
    });

    it("reports no runtime errors", () => {
      expect({
        allBacklinks: measurement.errors,
        aggregates: aggregates.errors,
      }).toEqual({ allBacklinks: [], aggregates: [] });
    });

    it("holds the pivot and every topic's backlinks under `all-backlinks`, and every topic's aggregates under `aggregates`", () => {
      expect({
        allBacklinks: outputKeys(measurement),
        aggregates: outputKeys(aggregates),
      }).toEqual({
        allBacklinks: {
          pivot: true,
          backlinks: topicIndices,
          commentCounts: [],
          lastActivity: [],
        },
        aggregates: {
          pivot: false,
          backlinks: [],
          commentCounts: topicIndices,
          lastActivity: topicIndices,
        },
      });
    });

    it("returns every topic's backlinks as `mentionedBy` and the fixture's indices compute them", () => {
      const { seeded, outputs } = measurement;
      const expected = topicIndices.map((topic) =>
        mentionersOf(fixture, topic)
      );
      expect(
        topicIndices.map((topic) =>
          mentionedByIndex(measurement, fixture, topic)
        ),
      )
        .toEqual(expected);
      expect(
        topicIndices.map((topic) =>
          topicIndicesOf(seeded, outputOf(outputs.backlinks, topic))
        ),
      ).toEqual(expected);
      expect(expected.every((backlinks) => backlinks.length > 0)).toBe(true);
    });

    it("returns a self-mentioning topic's backlinks without the topic itself", () => {
      const { seeded, outputs } = measurement;
      const backlinks = topicIndicesOf(
        seeded,
        outputOf(outputs.backlinks, SELF_MENTIONER),
      );
      expect(fixture.topics[SELF_MENTIONER].mentions).toContain(SELF_MENTIONER);
      expect(backlinks).toEqual(
        mentionedByIndex(measurement, fixture, SELF_MENTIONER),
      );
      expect(backlinks).not.toContain(SELF_MENTIONER);
    });

    it("returns a source that mentions a topic twice once among that topic's backlinks", () => {
      const { seeded, outputs } = measurement;
      const [target] = fixture.topics[REPEATED_MENTIONER].mentions;
      expect(
        fixture.topics[REPEATED_MENTIONER].mentions.filter((m) => m === target),
      ).toHaveLength(2);
      const backlinks = topicIndicesOf(
        seeded,
        outputOf(outputs.backlinks, target),
      );
      expect(backlinks).toEqual(mentionedByIndex(measurement, fixture, target));
      expect(backlinks.filter((source) => source === REPEATED_MENTIONER))
        .toHaveLength(1);
    });

    it("returns a pivot entry per board entry, naming its topic and the topics `mentionedBy` computes", () => {
      expect(
        pivotEntriesOf(measurement.seeded, tableOf(measurement)).map((
          { topic, mentionedBy },
        ) => ({ topic, mentionedBy })),
      ).toEqual(fixture.board.map((topic) => ({
        topic,
        mentionedBy: mentionedByIndex(measurement, fixture, topic),
      })));
    });

    it("returns each topic's present comment count as a count of its unretracted comments", () => {
      const counts = topicIndices.map((topic) =>
        outputOf(aggregates.outputs.commentCounts, topic).get()
      );
      expect(counts).toEqual(fixture.topics.map(presentCommentCount));
      expect(
        counts.some((count, topic) =>
          count < fixture.topics[topic].comments.length
        ),
      ).toBe(true);
    });

    it("returns each topic's last activity as its latest stamp, edits and retractions included", () => {
      const activity = topicIndices.map((topic) =>
        outputOf(aggregates.outputs.lastActivity, topic).get()
      );
      expect(activity).toEqual(fixture.topics.map(latestStamp));
      expect(
        fixture.topics.every((topic) =>
          latestStamp(topic) > latestSendOrAddition(topic)
        ),
      ).toBe(true);
    });

    it("attributes each lift's runs and attempts to that lift by the source the scheduler reports", () => {
      // Each started lift has one scheduler action per instance: under
      // `all-backlinks` one pivot and one backlinks lookup per topic, and under
      // `aggregates` one of each aggregate per topic. The run telemetry the
      // reads are keyed on, the graph snapshot, and the reach helper's `src`
      // all take an action's authored source from one lookup, so the source
      // string is not checked independently here. The action IDs are: the
      // reads gather them from run telemetry, and the snapshot lists the
      // actions the scheduler holds, so the two sets agreeing shows each
      // lift's runs are attributed to that lift's own actions and to no
      // others. Attempts are attributed through those same action IDs, and
      // each run commits in an attempt of its own.

      const topics = fixture.topics.length;
      const workloads: [TopicsMeasurement, Record<TopicsLiftName, number>][] = [
        [measurement, {
          crossrefTable: 1,
          backlinksOf: topics,
          presentCommentCountOf: 0,
          lastActivityOf: 0,
        }],
        [aggregates, {
          crossrefTable: 0,
          backlinksOf: 0,
          presentCommentCountOf: topics,
          lastActivityOf: topics,
        }],
      ];
      for (const [measured, instances] of workloads) {
        const { reads, graph, derivations, demand } = measured;
        for (const lift of TOPICS_LIFT_NAMES) {
          const count = instances[lift];
          const body = reads.bodies[lift];
          const graphActions = graph.nodes
            .filter((node) => node.src === derivations.sources[lift])
            .map((node) => node.id);
          expect({ demand, lift, actions: body.actions.size }).toEqual({
            demand,
            lift,
            actions: count,
          });
          expect([...body.actions].toSorted()).toEqual(
            graphActions.toSorted(),
          );
          expect({
            demand,
            lift,
            runs: body.runs >= count,
            read: body.proxyAccesses > 0 === count > 0,
            attempts: reads.attempts[lift].attempts >= count,
          }).toEqual({ demand, lift, runs: true, read: true, attempts: true });
        }
        expect(reads.attempts.other.attempts).toBeGreaterThan(0);
      }
    });
  });

  describe("over a board listing one topic twice", () => {
    const DUPLICATED = 2;
    const fixture = buildTopicsFixture({
      topicCount: 6,
      mentions: { shape: "low-degree", perSource: 2 },
      // The duplicated topic also mentions itself, so its second board entry
      // names it: a pivot counting that entry as a source apart from the topic
      // would list the topic among its own backlinks.
      selfMention: DUPLICATED,
      duplicateBoardEntry: DUPLICATED,
    });
    let measurement: TopicsMeasurement;

    beforeAll(async () => {
      measurement = await measureTopicsFixture(
        fixture,
        "topics-headless-fixture duplicate entry",
      );
    });
    afterAll(async () => {
      await measurement?.[Symbol.asyncDispose]();
    });

    it("reports no runtime errors", () => {
      expect(measurement.errors).toEqual([]);
    });

    it("returns a duplicated topic its own backlinks once", () => {
      const { seeded, outputs } = measurement;
      const oracle = mentionedByIndex(measurement, fixture, DUPLICATED);
      expect(oracle).toEqual(mentionersOf(fixture, DUPLICATED));
      expect(oracle).toEqual([0, 1]);
      expect(
        topicIndicesOf(seeded, outputOf(outputs.backlinks, DUPLICATED)),
      ).toEqual(oracle);
    });

    it("returns one pivot entry per distinct topic, each on its own row, in the order of each topic's first board entry", () => {
      // The duplicate is the board's last entry, so ordering by last
      // occurrence would move the duplicated topic to the end.

      const entries = pivotEntriesOf(
        measurement.seeded,
        tableOf(measurement),
      );
      expect(fixture.board).toEqual([0, 1, 2, 3, 4, 5, DUPLICATED]);
      const firstOccurrences = [0, 1, 2, 3, 4, 5];
      expect(
        entries.map(({ topic, mentionedBy }) => ({ topic, mentionedBy })),
      ).toEqual(firstOccurrences.map((topic) => ({
        topic,
        mentionedBy: mentionedByIndex(measurement, fixture, topic),
      })));
      expect(new Set(entries.map((entry) => entry.row)).size).toBe(
        firstOccurrences.length,
      );
    });

    it("returns every other topic's backlinks as the fixture's indices and `mentionedBy` compute them", () => {
      const { seeded, outputs } = measurement;
      const others = fixture.topics.map((_, topic) => topic).filter((topic) =>
        topic !== DUPLICATED
      );
      const expected = others.map((topic) => mentionersOf(fixture, topic));
      expect(
        others.map((topic) => mentionedByIndex(measurement, fixture, topic)),
      ).toEqual(expected);
      expect(
        others.map((topic) =>
          topicIndicesOf(seeded, outputOf(outputs.backlinks, topic))
        ),
      ).toEqual(expected);
    });

    it("returns a source listed at two board entries once among the backlinks of a topic it mentions", () => {
      const { seeded, outputs } = measurement;
      const [target] = fixture.topics[DUPLICATED].mentions;
      expect(fixture.board.filter((entry) => entry === DUPLICATED))
        .toHaveLength(2);
      // Topic 1 and the duplicated topic are the sources mentioning `target`.
      expect(target).toBe(3);
      expect(topicIndicesOf(seeded, outputOf(outputs.backlinks, target)))
        .toEqual([1, DUPLICATED]);
    });
  });

  describe("over a board listing one topic again through an alias", () => {
    const ALIASED = 2;
    const fixture = buildTopicsFixture({
      topicCount: 6,
      mentions: { shape: "low-degree", perSource: 2 },
    });
    let measurement: TopicsMeasurement;
    let holderId: string;
    let appended: TopicsOperation;

    beforeAll(async () => {
      measurement = await measureTopicsFixture(
        fixture,
        "topics-headless-fixture alias entry",
      );
      const { runtime, seeded } = measurement;
      appended = await measurement.update((tx) => {
        // The appended entry is a link to the holder's slot, a different link
        // from the topic's own that resolves to the same document.
        const holder = runtime.getCell<unknown[]>(
          seeded.board.getAsNormalizedFullLink().space,
          "topics-headless-fixture-alias-holder",
          undefined,
          tx,
        );
        holder.set([seeded.topics[ALIASED]]);
        seeded.board.withTx(tx).push(holder.key(0));
        holderId = holder.getAsNormalizedFullLink().id;
      });
    });
    afterAll(async () => {
      await measurement?.[Symbol.asyncDispose]();
    });

    it("reports no runtime errors", () => {
      expect(measurement.errors).toEqual([]);
    });

    it("returns a source listed again through an alias once among the backlinks of a topic it mentions", () => {
      const { seeded, outputs } = measurement;
      const alias = parseLink(
        seeded.board.key(fixture.board.length).getRaw(),
        seeded.board,
      );
      expect({ id: alias?.id, path: alias?.path }).toEqual({
        id: holderId,
        path: ["0"],
      });
      expect(topicIndicesOf(seeded, seeded.board)).toEqual([
        ...fixture.board,
        ALIASED,
      ]);
      const [target] = fixture.topics[ALIASED].mentions;
      // Topic 1 and the aliased topic are the sources mentioning `target`.
      expect(target).toBe(3);
      // The pivot ran after the alias was appended, so the backlinks below are
      // its result over the board holding the alias, not the result it held
      // over the board before it.
      expect(appended.reads.bodies.crossrefTable.runs).toBeGreaterThan(0);
      expect(topicIndicesOf(seeded, outputOf(outputs.backlinks, target)))
        .toEqual([1, ALIASED]);
    });
  });

  describe("over a board loaded before any topic is opened", () => {
    const fixture = buildTopicsFixture({
      topicCount: 6,
      mentions: { shape: "high-degree", perSource: 2 },
    });
    let measurement: TopicsMeasurement;

    beforeAll(async () => {
      measurement = await measureTopicsFixture(
        fixture,
        "topics-headless-fixture board demand",
        { workload: "board" },
      );
    });
    afterAll(async () => {
      await measurement?.[Symbol.asyncDispose]();
    });

    it("reports no runtime errors", () => {
      expect(measurement.errors).toEqual([]);
    });

    it("starts none of the reached lifts and holds none of their outputs", () => {
      expect(graphActionCounts(measurement)).toEqual({
        crossrefTable: 0,
        backlinksOf: 0,
        presentCommentCountOf: 0,
        lastActivityOf: 0,
      });
      expect(outputKeys(measurement)).toEqual({
        pivot: false,
        backlinks: [],
        commentCounts: [],
        lastActivity: [],
      });
      expect(
        TOPICS_LIFT_NAMES.map((lift) => measurement.reads.bodies[lift].runs),
      ).toEqual([0, 0, 0, 0]);
    });
  });

  describe("over a board with one topic open", () => {
    const OPEN = 1;
    const fixture = buildTopicsFixture({
      topicCount: 6,
      mentions: { shape: "high-degree", perSource: 2 },
    });
    let measurement: TopicsMeasurement;

    beforeAll(async () => {
      measurement = await measureTopicsFixture(
        fixture,
        "topics-headless-fixture topic-open demand",
        { workload: "topic-open", topic: OPEN },
      );
    });
    afterAll(async () => {
      await measurement?.[Symbol.asyncDispose]();
    });

    it("reports no runtime errors", () => {
      expect(measurement.errors).toEqual([]);
    });

    it("starts the pivot and the open topic's backlinks and comment count, and nothing else", () => {
      expect(graphActionCounts(measurement)).toEqual({
        crossrefTable: 1,
        backlinksOf: 1,
        presentCommentCountOf: 1,
        lastActivityOf: 0,
      });
      expect(outputKeys(measurement)).toEqual({
        pivot: true,
        backlinks: [OPEN],
        commentCounts: [OPEN],
        lastActivity: [],
      });
    });

    it("returns the open topic's backlinks and present comment count", () => {
      const { seeded, outputs } = measurement;
      expect(mentionersOf(fixture, OPEN)).toHaveLength(5);
      expect({
        backlinks: topicIndicesOf(seeded, outputOf(outputs.backlinks, OPEN)),
        commentCount: outputOf(outputs.commentCounts, OPEN).get(),
      }).toEqual({
        backlinks: mentionersOf(fixture, OPEN),
        commentCount: presentCommentCount(fixture.topics[OPEN]),
      });
    });

    it("throws for an open topic outside the fixture", async () => {
      await expect(
        measureTopicsFixture(fixture, "topics-headless-fixture out of range", {
          workload: "topic-open",
          topic: fixture.topics.length,
        }),
      ).rejects.toThrow(/`demand.topic`/);
    });
  });

  describe("update()", () => {
    const MENTIONER = 2;
    const OPEN = 0;
    const fixture = buildTopicsFixture({
      topicCount: 4,
      mentions: { shape: "none" },
    });
    let measurement: TopicsMeasurement;
    let initialPivotRuns: number;
    let update: TopicsOperation;

    beforeAll(async () => {
      measurement = await measureTopicsFixture(
        fixture,
        "topics-headless-fixture update",
        { workload: "topic-open", topic: OPEN },
      );
      const { seeded } = measurement;
      initialPivotRuns = measurement.reads.bodies.crossrefTable.runs;
      update = await measurement.update((tx) => {
        seeded.topics[MENTIONER].withTx(tx).key("mentions").set([
          seeded.topics[OPEN],
        ]);
      });
    });
    afterAll(async () => {
      await measurement?.[Symbol.asyncDispose]();
    });

    it("reports no runtime errors", () => {
      expect(measurement.errors).toEqual([]);
    });

    it("returns once the outputs reflect the edit", () => {
      const { seeded, outputs } = measurement;
      expect(topicIndicesOf(seeded, outputOf(outputs.backlinks, OPEN)))
        .toEqual([MENTIONER]);
    });

    it("returns the runs and attempts the edit causes, attributed to the pivot and the lookup", () => {
      const { bodies, attempts } = update.reads;
      expect({
        pivotRuns: bodies.crossrefTable.runs > 0,
        lookupRuns: bodies.backlinksOf.runs > 0,
        pivotAttempts: attempts.crossrefTable.attempts > 0,
        lookupAttempts: attempts.backlinksOf.attempts > 0,
      }).toEqual({
        pivotRuns: true,
        lookupRuns: true,
        pivotAttempts: true,
        lookupAttempts: true,
      });
    });

    it("leaves the initialization reads as they were", () => {
      expect(measurement.reads.bodies.crossrefTable.runs).toBe(
        initialPivotRuns,
      );
    });
  });

  describe("reopen()", () => {
    const MENTIONER = 2;
    const OPEN = 0;
    const fixture = buildTopicsFixture({
      topicCount: 4,
      mentions: { shape: "none" },
    });
    let measurement: TopicsMeasurement;
    let measuredRuntime: TopicsMeasurement["runtime"];
    let reopened: TopicsOperation;

    beforeAll(async () => {
      measurement = await measureTopicsFixture(
        fixture,
        "topics-headless-fixture reopen",
        { workload: "topic-open", topic: OPEN },
      );
      const { seeded } = measurement;
      await measurement.update((tx) => {
        seeded.topics[MENTIONER].withTx(tx).key("mentions").set([
          seeded.topics[OPEN],
        ]);
      });
      measuredRuntime = measurement.runtime;
      reopened = await measurement.reopen();
    });
    afterAll(async () => {
      await measurement?.[Symbol.asyncDispose]();
    });

    it("reports no runtime errors", () => {
      expect(measurement.errors).toEqual([]);
    });

    it("leaves the measurement holding a runtime other than the one it started", () => {
      expect(measurement.runtime).not.toBe(measuredRuntime);
    });

    it("returns outputs holding what the first runtime stored, its update included", () => {
      const { seeded, outputs } = measurement;
      expect({
        backlinks: topicIndicesOf(seeded, outputOf(outputs.backlinks, OPEN)),
        commentCount: outputOf(outputs.commentCounts, OPEN).get(),
      }).toEqual({
        backlinks: [MENTIONER],
        commentCount: presentCommentCount(fixture.topics[OPEN]),
      });
    });

    it("returns the reads of starting the demanded lifts again", () => {
      const { bodies, attempts } = reopened.reads;
      expect(
        TOPICS_LIFT_NAMES.map((lift) => ({
          lift,
          actions: bodies[lift].actions.size,
          attempted: attempts[lift].attempts > 0,
        })),
      ).toEqual([
        { lift: "crossrefTable", actions: 1, attempted: true },
        { lift: "backlinksOf", actions: 1, attempted: true },
        { lift: "presentCommentCountOf", actions: 1, attempted: true },
        { lift: "lastActivityOf", actions: 0, attempted: false },
      ]);
    });
  });
});
