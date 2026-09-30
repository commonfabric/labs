/// <reference path="./clock.d.ts" />

/** Exercises retained dependencies when an identical write has other outcomes. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import type { Operation } from "@commonfabric/memory/v2";
import { applyCommit } from "@commonfabric/memory/v2/engine";

import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import { Runtime } from "../src/runtime.ts";
import { createNonReactiveTransaction } from "../src/storage/extended-storage-transaction.ts";
import { authorizationRead } from "../src/storage/reactivity-log.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("commit-read-validation");
const space = signer.did();

describe("commit-read-validation", () => {
  it("keeps a dispatched event bound to its original durable identity", async () => {
    const storage = EmulatedStorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const underlying = runtime.edit();
      const tx = createNonReactiveTransaction(underlying);
      tx.dispatchedEventId = "original";
      tx.dispatchedEventId = "original";
      for (const replacement of [undefined, "replacement"]) {
        expect(() => {
          tx.dispatchedEventId = replacement;
        })
          .toThrow("cannot be cleared or rebound");
        expect(tx.dispatchedEventId).toBe("original");
        expect(underlying.dispatchedEventId).toBe("original");
      }
      tx.abort();
    } finally {
      await runtime.dispose();
    }
  });

  for (
    const kind of [
      "authorization",
      "sink",
      "effect",
      "event",
      "wrapped-event",
      "stream",
      "ordinary",
    ] as const
  ) {
    it(`${kind === "ordinary" ? "accepts" : "refuses"} an identical output with stale ${kind} dependencies`, async () => {
      const server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const usesMetadata = kind === "authorization" || kind === "sink";
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        cfcFlowLabels: usesMetadata ? "persist" : "off",
        cfcWriteFloor: "enforce",
        cfcEnforcementMode: "enforce-strict",
      });
      try {
        const source = runtime.getCell(space, "source");
        const output = runtime.getCell(space, "output");
        const stream = runtime.getCell<string>(space, "stream");
        const seed = runtime.edit();
        writeSeedEnvelopeDoc(seed, space);
        seedStoredEnvelope(seed, {
          ...source.getAsNormalizedFullLink(),
          path: [],
        }, {
          value: "observed",
          ...(usesMetadata
            ? {
              cfc: {
                version: 3,
                schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
                labelMap: { version: 1, entries: [] },
              },
            }
            : {}),
        });
        seed.writeValueOrThrow(output.getAsNormalizedFullLink(), "before");
        if (kind === "stream") {
          seed.writeValueOrThrow(stream.getAsNormalizedFullLink(), {
            $stream: true,
          });
        }
        expect((await seed.commit({ resolveAt: "verdict" })).error)
          .toBeUndefined();
        await server.flushSessions([space]);
        await storage.synced();

        const tx = runtime.edit();
        if (usesMetadata) {
          expect(readStoredCfcMetadata(tx, source.getAsNormalizedFullLink()))
            .toBeDefined();
        } else {
          expect(tx.readValueOrThrow(source.getAsNormalizedFullLink()))
            .toBe("observed");
        }
        tx.writeValueOrThrow(output.getAsNormalizedFullLink(), "after");
        let effects = 0;
        if (kind === "sink") {
          enqueueSinkRequestPostCommitEffect(
            tx,
            "test",
            "sink",
            "request",
            "test",
            () => {
              effects++;
            },
          );
        } else if (kind === "effect") {
          tx.enqueuePostCommitEffect({
            id: "external-result",
            kind: "test",
            flush: () => {
              effects++;
            },
          });
        }
        if (kind === "event") tx.dispatchedEventId = "durable-event";
        if (kind === "wrapped-event") {
          createNonReactiveTransaction(tx).dispatchedEventId = "durable-event";
        }
        if (kind === "stream") {
          using queued = stub(runtime.scheduler, "queueEvent");
          stream.withTx(tx).send("observed");
          expect(queued.calls).toHaveLength(1);
          expect(queued.calls[0].args[5]?.originTx).toBe(tx);
        }
        tx.prepareCfc();
        const native = tx.tx.getNativeCommit!(space)!;
        expect(native.operations.length).toBeGreaterThan(0);
        const replica = storage.open(space).replica as SpaceReplica;
        const exported = replica.accessForTestingOnly.buildReads(tx.tx, 2);
        const sourceReads = [...exported.confirmed, ...exported.pending]
          .filter((read) => read.id === source.getAsNormalizedFullLink().id);
        expect(sourceReads.length).toBeGreaterThan(0);
        expect(sourceReads.some((read) => read.validation === "required"))
          .toBe(kind !== "ordinary");

        const engine = await server.engineForSpace(space);
        applyCommit(engine, {
          sessionId: "parallel-output",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [...native.operations] as Operation[],
          },
        });
        applyCommit(engine, {
          sessionId: "changed-source",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id: source.getAsNormalizedFullLink().id,
              patches: [{
                op: "replace",
                path: usesMetadata ? "/cfc/labelMap/entries" : "/value",
                value: usesMetadata
                  ? [{
                    path: [],
                    origin: "derived",
                    observes: "value",
                    label: { confidentiality: ["private-now"] },
                  }]
                  : "changed",
              }],
            }],
          },
        });
        const result = await tx.commit({ resolveAt: "verdict" });
        expect(result.error?.name).toBe(
          kind === "ordinary" ? undefined : "ConflictError",
        );
        expect(effects).toBe(0);
      } finally {
        await server.flushSessions([space]);
        await runtime.dispose();
        await storage.close();
        await server.close();
      }
    });
  }

  for (const servingPosture of [false, true]) {
    it(`requires selection dependencies for ${servingPosture ? "served" : "local"} program acceptance`, async () => {
      const server = newSharedServer();
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        servingPosture,
        experimental: { serverExecution: servingPosture },
      });
      try {
        const choice = runtime.getCell<number>(space, "program-choice");
        const seed = runtime.edit();
        choice.withTx(seed).set(2);
        expect((await seed.commit()).error).toBeUndefined();

        const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
        const program = pattern<{ value: number }>(({ value }) => ({
          answer: lift((input: number) => input + 1)(value),
        }));
        const result = runtime.getCell(
          space,
          "chosen-program",
          program.resultSchema,
          undefined,
          "user",
        );
        const tx = runtime.edit();
        const selected = choice.withTx(tx).get();
        runtime.run(tx, program, { value: selected }, result.withTx(tx));
        const replica = storage.open(space).replica as SpaceReplica;
        const reads = replica.accessForTestingOnly.buildReads(tx.tx, 2);
        const selectionReads = [...reads.confirmed, ...reads.pending]
          .filter((read) => read.id === choice.getAsNormalizedFullLink().id);
        expect(selectionReads.length).toBeGreaterThan(0);
        expect(selectionReads.every((read) => read.validation === "required"))
          .toBe(true);
        expect(tx.abort("The selected program was not accepted").error)
          .toBeUndefined();
      } finally {
        await storage.synced();
        await clock.settle();
        await runtime.dispose();
        await storage.close();
        await server.close();
      }
    });
  }

  it("retains required descendants beside elidable ancestor dependencies", async () => {
    const server = newSharedServer();
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const cell = runtime.getCell(space, "compaction");
      const seed = runtime.edit();
      cell.withTx(seed).set({ evidence: "current" });
      expect((await seed.commit()).error).toBeUndefined();
      const tx = runtime.edit();
      tx.readValueOrThrow(cell.getAsNormalizedFullLink());
      tx.readValueOrThrow(
        cell.key("evidence").getAsNormalizedFullLink(),
        { meta: authorizationRead },
      );
      const replica = storage.open(space).replica as SpaceReplica;
      const reads = replica.accessForTestingOnly.buildReads(tx.tx, 2).confirmed;
      expect(
        reads.filter((read) => read.validation === "elidable").map((read) =>
          read.path
        ),
      )
        .toContainEqual(["value"]);
      expect(
        reads.filter((read) => read.validation === "required").map((read) =>
          read.path
        ),
      )
        .toContainEqual(["value", "evidence"]);
      tx.abort();
    } finally {
      await storage.synced();
      await clock.settle();
      await runtime.dispose();
      await storage.close();
      await server.close();
    }
  });
});
