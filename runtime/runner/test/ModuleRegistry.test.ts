import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { Module } from "../src/builder/types.ts";
import { ModuleRegistry, registeredBuiltinRef } from "../src/module.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("module-registry");

describe("ModuleRegistry", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let registry: ModuleRegistry;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    registry = new ModuleRegistry(runtime);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  describe("instance members", () => {
    describe("addModuleByRef()", () => {
      it("registers an extensible module as itself", () => {
        const module: Module = { type: "javascript", implementation: () => 1 };
        registry.addModuleByRef("one", module);

        expect(registry.getModule("one")).toBe(module);
        expect(registeredBuiltinRef(module)).toBe("one");
      });

      it("registers a frozen module as a copy carrying its members", () => {
        const implementation = () => 1;
        const tag = Symbol("tag");
        const module: Module = { type: "javascript", implementation };
        Object.defineProperty(module, tag, {
          value: "tagged",
          enumerable: true,
        });
        Object.defineProperty(module, "hidden", { value: "kept" });
        Object.freeze(module);
        registry.addModuleByRef("frozen", module);

        const registered = registry.getModule("frozen");
        expect(registered).not.toBe(module);
        expect(registered.type).toBe("javascript");
        expect(registered.implementation).toBe(implementation);
        expect(Reflect.get(registered, tag)).toBe("tagged");
        expect(Object.getOwnPropertyDescriptor(registered, "hidden"))
          .toEqual(Object.getOwnPropertyDescriptor(module, "hidden"));
        expect(registeredBuiltinRef(registered)).toBe("frozen");
        expect(registeredBuiltinRef(module)).toBeUndefined();
      });
    });

    describe("getModule()", () => {
      it("throws for a ref nothing is registered under", () => {
        registry.addModuleByRef("one", { type: "javascript" });

        expect(() => registry.getModule("two")).toThrow(
          "Unknown module ref: two",
        );
      });
    });
  });
});
