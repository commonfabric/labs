import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("conflict readiness fallback");
const space = signer.did();

describe("runtime-conflict-readiness", () => {
  let storage: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    storage = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  it("pulls the scoped singular descriptor when every array entry is unusable", async () => {
    using sync = stub(
      storage.open(space),
      "sync",
      () => Promise.resolve({ ok: {} }),
    );
    await runtime.awaitCommitRetryReadiness({
      conflicts: [
        { of: "of:missing-space" },
        { space },
        { space, of: "of:unknown" },
      ],
      conflict: { space, of: "of:fallback", scope: "user" },
    });
    expect(sync.calls.map(({ args }) => args)).toEqual([
      ["of:fallback", { path: [], schema: false }, "user"],
    ]);
  });

  it("uses valid array entries without pulling the singular fallback", async () => {
    using sync = stub(
      storage.open(space),
      "sync",
      () => Promise.resolve({ ok: {} }),
    );
    await runtime.awaitCommitRetryReadiness({
      conflicts: [
        null,
        undefined,
        { space, of: "of:invalid-scope", scope: "invalid" },
        { space, of: "of:shared", scope: "space" },
        { space, of: "of:shared" },
        { space, of: "of:shared", scope: "session" },
      ],
      conflict: { space, of: "of:fallback", scope: "user" },
    });
    expect(sync.calls.map(({ args }) => args)).toEqual([
      ["of:shared", { path: [], schema: false }, "space"],
      ["of:shared", { path: [], schema: false }, "session"],
    ]);
  });

  it("resolves without a pull when neither conflict representation is usable", async () => {
    using sync = stub(
      storage.open(space),
      "sync",
      () => Promise.resolve({ ok: {} }),
    );
    await runtime.awaitCommitRetryReadiness({
      conflicts: [{ of: "of:missing-space" }],
      conflict: { space, of: "of:unknown" },
    });
    await runtime.awaitCommitRetryReadiness(undefined);
    expect(sync.calls).toHaveLength(0);
  });

  it("continues other recovery pulls when one throws synchronously", async () => {
    using sync = stub(storage.open(space), "sync", (of) => {
      if (of === "of:failed") throw new Error("provider unavailable");
      return Promise.resolve({ ok: {} });
    });
    await runtime.awaitCommitRetryReadiness({
      conflicts: [
        { space, of: "of:failed", scope: "user" },
        { space, of: "of:other", scope: "session" },
      ],
    });
    expect(sync.calls.map(({ args }) => args[0])).toEqual([
      "of:failed",
      "of:other",
    ]);
  });

  it("returns the pulls that failed, each with its reason", async () => {
    const thrown = new Error("provider unavailable");
    const refused = new Error("the load was refused");
    const rejected = new Error("the connection dropped");
    using _sync = stub(storage.open(space), "sync", (of) => {
      if (of === "of:thrown") throw thrown;
      if (of === "of:refused") return Promise.resolve({ error: refused });
      if (of === "of:rejected") return Promise.reject(rejected);
      return Promise.resolve({ ok: {} });
    });
    const failures = await runtime.awaitCommitRetryReadiness({
      conflicts: [
        { space, of: "of:thrown" },
        { space, of: "of:refused", scope: "user" },
        { space, of: "of:rejected" },
        { space, of: "of:loaded" },
      ],
    });
    expect(failures).toEqual(expect.arrayContaining([
      { space, id: "of:thrown", scope: undefined, error: thrown },
      { space, id: "of:refused", scope: "user", error: refused },
      { space, id: "of:rejected", scope: undefined, error: rejected },
    ]));
    expect(failures).toHaveLength(3);
  });

  it("pulls a policy manifest with the documents its rules live in", async () => {
    using sync = stub(
      storage.open(space),
      "sync",
      () => Promise.resolve({ ok: {} }),
    );
    const manifest = "of:cfc-policy-manifest:digest";
    await runtime.awaitCommitRetryReadiness({
      conflicts: [{ space, of: manifest }],
    });
    expect(sync.calls.map(({ args }) => args)).toEqual([
      [
        manifest,
        {
          path: [],
          schema: { type: "object", additionalProperties: true },
        },
        undefined,
      ],
    ]);
  });
});
