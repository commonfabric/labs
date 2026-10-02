import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { viewerPrincipal } from "../../src/builder/viewer-principal.ts";
import { collectConsumedLabel, deriveFlowJoin } from "../../src/cfc/prepare.ts";
import { stampWaveRunContext } from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

const alice = await Identity.fromPassphrase("viewer-principal alice");
const bob = await Identity.fromPassphrase("viewer-principal bob");
const service = await Identity.fromPassphrase("viewer-principal service");

describe("viewer-principal", () => {
  const runtimes: Runtime[] = [];
  const transactions: IExtendedStorageTransaction[] = [];

  const runtimeFor = (identity: Identity, servingPosture = false) => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: identity }),
      servingPosture,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    runtimes.push(runtime);
    return runtime;
  };

  const edit = (runtime: Runtime) => {
    const tx = runtime.edit();
    transactions.push(tx);
    return tx;
  };

  const read = (
    runtime: Runtime,
    tx: IExtendedStorageTransaction,
    kind: "lift" | "handler" | "pattern" = "lift",
  ) => {
    const frame = pushFrame({
      runtime,
      tx,
      space: alice.did(),
      ...(kind === "pattern" ? {} : { frameKind: kind }),
      inHandler: kind === "handler",
    });
    try {
      return viewerPrincipal();
    } finally {
      popFrame(frame);
    }
  };

  afterEach(async () => {
    for (const tx of transactions.splice(0)) tx.abort(new Error("test-only"));
    for (const runtime of runtimes.splice(0)) {
      await runtime.dispose();
      await runtime.storageManager.close();
    }
  });

  it("scopes and labels each client viewer independently", () => {
    for (const identity of [alice, bob]) {
      const runtime = runtimeFor(identity);
      const tx = edit(runtime);
      expect(read(runtime, tx)).toBe(identity.did());
      expect(tx.getNarrowestReadScope()).toBe("user");
      expect(collectConsumedLabel(tx).confidentiality).toEqual([
        cfcAtom.user(identity.did()),
      ]);
      expect(deriveFlowJoin(tx).confidentiality).toEqual([
        cfcAtom.user(identity.did()),
      ]);
    }
  });

  it("reads a served instance viewer independently of its event actor", () => {
    const runtime = runtimeFor(service, true);
    const tx = edit(runtime);
    stampWaveRunContext(tx, {
      actionId: "viewer-probe",
      kind: "derivation",
      acting: { user: bob.did() },
      scopeKeyIdentity: { principal: alice.did(), sessionId: "alice-session" },
    });
    expect(read(runtime, tx)).toBe(alice.did());
    expect(tx.getNarrowestReadScope()).toBe("user");
    expect(collectConsumedLabel(tx).confidentiality).toEqual([
      cfcAtom.user(alice.did()),
    ]);
  });

  it("leaves an undemanded served computation without a viewer", () => {
    const runtime = runtimeFor(service, true);
    const tx = edit(runtime);
    expect(read(runtime, tx)).toBeUndefined();
    expect(tx.getNarrowestReadScope()).toBe("user");
    expect(collectConsumedLabel(tx).confidentiality).toEqual([]);
  });

  it("refuses handlers, pattern bodies, and calls outside a computation", () => {
    const runtime = runtimeFor(alice);
    const tx = edit(runtime);
    expect(() => read(runtime, tx, "handler")).toThrow("reactive computation");
    expect(() => read(runtime, tx, "pattern")).toThrow("reactive computation");
    expect(() => viewerPrincipal()).toThrow("reactive computation");
  });

  it("persists a compiled viewer and its dependent result at user scope with confidentiality", async () => {
    for (const identity of [alice, bob]) {
      const runtime = runtimeFor(identity);
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
            import { computed, pattern, viewerPrincipal } from "commonfabric";
            export default pattern(() => {
              const viewer = computed(() => viewerPrincipal());
              const derived = computed(() => "viewer:" + viewer);
              return { viewer, derived };
            });
          `,
        }],
      }, { space: identity.did() });
      const tx = edit(runtime);
      const result = runtime.getCell<{ viewer: string; derived: string }>(
        identity.did(),
        "compiled-viewer",
        compiled.resultSchema,
        tx,
      );
      runtime.run(tx, compiled, {}, result);
      expect((await tx.commit()).error).toBeUndefined();
      const output = result.withTx(undefined);
      await waitForCellValue(
        runtime,
        output.key("derived"),
        (value) => value === `viewer:${identity.did()}`,
      );
      await runtime.storageManager.synced();
      for (const key of ["viewer", "derived"] as const) {
        const value = output.key(key).resolveAsCell();
        expect(value.getAsNormalizedFullLink().scope).toBe("user");
        const readTx = edit(runtime);
        expect(value.withTx(readTx).get()).toBe(
          key === "viewer" ? identity.did() : `viewer:${identity.did()}`,
        );
        expect(collectConsumedLabel(readTx).confidentiality).toContainEqual(
          cfcAtom.user(identity.did()),
        );
      }
    }
  });

  it("refuses writing a viewer into an explicitly public destination", async () => {
    const runtime = runtimeFor(alice);
    const tx = edit(runtime);
    const value = read(runtime, tx);
    runtime.getCell<string>(alice.did(), "public-viewer", {
      type: "string",
      ifc: { maxConfidentiality: [] },
    }, tx).set(value!);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error?.message).toContain(
      "maxConfidentiality failed",
    );
  });
});
