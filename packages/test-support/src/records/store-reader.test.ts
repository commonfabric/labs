import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  listObjects,
  listObjectSizes,
  parseReportGroups,
  readObject,
} from "./store-reader.ts";
import { buildObjectBody, type RunContext, type TestRecord } from "./schema.ts";

const RECORD: TestRecord = {
  line: "record",
  test: { k: "unit", s: "bakery", n: "glaze > sets" },
  outcome: "pass",
  durationMs: 5,
};

function ciContext(reportId: string, fork: boolean): RunContext {
  return {
    schema: 1,
    line: "context",
    reportId,
    repo: "commonfabric/labs",
    commit: "0123456789abcdef0123456789abcdef01234567",
    dirty: false,
    env: "ci",
    ci: {
      workflowRunId: "77",
      runAttempt: 1,
      workflow: "CI",
      job: "Test",
      fork,
    },
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt: "2026-08-17T21:04:05.000Z",
  };
}

describe("store-reader", () => {
  describe("listObjects()", () => {
    it("paginates until the listing has no next page", async () => {
      const pages = [
        { items: [{ name: "a" }, { name: "b" }], nextPageToken: "t2" },
        { items: [{ name: "c" }] },
      ];
      const urls: string[] = [];
      const names = await listObjects({
        bucket: "cf-ci-metadata",
        prefix: "labs/test-records/",
        fetch: ((input: URL | RequestInfo) => {
          urls.push(String(input));
          return Promise.resolve(
            new Response(JSON.stringify(pages.shift()), { status: 200 }),
          );
        }) as typeof fetch,
      });
      expect(names).toEqual(["a", "b", "c"]);
      expect(urls.length).toBe(2);
      expect(urls[1]).toContain("pageToken=t2");
    });

    it("skips a listing item that names no object", async () => {
      const names = await listObjects({
        bucket: "cf-ci-metadata",
        prefix: "labs/test-records/",
        fetch: (() =>
          Promise.resolve(
            new Response(
              JSON.stringify({ items: [{ name: "a" }, {}, { name: "b" }] }),
              { status: 200 },
            ),
          )) as typeof fetch,
      });
      expect(names).toEqual(["a", "b"]);
    });

    it("asks the store to filter by a glob only where given one", async () => {
      const urls: URL[] = [];
      const listing = ((input: URL | RequestInfo) => {
        urls.push(new URL(String(input)));
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch;
      await listObjects({
        bucket: "b",
        prefix: "p/",
        matchGlob: "**/run-*.ndjson",
        fetch: listing,
      });
      await listObjects({ bucket: "b", prefix: "p/", fetch: listing });
      expect(urls[0]?.searchParams.get("matchGlob")).toBe("**/run-*.ndjson");
      expect(urls[1]?.searchParams.has("matchGlob")).toBe(false);
    });

    it("throws for an error status", async () => {
      await expect(listObjects({
        bucket: "b",
        prefix: "p",
        fetch: (() =>
          Promise.resolve(
            new Response("nope", { status: 500 }),
          )) as typeof fetch,
      })).rejects.toThrow("HTTP 500");
    });
  });

  describe("listObjectSizes()", () => {
    const listing = (items: unknown[]): typeof fetch =>
      (() =>
        Promise.resolve(
          new Response(JSON.stringify({ items }), { status: 200 }),
        )) as typeof fetch;

    it("gives each object's stored size, sorted by name", async () => {
      const listed = await listObjectSizes({
        bucket: "cf-ci-metadata",
        prefix: "labs/test-records/",
        fetch: listing([
          { name: "b", size: "4096" },
          { name: "a", size: "17" },
        ]),
      });
      expect(listed).toEqual([
        { name: "a", size: 17 },
        { name: "b", size: 4096 },
      ]);
    });

    it("throws for an object the listing gave no size for", async () => {
      await expect(listObjectSizes({
        bucket: "cf-ci-metadata",
        prefix: "labs/test-records/",
        fetch: listing([{ name: "a", size: "17" }, { name: "b" }]),
      })).rejects.toThrow("gave no size for b");
    });
  });

  describe("readObject()", () => {
    it("throws for an error status", async () => {
      await expect(readObject({
        bucket: "b",
        objectName: "x/y.ndjson",
        fetch: (() =>
          Promise.resolve(
            new Response("gone", { status: 404 }),
          )) as typeof fetch,
      })).rejects.toThrow("HTTP 404");
    });

    it("fetches and groups a stored object", async () => {
      const context = ciContext("01READ000000000000000000", false);
      const report = await readObject({
        bucket: "b",
        objectName: "x/y.ndjson",
        fetch: (() =>
          Promise.resolve(
            new Response(buildObjectBody(context, [RECORD]), { status: 200 }),
          )) as typeof fetch,
      });
      expect(report.context?.reportId).toBe(context.reportId);
      expect(report.records.length).toBe(1);
      expect(report.reports.length).toBe(1);
    });
  });

  describe("parseReportGroups()", () => {
    it("returns one group per context line with its own records", () => {
      const first = ciContext("01AAA0000000000000000000", false);
      const second = ciContext("01BBB0000000000000000000", true);
      const text = buildObjectBody(first, [RECORD]) +
        buildObjectBody(second, [RECORD, RECORD]);
      const groups = parseReportGroups(text);
      expect(groups.length).toBe(2);
      expect(groups[0]?.context?.reportId).toBe(first.reportId);
      expect(groups[0]?.records.length).toBe(1);
      expect(groups[1]?.context?.ci?.fork).toBe(true);
      expect(groups[1]?.records.length).toBe(2);
    });

    it("collects records ahead of any context into a contextless group", () => {
      const text = JSON.stringify(RECORD) + "\n" +
        buildObjectBody(ciContext("01CCC0000000000000000000", false), []);
      const groups = parseReportGroups(text);
      expect(groups.length).toBe(2);
      expect(groups[0]?.context).toBeUndefined();
      expect(groups[0]?.records.length).toBe(1);
      expect(groups[1]?.context?.reportId).toBe("01CCC0000000000000000000");
    });

    it("drops lines that parse as neither", () => {
      const groups = parseReportGroups("not json\n\n");
      expect(groups).toEqual([]);
    });
  });
});
