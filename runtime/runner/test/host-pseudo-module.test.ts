import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { moduleToEncodableForm } from "../src/builder/to-encodable-form.ts";
import type { Module, toEncodableForm } from "../src/builder/types.ts";
import { resolvePolicyFacingImplementationIdentity } from "../src/cfc/implementation-identity.ts";
import { Runtime } from "../src/runtime.ts";

/**
 * Identity E5 (design §5, as decided): host-trusted values ride a minted
 * PSEUDO-MODULE instead of the deleted `unsafe-host:` legacy channel — each
 * `unsafeTrustHostValue` call mints a unique `host:<n>` identity and registers
 * the walked functions as its symbols in the engine's session-lifetime
 * implementation index. Serialization then emits a normal `$implRef` (body
 * omitted: the live closure is the value; a stringified round-trip would
 * sever it), and resolution flows through the SAME `$implRef` arm as every
 * verified module.
 *
 * Host trust never grants CFC identity: a host function has no provenance, so
 * policy-facing identity resolution fails closed (design §5 invariant).
 */

const signer = await Identity.fromPassphrase("host-pseudo-module");

describe("host-trusted values ride a pseudo-module", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const hostModule = (fn: (...args: unknown[]) => unknown): Module => {
    const module: Module & toEncodableForm = {
      type: "javascript",
      implementation: fn,
      toEncodableForm: () => moduleToEncodableForm(module),
    };
    return module;
  };

  it("a trusted host module serializes with a host $implRef and no body", () => {
    const base = 41;
    // Closure-bearing on purpose: a stringified round-trip would sever
    // `base`, so only by-identity resolution rehydrates this correctly.
    const module = hostModule((value) => (value as number) + base);
    runtime.unsafeTrustModule(module, { reason: "host pseudo-module test" });

    const encodable = (module as Module & toEncodableForm)
      .toEncodableForm() as {
        $implRef?: { identity: string; symbol: string };
        implementation?: unknown;
        implementationRef?: string;
      };
    expect(encodable.$implRef).toBeDefined();
    expect(encodable.$implRef!.identity).toMatch(/^host:/);
    expect("implementation" in encodable).toBe(false);

    // ...and the ref resolves to the LIVE function through the engine's
    // strong implementation index — the same arm every verified module uses.
    const resolved = runtime.harness.getVerifiedImplementation?.(
      encodable.$implRef!.identity,
      encodable.$implRef!.symbol,
    );
    expect(typeof resolved).toBe("function");
    expect((resolved as (v: unknown) => number)(1)).toBe(42);
  });

  it("two host functions with identical source get distinct refs", () => {
    // Closures with the same bytes are NOT interchangeable — uniqueness wins
    // over content-derivation for host identities.
    const make = (base: number) => (value: unknown) => (value as number) + base;
    const a = hostModule(make(1));
    const b = hostModule(make(2));
    runtime.unsafeTrustModule(a, { reason: "host pseudo-module test" });
    runtime.unsafeTrustModule(b, { reason: "host pseudo-module test" });

    const ja = (a as Module & toEncodableForm).toEncodableForm() as {
      $implRef: { identity: string; symbol: string };
    };
    const jb = (b as Module & toEncodableForm).toEncodableForm() as {
      $implRef: { identity: string; symbol: string };
    };
    expect(ja.$implRef).not.toEqual(jb.$implRef);
  });

  it("re-trusting the same value keeps its ref stable", () => {
    const module = hostModule((value) => value);
    runtime.unsafeTrustModule(module, { reason: "host pseudo-module test" });
    const first = (module as Module & toEncodableForm).toEncodableForm() as {
      $implRef: { identity: string; symbol: string };
    };
    expect(first.$implRef).toBeDefined();
    runtime.unsafeTrustModule(module, { reason: "host pseudo-module test" });
    const second = (module as Module & toEncodableForm).toEncodableForm() as {
      $implRef: { identity: string; symbol: string };
    };
    expect(first.$implRef).toEqual(second.$implRef);
  });

  it("a host ref from ANOTHER runtime is not trusted here (per-engine scoping)", async () => {
    // Host identities are session/registry-scoped: the entry-ref side table
    // is process-wide, but trust facts must not leak across runtimes in one
    // process (Codex/cubic P1 on the E5 PR). A module whose function was
    // host-trusted only in runtime A must NOT serialize body-less in runtime
    // B, and B must not execute the live closure directly.
    const otherStorage = StorageManager.emulate({ as: signer });
    const other = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: otherStorage,
    });
    try {
      const base = 41;
      const module = hostModule((value) => (value as number) + base);
      // Trusted in the OTHER runtime only.
      other.unsafeTrustModule(module, { reason: "host pseudo-module test" });

      // Serialize under THIS suite's primary runtime's frame: it never
      // granted host trust, so its engine cannot prove the ref and the
      // serialization must keep the stringified body and emit no host
      // $implRef.
      const frame = pushFrame({ runtime } as never);
      let encodable: { $implRef?: unknown; implementation?: unknown };
      try {
        encodable = (module as Module & toEncodableForm)
          .toEncodableForm() as typeof encodable;
      } finally {
        popFrame(frame);
      }
      expect(encodable.$implRef).toBeUndefined();
      expect(typeof encodable.implementation).toBe("string");
    } finally {
      await other.dispose();
      await otherStorage.close();
    }
  });

  it("host trust never yields a verified CFC identity (fail closed)", () => {
    const fn = (value: unknown) => value;
    const module = hostModule(fn);
    runtime.unsafeTrustModule(module, { reason: "host pseudo-module test" });

    const identity = resolvePolicyFacingImplementationIdentity(module, {
      implementation: fn as never,
    });
    expect(identity?.kind).not.toBe("verified");
  });
});
