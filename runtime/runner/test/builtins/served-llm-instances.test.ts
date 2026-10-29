/** Verifies served effect requests distinguish the selected scope instance. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";

import { generateObject, generateText, llm } from "../../src/builtins/llm.ts";
import type { Cell } from "../../src/cell.ts";
import { stampWaveRunContext } from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import type { Action } from "../../src/scheduler.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

const service = await Identity.fromPassphrase("builtin-instance-service");
const alice = await Identity.fromPassphrase("builtin-instance-alice");
const bob = await Identity.fromPassphrase("builtin-instance-bob");
const space = service.did();
const aliceOne = { principal: alice.did(), sessionId: "alice-one" };
const aliceTwo = { principal: alice.did(), sessionId: "alice-two" };
const bobOne = { principal: bob.did(), sessionId: "bob-one" };

/** Builtin request driven with explicit run identity and staged scoped inputs. */
type Builtin = {
  /** Builtin under test. */
  name: string;

  /** Canonical request shared by both actors. */
  inputs: Record<string, unknown>;

  /** Constructs the reactive action. */
  create: (
    inputs: Cell<any>,
    publish: (tx: IExtendedStorageTransaction, result: any) => void,
    cancel: (callback: () => void) => void,
    cause: any,
    parent: Cell<any>,
    runtime: Runtime,
  ) => Action | { action: Action };
};

const builtins: Builtin[] = [
  {
    name: "generateText",
    inputs: { prompt: "same prompt" },
    create: generateText,
  },
  {
    name: "llm",
    inputs: { messages: [{ role: "user", content: "same prompt" }] },
    create: llm,
  },
  {
    name: "generateObject",
    inputs: { prompt: "same prompt", schema: { type: "object" } },
    create: generateObject,
  },
];

describe("served-llm-instances", () => {
  let manager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  const transactions: IExtendedStorageTransaction[] = [];

  beforeEach(() => {
    manager = StorageManager.emulate({ as: service });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    for (const tx of transactions.splice(0)) tx.abort();
    await manager.synced();
    await runtime.dispose().catch(async (error) => {
      await manager.close();
      throw error;
    });
  });

  /** Stages two requests without allowing network work or the first transaction to settle. */
  function staged(
    builtin: Builtin,
    scope: "user" | "session",
    identities: ScopeKeyIdentity[],
    sharedClosure = false,
  ) {
    const input = runtime.getCellFromLink({
      ...runtime.getCell(space, "instance-input").getAsNormalizedFullLink(),
      scope,
    });
    const parent = runtime.getCell(space, "instance-parent");
    const construct = () => {
      const created = builtin.create(
        input,
        () => {},
        () => {},
        "instance-cause",
        parent,
        runtime,
      );
      return typeof created === "function" ? created : created.action;
    };
    const shared = sharedClosure ? construct() : undefined;
    return identities.map((identity) => {
      const tx = runtime.edit();
      transactions.push(tx);
      stampWaveRunContext(tx, {
        kind: "derivation",
        actionId: "instance-investigation",
        scopeKeyIdentity: identity,
        attributionFromScope: true,
      });
      input.withTx(tx).set(builtin.inputs);
      (shared ?? construct())(tx);
      return tx.getCfcState().outbox.map((effect) => effect.idempotencyKey);
    });
  }

  for (const builtin of builtins) {
    it(`retains one user's deterministic ${builtin.name} request identity`, () => {
      const keys = staged(builtin, "user", [aliceOne, aliceOne]);
      expect(keys[0]).toHaveLength(1);
      expect(keys[1]).toEqual(keys[0]);
    });

    it(`separates two user instances for ${builtin.name}`, () => {
      const keys = staged(builtin, "user", [aliceOne, bobOne]);
      expect(keys[0]).toHaveLength(1);
      expect(keys[1]).toHaveLength(1);
      expect(keys[1][0]).not.toBe(keys[0][0]);
    });

    it(`separates two session instances for ${builtin.name}`, () => {
      const keys = staged(builtin, "session", [aliceOne, aliceTwo]);
      expect(keys[0]).toHaveLength(1);
      expect(keys[1]).toHaveLength(1);
      expect(keys[1][0]).not.toBe(keys[0][0]);
    });

    it(`stages both users on one ${builtin.name} closure`, () => {
      const keys = staged(builtin, "user", [aliceOne, bobOne], true);
      expect(keys[0]).toHaveLength(1);
      expect(keys[1]).toHaveLength(1);
    });
  }
});
