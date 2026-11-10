import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import {
  isUnavailable,
  UNAVAILABLE_PENDING,
  unavailableError,
} from "@commonfabric/data-model/availability";
import { Identity } from "@commonfabric/identity";
import type { ViewInterest, ViewPlan } from "@commonfabric/memory/v2";

import type { Module, Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { patternIdentityKey } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { ISpaceReplica } from "../src/storage/interface.ts";
import { viewNodeId } from "../src/view-replication.ts";
import { trustExecutable, trustModule } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("stored view registration");
const space = signer.did();
const source = { identity: "stored-view-fixture", symbol: "default" };
const identity = patternIdentityKey(source);

describe("view-piece-registration", () => {
  let runtime: Runtime;
  let root: Cell<unknown>;
  let pattern: Pattern;

  beforeEach(async () => {
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
    });
    root = runtime.getCell(space, "stored root", undefined);
    pattern = { argumentSchema: {}, resultSchema: {}, result: {}, nodes: [] };
    await runtime.editWithRetry((tx) => {
      root.withTx(tx).set({ $UI: "confirmed" });
      root.withTx(tx).setMetaRaw(
        "patternIdentity",
        source,
        rawMetaWriteAuthorization,
      );
    });
    await runtime.storageManager.synced();
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  it("owns one registration and makes cancellation idempotent", async () => {
    runtime.patternManager.associatePatternIdentity(pattern, source);
    expect(await runtime.runner.startViewPiece(root, identity, () => false))
      .toBeUndefined();
    const registration = await runtime.runner.startViewPiece(
      root,
      identity,
      () => true,
    );
    expect(registration).toBeDefined();
    expect(registration!.graphIsInstalled()).toBe(true);
    expect(await runtime.runner.startViewPiece(root, identity, () => true))
      .toBeUndefined();
    registration!();
    registration!();
    expect(registration!.resume()).toBe(false);
    expect(registration!.graphIsInstalled()).toBe(false);
    const replacement = await runtime.runner.startViewPiece(
      root,
      identity,
      () => true,
    );
    expect(replacement).toBeDefined();
    replacement!();
    expect(root.get()).toEqual({ $UI: "confirmed" });
  });

  it("leaves unknown and mismatched stored identities unregistered", async () => {
    const unknown = runtime.getCell(space, "unknown root", undefined);
    expect(await runtime.runner.startViewPiece(unknown, identity, () => true))
      .toBeUndefined();
    await unknown.sync();
    expect(await runtime.runner.startViewPiece(unknown, identity, () => true))
      .toBeUndefined();
    expect(
      await runtime.runner.startViewPiece(
        root,
        "different#default",
        () => true,
      ),
    ).toBeUndefined();
    expect(root.get()).toEqual({ $UI: "confirmed" });
  });

  for (const change of ["cancel", "identity", "unavailable"] as const) {
    it(`refuses installation when ${change} changes during artifact loading`, async () => {
      const entered = Promise.withResolvers<void>();
      const loaded = Promise.withResolvers<Pattern | undefined>();
      let current = true;
      using loading = stub(
        runtime.patternManager,
        "loadPatternByIdentity",
        () => {
          entered.resolve();
          return loaded.promise;
        },
      );
      pattern.nodes.push({
        module: {
          type: "raw",
          implementation: () => {
            throw new Error("Boundary must remain on server");
          },
        },
        inputs: {},
        outputs: {},
      });
      const installing = runtime.runner.startViewPiece(
        root,
        identity,
        () => current,
      );
      try {
        await entered.promise;
        if (change === "cancel") current = false;
        if (change === "identity") {
          await runtime.editWithRetry((tx) => {
            root.withTx(tx).setMetaRaw("patternIdentity", {
              ...source,
              identity: "replacement",
            }, rawMetaWriteAuthorization);
          });
        }
        loaded.resolve(change === "unavailable" ? undefined : pattern);
        expect(await installing).toBeUndefined();
        expect(loading.calls).toHaveLength(1);
        runtime.patternManager.associatePatternIdentity(pattern, source);
        const replacement = await runtime.runner.startViewPiece(
          root,
          identity,
          () => true,
        );
        if (change === "identity") expect(replacement).toBeUndefined();
        else {
          expect(replacement).toBeDefined();
          replacement!();
        }
        expect(root.get()).toEqual({ $UI: "confirmed" });
      } finally {
        loaded.resolve(undefined);
        await installing;
      }
    });
  }

  it("installs referenced boundary bindings without executing their modules", async () => {
    pattern.nodes.push({
      module: { type: "ref", implementation: "server-boundary" },
      inputs: {},
      outputs: {},
    });
    runtime.moduleRegistry.addModuleByRef("server-boundary", {
      type: "raw",
      implementation: () => {
        throw new Error("Boundary must remain on server");
      },
    });
    runtime.patternManager.associatePatternIdentity(pattern, source);
    const registration = await runtime.runner.startViewPiece(
      root,
      identity,
      () => true,
    );
    expect(registration?.graphIsInstalled()).toBe(true);
    expect(root.get()).toEqual({ $UI: "confirmed" });
    registration!();
  });

  for (const referenced of [false, true]) {
    it(`restores ${referenced ? "a referenced" : "an inline"} availability computation with its observation policy`, async () => {
      const input = runtime.getCell(space, "view availability input");
      await runtime.editWithRetry((tx) => {
        input.withTx(tx).setRaw(UNAVAILABLE_PENDING);
      });
      const calls: (number | string)[] = [];
      const implementation = ({ value }: { value: unknown }) => {
        const observed = isUnavailable(value)
          ? value.message ?? "unavailable"
          : Number(value) + 1;
        calls.push(observed);
        return observed;
      };
      const contract = {
        argumentSchema: {
          type: "object",
          properties: {
            value: {
              anyOf: [{ type: "number" }, { type: "FabricUnavailable" }],
            },
          },
          required: ["value"],
        },
        resultSchema: { anyOf: [{ type: "number" }, { type: "string" }] },
        unavailableInputPolicy: [{ path: ["value"], reasons: ["error"] }],
      } as const;
      const availabilityModule = {
        type: "javascript-availability",
        implementation,
        ...contract,
      } satisfies Module;
      const registryModule = {
        type: "javascript-availability",
        implementation,
        argumentSchema: {
          type: "object",
          properties: { value: { type: "number" } },
        },
        resultSchema: { type: "number" },
        unavailableInputPolicy: [],
      } satisfies Module;
      let module: Module = trustModule(runtime, availabilityModule);
      if (referenced) {
        runtime.moduleRegistry.addModuleByRef(
          "view-availability",
          trustModule(runtime, registryModule),
        );
        module = {
          type: "ref",
          implementation: "view-availability",
          ...contract,
        };
      }
      pattern.nodes.push({
        module,
        inputs: { value: { $alias: { cell: "argument", path: ["value"] } } },
        outputs: { $alias: { cell: "result", path: ["observed"] } },
      });
      pattern.result = { $UI: "confirmed" };
      const setup = runtime.edit();
      runtime.run(
        setup,
        trustExecutable(runtime, pattern),
        { value: input },
        root,
      );
      root.withTx(setup).setMetaRaw(
        "patternIdentity",
        source,
        rawMetaWriteAuthorization,
      );
      runtime.prepareTxForCommit(setup);
      expect((await setup.commit().settled).error).toBeUndefined();
      await runtime.idle();
      const storage = runtime.storageManager;
      const rootLink = root.getAsNormalizedFullLink();
      const inputLink = input.getAsNormalizedFullLink();
      const argumentLink = root.getArgumentCell()!.getAsNormalizedFullLink();
      await runtime.dispose({ closeStorage: false });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        clientClass: "web",
        experimental: { serverExecution: true, viewScopedReplication: true },
      });
      root = runtime.getCellFromLink(rootLink);
      const viewingInput = runtime.getCellFromLink(inputLink);
      trustModule(runtime, availabilityModule);
      if (referenced) {
        runtime.moduleRegistry.addModuleByRef(
          "view-availability",
          trustModule(runtime, registryModule),
        );
      }
      trustExecutable(runtime, pattern);
      runtime.patternManager.associatePatternIdentity(pattern, source);
      const replica = storage.open(space).replica as Required<ISpaceReplica>;
      let emit!: (plans: readonly ViewPlan[]) => void;
      let interests: ViewInterest[] = [];
      using _supports = stub(
        replica,
        "supportsViewReplication",
        () => Promise.resolve(true),
      );
      using _supported = stub(replica, "viewReplicationSupported", () => true);
      using _plans = stub(replica, "subscribeViewPlans", (observer) => {
        emit = observer;
        observer([]);
        return () => {};
      });
      using _interested = stub(replica, "setViewInterests", (views) => {
        interests = views;
        return Promise.resolve(true);
      });
      const unmount = await runtime.viewReplication.mount(root, "screen");
      expect(unmount).toBeDefined();
      emit([{
        id: "screen",
        revision: interests[0].revision,
        generation: 1,
        eligibleActions: [viewNodeId(rootLink, 0)],
        inputs: [rootLink, inputLink, argumentLink],
        pieces: [{ ...rootLink, patternIdentity: identity }],
      }]);
      const stopOutput = root.key("observed").sink(() => {});
      try {
        await runtime.idle();
        expect(calls).toEqual([]);

        await runtime.editWithRetry((tx) => {
          viewingInput.withTx(tx).setRaw(
            unavailableError("source refused", "provider"),
          );
        });
        await runtime.idle();
        expect(calls).toEqual(["source refused"]);

        await runtime.editWithRetry((tx) => viewingInput.withTx(tx).setRaw(41));
        await runtime.idle();
        expect(calls).toEqual(["source refused", 42]);
        expect(root.get()).toEqual({ $UI: "confirmed", observed: 42 });
      } finally {
        stopOutput();
        unmount?.();
        await runtime.idle();
      }
    });
  }

  it("installs a handler node without reading its stream's document", async () => {
    // A handler registers on the stream its `$event` names; nothing about the
    // stream's document has to be locally available for the graph to install.
    const event = runtime.getCell(space, "unavailable event", undefined);
    await runtime.editWithRetry((tx) =>
      root.withTx(tx).setMetaRaw(
        "argument",
        event.getAsLink(),
        rawMetaWriteAuthorization,
      )
    );
    pattern.nodes.push({
      module: {
        type: "javascript",
        wrapper: "handler",
        implementation: () => {},
      },
      inputs: { $event: { $alias: { cell: "argument", path: [] } } },
      outputs: {},
    });
    runtime.patternManager.associatePatternIdentity(pattern, source);
    const registration = await runtime.runner.startViewPiece(
      root,
      identity,
      () => true,
    );
    expect(registration).toBeDefined();
    expect(registration!.graphIsInstalled()).toBe(true);
    registration!();
    expect(registration!.graphIsInstalled()).toBe(false);
    expect(root.get()).toEqual({ $UI: "confirmed" });
  });

  it("releases a registration after a binding error so a corrected graph can install", async () => {
    pattern.nodes.push({
      module: { type: "javascript" },
      inputs: {},
      outputs: {},
    });
    runtime.patternManager.associatePatternIdentity(pattern, source);
    await expect(runtime.runner.startViewPiece(root, identity, () => true))
      .rejects.toThrow("missing an executable implementation");
    pattern.nodes.length = 0;
    const registration = await runtime.runner.startViewPiece(
      root,
      identity,
      () => true,
    );
    expect(registration?.graphIsInstalled()).toBe(true);
    registration!();
    expect(root.get()).toEqual({ $UI: "confirmed" });
  });

  it("cancels a graph when module resolution retires its mount", async () => {
    pattern.nodes.push({
      module: { type: "ref", implementation: "retiring-module" },
      inputs: {},
      outputs: {},
    });
    runtime.patternManager.associatePatternIdentity(pattern, source);
    let current = true;
    using modules = stub(runtime.moduleRegistry, "getModule", () => {
      current = false;
      return { type: "raw" as const, implementation: () => {} };
    });
    expect(await runtime.runner.startViewPiece(root, identity, () => current))
      .toBeUndefined();
    expect(modules.calls).toHaveLength(1);
    pattern.nodes.length = 0;
    const replacement = await runtime.runner.startViewPiece(
      root,
      identity,
      () => true,
    );
    expect(replacement?.graphIsInstalled()).toBe(true);
    replacement!();
    expect(root.get()).toEqual({ $UI: "confirmed" });
  });

  it("propagates storage failures while reading a stored graph identity", async () => {
    runtime.patternManager.associatePatternIdentity(pattern, source);
    const replica = runtime.storageManager.open(space).replica;
    const failure = new Error("Replica read failed");
    {
      using _reads = stub(replica, "getDocument", () => {
        throw failure;
      });
      await expect(runtime.runner.startViewPiece(root, identity, () => true))
        .rejects.toBe(failure);
    }
    const registration = await runtime.runner.startViewPiece(
      root,
      identity,
      () => true,
    );
    expect(registration?.graphIsInstalled()).toBe(true);
    registration!();
    expect(root.get()).toEqual({ $UI: "confirmed" });
  });
});
