import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";

import { close, open } from "../v2/engine.ts";
import {
  insertExecutionOutboxRows,
  selectPendingExecutionOutboxRows,
} from "../v2/execution-outbox.ts";

describe("engine migrations", () => {
  let path: string;

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
  });

  afterEach(async () => {
    await Deno.remove(path);
  });

  describe("open()", () => {
    it("adds the stream link and the sessionless declaration columns to an outbox from before them", async () => {
      close(await open({ url: toFileUrl(path) }));
      const database = new Database(path);
      database.exec(`
        ALTER TABLE execution_outbox DROP COLUMN target_stream_link;
        ALTER TABLE execution_outbox DROP COLUMN sessionless_space_scope;
      `);
      database.close();

      const engine = await open({ url: toFileUrl(path) });
      try {
        const targetStreamLink = { id: "of:target", path: ["events"] };
        insertExecutionOutboxRows(engine, {
          branch: "",
          createdSeq: 1,
          rows: [{
            targetSpace: "did:key:z6MkMigrationTarget",
            targetStream: "of:stream-events:migration",
            targetStreamLink,
            eventId: "event:migration",
            payload: null,
            sessionlessSpaceScope: true,
            capabilityRef: "capability:migration",
          }],
        });

        const [pending] = selectPendingExecutionOutboxRows(engine, {
          branch: "",
        });
        expect(pending.targetStreamLink).toEqual(targetStreamLink);
        expect(pending.sessionlessSpaceScope).toBe(true);
      } finally {
        close(engine);
      }
    });
  });
});
