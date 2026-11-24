// Stage E (scopes.md §7 M2) — instance re-keying contract tests.
//
// Three properties, per docs/specs/server-side-execution/key-vocabulary.md:
//
// 1. PARTITION EQUIVALENCE AT CARDINALITY 1 (§2, the OFF-arm-neutrality
//    argument, and the plan's stage-E success criterion): with ONE fixed
//    identity — the runtime's own authenticated session — the re-keyed
//    form partitions addresses into exactly the equivalence classes the
//    scope-NAME form did. No two distinct things merge; no two merged
//    things separate.
// 2. STORAGE ALIGNMENT (§1 site 1's rationale): the client-side instance
//    keys embed exactly the scope_key the engine keys storage rows with
//    for the same authenticated session — dirtiness can match storage's
//    exact-scope_key reader matching.
// 3. FAN-OUT READINESS (M2's point): two IDENTITIES' instances of one
//    scoped address are DISTINCT keys — the collapse that made scope-NAME
//    keys unsound on a serving runtime is structurally gone.
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type CellScope,
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import { entityKey } from "../src/scheduler/keys.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/v2.ts";
import type { MemorySpace, URI } from "../src/storage/interface.ts";

const space = "did:test:space" as MemorySpace;
const alice: ScopeKeyIdentity = {
  principal: "did:key:z6MkAlice",
  sessionId: "session-a",
};
const bob: ScopeKeyIdentity = {
  principal: "did:key:z6MkBob",
  sessionId: "session-b",
};

const address = (id: string, scope?: CellScope) => ({
  space,
  id: id as URI,
  ...(scope === undefined ? {} : { scope }),
});

describe("stage E instance re-keying", () => {
  it("partitions exactly as the scope-NAME form at cardinality 1", () => {
    // Every (scope, id) pair a single runtime can address:
    const addresses = [
      address("of:doc1"),
      address("of:doc1", "space"),
      address("of:doc1", "user"),
      address("of:doc1", "session"),
      address("of:doc2"),
      address("of:doc2", "user"),
      address("of:doc2", "session"),
    ];
    const nameKey = (
      a: { space: MemorySpace; id: URI; scope?: CellScope },
    ) => `${a.space}/${a.scope ?? "space"}/${a.id}`;

    // Same-partition iff same name-key — pairwise, both directions.
    for (const a of addresses) {
      for (const b of addresses) {
        expect(entityKey(a, alice) === entityKey(b, alice)).toBe(
          nameKey(a) === nameKey(b),
        );
      }
    }
  });

  it("keys are stable across calls for one identity", () => {
    const a = address("of:doc1", "session");
    expect(entityKey(a, alice)).toBe(entityKey(a, alice));
  });

  it("embeds exactly the engine's storage-row scope_key for the same session", () => {
    // The engine derives (principal, sessionId) from the authenticated
    // session at admission and keys rows via the SAME shared constructor
    // the runner sites build in-memory keys with. Equal inputs ⇒ equal
    // keys, by construction — pinned here so a future divergence (a
    // second construction path on either side) fails a test.
    for (const scope of ["space", "user", "session"] as const) {
      const rowKey = resolveScopeKey(scope, alice);
      expect(entityKey(address("of:doc1", scope), alice)).toBe(
        `${space}/${rowKey}/of:doc1`,
      );
    }
  });

  it("two principals' instances of one scoped address are distinct keys (fan-out readiness)", () => {
    for (const scope of ["user", "session"] as const) {
      const a = entityKey(address("of:doc1", scope), alice);
      const b = entityKey(address("of:doc1", scope), bob);
      expect(a).not.toBe(b);
    }
    // The shared space instance stays shared.
    expect(entityKey(address("of:doc1", "space"), alice)).toBe(
      entityKey(address("of:doc1", "space"), bob),
    );
  });

  it("StorageManager.scopeKeyIdentity is the manager's own authenticated session", async () => {
    const signer = await Identity.fromPassphrase("stage-e rekeying test");
    const manager = StorageManager.open({
      as: signer,
      memoryHost: new URL("http://localhost:9999"),
    });
    const identity = manager.scopeKeyIdentity();
    expect(identity.principal).toBe(signer.did());
    expect(identity.sessionId).toBe(manager.id);
    // Stable within the manager's live span.
    expect(manager.scopeKeyIdentity()).toEqual(identity);
  });
});
