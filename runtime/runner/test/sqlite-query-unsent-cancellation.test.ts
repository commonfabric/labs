/**
 * What a cancelled node writes when its request was staged and never sent.
 *
 * A request that never goes out settles its ending on a transaction of its
 * own, after the run that staged it — so a piece cancelled in between would
 * write that ending to a result cell nobody reads. The cost is not only a
 * stray write: cancellation releases the runtime-owned enrollment that carries
 * §8.12.5 route 2 for this store, so the ending would arrive at a document
 * whose control paths resolve to the empty ceiling again, and at
 * `enforce-strict` it is refused exactly as the misfit that route exists to
 * remove — a late refusal naming a pane that no longer exists.
 *
 * The node is driven directly rather than through a pattern, which is what
 * makes the moment of cancellation exact: the ending fires when the staging
 * transaction abandons its work, and the case cancels between the staging and
 * that abandonment.
 *
 * Two things these cases do NOT reach, said here rather than left to be
 * discovered. The staging entry the cancelled path releases on its way out:
 * that map is closure state of the node, with no accessor, and giving it one
 * would widen every builtin's result shape to let a test peek at a leak whose
 * lifetime is the piece's. And the second cancellation check, inside the
 * ending's write: `editWithRetry` runs that callback synchronously on the
 * first attempt, so only a RETRY can arrive after a cancellation, and forcing
 * one would mean driving a storage conflict for a branch that is one term of
 * an existing guard. Both are read rather than asserted.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { table } from "@commonfabric/memory/sqlite/schema";
import { describe, it } from "@commonfabric/test-support/test";

import { sqliteQuery } from "../src/builtins/sqlite-builtins.ts";
import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import { cfcConfidentialityForObservationNode } from "../src/cfc/observation.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("sqlite unsent cancellation");
const space = signer.did();

interface QueryState {
  pending?: boolean;
  error?: unknown;
  requestHash?: string;
  requestKey?: string;
}

describe("sqlite-query-unsent-cancellation", () => {
  const drive = async (
    options: {
      cancel?: "before-abandon";
      requestKey?: string | { nested: string };
      labeled?: boolean;
    },
  ) => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const setup = runtime.edit();
      const parent = runtime.getCell(space, "unsent-parent", undefined, setup);
      parent.set({});
      const key = runtime.getCell<string | { nested: string } | undefined>(
        space,
        "unsent-key",
        options.labeled
          ? { type: "string", ifc: { confidentiality: ["request-secret"] } }
          : undefined,
        setup,
      );
      key.set(options.requestKey);
      const inputs = runtime.getImmutableCell(
        space,
        {
          db: { id: "of:unsent-cancelled-query" },
          sql: "SELECT content FROM messages",
          ...(options.requestKey === undefined ? {} : { requestKey: key }),
        },
        undefined,
        setup,
      );
      runtime.prepareTxForCommit(setup);
      expect((await setup.commit().settled).error).toBeUndefined();

      let cancel!: () => void;
      // deno-lint-ignore no-explicit-any -- the builtin's own result cell
      let result: Cell<any> | undefined;
      const builtin = sqliteQuery(
        inputs,
        (_tx, cell) => result = cell,
        (stop) => cancel = stop,
        [parent],
        parent,
        runtime,
      );

      // The staging run. The transaction is never committed, which is what
      // an abandoned staging is: the claim never lands and the request never
      // goes out, so the ending is the only thing that can say so.
      const tx = runtime.edit();
      builtin.action(tx);
      expect(result).toBeDefined();

      if (options.cancel === "before-abandon") cancel();
      // What the scheduler does when it stops attempting a transaction's
      // staged work: every effect it holds is abandoned, which is the entry
      // point to the ending under test. It runs the abandon callbacks
      // synchronously, so the ending is scheduled by the time this returns
      // and has not yet written anything.
      tx.abandonStagedWork({
        name: "StorageTransactionAborted",
        message: "test abandon",
        reason: new Error("test abandon"),
        // deno-lint-ignore no-explicit-any -- the commit-error shape
      } as any);
      tx.abort("staging abandoned");
      await runtime.idle();
      await runtime.settled();

      if (options.labeled) {
        if (!result) throw new Error("A query result is required");
        expect(cfcConfidentialityForObservationNode({
          labelView: cfcLabelViewForCell(
            result.key("requestKey").resolveAsCell(),
          ),
          logicalPath: [],
        })).toContainEqual("request-secret");
      }

      return result?.get() as QueryState | undefined;
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  };

  it("writes no ending for a node cancelled before the abandonment", async () => {
    const state = await drive({ cancel: "before-abandon" });
    expect(state?.error).toBeUndefined();
  });

  it("writes the ending for a node that is still running", async () => {
    // What the case above rests on. Its assertion is an ABSENCE, which a
    // builtin that settled nothing at all would satisfy too; this one fails
    // in that world, so the pair together says the ending is skipped for a
    // cancelled node rather than never written.
    const state = await drive({});
    expect(String(state?.error)).toContain("refused before it started");
    expect(state?.pending).toBe(false);
  });

  it("correlates an unsent refusal with the request that was abandoned", async () => {
    const state = await drive({ requestKey: "abandoned search" });
    expect(String(state?.error)).toContain("refused before it started");
    expect(state?.pending).toBe(false);
    expect(state?.requestKey).toBe("abandoned search");
  });

  it("preserves the request key's label when its staging transaction is abandoned", async () => {
    const state = await drive({ requestKey: "private search", labeled: true });
    expect(String(state?.error)).toContain("refused before it started");
    expect(state?.requestKey).toBe("private search");
  });

  it("leaves a collection query's rows standing when its refresh is abandoned", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const id = `of:unsent-refresh-${crypto.randomUUID()}`;
      const tables = {
        notes: table({ id: "integer primary key", body: "text" }),
      };
      // The declaration that makes this a query over an indexed collection,
      // which follows the collection's revision without the revision joining
      // the request's identity.
      const index = {
        kinds: {
          note: {
            table: "notes",
            columns: ["body"],
            relations: [],
            relationTables: {},
          },
        },
      };
      const insert = async (body: string) => {
        const tx = runtime.edit();
        tx.recordSqliteWrite!(signer.did(), {
          op: "sqlite",
          db: { id, owner: signer.did(), tables },
          sql: "INSERT INTO notes (body) VALUES (?)",
          params: [body],
        });
        expect((await tx.commit().settled).error).toBeUndefined();
      };
      await insert("first");

      const setup = runtime.edit();
      const parent = runtime.getCell(space, "refresh-parent", undefined, setup);
      parent.set({});
      const inputs = runtime.getCell<{
        db: Record<string, unknown>;
        sql: string;
      }>(space, "refresh-inputs", undefined, setup);
      const query = (rev: number) => ({
        db: { id, owner: signer.did(), tables, index, rev },
        sql: "SELECT body FROM notes ORDER BY id",
      });
      inputs.set(query(0));
      runtime.prepareTxForCommit(setup);
      expect((await setup.commit().settled).error).toBeUndefined();

      // deno-lint-ignore no-explicit-any -- the builtin's own result cell
      let result: Cell<any> | undefined;
      const builtin = sqliteQuery(
        inputs,
        (_tx, cell) => result = cell,
        () => {},
        [parent],
        parent,
        runtime,
      );
      const run = async (commit: boolean) => {
        const tx = runtime.edit();
        builtin.action(tx);
        if (commit) {
          expect((await tx.commit().settled).error).toBeUndefined();
        } else {
          tx.abandonStagedWork({
            name: "StorageTransactionAborted",
            message: "test abandon",
            reason: new Error("test abandon"),
            // deno-lint-ignore no-explicit-any -- the commit-error shape
          } as any);
          tx.abort("staging abandoned");
        }
        await runtime.idle();
        await runtime.settled();
        return result?.get() as QueryState & { result?: unknown[] };
      };
      const bodies = (state: { result?: unknown[] }) =>
        state.result?.map((row) => (row as { body: string }).body);

      const answered = await run(true);
      expect(answered.pending).toBe(false);
      expect(answered.error).toBeUndefined();
      expect(bodies(answered)).toEqual(["first"]);

      // The collection moves on, and the run that would ask again under the
      // new revision is abandoned before its request goes out.
      await insert("second");
      const bump = runtime.edit();
      inputs.withTx(bump).set(query(1));
      expect((await bump.commit().settled).error).toBeUndefined();
      const abandoned = await run(false);
      expect(abandoned.error).toBeUndefined();
      expect(abandoned.pending).toBe(false);
      expect(abandoned.requestHash).toBe(answered.requestHash);
      expect(bodies(abandoned)).toEqual(["first"]);

      // The abandoned refresh is not recorded as served, so the next run
      // asks again and the result follows the collection.
      const refreshed = await run(true);
      expect(refreshed.error).toBeUndefined();
      expect(refreshed.requestHash).toBe(answered.requestHash);
      expect(bodies(refreshed)).toEqual(["first", "second"]);
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  });

  it("omits a non-string request key from an asynchronous ending", async () => {
    const state = await drive({ requestKey: { nested: "not a string" } });
    expect(String(state?.error)).toContain("refused before it started");
    expect(state?.pending).toBe(false);
    expect(state?.requestKey).toBeUndefined();
  });
});
