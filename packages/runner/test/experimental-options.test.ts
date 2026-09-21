/**
 * Tests for the `ExperimentalOptions` feature-flag system: verifies that
 * `Runtime` construction/disposal correctly resolves flags and propagates the
 * flags whose consumers are ambient.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import {
  getModernCellRepConfig,
  resetModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import {
  getCommitPreconditionsConfig,
  getServerExecutionConfig,
  resetCommitPreconditionsConfig,
  resetServerExecutionConfig,
} from "@commonfabric/memory/v2";
import { ExecutorHost } from "../src/executor/host.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { Runtime } from "../src/runtime.ts";
import {
  getReaderSchemaPrecedenceConfig,
  resetReaderSchemaPrecedenceConfig,
} from "../src/reader-schema-precedence-config.ts";

const signer = await Identity.fromPassphrase("test experimental");

describe("ExperimentalOptions", () => {
  afterEach(() => {
    resetModernCellRepConfig();
    resetCommitPreconditionsConfig();
    resetServerExecutionConfig();
    resetReaderSchemaPrecedenceConfig();
  });

  describe("Runtime construction", () => {
    it("respects explicitly-set flags (all false)", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          modernCellRep: false,
          agentBuiltin: false,
          commitPreconditions: false,
          plainResultReceipts: false,
          computedCellIds: false,
          lazyMaterialization: false,
          readerSchemaPrecedence: false,
        },
      });
      expect(runtime.experimental).toEqual({
        modernCellRep: false,
        agentBuiltin: false,
        contentAddressedSchemas: true,
        commitPreconditions: false,
        plainResultReceipts: false,
        computedCellIds: false,
        lazyMaterialization: false,
        readerSchemaPrecedence: false,
        serverExecution: false,
      });
      await runtime.dispose();
      await sm.close();
    });

    it("respects explicitly-set flags (all true)", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          modernCellRep: true,
        },
      });
      expect(runtime.experimental).toEqual({
        modernCellRep: true,
        agentBuiltin: true,
        contentAddressedSchemas: true,
        commitPreconditions: true,
        plainResultReceipts: true,
        computedCellIds: true,
        lazyMaterialization: true,
        readerSchemaPrecedence: true,
        serverExecution: false,
      });
      await runtime.dispose();
      await sm.close();
    });

    it("merges provided flags with defaults", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {},
      });
      expect(runtime.experimental).toEqual({
        modernCellRep: false,
        agentBuiltin: true,
        contentAddressedSchemas: true,
        commitPreconditions: true,
        plainResultReceipts: true,
        computedCellIds: true,
        lazyMaterialization: true,
        readerSchemaPrecedence: true,
        serverExecution: false,
      });
      await runtime.dispose();
      await sm.close();
    });
  });

  describe("Runtime sets and resets ambient config", () => {
    it("constructing Runtime with modernCellRep sets global config", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          modernCellRep: true,
        },
      });

      expect(getModernCellRepConfig()).toBe(true);

      await runtime.dispose();
      await sm.close();
    });

    it("constructing Runtime with serverExecution sets global config", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          serverExecution: true,
        },
      });

      expect(getServerExecutionConfig()).toBe(true);
      expect(runtime.experimental.serverExecution).toBe(true);

      await runtime.dispose();
      await sm.close();

      expect(getServerExecutionConfig()).toBe(false);
    });

    it("constructing Runtime with commitPreconditions sets global config", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          commitPreconditions: true,
        },
      });

      expect(getCommitPreconditionsConfig()).toBe(true);

      await runtime.dispose();
      await sm.close();
    });

    it("constructing Runtime with explicit false sets config to false", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: { modernCellRep: false },
      });

      expect(getModernCellRepConfig()).toBe(false);

      await runtime.dispose();
      await sm.close();
    });

    it("constructing Runtime with explicit true sets config to true", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: { modernCellRep: true },
      });

      expect(getModernCellRepConfig()).toBe(true);

      await runtime.dispose();
      await sm.close();
    });

    it("constructing Runtime with readerSchemaPrecedence false sets global config, and dispose leaves it", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: { readerSchemaPrecedence: false },
      });

      expect(getReaderSchemaPrecedenceConfig()).toBe(false);
      expect(runtime.experimental.readerSchemaPrecedence).toBe(false);

      // Serving runtimes are per-space and idle-disposed; a dispose must
      // not lift a live rollback (the ambient family below pins the rest).
      await runtime.dispose();
      await sm.close();

      expect(getReaderSchemaPrecedenceConfig()).toBe(false);
    });

    it("disposing Runtime resets global config to the default", async () => {
      const initial = getModernCellRepConfig();
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          modernCellRep: !initial,
        },
      });

      expect(getModernCellRepConfig()).toBe(!initial);

      await runtime.dispose();
      await sm.close();

      expect(getModernCellRepConfig()).toBe(initial);
      expect(getCommitPreconditionsConfig()).toBe(true);
      expect(getServerExecutionConfig()).toBe(false);
    });
  });
});

describe("serverExecution ambient-flag ownership", () => {
  // The serverExecution ambient-flag OWNERSHIP family (PR #5439 threads
  // r3731191424, r3731191435, r3731191451): the flag is a process-global
  // admission input, so its lifecycle must be reference-counted across ALL
  // owners (explicit-enabler Runtimes AND the ExecutorHost), survive
  // construction/dispose failures, and never be stomped by a co-hosted
  // non-serving runtime.

  afterEach(() => {
    resetModernCellRepConfig();
    resetCommitPreconditionsConfig();
    resetServerExecutionConfig();
  });

  it("a co-hosted explicit-false Runtime must not un-claim the ambient flag while an enabler is live", async () => {
    const smEnabler = StorageManager.emulate({ as: signer });
    const enabler = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smEnabler,
      experimental: { serverExecution: true },
    });
    expect(getServerExecutionConfig()).toBe(true);

    const smDisabled = StorageManager.emulate({ as: signer });
    const disabled = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smDisabled,
      experimental: { serverExecution: false },
    });
    // The live serving enabler keeps the ambient admission claim: an
    // explicit-false construction elsewhere in the process must not
    // silently un-claim `derived` mid-serve.
    expect(getServerExecutionConfig()).toBe(true);
    // The explicit-false runtime keeps its OWN posture.
    expect(disabled.experimental.serverExecution).toBe(false);

    await disabled.dispose();
    expect(getServerExecutionConfig()).toBe(true);
    await enabler.dispose();
    expect(getServerExecutionConfig()).toBe(false);
    await smDisabled.close();
    await smEnabler.close();
  });

  it("a THROWING construction rolls its enabler back instead of poisoning the process-global lifecycle", async () => {
    const smBad = StorageManager.emulate({ as: signer });
    expect(() =>
      new Runtime({
        apiUrl: "::not a url::" as never,
        storageManager: smBad,
        experimental: { serverExecution: true },
      })
    ).toThrow();
    // The failed construction must not leak an enabler: a later
    // well-formed enabler's dispose still resets the ambient flag.
    const sm = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
      experimental: { serverExecution: true },
    });
    expect(getServerExecutionConfig()).toBe(true);
    await runtime.dispose();
    expect(getServerExecutionConfig()).toBe(false);
    await sm.close();
    await smBad.close();
  });

  it("ExecutorHost close does not un-claim the flag while an explicit-enabler Runtime is live (shared refcount across owners)", async () => {
    const server = newSharedServer();
    const host = new ExecutorHost({
      server,
      serviceIdentity: "did:key:z6Mk-flag-test-service",
      createRuntime: () => Promise.reject(new Error("never activated")),
    });
    expect(getServerExecutionConfig()).toBe(true);

    const sm = StorageManager.emulate({ as: signer });
    const enabler = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
      experimental: { serverExecution: true },
    });

    // Host teardown while a serving runtime still lives: the ambient
    // claim must survive (its in-flight wave commits are admitted off
    // this flag).
    await host.close();
    expect(getServerExecutionConfig()).toBe(true);

    await enabler.dispose();
    expect(getServerExecutionConfig()).toBe(false);
    await sm.close();
    await server.close();
  });

  it("a REJECTING dispose still releases the enabler (the reset must not depend on a clean async teardown)", async () => {
    const sm = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
      experimental: { serverExecution: true },
    });
    expect(getServerExecutionConfig()).toBe(true);
    (runtime.scheduler as unknown as { idle: () => Promise<void> }).idle = () =>
      Promise.reject(new Error("induced dispose failure"));
    let threw = false;
    try {
      await runtime.dispose();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(getServerExecutionConfig()).toBe(false);
    await sm.close();
  });
});

describe("readerSchemaPrecedence ambient flag", () => {
  // The readerSchemaPrecedence ambient-flag family: plain last-write-wins
  // module state like the other flags' ambient configs. Successive runtimes
  // in one test process may run different flag states; a real server
  // constructs one posture and never changes it mid-flight.

  afterEach(() => {
    resetModernCellRepConfig();
    resetCommitPreconditionsConfig();
    resetServerExecutionConfig();
    resetReaderSchemaPrecedenceConfig();
  });

  it("sets the ambient state per construction; dispose leaves it standing", async () => {
    const smRollback = StorageManager.emulate({ as: signer });
    const rollback = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smRollback,
      experimental: { readerSchemaPrecedence: false },
    });
    expect(getReaderSchemaPrecedenceConfig()).toBe(false);
    expect(rollback.experimental.readerSchemaPrecedence).toBe(false);

    // A server runs one serving runtime per space and disposes idle ones
    // while the rest live: a dispose must not lift the rollback out from
    // under them.
    await rollback.dispose();
    await smRollback.close();
    expect(getReaderSchemaPrecedenceConfig()).toBe(false);

    // The next construction decides — an unset option sets the default.
    const smDefault = StorageManager.emulate({ as: signer });
    const plain = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smDefault,
    });
    expect(getReaderSchemaPrecedenceConfig()).toBe(true);
    expect(plain.experimental.readerSchemaPrecedence).toBe(true);
    await plain.dispose();
    await smDefault.close();
  });

  it("a THROWING construction also leaves the ambient to the next construction", async () => {
    const smBad = StorageManager.emulate({ as: signer });
    expect(() =>
      new Runtime({
        apiUrl: "::not a url::" as never,
        storageManager: smBad,
        experimental: { readerSchemaPrecedence: false },
      })
    ).toThrow();
    await smBad.close();

    const smNext = StorageManager.emulate({ as: signer });
    const next = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smNext,
    });
    expect(getReaderSchemaPrecedenceConfig()).toBe(true);
    await next.dispose();
    await smNext.close();
  });
});
