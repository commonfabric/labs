import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { RuntimeTelemetryEvent } from "../src/telemetry.ts";

// An owner-protected field bound by `WriteAuthorizedBy<T, typeof fn>` compiles
// to a verified-binding `writeAuthorizedBy` claim. At commit the CFC verifier
// resolves the authoring handler's identity — sourceFile/bindingPath — from the
// function's content-addressed provenance (`bindingIdentity`, recorded by
// Engine.#recordModuleProvenance from the transformer's
// `__cfBindVerifiedBinding` annotation on the FACTORY object). A handler
// declared as a NON-exported module-scope const (the shape used throughout
// system/profile-home.tsx) surfaces through the `__cfReg` registration sink,
// and that sink registration must carry the binding identity, without which the
// write is rejected with "writeAuthorizedBy requires a trusted verified binding
// identity".
//
// Scope: these tests assert the writer identity is REGISTERED (provenance
// carries the bindingIdentity) and RESOLVES onto transactions while handlers
// run — the value the CFC verifier consumes at commit. An end-to-end "the
// write is accepted" assertion additionally needs trust-snapshot +
// owner-principal + trusted-event provenance setup, which
// profile-owner-cfc.test.ts drives via a mocked authoring identity.

const signer = await Identity.fromPassphrase("ct1665-repro");
const space = signer.did();

const INTERNAL_SRC = `/// <cts-enable />
  import { handler, pattern, Writable, WriteAuthorizedBy } from "commonfabric";
  const setName = handler<{ name?: string }, { name: Writable<string> }>(
    (event, state) => { state.name.set(event.name ?? ""); },
  );
  const setAvatar = handler<{ avatar?: string }, { avatar: Writable<string> }>(
    (event, state) => { state.avatar.set(event.avatar ?? ""); },
  );
  export default pattern(() => {
    const name = new Writable<WriteAuthorizedBy<string, typeof setName>>("").for("name");
    const avatar = new Writable<WriteAuthorizedBy<string, typeof setAvatar>>("").for("avatar");
    return { name, avatar, setName: setName({ name }), setAvatar: setAvatar({ avatar }) };
  });
`;

// The same handlers, EXPORTED: the identity must resolve on that path too.
const EXPORTED_SRC = INTERNAL_SRC.replace(
  / {2}const set/g,
  "  export const set",
);

const PROFILE_HOME_SRC = Deno.readTextFileSync(
  new URL("../../patterns/system/profile-home.tsx", import.meta.url),
);

function programFor(src: string): RuntimeProgram {
  return { main: "/main.tsx", files: [{ name: "/main.tsx", contents: src }] };
}

// The binding paths each runtime's engine has registered so far, collected
// from its `harness.implementation.register` markers from the moment
// `newRuntime()` built it.
const bindingPathsByRuntime = new WeakMap<Runtime, string[][]>();

function recordedBindingPaths(rt: Runtime): string[][] {
  const paths = bindingPathsByRuntime.get(rt);
  if (paths === undefined) {
    throw new Error("Runtime was not built by `newRuntime()`");
  }
  return paths;
}

// Capture the bindingPaths of the writer identities current on transactions
// as a handler's writes are recorded — each write-policy input carries the
// identity current when it was recorded, and that is the value the CFC
// verifier consumes at commit. Channel-agnostic: the identity may resolve
// through the content-addressed provenance WeakMap or the legacy
// implementationRef registry; what matters is the identity (with its
// bindingPath) reaching the transaction.
async function bindingPathsResolvedDuring(
  rt: Runtime,
  fn: () => void,
): Promise<string[][]> {
  const proto = ExtendedStorageTransaction.prototype as unknown as {
    recordCfcWritePolicyInput: (...args: unknown[]) => void;
  };
  const orig = proto.recordCfcWritePolicyInput;
  const resolved: string[][] = [];
  proto.recordCfcWritePolicyInput = function (
    this: ExtendedStorageTransaction,
    ...args: unknown[]
  ) {
    const bindingPath = (this.getCfcState().implementationIdentity as
      | { bindingPath?: string[] }
      | undefined)?.bindingPath;
    if (Array.isArray(bindingPath)) resolved.push([...bindingPath]);
    return orig.apply(this, args);
  };
  try {
    fn();
    await (rt as any).idle?.();
  } finally {
    proto.recordCfcWritePolicyInput = orig;
  }
  return resolved;
}

describe("verified binding metadata for non-exported handlers", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const newRuntime = () => {
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const paths: string[][] = [];
    rt.telemetry.addEventListener("telemetry", (event: Event) => {
      const { marker } = (event as RuntimeTelemetryEvent).detail;
      if (
        marker.type === "harness.implementation.register" &&
        marker.bindingPath !== undefined
      ) {
        paths.push(marker.bindingPath);
      }
    });
    bindingPathsByRuntime.set(rt, paths);
    return rt;
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  for (
    const [label, src] of [["internal", INTERNAL_SRC], [
      "exported",
      EXPORTED_SRC,
    ]] as const
  ) {
    it(`resolves the writer identity when ${label} handlers run`, async () => {
      const rt = newRuntime();
      try {
        const tx = rt.edit();
        const pattern = await rt.patternManager.compilePattern(
          programFor(src),
          { space, tx },
        );
        const resultCell = rt.getCell<Record<string, unknown>>(
          space,
          `ct1665-${label}`,
          undefined,
          tx,
        );
        const r = rt.run(tx, pattern, {}, resultCell);
        rt.prepareTxForCommit(tx);
        await tx.commit();
        await r.pull();

        // The metadata is registered for both siblings...
        const paths = recordedBindingPaths(rt);
        expect(paths).toContainEqual(["setName"]);
        expect(paths).toContainEqual(["setAvatar"]);

        // ...and resolves through the verifier's lookup as each handler runs.
        const onName = await bindingPathsResolvedDuring(rt, () => {
          r.key("setName").send({ name: "Alice" });
        });
        expect(onName).toContainEqual(["setName"]);

        const onAvatar = await bindingPathsResolvedDuring(rt, () => {
          r.key("setAvatar").send({ avatar: "🦊" });
        });
        expect(onAvatar).toContainEqual(["setAvatar"]);
      } finally {
        await rt.dispose();
      }
    });
  }

  it("registers binding metadata for real profile-home setName/setAvatar/mutateElements", async () => {
    const rt = newRuntime();
    try {
      const tx = rt.edit();
      const pattern = await rt.patternManager.compilePattern(
        programFor(PROFILE_HOME_SRC),
        { space, tx },
      );
      const resultCell = rt.getCell<Record<string, unknown>>(
        space,
        "ct1665-profile",
        undefined,
        tx,
      );
      const r = rt.run(tx, pattern, { initialName: "Init" }, resultCell);
      rt.prepareTxForCommit(tx);
      await tx.commit();
      await r.pull();

      const paths = recordedBindingPaths(rt);
      expect(paths).toContainEqual(["setName"]);
      expect(paths).toContainEqual(["setAvatar"]);
      expect(paths).toContainEqual(["mutateElements"]);
    } finally {
      await rt.dispose();
    }
  });

  it("registers binding metadata after resume-by-identity (source-free reload)", async () => {
    const rt1 = newRuntime();
    const rt2 = newRuntime();
    try {
      const tx1 = rt1.edit();
      const pm1 = rt1.patternManager;
      const cold = await pm1.compilePattern(programFor(INTERNAL_SRC), {
        space,
        tx: tx1,
      });
      const resultCell1 = rt1.getCell<Record<string, unknown>>(
        space,
        "ct1665-resume",
        undefined,
        tx1,
      );
      const r1 = rt1.run(tx1, cold, {}, resultCell1);
      rt1.prepareTxForCommit(tx1);
      await tx1.commit();
      await r1.pull();
      await pm1.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      const pm2 = rt2.patternManager;
      const tx2 = rt2.edit();
      const resultCell2 = rt2.getCell<Record<string, unknown>>(
        space,
        "ct1665-resume",
        undefined,
        tx2,
      );
      rt2.prepareTxForCommit(tx2);
      await tx2.commit();
      await resultCell2.sync();
      await rt2.start(resultCell2);
      await resultCell2.pull();

      expect(pm2.getCompileCacheStats().byIdentityHits).toBeGreaterThan(0);
      const paths = recordedBindingPaths(rt2);
      expect(paths).toContainEqual(["setName"]);
      expect(paths).toContainEqual(["setAvatar"]);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
