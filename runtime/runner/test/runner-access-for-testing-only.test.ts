import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { DependencySyncer } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import { CooperativeYield } from "../src/scheduler/cooperative-yield.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner access for testing");

describe("Runner", () => {
  describe("instance members", () => {
    describe("accessForTestingOnly", () => {
      let storage: ReturnType<typeof StorageManager.emulate>;
      let runtime: Runtime;

      beforeEach(() => {
        storage = StorageManager.emulate({ as: signer });
        runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
        });
      });

      afterEach(async () => {
        await runtime.dispose();
        await storage.close();
      });

      it("reads back each recorder and syncer a test installs, and `undefined` once it is cleared", () => {
        const access = runtime.runner.accessForTestingOnly;
        const syncer: DependencySyncer = (cell, executable, inputs, sync) =>
          sync(cell, executable, inputs);
        const presync = () => {};
        const binding = () => {};
        const displaced = () => {};

        expect(access.dependencySyncer).toBeUndefined();
        expect(access.presyncPlanRecorder).toBeUndefined();
        expect(access.nodeBindingRecorder).toBeUndefined();
        expect(access.displacedChildReadRecorder).toBeUndefined();

        access.dependencySyncer = syncer;
        access.presyncPlanRecorder = presync;
        access.nodeBindingRecorder = binding;
        access.displacedChildReadRecorder = displaced;
        expect(access.dependencySyncer).toBe(syncer);
        expect(access.presyncPlanRecorder).toBe(presync);
        expect(access.nodeBindingRecorder).toBe(binding);
        expect(access.displacedChildReadRecorder).toBe(displaced);

        access.dependencySyncer = undefined;
        access.presyncPlanRecorder = undefined;
        access.nodeBindingRecorder = undefined;
        access.displacedChildReadRecorder = undefined;
        expect(access.dependencySyncer).toBeUndefined();
        expect(access.presyncPlanRecorder).toBeUndefined();
        expect(access.nodeBindingRecorder).toBeUndefined();
        expect(access.displacedChildReadRecorder).toBeUndefined();
      });

      it("reads back the resume yield a test installs, and the one it restores", () => {
        const access = runtime.runner.accessForTestingOnly;
        const original = access.resumeYield;
        const installed = new CooperativeYield(0);

        access.resumeYield = installed;
        expect(access.resumeYield).toBe(installed);
        expect(access.resumeYield).not.toBe(original);

        access.resumeYield = original;
        expect(access.resumeYield).toBe(original);
      });
    });
  });
});
