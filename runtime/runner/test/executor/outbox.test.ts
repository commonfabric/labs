import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { executionLeaseHolder } from "@commonfabric/memory/v2/execution-lease";
import {
  insertExecutionOutboxRows,
  type OutboxAppendRow,
  selectPendingExecutionOutboxRows,
} from "@commonfabric/memory/v2/execution-outbox";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
  streamEntriesDocId,
} from "@commonfabric/memory/v2";
import type { PostCommitSideEffect } from "../../src/cfc/types.ts";
import { ExtendedStorageTransaction } from "../../src/storage/extended-storage-transaction.ts";
import { StoreObjectManager } from "../../src/storage/query.ts";
import { ManagedStorageTransaction } from "../../src/traverse.ts";
import { SpaceOutbox } from "../../src/executor/outbox.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("outbox failure paths");
const space = signer.did();
const targetSigner = await Identity.fromPassphrase("outbox failure target");
const targetSpace = targetSigner.did();

describe("SpaceOutbox", () => {
  let server: MemoryV2Server.Server;
  let engine: Engine.Engine;
  const holder = executionLeaseHolder(`service:${space}`);

  beforeEach(async () => {
    setServerExecutionConfig(true);
    server = newSharedServer();
    engine = await server.engineForSpace(space);
  });

  afterEach(async () => {
    await server.close();
    resetServerExecutionConfig();
  });

  const newOutbox = (options: { space?: string } = {}) => {
    const stats = emptyServingLoopStats();
    const outbox = new SpaceOutbox({
      stats,
      server,
      engine,
      ...options,
      sessionId: holder,
      localSeqRef: { value: 0 },
    });
    return { outbox, stats };
  };

  /** The event ids the target stream at `sidecar` holds. */
  const delivered = async (sidecar: string): Promise<string[]> => {
    const target = await server.engineForSpace(targetSpace);
    const doc = Engine.read(target, { id: sidecar });
    return ((doc?.value as { entries?: Array<{ eventId?: string }> })
      ?.entries ?? []).map((entry) => entry.eventId ?? "");
  };

  const pendingEventIds = () =>
    selectPendingExecutionOutboxRows(engine, { branch: "" }).map((row) =>
      row.eventId
    );

  /**
   * Inserts a row the target refuses deterministically (it names no acting
   * principal and declares no sessionless scope), followed by a row the
   * target admits, both on one stream. Returns that stream's sidecar.
   */
  const insertRefusedThenAdmitted = (
    refused: Partial<OutboxAppendRow> = {},
  ): string => {
    const stream = { id: "of:outbox-failure-stream", path: [] as string[] };
    const sidecar = streamEntriesDocId(stream);
    const base = {
      targetSpace,
      targetStream: sidecar,
      targetStreamLink: stream,
      capabilityRef: "cap-outbox-failure",
    };
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 1,
      rows: [
        { ...base, eventId: "evt-refused", payload: { n: 1 }, ...refused },
        {
          ...base,
          eventId: "evt-admitted",
          payload: { n: 2 },
          actingPrincipal: "user:alice",
          actingSession: "sess-1",
        },
      ],
    });
    return sidecar;
  };

  const sourceEvent = {
    sidecarId: streamEntriesDocId({ id: "of:outbox-source", path: [] }),
    eventId: "evt-source",
  };

  describe("delivering a deterministically refused append", () => {
    it("keeps the row and stops the drain when the failure notice cannot be written", async () => {
      const sidecar = insertRefusedThenAdmitted({ sourceEvent });
      const notices: string[] = [];
      server.commitDeliveryFailureNotice = (notice) => {
        notices.push(notice.failure.eventId);
        return Promise.reject(new Error("notice store unavailable"));
      };
      const { outbox, stats } = newOutbox({ space });

      expect(await outbox.deliverPendingAppends()).toEqual({ remaining: 2 });
      expect(notices).toEqual(["evt-refused"]);
      expect(pendingEventIds()).toEqual(["evt-refused", "evt-admitted"]);
      expect(await delivered(sidecar)).toEqual([]);
      expect(stats.outbox.failed).toBe(1);
    });

    it("keeps the row and stops the drain when the refused row cannot be retired", async () => {
      const sidecar = insertRefusedThenAdmitted();
      engine.database.exec(
        `CREATE TRIGGER refuse_outbox_delete BEFORE DELETE ON execution_outbox
         BEGIN SELECT RAISE(ABORT, 'outbox row delete refused'); END`,
      );
      const { outbox, stats } = newOutbox({ space });

      expect(await outbox.deliverPendingAppends()).toEqual({ remaining: 2 });
      expect(pendingEventIds()).toEqual(["evt-refused", "evt-admitted"]);
      expect(await delivered(sidecar)).toEqual([]);
      expect(stats.outbox.failed).toBe(1);

      // With the delete allowed again, the same drain retires the refused
      // row and delivers the one behind it.
      engine.database.exec(`DROP TRIGGER refuse_outbox_delete`);
      expect(await outbox.deliverPendingAppends()).toEqual({ remaining: 0 });
      expect(pendingEventIds()).toEqual([]);
      expect(await delivered(sidecar)).toEqual(["evt-admitted"]);
      expect(stats.outbox.failed).toBe(2);
    });

    it("writes no notice without a home space, retires the row, and drains on", async () => {
      const sidecar = insertRefusedThenAdmitted({ sourceEvent });
      const notices: string[] = [];
      server.commitDeliveryFailureNotice = (notice) => {
        notices.push(notice.failure.eventId);
        return Promise.resolve();
      };
      const { outbox, stats } = newOutbox();

      expect(await outbox.deliverPendingAppends()).toEqual({ remaining: 0 });
      expect(notices).toEqual([]);
      expect(pendingEventIds()).toEqual([]);
      expect(await delivered(sidecar)).toEqual(["evt-admitted"]);
      expect(stats.outbox.failed).toBe(1);
    });
  });

  describe("running an effect", () => {
    /** An effect whose flush starts `work` as the effect's async work. */
    const effectStarting = (
      outbox: SpaceOutbox,
      id: string,
      work: () => Promise<unknown>,
    ): PostCommitSideEffect => ({
      id,
      kind: "fetch-json",
      flush: () => {
        outbox.observeAsyncWork(work());
      },
    });

    const tx = new ExtendedStorageTransaction(
      new ManagedStorageTransaction(new StoreObjectManager()),
    );

    it("counts an effect whose async work rejects as failed, and one whose work settles as completed", async () => {
      const { outbox, stats } = newOutbox({ space });
      outbox.admitSealedEffects([{
        tx,
        context: undefined,
        effects: [
          effectStarting(
            outbox,
            "broken",
            () => Promise.reject(new Error("transport broke")),
          ),
          effectStarting(outbox, "working", () => Promise.resolve("ok")),
        ],
      }]);
      await outbox.settle();

      expect(stats.outbox.queued).toBe(2);
      expect(stats.outbox.failed).toBe(1);
      expect(stats.outbox.completed).toBe(1);
      expect(outbox.inflightCount).toBe(0);
    });
  });
});
