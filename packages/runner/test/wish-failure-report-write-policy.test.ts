/**
 * What makes the report the subject here decidable at all is the document it
 * writes to. A resolved wish emits a `cf-cell-link` as its `[UI]`, whose
 * `$cell` prop is a link to the wished-for cell, so the stored label map
 * carries a link-origin entry under `[UI]`. A value write reaching a path
 * the stored label map reaches is refused unless something names the schema
 * it was authored against, and that refusal reads `missing schema
 * write-policy input`.
 *
 * The dials are the shell's (`packages/lib-shell/src/runtime.ts`), stated
 * rather than inherited because the refusal is the subject. The runner's own
 * flow-label default is `off`, and under `off` a transaction carrying only
 * raw value writes is never CFC-relevant, so the report commits without the
 * boundary looking at it.
 *
 * A wish-state document is addressed by a content-derived id, so a
 * throwaway runtime is what learns the address the cases then seed.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { defer } from "@commonfabric/utils/defer";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { resolveLink } from "../src/link-resolution.ts";
import { type JSONSchema, UI } from "../src/builder/types.ts";
import type { IStorageTransaction } from "../src/storage/interface.ts";
import { StateInconsistency } from "../src/storage/transaction/attestation.ts";

const signer = await Identity.fromPassphrase(
  "wish failure report write policy",
);
const space = signer.did();

/** The requested wish view: one labeled field, as the profile consumer view. */
const profileViewSchema: JSONSchema = {
  type: "object",
  properties: {
    name: { type: "string", ifc: { confidentiality: ["secret"] } },
  },
} as JSONSchema;

const altProfileViewSchema: JSONSchema = {
  type: "string",
  ifc: { confidentiality: ["other"] },
} as JSONSchema;

/**
 * The stored envelope that refuses the wish's own state commit: TWO
 * ifc-carrying branches under `/result` is the ambiguity
 * `assertNoDivergentIfcBranches` refuses when a later writer's candidate
 * merges with it.
 *
 * The two variants are the two shapes a wish-state document is found in. The
 * first declares the report's own fields, as the real wish-state schema
 * does, and holds the `cf-cell-link` a resolved wish emits — so its stored
 * label map reaches `[UI]` and the report needs a name for what it writes.
 * The second says nothing about those fields, so the label map does not
 * reach them and the report needs no name; it is there because a report that
 * needs no name must not be refused for offering one.
 */
const ambiguousWishShapedSchema: JSONSchema = {
  type: "object",
  properties: {
    result: { anyOf: [profileViewSchema, altProfileViewSchema] },
    candidates: { type: "array", items: profileViewSchema },
    error: true,
    [UI]: true,
  },
} as JSONSchema;

const ambiguousSchemaSilentAboutTheReport: JSONSchema = {
  type: "object",
  properties: {
    result: { anyOf: [profileViewSchema, altProfileViewSchema] },
    candidates: { type: "array", items: profileViewSchema },
  },
} as JSONSchema;

describe("wish commit-failure reporting", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  const makeRuntime = () => {
    const manager = StorageManager.emulate({ as: signer });
    return {
      manager,
      runtime: new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: manager,
        // The two rungs every case here reads: `persist` is what makes a
        // transaction of raw value writes CFC-relevant, and
        // `enforce-explicit` is what turns a prepare reason into a refused
        // commit.
        cfcFlowLabels: "persist",
        cfcEnforcementMode: "enforce-explicit",
      }),
    };
  };

  beforeEach(() => {
    const made = makeRuntime();
    storageManager = made.manager;
    runtime = made.runtime;
  });

  afterEach(async () => {
    await runtime.idle();
    await runtime.dispose();
  });

  /** Point the space cell's `/secret` at a document carrying a labeled name. */
  const seedWishTarget = async (rt: Runtime, name: string) => {
    const spaceCell = rt.getCell<{ secret?: unknown }>(space, space);
    await spaceCell.pull();
    const tx = rt.edit();
    const target = rt.getCell(space, "wish-target", profileViewSchema, tx);
    target.set({ name });
    spaceCell.withTx(tx).key("secret").set(target.withTx(tx));
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await rt.idle();
  };

  /** Run the wish and hand back the document its state lives in. */
  const runWish = async (rt: Runtime) => {
    const { commonfabric } = createTrustedBuilder(rt);
    const { wish, pattern } = commonfabric;
    const tx = rt.edit();
    const wishPattern = pattern(() => ({
      secretWish: wish({
        query: "/secret",
        schema: profileViewSchema as Record<string, unknown>,
      }),
    }));
    const resultCell = rt.getCell<{ secretWish?: unknown }>(
      space,
      "wish failure report result",
      undefined,
      tx,
    );
    const result = rt.run(tx, wishPattern, {}, resultCell);
    rt.prepareTxForCommit(tx);
    await tx.commit().settled;
    await result.pull().catch(() => {});
    await rt.idle();
    const readTx = rt.edit();
    const resolved = resolveLink(
      rt,
      readTx,
      result.key("secretWish").getAsNormalizedFullLink(),
    );
    readTx.abort();
    return { id: resolved.id, scope: resolved.scope };
  };

  /** The paths the document's stored label map carries entries at. */
  const storedLabelPaths = (
    rt: Runtime,
    doc: { id: string; scope: string | undefined },
  ): string[][] => {
    const tx = rt.edit();
    const stored = tx.read({
      space,
      id: doc.id,
      scope: doc.scope,
      type: "application/json",
      path: ["cfc"],
    } as never);
    tx.abort();
    const entries =
      (stored.ok?.value as { labelMap?: { entries?: { path: string[] }[] } })
        ?.labelMap?.entries ?? [];
    return entries.map((entry) => entry.path);
  };

  const stateCellAt = (
    rt: Runtime,
    doc: { id: string; scope: string | undefined },
  ) =>
    rt.getCellFromLink(
      { id: doc.id, space, scope: doc.scope, path: [] } as never,
      undefined,
      undefined,
    );

  it("persists a link-origin label entry under `[UI]` when a wish resolves", async () => {
    await seedWishTarget(runtime, "classified");
    const doc = await runWish(runtime);

    expect(
      storedLabelPaths(runtime, doc).some((path) => path[0] === UI),
    ).toBe(true);
  });

  /**
   * Seed the state document with an envelope the wish's own candidate cannot
   * merge with, run the wish against it, and hand back what the document
   * reads once the refusal has been reported.
   */
  const refusedWishReport = async (
    seedSchema: JSONSchema,
    withUILink: boolean,
  ) => {
    // Learn the state document's address: it is derived from the space, the
    // pattern and the result cell, so a throwaway runtime names the same one.
    const discovery = makeRuntime();
    let doc: { id: string; scope: string | undefined };
    try {
      await seedWishTarget(discovery.runtime, "classified");
      doc = await runWish(discovery.runtime);
    } finally {
      await discovery.runtime.idle();
      await discovery.runtime.dispose();
    }

    await seedWishTarget(runtime, "classified");
    {
      const tx = runtime.edit();
      const linked = runtime.getCell(
        space,
        "wish-ui-link-source",
        profileViewSchema,
        tx,
      );
      linked.set({ name: "classified" });
      const state = runtime.getCellFromLink(
        { id: doc.id, space, scope: doc.scope, path: [] } as never,
        seedSchema,
        tx,
      );
      state.set({
        result: { name: "Bob" },
        candidates: [{ name: "Bob" }],
        ...(withUILink
          ? {
            [UI]: {
              type: "vnode",
              name: "cf-cell-link",
              props: { $cell: linked.withTx(tx) },
              children: [],
            },
          }
          : {}),
      });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
    }

    // The report ends one of two ways, and each announces itself: the
    // document gains an `error`, or the surfacing gives up and prints
    // "Can't report …". Waiting on both is what makes the failing run say
    // which happened instead of never returning. Neither wait has a timer
    // under it — the surfacing chain is deliberately untracked by the
    // scheduler, so `idle()` can return a beat before the report lands.
    const settled = defer<void>();
    const reports: string[] = [];
    const realConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      // Render the reason a commit rejection carries: it arrives as a plain
      // record rather than an Error, and `String()` on it says nothing.
      const line = args.map((arg) =>
        isObjectOrArray(arg) && "message" in arg
          ? String((arg as { message: unknown }).message)
          : String(arg)
      ).join(" ");
      reports.push(line);
      if (line.includes("Can't report")) settled.resolve();
    };
    const state = stateCellAt(runtime, doc);
    const readState = () =>
      state.get() as {
        error?: unknown;
        result?: unknown;
        candidates?: unknown;
        [key: string]: unknown;
      } | undefined;
    const cancel = state.sink(() => {
      if (readState()?.error !== undefined) settled.resolve();
    });
    try {
      await runWish(runtime);
      await settled.promise;
      await runtime.idle();
      return { doc, reports, value: readState() ?? {} };
    } finally {
      cancel();
      console.error = realConsoleError;
    }
  };

  it("lands a refusal on the state document rather than only on the console", async () => {
    const { doc, reports, value } = await refusedWishReport(
      ambiguousWishShapedSchema,
      true,
    );
    // First, because it names what went wrong when it goes wrong: the
    // console fallback is where the reason goes when the report is refused.
    expect(reports.filter((line) => line.includes("Can't report"))).toEqual([]);
    expect(String(value.error)).toMatch(/divergent anyOf|commit-prep/);
    expect(value[UI]).toBeDefined();
    // The report carries the refusal and nothing else. The wish resolved
    // "classified" and its write of that was refused; the document still
    // reads what stood there before, so no part of the refused write rode
    // outward inside the account of its refusal.
    expect(value.result).toEqual({ name: "Bob" });
    expect(value.candidates).toEqual([{ name: "Bob" }]);
    // Nor did the report launder the document's labels. It replaces the
    // `[UI]` subtree, so the entries describing the link that used to sit
    // there go with the value they described; every entry at a path the
    // report does not write stands.
    const labelled = storedLabelPaths(runtime, doc);
    expect(labelled).toContainEqual(["result", "name"]);
    expect(labelled).toContainEqual(["candidates", "0"]);
    expect(labelled.filter((path) => path[0] === UI)).toEqual([]);
  });

  it("lands a refusal on a document whose stored envelope says nothing about the report's own fields", async () => {
    // The report names a schema for the fields it writes. That name must not
    // drag the write into a merge with the stored envelope, because the merge
    // reads that envelope — and the envelope refusing the wish is exactly the
    // one a report follows.
    const { reports, value } = await refusedWishReport(
      ambiguousSchemaSilentAboutTheReport,
      false,
    );
    expect(reports.filter((line) => line.includes("Can't report"))).toEqual([]);
    expect(String(value.error)).toMatch(/divergent anyOf|commit-prep/);
    expect(value[UI]).toBeDefined();
    expect(value.result).toEqual({ name: "Bob" });
  });

  it("retries a transient refusal of the error report and preserves the refused result", async () => {
    const replica = storageManager.open(space).replica;
    const commitNative = replica.commitNative!;
    const stampServerRun = runtime.stampServerRun;
    const reportTransactions = new WeakSet<IStorageTransaction>();
    let attempts = 0;
    let refusals = 0;
    runtime.stampServerRun = (tx, info) => {
      stampServerRun.call(runtime, tx, info);
      if (info.actionId.startsWith("wish/commit-failure-ui/")) {
        reportTransactions.add(tx.tx);
      }
    };
    replica.commitNative = (native, source, options) => {
      if (source && reportTransactions.has(source)) {
        attempts++;
        if (refusals === 0) {
          refusals++;
          // Refuse the first report at the storage boundary. Its fresh
          // transaction must retry even when no real writer races this test.
          return Promise.resolve({
            error: StateInconsistency({
              address: {
                id: "of:wish-report",
                type: "application/json",
                path: [],
              },
            }),
          });
        }
      }
      return commitNative.call(replica, native, source, options);
    };
    try {
      const { reports, value } = await refusedWishReport(
        ambiguousWishShapedSchema,
        true,
      );
      expect(refusals).toBe(1);
      expect(attempts).toBe(2);
      expect(reports.filter((line) => line.includes("Can't report"))).toEqual(
        [],
      );
      expect(String(value.error)).toMatch(/divergent anyOf|commit-prep/);
      expect(value[UI]).toBeDefined();
      expect(value.result).toEqual({ name: "Bob" });
      expect(value.candidates).toEqual([{ name: "Bob" }]);
    } finally {
      replica.commitNative = commitNative;
      runtime.stampServerRun = stampServerRun;
    }
  });
});
