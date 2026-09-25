import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { hashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { raw } from "../src/module.ts";
import { createNodeFactory } from "../src/builder/module.ts";
import { Runtime } from "../src/runtime.ts";
import {
  builtinArtifactCodeHash,
  resolvePolicyFacingImplementationIdentity,
  transformedByOperation,
} from "../src/cfc/implementation-identity.ts";
import { getTopFrame } from "../src/builder/pattern.ts";
import {
  getVerifiedProvenance,
  recordVerifiedProvenance,
} from "../src/harness/verified-provenance.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-implementation-identity",
);

describe("CFC builtin implementation identity", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("derives builtin provenance from a versioned registry artifact", () => {
    expect(transformedByOperation({ kind: "builtin", builtinId: "map" }))
      .toEqual({
        codeHash: hashStringOf({
          format: "commonfabric/cfc/builtin-registry/v1",
          operation: "map",
        }),
        operation: "map",
      });
    expect(builtinArtifactCodeHash("map")).not.toBe(
      builtinArtifactCodeHash("filter"),
    );
  });

  it("does not accept a function-source hash as artifact identity", () => {
    expect(transformedByOperation(
      {
        kind: "verified",
        codeHash: "hash-of-Function-toString",
        symbol: "tally",
      } as unknown as Parameters<typeof transformedByOperation>[0],
    ))
      .toBeUndefined();
  });

  it("uses the verified module artifact and operation", () => {
    expect(transformedByOperation({
      kind: "verified",
      moduleIdentity: "cf:module/content-hash",
      symbol: "tally",
    })).toEqual({
      codeHash: "cf:module/content-hash",
      operation: "tally",
    });
  });

  it("stamps registered raw builtins with a stable builtin identity", () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const captured: Array<unknown> = [];
    runtime.moduleRegistry.addModuleByRef(
      "test-builtin",
      raw((inputsCell) => {
        captured.push(inputsCell.tx?.getCfcState().implementationIdentity);
        return () => undefined;
      }),
    );

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      signer.did(),
      "cfc-builtin-identity",
      undefined,
      tx,
    );
    runtime.runner.run(
      tx,
      runtime.moduleRegistry.getModule("test-builtin"),
      {},
      resultCell,
    );

    expect(captured[0]).toEqual({
      kind: "builtin",
      builtinId: "test-builtin",
    });
    tx.abort("test-complete");
  });

  it("keeps the builtin identity when the ref declares a scope", () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const captured: Array<unknown> = [];
    runtime.moduleRegistry.addModuleByRef(
      "scoped-test-builtin",
      raw((inputsCell) => {
        captured.push(inputsCell.tx?.getCfcState().implementationIdentity);
        return () => undefined;
      }),
    );

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      signer.did(),
      "cfc-scoped-builtin-identity",
      undefined,
      tx,
    );
    // `.asScope("user")` — what the transformer lowers a `PerUser<>` result
    // annotation to — records the scope on the REF module, so resolving the
    // ref has to carry the registry module's `debugName` onto the scoped copy.
    // That name is the whole proof of the builtin identity, and it is
    // non-enumerable (so it stays out of the serialized key set), so a copy
    // that does not go out of its way to keep it drops the identity.
    runtime.runner.run(
      tx,
      createNodeFactory({
        type: "ref",
        implementation: "scoped-test-builtin",
      }).asScope("user"),
      {},
      resultCell,
    );

    expect(captured[0]).toEqual({
      kind: "builtin",
      builtinId: "scoped-test-builtin",
    });
    tx.abort("test-complete");
  });

  it("keeps the name off the serialized key set of a module that carried one", () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    // The name is what the policy identity is read from, and it stays out of
    // `moduleToEncodableForm`'s key set — which is `...rest`, so the name must
    // be non-enumerable wherever it is set. A module arriving with an ordinary
    // `debugName` of its own is the case that tests it: `defineProperty`
    // carries forward an existing property's attributes, so anything that
    // leaves `enumerable` to default would keep this one enumerable and put
    // the name into every content-derived id built from the module.
    const carriesItsOwn = Object.assign(
      raw(() => () => undefined),
      { debugName: "stale" },
    );
    runtime.moduleRegistry.addModuleByRef("named-test-builtin", carriesItsOwn);

    const plain = runtime.moduleRegistry.getModule("named-test-builtin");
    const scoped = runtime.moduleRegistry.getModule(
      "named-test-builtin",
      "user",
    );

    for (const module of [plain, scoped]) {
      expect(Object.keys(module)).not.toContain("debugName");
      expect(
        Object.getOwnPropertyDescriptor(module, "debugName")?.enumerable,
      ).toBe(false);
      expect(resolvePolicyFacingImplementationIdentity(module)).toEqual({
        kind: "builtin",
        builtinId: "named-test-builtin",
      });
    }
  });

  it("threads builtin implementation identity through the active execution frame", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const captured: Array<unknown> = [];
    runtime.moduleRegistry.addModuleByRef(
      "frame-builtin",
      raw((_inputsCell) => {
        captured.push(getTopFrame()?.implementationIdentity);
        return () => undefined;
      }),
    );

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      signer.did(),
      "cfc-builtin-frame-identity",
      undefined,
      tx,
    );
    runtime.runner.run(
      tx,
      runtime.moduleRegistry.getModule("frame-builtin"),
      {},
      resultCell,
    );
    await tx.commit();
    await runtime.idle();

    expect(captured[0]).toEqual({
      kind: "builtin",
      builtinId: "frame-builtin",
    });
  });

  it("leaves unregistered raw modules without a builtin identity", () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const captured: Array<unknown> = [];
    const module = raw((inputsCell) => {
      captured.push(inputsCell.tx?.getCfcState().implementationIdentity);
      return () => undefined;
    });

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      signer.did(),
      "cfc-unregistered-raw",
      undefined,
      tx,
    );
    runtime.runner.run(tx, module, {}, resultCell);

    expect(captured[0]).toBeUndefined();
    tx.abort("test-complete");
  });

  it("leaves the frame stack as it found it when a raw module has no builtin identity", () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const frameBeforeRun = getTopFrame();
    const module = raw(() => () => undefined);

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      signer.did(),
      "cfc-unregistered-raw-frame",
      undefined,
      tx,
    );
    runtime.runner.run(tx, module, {}, resultCell);

    expect(getTopFrame()).toBe(frameBeforeRun);
    tx.abort("test-complete");
  });

  it("resolves verified compiled modules through provenance, with binding identity and bundle id", () => {
    // PR E2: the implementationRef × verifiedLoadId registry arm is gone; the
    // function object's provenance (recorded during verified evaluation) is
    // the only source of `kind: "verified"`. This drives the resolver through
    // the same registration channel the engine uses.
    const implementation = Object.assign(() => undefined, {
      // `.src` is present but NO LONGER consulted — identity is provenance-only,
      // so no `sourceLocation` is derived from it.
      src: "cf:module/module-hash-1/main.tsx:4:12",
    });
    recordVerifiedProvenance(implementation, {
      identity: "module-hash-1",
      symbol: "localFunction",
      bindingIdentity: {
        sourceFile: "/main.tsx",
        bindingPath: ["localFunction"],
      },
    });
    const module = { type: "javascript" as const };
    expect(
      resolvePolicyFacingImplementationIdentity(module, { implementation }),
    ).toEqual({
      kind: "verified",
      moduleIdentity: "module-hash-1",
      symbol: "localFunction",
      sourceFile: "/main.tsx",
      bindingPath: ["localFunction"],
    });
  });

  it("registers exported trusted builder bindings with source identity", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const program = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cts-enable />
          import { handler, pattern, Writable, WriteAuthorizedBy } from "commonfabric";

          export const saveTitle = handler<void, { title: Writable<string> }>(
            (_event, { title }) => {
              title.set(title.get());
            },
          );

          export type SavedTitle = WriteAuthorizedBy<string, typeof saveTitle>;

          export default pattern(() => ({ saveTitle }));
        `,
      }],
    };

    const { main } = await runtime.harness.compileAndEvaluateModules(program);

    // The binding identity rides on the function's content-addressed
    // provenance (recorded by Engine.#recordModuleProvenance from the
    // transformer's annotation on the exported factory).
    expect(
      getVerifiedProvenance(
        (main as {
          saveTitle: { implementation: (...args: unknown[]) => unknown };
        }).saveTitle.implementation,
      )?.bindingIdentity,
    ).toEqual({
      sourceFile: "/main.tsx",
      bindingPath: ["saveTitle"],
    });
  });

  it("treats unknown implementation identities as untrusted", () => {
    const module = { type: "javascript" as const };
    expect(resolvePolicyFacingImplementationIdentity(module)).toBeUndefined();
  });

  it("an implementationRef alone grants nothing — a provenance-less function stays untrusted", () => {
    // The legacy-arm-deletion pin (PR E2): under the dual-read window a
    // module's `implementationRef` could still resolve a verified identity
    // through the per-load registry. Post-flip the ref is inert for CFC — a
    // function that was never registered during a verified evaluation has no
    // provenance and gets NO identity, no matter what the module claims.
    const implementation = Object.assign(() => undefined, {
      src: "/main.tsx:4:12",
    });
    const module = {
      type: "javascript" as const,
      implementationRef: "verified-implementation-ref",
    };

    expect(
      resolvePolicyFacingImplementationIdentity(module, { implementation }),
    ).toBeUndefined();
  });

  it("ignores a canonical source that disagrees with the provenance identity", () => {
    // Re-rooted off `.src`: the former consistency check (src identity ===
    // provenance identity, else `unsupported`) is GONE. The WeakMap provenance is
    // the anti-spoof proof and the sole identity source, so a `.src` that points
    // at a DIFFERENT module — or is garbled/absent, as it will be under lazy
    // debug-only `.src` — is inert and does NOT downgrade the identity. (An
    // attacker cannot exploit this: a forged function has no provenance entry at
    // all and resolves to nothing — see the provenance-less test above.)
    const implementation = Object.assign(() => undefined, {
      src: "cf:module/other-module-hash/other.tsx:4:12",
    });
    recordVerifiedProvenance(implementation, {
      identity: "module-hash-1",
      symbol: "localFunction",
    });
    const module = { type: "javascript" as const };

    const identity = resolvePolicyFacingImplementationIdentity(module, {
      implementation,
    });
    expect(identity?.kind).toBe("verified");
    expect((identity as { moduleIdentity?: string }).moduleIdentity).toBe(
      "module-hash-1",
    );
  });
});
