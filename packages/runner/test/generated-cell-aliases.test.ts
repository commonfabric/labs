/**
 * Reopens persisted state in a second runtime that first loads the same
 * artifact through a re-exporting module, then invokes its stored handler.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";

import type { JSONSchema } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";

const source = `
  import { handler, pattern, Writable } from "commonfabric";
  const changeSlot = handler<{}, { slot: Writable<string> }>(
    (_, { slot }) => slot.set("handler-updated"),
  );
  export default pattern<Record<string, never>>(() => {
    const slots = [0].map(() => new Writable("initial"));
    const change = changeSlot({ slot: slots[0] });
    return { slots, change };
  });
`;

const standalone: RuntimeProgram = {
  main: "/dep.tsx",
  files: [{ name: "/dep.tsx", contents: source }],
};

const reexporting: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: 'export { default } from "./dep.tsx";',
    },
    { name: "/dep.tsx", contents: source },
  ],
};

const viewSchema: JSONSchema = {
  type: "object",
  properties: {
    slots: { type: "array", items: { type: "string" } },
    change: { asCell: ["stream"] },
  },
};

/** The public projection observed independently of either artifact's graph. */
type View = {
  /** User-managed state in an anonymous internal cell. */
  slots: string[];

  /** Event whose closure writes the anonymous cell. */
  change: Record<string, never>;
};

/** Runs a persisted piece after preloading a re-export of its accepted artifact. */
async function exerciseReexport(
  markerlessLegacy: boolean,
  followup?: "rerun" | "transition" | "scoped",
): Promise<void> {
  const signer = await Identity.fromPassphrase("review-generated-alias");
  const space = signer.did();
  const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
  const holder = executionLeaseHolder(signer.did());
  const createRuntime = (serving = false) =>
    new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: EmulatedStorageManager.connectTo(server, {
        as: signer,
        ...(serving ? { id: holder } : {}),
      }),
      ...(serving
        ? { servingPosture: true, experimental: { serverExecution: true } }
        : {}),
    });
  const writer = createRuntime();
  const reader = createRuntime(followup === "scoped");
  let lease: ExecutionLeaseCycle | undefined;
  let cancelDemand: (() => void) | undefined;
  try {
    if (followup === "scoped") {
      const engine = await server.engineForSpace(space);
      lease = new ExecutionLeaseCycle({ engine, space, holder });
      expect(lease.acquire()).toBe(true);
    }
    const artifact = await writer.patternManager.compilePattern(standalone, {
      space,
    });
    const accepted = writer.patternManager.getArtifactEntryRef(artifact);
    expect(accepted).toBeDefined();
    if (accepted === undefined) throw new Error("Expected an artifact ref");
    const piece = writer.getCell(
      space,
      "review-generated-alias-piece",
      undefined,
      undefined,
      followup === "scoped" ? "user" : "space",
    );
    if (markerlessLegacy) {
      const seed = writer.edit();
      piece.withTx(seed).setMetaRaw(
        "patternIdentity",
        accepted,
        rawMetaWriteAuthorization,
      );
      await writer.setup(seed, artifact, {}, piece);
      expect((await seed.commit()).error).toBeUndefined();
    } else {
      await writer.setup(undefined, artifact, {}, piece);
    }
    const original = piece.asSchema<View>(viewSchema);
    const slot = original.key("slots").key(0).resolveAsCell();
    expect(
      (await writer.editWithRetry((tx) => {
        slot.withTx(tx).set("sentinel");
        if (markerlessLegacy) {
          piece.withTx(tx).setMetaRaw(
            "generatedCellIdentity",
            undefined,
            rawMetaWriteAuthorization,
          );
          piece.withTx(tx).setMetaRaw(
            "patternSetupIdentity",
            undefined,
            rawMetaWriteAuthorization,
          );
        }
      })).error,
    ).toBeUndefined();
    expect(original.get().slots).toEqual(["sentinel"]);
    await writer.patternManager.flushCompileCacheWrites();
    await writer.storageManager.synced();

    const reexport = await reader.patternManager.compilePattern(reexporting, {
      space,
    });
    const loaded = await reader.patternManager.loadPatternByIdentity(
      accepted.identity,
      accepted.symbol,
      space,
    );
    expect(loaded).toBeDefined();
    if (loaded === undefined) throw new Error("Expected the accepted artifact");
    // Both refs resolve to the same executable artifact. Which ref was indexed
    // first in this runtime must not change the persisted piece's addresses.
    expect(reader.patternManager.getArtifactEntryRef(loaded)).toEqual(
      reader.patternManager.getArtifactEntryRef(reexport),
    );
    expect(reader.patternManager.getArtifactEntryRef(loaded)).not.toEqual(
      accepted,
    );

    const reopened = reader.getCellFromLink(piece.getAsNormalizedFullLink());
    await reopened.sync();
    expect(await reader.start(reopened)).toBe(true);
    const visible = reopened.asSchema<View>(viewSchema);
    if (followup === "scoped") cancelDemand = visible.sink(() => {});
    expect((await visible.pull()).slots).toEqual(["sentinel"]);
    visible.key("change").send({});
    await reader.idle();
    expect((await visible.pull()).slots).toEqual(["handler-updated"]);
    expect(reopened.getMetaRaw("patternIdentity")).toEqual(accepted);

    const acceptedSlot = visible.key("slots").key(0).resolveAsCell();
    const acceptedSlotLink = acceptedSlot.getAsNormalizedFullLink();
    expect(acceptedSlotLink.id).toBe(slot.getAsNormalizedFullLink().id);

    if (followup === "rerun") {
      for (const operation of ["setup", "run"] as const) {
        expect(
          (await reader.editWithRetry((tx) => {
            acceptedSlot.withTx(tx).set(`${operation}-sentinel`);
          })).error,
        ).toBeUndefined();
        reader.runner.stop(reopened);
        if (operation === "setup") {
          await reader.setup(undefined, undefined, {}, reopened);
          expect(await reader.start(reopened)).toBe(true);
        } else {
          reader.run(undefined, undefined, {}, reopened);
        }
        await reader.idle();
        expect((await visible.pull()).slots).toEqual([`${operation}-sentinel`]);
        expect(reopened.getMetaRaw("patternIdentity")).toEqual(accepted);
        expect(reopened.getMetaRaw("generatedCellIdentity")).toEqual({
          version: markerlessLegacy ? 0 : 1,
          ...accepted,
        });
        expect(
          visible.key("slots").key(0).resolveAsCell()
            .getAsNormalizedFullLink().id,
        ).toBe(acceptedSlotLink.id);
        visible.key("change").send({});
        await reader.idle();
        expect((await visible.pull()).slots).toEqual(["handler-updated"]);
      }
    }

    if (followup === "transition") {
      const wrapperRef = reader.patternManager.getArtifactEntryRef(reexport);
      expect(wrapperRef).toBeDefined();
      if (wrapperRef === undefined) throw new Error("Expected the wrapper ref");
      expect(
        (await reader.editWithRetry((tx) => {
          acceptedSlot.withTx(tx).set("retained-after-transition");
        })).error,
      ).toBeUndefined();
      await reader.setup(undefined, reexport, {}, reopened);
      await reader.runner.idlePointerMaintenance();
      await reader.idle();
      expect(reopened.getMetaRaw("patternIdentity")).toEqual(wrapperRef);
      expect(reopened.getMetaRaw("generatedCellIdentity")).toEqual({
        version: 1,
        ...wrapperRef,
      });
      expect((await visible.pull()).slots).toEqual(["initial"]);
      expect(
        visible.key("slots").key(0).resolveAsCell()
          .getAsNormalizedFullLink().id,
      ).not.toBe(acceptedSlotLink.id);
      visible.key("change").send({});
      await reader.idle();
      expect((await visible.pull()).slots).toEqual(["handler-updated"]);
      expect(acceptedSlot.get()).toBe("retained-after-transition");
    }
  } finally {
    cancelDemand?.();
    for (const runtime of [writer, reader]) {
      await runtime.idle();
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.storageManager.synced();
      await runtime.dispose();
    }
    lease?.release();
    await server.close();
  }
}

describe("generated-cell-aliases", () => {
  it("updates visible generated state after preloading a re-export", async () => {
    await exerciseReexport(false);
  });

  it("retains markerless legacy state after preloading a re-export", async () => {
    await exerciseReexport(true);
  });

  it("retains the accepted reference when setup and run omit the pattern", async () => {
    await exerciseReexport(false, "rerun");
  });

  it("retains legacy addresses when setup and run omit the pattern", async () => {
    await exerciseReexport(true, "rerun");
  });

  it("selects fresh generated state when explicitly changing to the wrapper", async () => {
    await exerciseReexport(false, "transition");
  });

  it("leaves legacy addresses when explicitly changing to the wrapper", async () => {
    await exerciseReexport(true, "transition");
  });

  it("keeps the accepted alias selected in a scoped serving graph", async () => {
    await exerciseReexport(false, "scoped");
  });

  it("retains nested generated state after preloading a child re-export", async () => {
    const signer = await Identity.fromPassphrase(
      "review-nested-generated-alias",
    );
    const space = signer.did();
    const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const createRuntime = () =>
      new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: EmulatedStorageManager.connectTo(server, {
          as: signer,
        }),
      });
    const writer = createRuntime();
    const reader = createRuntime();
    try {
      const child = await writer.patternManager.compilePattern(standalone, {
        space,
      });
      const childRef = writer.patternManager.getArtifactEntryRef(child)!;
      const parent = await writer.patternManager.compilePattern({
        main: "/parent.tsx",
        files: [
          {
            name: "/parent.tsx",
            contents: `
              import { pattern } from "commonfabric";
              import child from "./dep.tsx";
              export default pattern<Record<string, never>>(() => ({
                child: child({}),
              }));
            `,
          },
          { name: "/dep.tsx", contents: source },
        ],
      }, { space });
      const accepted = writer.patternManager.getArtifactEntryRef(parent)!;
      const piece = writer.getCell(
        space,
        "review-nested-generated-alias-piece",
      );
      await writer.setup(undefined, parent, {}, piece);
      await writer.start(piece);
      await writer.idle();
      const nestedSchema: JSONSchema = {
        type: "object",
        properties: { child: viewSchema },
      };
      const original = piece.asSchema<{ child: View }>(nestedSchema).key(
        "child",
      );
      const slot = original.key("slots").key(0).resolveAsCell();
      expect(
        (await writer.editWithRetry((tx) => {
          slot.withTx(tx).set("nested-sentinel");
        })).error,
      ).toBeUndefined();
      expect(original.get().slots).toEqual(["nested-sentinel"]);
      writer.runner.stop(piece);
      await writer.idle();
      await writer.patternManager.flushCompileCacheWrites();
      await writer.storageManager.synced();

      const wrapper = await reader.patternManager.compilePattern(reexporting, {
        space,
      });
      const loadedChild = await reader.patternManager.loadPatternByIdentity(
        childRef.identity,
        childRef.symbol,
        space,
      );
      expect(loadedChild).toBeDefined();
      expect(reader.patternManager.getArtifactEntryRef(loadedChild!)).toEqual(
        reader.patternManager.getArtifactEntryRef(wrapper),
      );
      expect(reader.patternManager.getArtifactEntryRef(loadedChild!)).not
        .toEqual(
          childRef,
        );
      const loaded = await reader.patternManager.loadPatternByIdentity(
        accepted.identity,
        accepted.symbol,
        space,
      );
      expect(loaded).toBeDefined();
      const reopened = reader.getCellFromLink(piece.getAsNormalizedFullLink());
      await reopened.sync();
      expect(await reader.start(reopened)).toBe(true);
      const visible = reopened.asSchema<{ child: View }>(nestedSchema).key(
        "child",
      );
      expect((await visible.pull()).slots).toEqual(["nested-sentinel"]);
      expect(
        visible.key("slots").key(0).resolveAsCell()
          .getAsNormalizedFullLink().id,
      ).toBe(slot.getAsNormalizedFullLink().id);
      visible.key("change").send({});
      await reader.idle();
      expect((await visible.pull()).slots).toEqual(["handler-updated"]);
    } finally {
      for (const runtime of [writer, reader]) {
        await runtime.idle();
        await runtime.patternManager.flushCompileCacheWrites();
        await runtime.storageManager.synced();
        await runtime.dispose();
      }
      await server.close();
    }
  });
});
