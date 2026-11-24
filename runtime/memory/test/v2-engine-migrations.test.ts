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
    it("gives an in-memory store the schema, rows and settings a new file store opens with", async () => {
      const stateOf = (database: Database) => {
        const schema = database.prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name",
        ).all<{ type: string; name: string }>();
        const tables = schema.filter(({ type }) => type === "table").map((
          { name },
        ) => ({
          name,
          rows: database.prepare(`SELECT * FROM "${name}"`).all().map((
            { created_at: _, ...row },
          ) => row),
        }));
        return {
          schema,
          tables,
          foreignKeys: database.prepare("PRAGMA foreign_keys").value(),
          pageSize: database.prepare("PRAGMA page_size").value(),
        };
      };
      const file = await open({ url: toFileUrl(path) });
      const memory = await open({ url: new URL("memory://schema") });
      try {
        const fileState = stateOf(file.database);
        expect(fileState.schema.length).toBeGreaterThan(0);
        expect(fileState.tables.flatMap(({ rows }) => rows).length)
          .toBeGreaterThan(0);
        expect(fileState.foreignKeys).toEqual([1]);
        expect(stateOf(memory.database)).toEqual(fileState);
      } finally {
        close(file);
        close(memory);
      }
    });

    it("opens each in-memory store empty, whatever another one holds", async () => {
      const count = (database: Database) =>
        database.prepare("SELECT count(*) FROM authorization").value<
          [number]
        >()?.[0];
      const first = await open({ url: new URL("memory://first") });
      try {
        first.database.exec(
          "INSERT INTO authorization (ref, authorization) VALUES ('a', '{}')",
        );
        expect(count(first.database)).toBe(1);

        const second = await open({ url: new URL("memory://second") });
        try {
          expect(count(second.database)).toBe(0);
        } finally {
          close(second);
        }
      } finally {
        close(first);
      }
    });

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
