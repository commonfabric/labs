import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { isStream, type JSONSchema, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  projectWishValue,
  readWish,
  resolveWish,
  WISH_STREAM_MARKER,
} from "../lib/wish.ts";
import { safeStringify } from "../lib/render.ts";

// Exercises the headless wish read core (`resolveWish`) against an emulated
// runtime — no live server. The full `readWish` (which adds a session-backed
// `loadPieces`) is covered by the integration lane. These tests assert that the
// blessed read resolves through the SAME builtin resolution the runtime uses:
// a profile object, a profile scalar, and the zero-profile error path.

const userIdentity = await Identity.fromPassphrase("cf-wish-test-user");

describe("cf wish headless read (resolveWish)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: userIdentity });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  // Seed a single profile (in its own space) into the user's home
  // `defaultPattern.profiles` list, mirroring the multi-profile home model.
  async function seedProfile(): Promise<void> {
    const profileSpaceDid =
      (await Identity.fromPassphrase("cf-wish-test-profile-space")).did();

    // A transaction has a single writer space, so seed the profile's own space
    // and the home space in separate committed transactions.
    let tx = runtime.edit();
    const profileSpaceCell = runtime.getSpaceCell(
      profileSpaceDid,
      undefined,
      tx,
    );
    const profileDefaultCell = runtime.getCell(
      profileSpaceDid,
      "profile-default",
      undefined,
      tx,
    );
    profileDefaultCell.set({
      name: "Ada Lovelace",
      initialNameApplied: "Ada Lovelace",
      avatar: "ada.png",
      bio: "Mathematician & first programmer.",
      elements: [],
    });
    profileSpaceCell.key("defaultPattern").set(profileDefaultCell);
    await tx.commit();
    await runtime.idle();

    tx = runtime.edit();
    const homeSpaceCell = runtime.getHomeSpaceCell(tx);
    const homeDefaultCell = runtime.getCell(
      userIdentity.did(),
      "home-default-profile-link",
      undefined,
      tx,
    );
    homeDefaultCell.key("profiles").set([
      runtime.getCell(profileSpaceDid, "profile-default", undefined, tx),
    ]);
    // deno-lint-ignore no-explicit-any
    (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);
    await tx.commit();
    await runtime.idle();
  }

  it("resolves #profile to the default profile object", async () => {
    await seedProfile();
    const { result, error } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profile",
    });
    expect(error).toBeUndefined();
    expect((result as { name?: string })?.name).toBe("Ada Lovelace");
    expect((result as { bio?: string })?.bio).toBe(
      "Mathematician & first programmer.",
    );
  });

  it("resolves the #profileName scalar target", async () => {
    await seedProfile();
    const { result, error } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profileName",
    });
    expect(error).toBeUndefined();
    expect(result).toBe("Ada Lovelace");
  });

  it("returns a clear error and null result when no profile exists", async () => {
    const { result, error } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profile",
    });
    expect(result).toBeNull();
    expect(error).toBe("No profile exists yet");
  });

  it("surfaces a permanent authorization denial for the wish's space", async () => {
    const denial = Object.assign(
      new Error("Principal lacks READ on space"),
      { name: "AuthorizationError" },
    );
    // The storage layer keeps synced() quiet on a denial and records it per
    // space; resolveWish reads that status for its own space after syncing and
    // rethrows the real error instead of returning an empty "no profile" result.
    (storageManager as unknown as {
      authorizationError: () => Error | undefined;
    }).authorizationError = () => denial;

    let thrown: unknown;
    try {
      await resolveWish(runtime, userIdentity.did(), { query: "#profile" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(denial);
    expect((thrown as Error).name).toBe("AuthorizationError");
  });

  it("leaves no run registered once it has answered", async () => {
    await seedProfile();
    const { result } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profileName",
    });
    expect(result).toBe("Ada Lovelace");
    expect(runtime.runner.cancels.size).toBe(0);
  });

  it("throws and leaves no run registered when its setup commit is refused", async () => {
    // The setup transaction is aborted as its commit begins, so the commit
    // settles with an error through the ordinary path, commit callbacks and
    // all.
    const edit = runtime.edit.bind(runtime);
    using _edit = stub(runtime, "edit", () => {
      const tx = edit();
      const commit = tx.commit.bind(tx);
      tx.commit = () => {
        tx.abort("refused by the test");
        return commit();
      };
      return tx;
    });

    await expect(
      resolveWish(runtime, userIdentity.did(), { query: "#profileName" }),
    ).rejects.toThrow('Cannot set up the headless read of "#profileName": ');
    expect(runtime.runner.cancels.size).toBe(0);
  });

  it("appends extra path segments to the resolved target", async () => {
    await seedProfile();
    const { result, error } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profile",
      path: ["bio"],
    });
    expect(error).toBeUndefined();
    expect(result).toBe("Mathematician & first programmer.");
  });

  it("projects the result through a provided schema", async () => {
    await seedProfile();
    const { result, error } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profile",
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    });
    expect(error).toBeUndefined();
    expect((result as { name?: string })?.name).toBe("Ada Lovelace");
  });

  it("projectWishValue strips stream handles but keeps profile data (CT-1844)", () => {
    // Build a profile-shaped result carrying a REAL stream handle alongside its
    // data fields, exactly as a materialized #profile object does.
    const tx = runtime.edit();
    const cell = runtime.getCell<{
      name: string;
      avatar: string;
      bio: string;
      isEditing: boolean;
      elements: { title: string }[];
      $UI: { type: string; name: string };
    }>(userIdentity.did(), "ct1844-projection-fixture", undefined, tx);
    // Nothing is stored where `setName` stands; the schema declares it.
    cell.set({
      name: "Ada Lovelace",
      avatar: "ada.png",
      bio: "Mathematician & first programmer.",
      isEditing: false,
      elements: [{ title: "Note" }],
      $UI: { type: "vnode", name: "cf-screen" },
    });
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        avatar: { type: "string" },
        bio: { type: "string" },
        isEditing: { type: "boolean" },
        elements: { type: "array" },
        $UI: { type: "object" },
        setName: { type: "object", asCell: ["stream"] },
      },
    } as const satisfies JSONSchema;
    const value = cell.asSchema(schema).get();
    // Sanity: the raw value really does carry a live stream handle.
    expect(isStream(value.setName)).toBe(true);

    const projected = projectWishValue(value) as Record<string, unknown>;

    // Data fields survive, including the nested `elements` array and $UI VNode.
    expect(projected.name).toBe("Ada Lovelace");
    expect(projected.avatar).toBe("ada.png");
    expect(projected.bio).toBe("Mathematician & first programmer.");
    expect(projected.isEditing).toBe(false);
    expect(projected.elements).toEqual([{ title: "Note" }]);
    expect(projected.$UI).toEqual({ type: "vnode", name: "cf-screen" });

    // The stream handle is replaced by a key-tagged marker — no runtime graph.
    expect(projected.setName).toBe("[stream:setName]");

    // The serialized output stays small and free of the runtime object graph.
    const json = safeStringify(projected);
    expect(json.length).toBeLessThan(2000);
    expect(json).not.toContain("scheduler");
    expect(json).not.toContain("circular reference");
    expect(json).not.toContain("runtime");
  });

  it("strips handles nested in a shared DAG subtree on BOTH paths (CT-1844)", () => {
    // A "diamond": one plain object referenced by two keys of the result, with a
    // real stream handle nested inside it. A naive already-seen-return-raw dedup
    // would project the shared subtree on the first path but return it RAW on
    // the second — leaking the handle. The memo must project it on both.
    const tx = runtime.edit();
    const cell = runtime.getCell<{ shared: { label: string } }>(
      userIdentity.did(),
      "ct1844-diamond-fixture",
      undefined,
      tx,
    );
    cell.set({ shared: { label: "shared" } });
    const schema = {
      type: "object",
      properties: {
        shared: {
          type: "object",
          properties: {
            label: { type: "string" },
            setName: { type: "object", asCell: ["stream"] },
          },
        },
      },
    } as const satisfies JSONSchema;
    const shared = cell.asSchema(schema).get().shared;
    if (!shared) throw new Error("fixture: shared subtree missing");
    expect(isStream(shared.setName)).toBe(true);

    // Alias the SAME object under two keys — this is the diamond.
    const value = { left: shared, right: shared };
    const projected = projectWishValue(value) as {
      left: Record<string, unknown>;
      right: Record<string, unknown>;
    };

    // Data survives on both branches...
    expect(projected.left.label).toBe("shared");
    expect(projected.right.label).toBe("shared");
    // ...and the nested handle is stripped on BOTH (would leak on `right` under
    // a raw already-seen dedup).
    expect(projected.left.setName).toBe("[stream:setName]");
    expect(projected.right.setName).toBe("[stream:setName]");

    const json = safeStringify(projected);
    expect(json).toBe(`{
  "left": {
    "label": "shared",
    "setName": "[stream:setName]"
  },
  "right": "<circular reference>"
}`);
    expect(json).not.toContain("scheduler");
    expect(json).not.toContain("runtime");
  });

  it("terminates on a genuine cycle without infinite recursion (CT-1844)", () => {
    // A self-referential plain object (a real cycle, not a diamond) must not
    // recurse forever; the in-progress sentinel breaks it with a marker.
    const node: Record<string, unknown> = { name: "loop" };
    node.self = node;

    const projected = projectWishValue(node) as Record<string, unknown>;
    expect(projected.name).toBe("loop");
    expect(projected.self).toBe("[circular]");
    // Serializes cleanly (no throw, no runaway).
    expect(safeStringify(projected)).toContain("[circular]");
  });

  it("projectWishValue passes scalar targets through unchanged (CT-1844)", () => {
    // #profileName and friends resolve to a bare scalar — untouched.
    expect(projectWishValue("Ada Lovelace")).toBe("Ada Lovelace");
    expect(projectWishValue(42)).toBe(42);
    expect(projectWishValue(true)).toBe(true);
    expect(projectWishValue(null)).toBe(null);
    // A handle with no owning key falls back to the untagged base marker.
    expect(projectWishValue(() => {})).toBe(WISH_STREAM_MARKER);
  });

  it("readWish connects through the injected manager and resolves", async () => {
    await seedProfile();
    const seen: string[] = [];
    const { result, error } = await readWish(
      {
        apiUrl: "http://127.0.0.1:8000",
        space: "ignored-by-fake",
        identity: "/nonexistent.key",
        query: "#profileName",
      },
      {
        loadPieces: (config) => {
          seen.push(config.apiUrl, config.space);
          return Promise.resolve({
            runtime,
            getSpace: () => userIdentity.did(),
          });
        },
      },
    );
    expect(error).toBeUndefined();
    expect(result).toBe("Ada Lovelace");
    // The wrapper passes the connection config through to the dep.
    expect(seen).toEqual(["http://127.0.0.1:8000", "ignored-by-fake"]);
  });
});
