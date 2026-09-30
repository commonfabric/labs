/** Durable outbox reference attestations survive storage migration and reopen. */

import { Database } from "@db/sqlite";
import { expect } from "@std/expect";
import { join, toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { close, open } from "../v2/engine.ts";
import {
  insertExecutionOutboxRows,
  selectPendingExecutionOutboxRows,
} from "../v2/execution-outbox.ts";

describe("event reference carriage", () => {
  it("preserves old rows while adding durable optional reference context", async () => {
    const directory = await Deno.makeTempDir();
    const path = join(directory, "memory.sqlite");
    const url = toFileUrl(path);
    let engine = await open({ url });
    try {
      const row = {
        targetSpace: "did:key:destination",
        targetStream: "of:stream",
        eventId: "old-event",
        payload: { value: 1 },
        actingPrincipal: "did:key:actor",
        actingSession: "session",
        capabilityRef: "capability",
      };
      insertExecutionOutboxRows(engine, {
        branch: "",
        createdSeq: 1,
        rows: [row],
      });
      close(engine);
      const database = new Database(path);
      try {
        database.exec(
          "ALTER TABLE execution_outbox DROP COLUMN runtime_reference_context",
        );
      } finally {
        database.close();
      }

      engine = await open({ url });
      const oldRows = selectPendingExecutionOutboxRows(engine, { branch: "" });
      expect(oldRows).toHaveLength(1);
      expect(oldRows[0].payload).toEqual({ value: 1 });
      expect(oldRows[0].runtimeReferenceContext).toBeUndefined();
      insertExecutionOutboxRows(engine, {
        branch: "",
        createdSeq: 2,
        rows: [{
          ...row,
          eventId: "reference-event",
          runtimeReferenceContext: "opaque-runtime-context",
        }],
      });
      close(engine);
      engine = await open({ url });
      const rows = selectPendingExecutionOutboxRows(engine, { branch: "" });
      expect(rows.map(({ eventId, runtimeReferenceContext }) => ({
        eventId,
        runtimeReferenceContext,
      }))).toEqual([
        { eventId: "old-event", runtimeReferenceContext: undefined },
        {
          eventId: "reference-event",
          runtimeReferenceContext: "opaque-runtime-context",
        },
      ]);
    } finally {
      close(engine);
      await Deno.remove(directory, { recursive: true });
    }
  });
});
