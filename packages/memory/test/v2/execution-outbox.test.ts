import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { close, type Engine, open } from "../../v2/engine.ts";
import {
  insertExecutionOutboxRows,
  type OutboxAppendRow,
  selectPendingExecutionOutboxRows,
} from "../../v2/execution-outbox.ts";

describe("execution-outbox", () => {
  let engine: Engine;
  let path: string;

  const row = (payload: OutboxAppendRow["payload"]): OutboxAppendRow => ({
    targetSpace: "did:key:z6MkexecutionOutboxTestTarget",
    targetStream: "of:stream-events:outbox-test",
    eventId: "event:outbox-test",
    payload,
    capabilityRef: "capability:outbox-test",
  });

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  describe("selectPendingExecutionOutboxRows()", () => {
    it("returns a payload property holding `undefined` as a property", () => {
      insertExecutionOutboxRows(engine, {
        branch: "",
        createdSeq: 1,
        rows: [row({ inbox: "of:inbox", replacing: undefined })],
      });

      const [pending] = selectPendingExecutionOutboxRows(engine, {
        branch: "",
      });
      const payload = pending.payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(["inbox", "replacing"]);
      expect(payload.replacing).toBeUndefined();
    });

    it("returns an `undefined` payload as `undefined`", () => {
      insertExecutionOutboxRows(engine, {
        branch: "",
        createdSeq: 1,
        rows: [row(undefined)],
      });

      const [pending] = selectPendingExecutionOutboxRows(engine, {
        branch: "",
      });
      expect(pending.payload).toBeUndefined();
    });
  });

  describe("open()", () => {
    it("rewrites a payload stored as plain JSON into the memory boundary's encoding", async () => {
      insertExecutionOutboxRows(engine, {
        branch: "",
        createdSeq: 1,
        rows: [row(null)],
      });
      engine.database.prepare(
        "UPDATE execution_outbox SET payload = :payload",
      ).run({ payload: JSON.stringify({ inbox: "of:inbox", count: 2 }) });
      close(engine);

      engine = await open({ url: toFileUrl(path) });

      const stored = engine.database.prepare(
        "SELECT payload FROM execution_outbox",
      ).get() as { payload: string };
      expect(stored.payload.startsWith("fvj1:")).toBe(true);
      const [pending] = selectPendingExecutionOutboxRows(engine, {
        branch: "",
      });
      expect(pending.payload).toEqual({ inbox: "of:inbox", count: 2 });
    });
  });
});
