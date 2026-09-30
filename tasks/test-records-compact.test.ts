import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  closedDays,
  compactDays,
  COMPACTION_LAG_DAYS,
  parseCompactArgs,
  parseRollupManifest,
  parseRollupPartition,
  rollupManifestName,
  rollupPartitionName,
  rollupPrefix,
  rollupShardName,
  rollupShards,
  SHARD_TARGET_BYTES,
  shardCount,
  shardOf,
  writeToken,
} from "./test-records-compact.ts";
import {
  buildObjectBody,
  gunzipToText,
  parseReportGroups,
  type RunContext,
  type TestRecord,
} from "@commonfabric/test-support/records";

const NOW = Date.parse("2026-08-18T12:00:00Z");
const DAY = "2026/08/11";

const RECORD: TestRecord = {
  line: "record",
  test: { k: "unit", s: "bakery", n: "glaze > sets" },
  outcome: "pass",
  durationMs: 4,
};

function contextOn(day: string): RunContext {
  return {
    schema: 1,
    line: "context",
    reportId: "01COMPACT000000000000000",
    repo: "commonfabric/labs",
    commit: "e".repeat(40),
    dirty: false,
    env: "ci",
    ci: { workflowRunId: "9", runAttempt: 1, workflow: "CI", job: "Test" },
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt: `${day.replaceAll("/", "-")}T01:00:00.000Z`,
  };
}

interface Store {
  /** Object name to body text, for everything the store already holds. */
  objects: Record<string, string>;

  /** Object name to gzipped bytes, for everything a run created. */
  created: Record<string, Uint8Array>;

  /** Stored size the listing reports for every object, in bytes. */
  size: number;
}

function storeOf(day: string, bodies: string[], size = 1000): Store {
  const objects: Record<string, string> = {};
  bodies.forEach((body, index) => {
    objects[
      `labs/test-records/submissions/ci/v1/${day}/run-${index}-Test.ndjson`
    ] = body;
  });
  return { objects, created: {}, size };
}

/** A day's raw objects, one record each, named for their own case. */
function casesOn(day: string, count: number): string[] {
  const bodies: string[] = [];
  for (let index = 0; index < count; index++) {
    bodies.push(buildObjectBody(contextOn(day), [{
      ...RECORD,
      test: { ...RECORD.test, n: `case ${index}` },
    }]));
  }
  return bodies;
}

/** The payload part of a multipart create, without decoding its bytes. */
function payloadOf(body: Uint8Array): Uint8Array {
  const afterHeaders = (from: number): number => {
    for (let at = from; at <= body.length - 4; at++) {
      if (
        body[at] === 13 && body[at + 1] === 10 && body[at + 2] === 13 &&
        body[at + 3] === 10
      ) {
        return at + 4;
      }
    }
    return body.length;
  };
  const boundary = body.indexOf(13);
  return body.subarray(
    afterHeaders(afterHeaders(0)),
    body.length - (boundary + 6),
  );
}

/**
 * A store stub: listings answer by prefix, reads serve bodies, and creates
 * land in both `created` and `objects`, so a later run against the same
 * store sees what an earlier one wrote.
 */
function storeFetch(store: Store): typeof fetch {
  return ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = init.body as Uint8Array;
      const head = new TextDecoder("utf-8", { fatal: false }).decode(
        body.subarray(0, 512),
      );
      const name = head.match(/"name":"([^"]+)"/)?.[1] ?? "unnamed";
      store.created[name] = payloadOf(body);
      // The JSON objects are stored as written, so a later run against the
      // same store reads back what an earlier one put there; a shard's
      // body is gzipped and no run reads one.
      store.objects[name] = name.endsWith(".json")
        ? new TextDecoder().decode(store.created[name]!)
        : "";
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    if (url.includes("/storage/v1/")) {
      const prefix = new URL(url).searchParams.get("prefix")!;
      const items = Object.keys(store.objects)
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name, size: String(store.size) }));
      return Promise.resolve(
        new Response(JSON.stringify({ items }), { status: 200 }),
      );
    }
    const name = url
      .replace("https://storage.googleapis.com/cf-ci-metadata/", "")
      .split("/").map(decodeURIComponent).join("/");
    const body = store.objects[name];
    if (body === undefined) {
      return Promise.resolve(new Response("no such object", { status: 404 }));
    }
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as typeof fetch;
}

/** The shards a run created, by name. */
function createdShards(store: Store): string[] {
  return Object.keys(store.created)
    .filter((name) => name.endsWith(".ndjson")).sort();
}

/** The manifest a run created. */
function createdManifest(store: Store, day: string) {
  return parseRollupManifest(
    new TextDecoder().decode(store.created[rollupManifestName(day)]!),
    day,
  );
}

/** Every record name in every shard a run created. */
async function compactedNames(store: Store): Promise<string[]> {
  const found: string[] = [];
  for (const name of createdShards(store)) {
    for (
      const group of parseReportGroups(await gunzipToText(store.created[name]!))
    ) {
      for (const record of group.records) found.push(record.test.n);
    }
  }
  return found.sort();
}

const OPTIONS = {
  days: COMPACTION_LAG_DAYS,
  bucket: "cf-ci-metadata",
  rawPrefix: "labs/test-records/submissions/ci",
  token: "t",
  now: NOW,
  plan: false,
};

describe("test-records-compact", () => {
  describe("closedDays()", () => {
    it("returns the partitions between the lag and the window edge", () => {
      const days = closedDays(COMPACTION_LAG_DAYS + 2, NOW);
      expect(days).toEqual(["2026/08/11", "2026/08/10", "2026/08/09"]);
    });
  });

  describe("shardCount()", () => {
    it("gives one shard up to the target and divides beyond it", () => {
      expect(shardCount(0)).toBe(1);
      expect(shardCount(SHARD_TARGET_BYTES)).toBe(1);
      expect(shardCount(SHARD_TARGET_BYTES + 1)).toBe(2);
      expect(shardCount(SHARD_TARGET_BYTES * 20)).toBe(20);
    });
  });

  describe("shardOf()", () => {
    it("puts a given name in a fixed shard", () => {
      // Pinned rather than recomputed: shards already in the store were
      // partitioned by this hash, so a change to it would put an object in
      // a shard that does not hold it and leave the one that does
      // unreferenced.
      const name =
        "labs/test-records/submissions/ci/v1/2026/08/11/run-7.ndjson";
      expect(shardOf(name, 16)).toBe(5);
      expect(shardOf(name, 256)).toBe(101);
      expect(shardOf(name, 17)).toBe(11);
    });

    it("spreads a day's names across the shards", () => {
      const seen = new Set<number>();
      for (let index = 0; index < 200; index++) {
        seen.add(shardOf(`run-${index}-Test.ndjson`, 8));
      }
      expect(seen.size).toBe(8);
    });
  });

  describe("rollupShardName()", () => {
    it("puts the shard count in the name", () => {
      expect(rollupShardName(3, 24)).toBe("0003-of-0024.ndjson");
    });
  });

  describe("parseRollupManifest()", () => {
    const good = JSON.stringify({
      schema: 1,
      day: DAY,
      shards: ["0000-of-0002.ndjson", "0001-of-0002.ndjson"],
    });

    it("accepts a manifest for the day asked about", () => {
      expect(parseRollupManifest(good, DAY)?.shards.length).toBe(2);
    });

    it("rejects a shard set no run writes", () => {
      const shards = (...names: string[]) =>
        parseRollupManifest(
          JSON.stringify({ schema: 1, day: DAY, shards: names }),
          DAY,
        );
      // A repeat would count its records twice, an index past the count
      // names an object no run writes, and a disagreeing count is two
      // partitions read as one day.
      expect(shards("0000-of-0002.ndjson", "0000-of-0002.ndjson"))
        .toBeUndefined();
      expect(shards("0002-of-0002.ndjson")).toBeUndefined();
      expect(shards("0000-of-0002.ndjson", "0001-of-0003.ndjson"))
        .toBeUndefined();
      // Gaps are what a day with an empty shard leaves behind.
      expect(shards("0000-of-0003.ndjson", "0002-of-0003.ndjson")?.shards)
        .toEqual(["0000-of-0003.ndjson", "0002-of-0003.ndjson"]);
    });

    it("rejects a manifest naming no shard", () => {
      // A day with no shards gets no manifest, so an empty one would say a
      // day's records are all accounted for by nothing.
      expect(parseRollupManifest(
        JSON.stringify({ schema: 1, day: DAY, shards: [] }),
        DAY,
      )).toBeUndefined();
    });

    it("rejects anything else", () => {
      expect(parseRollupManifest("not json", DAY)).toBeUndefined();
      // Valid JSON that is not a record of fields. A manifest is read out
      // of a stored object, so what arrives under its name is whatever
      // was created there.
      expect(parseRollupManifest("7", DAY)).toBeUndefined();
      expect(parseRollupManifest("null", DAY)).toBeUndefined();
      expect(parseRollupManifest(good, "2026/08/12")).toBeUndefined();
      // A shard entry that is not a name at all.
      expect(parseRollupManifest(
        JSON.stringify({ schema: 1, day: DAY, shards: [7] }),
        DAY,
      )).toBeUndefined();
      expect(parseRollupManifest(
        JSON.stringify({ schema: 2, day: DAY, shards: [] }),
        DAY,
      )).toBeUndefined();
      // A shard name is joined onto the day's prefix, so a name that could
      // reach outside that prefix is not a shard name.
      expect(parseRollupManifest(
        JSON.stringify({
          schema: 1,
          day: DAY,
          shards: ["../elsewhere.ndjson"],
        }),
        DAY,
      )).toBeUndefined();
    });
  });

  describe("parseRollupPartition()", () => {
    it("accepts a partition of the day asked about", () => {
      expect(
        parseRollupPartition(
          JSON.stringify({ schema: 1, day: DAY, count: 17 }),
          DAY,
        )?.count,
      ).toBe(17);
    });

    it("rejects anything else", () => {
      const partition = (fields: Record<string, unknown>) =>
        parseRollupPartition(JSON.stringify(fields), DAY);
      expect(parseRollupPartition("not json", DAY)).toBeUndefined();
      // Valid JSON that is not a record of fields, the way a manifest
      // that is not one is refused.
      expect(parseRollupPartition("7", DAY)).toBeUndefined();
      expect(parseRollupPartition("null", DAY)).toBeUndefined();
      expect(partition({ schema: 2, day: DAY, count: 1 })).toBeUndefined();
      expect(partition({ schema: 1, day: "2026/08/12", count: 1 }))
        .toBeUndefined();
      expect(partition({ schema: 1, day: DAY, count: 0 })).toBeUndefined();
      expect(partition({ schema: 1, day: DAY, count: 1.5 })).toBeUndefined();
      expect(partition({ schema: 1, day: DAY })).toBeUndefined();
    });
  });

  describe("rollupShards()", () => {
    it("names the shards of a compacted day", async () => {
      const store = storeOf(DAY, []);
      store.objects[rollupManifestName(DAY)] = JSON.stringify({
        schema: 1,
        day: DAY,
        shards: ["0000-of-0002.ndjson", "0001-of-0002.ndjson"],
      });
      expect(
        await rollupShards({
          bucket: "cf-ci-metadata",
          day: DAY,
          fetch: storeFetch(store),
        }),
      ).toEqual([
        `${rollupPrefix(DAY)}0000-of-0002.ndjson`,
        `${rollupPrefix(DAY)}0001-of-0002.ndjson`,
      ]);
    });

    it("gives nothing for a day with no manifest", async () => {
      expect(
        await rollupShards({
          bucket: "cf-ci-metadata",
          day: DAY,
          fetch: storeFetch(storeOf(DAY, [])),
        }),
      ).toBeUndefined();
    });

    it("gives nothing for a manifest that is there and will not read", async () => {
      // Read the same way a day that was never compacted reads, so the
      // reader goes to the raw area rather than to shard names taken from
      // a body nobody validated. Nothing can replace the object, since the
      // store's writers hold create alone.
      const store = storeOf(DAY, []);
      store.objects[rollupManifestName(DAY)] = "{ not a manifest";
      expect(
        await rollupShards({
          bucket: "cf-ci-metadata",
          day: DAY,
          fetch: storeFetch(store),
        }),
      ).toBeUndefined();
    });
  });

  describe("compactDays()", () => {
    it("writes one shard and a manifest for a small day", async () => {
      const store = storeOf(DAY, [
        buildObjectBody(contextOn(DAY), [RECORD, RECORD]),
      ]);
      await compactDays({ ...OPTIONS, fetchImpl: storeFetch(store) });
      // Spelled out rather than built from the functions under test: this
      // is the layout docs/specs/test-records.md documents.
      expect(Object.keys(store.created).sort()).toEqual([
        "labs/test-records/aggregated/ci/v1/2026/08/11/0000-of-0001.ndjson",
        "labs/test-records/aggregated/ci/v1/2026/08/11/partition.json",
        "labs/test-records/aggregated/ci/v1/2026/08/11/rollup.json",
      ]);
      expect(await compactedNames(store)).toEqual([
        RECORD.test.n,
        RECORD.test.n,
      ]);
    });

    it("keeps each report's own context ahead of its own records", async () => {
      // One object holding two reports, as a rollup of a rollup would be.
      const first = { ...contextOn(DAY), reportId: "01FIRST00000000000000000" };
      const second = {
        ...contextOn(DAY),
        reportId: "01SECOND0000000000000000",
      };
      const store = storeOf(DAY, [
        buildObjectBody(first, [RECORD]) +
        buildObjectBody(second, [RECORD, RECORD]),
      ]);
      await compactDays({ ...OPTIONS, fetchImpl: storeFetch(store) });
      const groups = parseReportGroups(
        await gunzipToText(store.created[createdShards(store)[0]!]!),
      );
      expect(groups.map((group) => group.context?.reportId)).toEqual([
        first.reportId,
        second.reportId,
      ]);
      expect(groups.map((group) => group.records.length)).toEqual([1, 2]);
    });

    it("compacts every closed day in the window", async () => {
      const store = storeOf(DAY, [buildObjectBody(contextOn(DAY), [RECORD])]);
      const older = "2026/08/10";
      Object.assign(
        store.objects,
        storeOf(older, [buildObjectBody(contextOn(older), [RECORD])]).objects,
      );
      await compactDays({
        ...OPTIONS,
        days: COMPACTION_LAG_DAYS + 1,
        fetchImpl: storeFetch(store),
      });
      expect(Object.keys(store.created).sort()).toEqual([
        "labs/test-records/aggregated/ci/v1/2026/08/10/0000-of-0001.ndjson",
        "labs/test-records/aggregated/ci/v1/2026/08/10/partition.json",
        "labs/test-records/aggregated/ci/v1/2026/08/10/rollup.json",
        "labs/test-records/aggregated/ci/v1/2026/08/11/0000-of-0001.ndjson",
        "labs/test-records/aggregated/ci/v1/2026/08/11/partition.json",
        "labs/test-records/aggregated/ci/v1/2026/08/11/rollup.json",
      ]);
    });

    it("divides a day past the target, losing no record", async () => {
      // Five shards' worth of stored bytes across the day's objects.
      const store = storeOf(DAY, casesOn(DAY, 40), SHARD_TARGET_BYTES / 8);
      await compactDays({ ...OPTIONS, fetchImpl: storeFetch(store) });
      expect(createdShards(store).length).toBe(5);
      expect(await compactedNames(store)).toEqual(
        casesOn(DAY, 40).map((_, index) => `case ${index}`).sort(),
      );
    });

    it("names every shard it wrote in the manifest", async () => {
      const store = storeOf(DAY, casesOn(DAY, 40), SHARD_TARGET_BYTES / 8);
      await compactDays({ ...OPTIONS, fetchImpl: storeFetch(store) });
      expect(createdManifest(store, DAY)?.shards).toEqual(
        createdShards(store).map((name) =>
          name.slice(rollupPrefix(DAY).length)
        ),
      );
    });

    it("skips a day whose manifest already exists", async () => {
      const store = storeOf(DAY, [buildObjectBody(contextOn(DAY), [RECORD])]);
      store.objects[rollupManifestName(DAY)] = "{}";
      await compactDays({ ...OPTIONS, fetchImpl: storeFetch(store) });
      expect(Object.keys(store.created)).toEqual([]);
    });

    it("finishes a day whose shards were half written", async () => {
      const bodies = casesOn(DAY, 40);
      const whole = storeOf(DAY, bodies, SHARD_TARGET_BYTES / 8);
      await compactDays({ ...OPTIONS, fetchImpl: storeFetch(whole) });
      const written = createdShards(whole);

      // A run that died after two shards leaves its partition and those
      // two behind, and no manifest, which is what the next run finds.
      const store = storeOf(DAY, bodies, SHARD_TARGET_BYTES / 8);
      store.objects[rollupPartitionName(DAY)] = whole
        .objects[rollupPartitionName(DAY)]!;
      for (const name of written.slice(0, 2)) store.objects[name] = "";
      await compactDays({ ...OPTIONS, fetchImpl: storeFetch(store) });

      expect(createdShards(store)).toEqual(written.slice(2));
      // The manifest names what the earlier run wrote as well as what this
      // one did, so the day reads whole.
      expect(createdManifest(store, DAY)?.shards).toEqual(
        written.map((name) => name.slice(rollupPrefix(DAY).length)),
      );
    });

    it("finishes a day in the partition it was started in", async () => {
      const bodies = casesOn(DAY, 40);
      const whole = storeOf(DAY, bodies, SHARD_TARGET_BYTES / 8);
      await compactDays({ ...OPTIONS, fetchImpl: storeFetch(whole) });
      const written = createdShards(whole);

      // A run that died after two shards, and then enough raw objects
      // arriving to size the day differently. The partition the first run
      // claimed is the one the second finishes, so the shards it wrote are
      // named by the manifest rather than left behind by a second
      // partition alongside them.
      const store = storeOf(
        DAY,
        [...bodies, ...casesOn(DAY, 40)],
        SHARD_TARGET_BYTES / 8,
      );
      store.objects[rollupPartitionName(DAY)] = whole
        .objects[rollupPartitionName(DAY)]!;
      for (const name of written.slice(0, 2)) store.objects[name] = "";
      await compactDays({ ...OPTIONS, fetchImpl: storeFetch(store) });

      expect(createdManifest(store, DAY)?.shards).toEqual(
        written.map((name) => name.slice(rollupPrefix(DAY).length)),
      );
      expect(createdShards(store).every((name) => name.includes("-of-0005.")))
        .toBe(true);
    });

    it("names a shard another run created in the manifest", async () => {
      const store = storeOf(DAY, [buildObjectBody(contextOn(DAY), [RECORD])]);
      const inner = storeFetch(store);
      const shard = `${rollupPrefix(DAY)}0000-of-0001.ndjson`;
      // The shard's create loses its race and the manifest's does not, as
      // a run reaching a shard a concurrent run had just written would
      // find.
      const raced = ((input: URL | RequestInfo, init?: RequestInit) => {
        const head = init?.method === "POST"
          ? new TextDecoder("utf-8", { fatal: false })
            .decode((init.body as Uint8Array).subarray(0, 512))
          : "";
        if (head.includes(`"name":"${shard}"`)) {
          return Promise.resolve(new Response("taken", { status: 412 }));
        }
        return inner(input, init);
      }) as typeof fetch;
      await compactDays({ ...OPTIONS, fetchImpl: raced });
      expect(createdShards(store)).toEqual([]);
      expect(createdManifest(store, DAY)?.shards)
        .toEqual(["0000-of-0001.ndjson"]);
    });

    it("takes the partition of the run that claimed it first", async () => {
      // This run would size the day at five shards, and finds one claimed
      // at two, so two is what it writes.
      const store = storeOf(DAY, casesOn(DAY, 40), SHARD_TARGET_BYTES / 8);
      store.objects[rollupPartitionName(DAY)] = JSON.stringify({
        schema: 1,
        day: DAY,
        count: 2,
      });
      await compactDays({ ...OPTIONS, fetchImpl: storeFetch(store) });
      expect(
        createdShards(store).map((name) =>
          name.slice(rollupPrefix(DAY).length)
        ),
      ).toEqual(["0000-of-0002.ndjson", "0001-of-0002.ndjson"]);
      expect(await compactedNames(store)).toEqual(
        casesOn(DAY, 40).map((_, index) => `case ${index}`).sort(),
      );
    });

    it("takes the count of the run that won the create", async () => {
      const store = storeOf(DAY, casesOn(DAY, 40), SHARD_TARGET_BYTES / 8);
      const inner = storeFetch(store);
      const partition = JSON.stringify({ schema: 1, day: DAY, count: 2 });
      // The listing this run made came before the other run's partition
      // existed, so it claims one of its own, loses, and reads the count
      // that won: two shards, where its own listing said five.
      const raced = ((input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          const head = new TextDecoder("utf-8", { fatal: false })
            .decode((init.body as Uint8Array).subarray(0, 512));
          if (head.includes(`"name":"${rollupPartitionName(DAY)}"`)) {
            return Promise.resolve(new Response("taken", { status: 412 }));
          }
        } else if (url.endsWith("/partition.json")) {
          return Promise.resolve(new Response(partition, { status: 200 }));
        }
        return inner(input, init);
      }) as typeof fetch;
      await compactDays({ ...OPTIONS, fetchImpl: raced });
      expect(
        createdShards(store).map((name) =>
          name.slice(rollupPrefix(DAY).length)
        ),
      ).toEqual(["0000-of-0002.ndjson", "0001-of-0002.ndjson"]);
      expect(await compactedNames(store)).toEqual(
        casesOn(DAY, 40).map((_, index) => `case ${index}`).sort(),
      );
    });

    it("leaves a day whose partition cannot be read open", async () => {
      const store = storeOf(DAY, [buildObjectBody(contextOn(DAY), [RECORD])]);
      store.objects[rollupPartitionName(DAY)] = "not a partition";
      await compactDays({ ...OPTIONS, fetchImpl: storeFetch(store) });
      expect(Object.keys(store.created)).toEqual([]);
    });

    it("leaves a day claiming more shards than objects open", async () => {
      const store = storeOf(DAY, [buildObjectBody(contextOn(DAY), [RECORD])]);
      store.objects[rollupPartitionName(DAY)] = JSON.stringify({
        schema: 1,
        day: DAY,
        count: 1e9,
      });
      await compactDays({ ...OPTIONS, fetchImpl: storeFetch(store) });
      expect(Object.keys(store.created)).toEqual([]);
    });

    it("takes a partition with more shards than the day has objects", async () => {
      // One raw object past the size a shard aims at: the count its bytes
      // come to is above the count of objects, and is what a run writes.
      const store = storeOf(
        DAY,
        [buildObjectBody(contextOn(DAY), [RECORD])],
        SHARD_TARGET_BYTES * 3,
      );
      store.objects[rollupPartitionName(DAY)] = JSON.stringify({
        schema: 1,
        day: DAY,
        count: 3,
      });
      await compactDays({ ...OPTIONS, fetchImpl: storeFetch(store) });
      // The one object reaches one of the three shards; the other two
      // hold nothing and are not written.
      const written = createdShards(store);
      expect(written.length).toBe(1);
      expect(written[0]).toMatch(/\/\d{4}-of-0003\.ndjson$/);
      expect(createdManifest(store, DAY)?.shards.length).toBe(1);
      expect(await compactedNames(store)).toEqual([RECORD.test.n]);
    });

    it("leaves a folder with shards and no partition open", async () => {
      const store = storeOf(DAY, [buildObjectBody(contextOn(DAY), [RECORD])]);
      store.objects[`${rollupPrefix(DAY)}0000-of-0002.ndjson`] = "";
      await compactDays({ ...OPTIONS, fetchImpl: storeFetch(store) });
      expect(Object.keys(store.created)).toEqual([]);
    });

    it("leaves a day whose objects all list as empty open", async () => {
      const store = storeOf(DAY, casesOn(DAY, 4), 0);
      await compactDays({ ...OPTIONS, fetchImpl: storeFetch(store) });
      expect(Object.keys(store.created)).toEqual([]);
    });

    it("leaves a day with no records open", async () => {
      const store = storeOf(DAY, [buildObjectBody(contextOn(DAY), [])]);
      await compactDays({ ...OPTIONS, fetchImpl: storeFetch(store) });
      // The partition is claimed before the day is read, so it stays; what
      // says the day is not compacted is that no shard and no manifest
      // followed it.
      expect(createdShards(store)).toEqual([]);
      expect(store.created[rollupManifestName(DAY)]).toBeUndefined();
    });

    it("writes nothing in plan mode, and reads no object body", async () => {
      const store = storeOf(DAY, [buildObjectBody(contextOn(DAY), [RECORD])]);
      const inner = storeFetch(store);
      const reads: string[] = [];
      const watched = ((input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes("/storage/v1/") && init?.method !== "POST") {
          reads.push(url);
        }
        return inner(input, init);
      }) as typeof fetch;
      await compactDays({ ...OPTIONS, plan: true, fetchImpl: watched });
      expect(Object.keys(store.created)).toEqual([]);
      expect(reads).toEqual([]);
    });
  });

  describe("writeToken()", () => {
    it("reads the federated token the workflow supplies", () => {
      expect(
        writeToken((name) =>
          name === "TEST_RECORDS_GCS_TOKEN" ? "token-1" : undefined
        ),
      ).toBe("token-1");
    });

    it("has no token to offer anywhere else", () => {
      // The compactor's identity exists as no key, so there is nothing to
      // fall back to and a run outside the workflow must say so rather
      // than reach the store with a credential meant for something else.
      expect(writeToken(() => undefined)).toBeUndefined();
      expect(
        writeToken((name) =>
          name === "TEST_RECORDS_GCS_TOKEN" ? "" : "other-value"
        ),
      ).toBeUndefined();
    });
  });

  describe("parseCompactArgs()", () => {
    it("returns the defaults and the given flags", () => {
      expect(parseCompactArgs([])).toEqual({ days: 14, plan: false });
      expect(parseCompactArgs(["--plan", "--days", "9"]))
        .toEqual({ days: 9, plan: true });
    });

    it("returns undefined for malformed command lines", () => {
      expect(parseCompactArgs(["--days", "0"])).toBeUndefined();
      expect(parseCompactArgs(["--days", "x"])).toBeUndefined();
      expect(parseCompactArgs(["--mystery"])).toBeUndefined();
    });

    it("returns undefined for a window shorter than the lag", () => {
      expect(parseCompactArgs(["--days", String(COMPACTION_LAG_DAYS - 1)]))
        .toBeUndefined();
      expect(parseCompactArgs(["--days", String(COMPACTION_LAG_DAYS)]))
        .toEqual({ days: COMPACTION_LAG_DAYS, plan: false });
    });
  });
});
