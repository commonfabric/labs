import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Context } from "@lit/context";
import type { RuntimeClient } from "@commonfabric/runtime-client";
import type { DID } from "@commonfabric/identity";
import { runtimeContext, spaceContext } from "./runtime-context.ts";

describe("host embedding contract: runtime/space contexts", () => {
  // Host-embedding contract seam 2 (docs/features/host-embedding.md §2):
  // `runtimeContext` and `spaceContext` are the contexts a host provides. A host
  // and the mounted components must agree on the context *identity* — with
  // `@lit/context`, `createContext(key)` returns the string key itself, so the
  // key string is the wire identity of the seam. A rename, or a merge into a
  // different context, silently breaks every embedder's provide/consume wiring.
  // These assertions go red when that identity changes.

  it("runtimeContext is keyed 'runtime'", () => {
    expect(runtimeContext).toBe("runtime");
  });

  it("spaceContext is keyed 'space'", () => {
    expect(spaceContext).toBe("space");
  });

  it("the two contexts are distinct", () => {
    expect(runtimeContext).not.toBe(spaceContext);
  });

  it("carries the host-providable value types (compile-time contract)", () => {
    // Type-level assertion: the value types are what a host provides. If the
    // published value types drift (e.g. RuntimeClient -> some shell-internal
    // type), this stops compiling and the seam test fails at type-check time.
    const _runtime: typeof runtimeContext extends
      Context<unknown, RuntimeClient | undefined> ? true
      : never = true;
    const _space: typeof spaceContext extends Context<unknown, DID | undefined>
      ? true
      : never = true;
    expect(_runtime).toBe(true);
    expect(_space).toBe(true);
  });
});
