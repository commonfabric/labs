import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  buildObjectBody,
  ciObjectName,
  datePartition,
  isMainPush,
  localObjectName,
  objectNameSlug,
  parseContextLine,
  parseRecordLine,
  type RunContext,
  serializeContextLine,
  serializeRecordLine,
  testIdentityKey,
  testIdentityOfKey,
  type TestRecord,
} from "./schema.ts";

const RECORD: TestRecord = {
  line: "record",
  test: { k: "unit", s: "bakery", n: "glaze > thickens when heated" },
  outcome: "pass",
  durationMs: 12,
};

const CONTEXT: RunContext = {
  schema: 1,
  line: "context",
  reportId: "01JEXAMPLEULID0000000000",
  repo: "commonfabric/labs",
  commit: "0123456789abcdef0123456789abcdef01234567",
  dirty: false,
  branch: "main",
  env: "local",
  os: "darwin",
  arch: "aarch64",
  denoVersion: "2.9.4",
  startedAt: "2026-08-17T21:04:05.000Z",
};

describe("schema", () => {
  describe("serializeRecordLine()", () => {
    it("returns one newline-terminated JSON line", () => {
      const line = serializeRecordLine(RECORD);
      expect(line.endsWith("\n")).toBe(true);
      expect(line.slice(0, -1).includes("\n")).toBe(false);
    });
  });

  describe("parseRecordLine()", () => {
    it("returns the record for a serialized line", () => {
      expect(parseRecordLine(serializeRecordLine(RECORD).trim()))
        .toEqual(RECORD);
    });

    it("keeps the optional file field", () => {
      const record: TestRecord = { ...RECORD, file: "packages/x/test/a.ts" };
      expect(parseRecordLine(serializeRecordLine(record).trim()))
        .toEqual(record);
    });

    it("keeps a non-default test variant", () => {
      const record: TestRecord = {
        ...RECORD,
        test: { ...RECORD.test, v: "wood-fired" },
      };
      expect(parseRecordLine(serializeRecordLine(record).trim()))
        .toEqual(record);
    });

    it("returns undefined for malformed JSON", () => {
      expect(parseRecordLine("{nope")).toBeUndefined();
    });

    it("returns undefined for an unknown outcome", () => {
      const line = JSON.stringify({ ...RECORD, outcome: "flaky" });
      expect(parseRecordLine(line)).toBeUndefined();
    });

    it("returns undefined for a negative duration", () => {
      const line = JSON.stringify({ ...RECORD, durationMs: -1 });
      expect(parseRecordLine(line)).toBeUndefined();
    });

    it("returns undefined for a context line", () => {
      expect(parseRecordLine(serializeContextLine(CONTEXT).trim()))
        .toBeUndefined();
    });

    it("returns undefined for an empty identity component", () => {
      const line = JSON.stringify({
        ...RECORD,
        test: { k: "unit", s: "", n: "x" },
      });
      expect(parseRecordLine(line)).toBeUndefined();
    });

    it("returns undefined for an empty test variant", () => {
      const line = JSON.stringify({
        ...RECORD,
        test: { ...RECORD.test, v: "" },
      });
      expect(parseRecordLine(line)).toBeUndefined();
    });
  });

  describe("testIdentityKey()", () => {
    it("keeps the existing key for the default configuration", () => {
      expect(testIdentityKey(RECORD.test)).toBe(
        '["unit","bakery","glaze > thickens when heated"]',
      );
    });

    it("adds the non-default variant as a fourth part", () => {
      expect(testIdentityKey({ ...RECORD.test, v: "wood-fired" }))
        .toBe(
          '["unit","bakery","glaze > thickens when heated","wood-fired"]',
        );
    });
  });

  describe("testIdentityOfKey()", () => {
    it("gives back the identity a key was built from", () => {
      const variant = { ...RECORD.test, v: "wood-fired" };
      expect(testIdentityOfKey(testIdentityKey(RECORD.test)))
        .toEqual(RECORD.test);
      expect(testIdentityOfKey(testIdentityKey(variant))).toEqual(variant);
    });

    it("gives nothing for text that is not a key", () => {
      for (
        const text of [
          "not json",
          '{"k":"unit"}',
          '["unit","bakery"]',
          '["unit","bakery","glaze","wood-fired","extra"]',
          '["unit","","glaze"]',
          '["unit","bakery","glaze",7]',
        ]
      ) {
        expect(testIdentityOfKey(text)).toBeUndefined();
      }
    });
  });

  describe("parseContextLine()", () => {
    it("returns the context for a serialized line", () => {
      expect(parseContextLine(serializeContextLine(CONTEXT).trim()))
        .toEqual(CONTEXT);
    });

    it("keeps the ci block with its optional fields", () => {
      const context: RunContext = {
        ...CONTEXT,
        env: "ci",
        ci: {
          workflowRunId: "123",
          runAttempt: 2,
          workflow: "CI",
          job: "Test (3/8)",
          shard: "3/8",
          headCommit: "feedfacefeedfacefeedfacefeedfacefeedface",
        },
      };
      expect(parseContextLine(serializeContextLine(context).trim()))
        .toEqual(context);
    });

    it("keeps the seed the run shuffled by", () => {
      const context: RunContext = { ...CONTEXT, shuffleSeed: 20260922 };
      expect(parseContextLine(serializeContextLine(context).trim()))
        .toEqual(context);
    });

    it("leaves the seed out of a run that did not shuffle", () => {
      const parsed = parseContextLine(serializeContextLine(CONTEXT).trim());
      expect(parsed).toBeDefined();
      expect("shuffleSeed" in parsed!).toBe(false);
    });

    it("returns undefined for a seed deno test would not take", () => {
      for (const shuffleSeed of [-1, 1.5, "20260922", null]) {
        const line = JSON.stringify({ ...CONTEXT, shuffleSeed });
        expect(parseContextLine(line)).toBeUndefined();
      }
    });

    it("returns undefined for a wrong schema version", () => {
      const line = JSON.stringify({ ...CONTEXT, schema: 2 });
      expect(parseContextLine(line)).toBeUndefined();
    });

    it("returns undefined for a ci env with no ci block", () => {
      const line = JSON.stringify({ ...CONTEXT, env: "ci" });
      expect(parseContextLine(line)).toBeUndefined();
    });

    it("returns undefined for a local env carrying a ci block", () => {
      const line = JSON.stringify({
        ...CONTEXT,
        ci: { workflowRunId: "123", runAttempt: 1, workflow: "CI", job: "x" },
      });
      expect(parseContextLine(line)).toBeUndefined();
    });

    it("returns undefined for a record line", () => {
      expect(parseContextLine(serializeRecordLine(RECORD).trim()))
        .toBeUndefined();
    });

    it("returns undefined for a malformed ci block", () => {
      const ci = {
        workflowRunId: "1",
        runAttempt: 1,
        workflow: "CI",
        job: "x",
      };
      const base = { ...CONTEXT, env: "ci" };
      expect(parseContextLine(JSON.stringify({ ...base, ci: "not a block" })))
        .toBeUndefined();
      expect(parseContextLine(JSON.stringify({
        ...base,
        ci: { ...ci, workflowRunId: 5 },
      }))).toBeUndefined();
      expect(parseContextLine(JSON.stringify({
        ...base,
        ci: { ...ci, fork: "yes" },
      }))).toBeUndefined();
    });

    it("returns undefined for non-JSON and non-object lines", () => {
      expect(parseContextLine("{nope")).toBeUndefined();
      expect(parseContextLine("42")).toBeUndefined();
    });
  });

  describe("buildObjectBody()", () => {
    it("returns the context line followed by one line per record", () => {
      const body = buildObjectBody(CONTEXT, [RECORD, RECORD]);
      const lines = body.split("\n");
      expect(lines.length).toBe(4);
      expect(lines[3]).toBe("");
      expect(parseContextLine(lines[0]!)).toEqual(CONTEXT);
      expect(parseRecordLine(lines[1]!)).toEqual(RECORD);
      expect(parseRecordLine(lines[2]!)).toEqual(RECORD);
    });
  });

  describe("isMainPush()", () => {
    const ci = {
      workflowRunId: "1",
      runAttempt: 1,
      workflow: "CI",
      job: "Coverage Check",
      event: "push",
      fork: false,
    };
    const pushed: RunContext = { ...CONTEXT, env: "ci", ci };

    it("returns true for a push to main the fork flag does not mark", () => {
      expect(isMainPush(pushed)).toBe(true);
      const { fork: _, ...unmarked } = ci;
      expect(isMainPush({ ...pushed, ci: unmarked })).toBe(true);
    });

    it("returns false for any other run", () => {
      expect(isMainPush({ ...pushed, ci: { ...ci, fork: true } })).toBe(false);
      expect(isMainPush({ ...pushed, ci: { ...ci, event: "pull_request" } }))
        .toBe(false);
      expect(isMainPush({ ...pushed, branch: "topic" })).toBe(false);
      expect(isMainPush(CONTEXT)).toBe(false);
    });
  });

  describe("datePartition()", () => {
    it("returns the UTC date path of an ISO timestamp", () => {
      expect(datePartition("2026-08-17T21:04:05.000Z")).toBe("2026/08/17");
    });

    it("throws for a non-ISO string", () => {
      expect(() => datePartition("yesterday")).toThrow();
    });
  });

  describe("objectNameSlug()", () => {
    it("returns the label with unsafe characters collapsed", () => {
      expect(objectNameSlug("Test (3/8)")).toBe("Test-3-8");
    });

    it("returns a placeholder for an entirely unsafe label", () => {
      expect(objectNameSlug("///")).toBe("unnamed");
    });
  });

  describe("localObjectName()", () => {
    it("returns a versioned, date-partitioned, report-id-keyed name", () => {
      expect(localObjectName(CONTEXT)).toBe(
        "v1/2026/08/17/01JEXAMPLEULID0000000000-main.ndjson",
      );
    });

    it("returns the same name for the same context", () => {
      expect(localObjectName(CONTEXT)).toBe(localObjectName(CONTEXT));
    });

    it("labels a context with no branch as detached", () => {
      const { branch: _branch, ...detached } = CONTEXT;
      expect(localObjectName(detached as typeof CONTEXT)).toContain(
        "-detached.ndjson",
      );
    });
  });

  describe("ciObjectName()", () => {
    it("returns a name keyed by run and artifact", () => {
      expect(ciObjectName({
        runStartedAt: "2026-08-17T20:00:00Z",
        workflowRunId: "456",
        artifactName: "test-records-test-3-a2",
      })).toBe("v1/2026/08/17/run-456-test-records-test-3-a2.ndjson");
    });
  });
});
