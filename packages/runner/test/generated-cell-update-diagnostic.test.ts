/**
 * Verifies authored updates isolate generated state and retain explicit names,
 * including nested pieces and a second runtime loading the accepted artifact.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { getDerivedInternalCellLink, getMetaLink } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { prepareGeneratedCellIdentity } from "../src/builder/pattern-metadata.ts";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  applyPieceSourceTransition,
  getPieceSourceSnapshot,
  preparePieceSourceTransitionBaseline,
} from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase(
  "generated-cell-update-diagnostic",
);
const space = signer.did();

describe("generated-cell-update-diagnostic", () => {
  let runtime: Runtime;
  let server: ReturnType<typeof newLoopbackServer>;

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
  });

  afterEach(async () => {
    await runtime.idle();
    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.storageManager.synced();
    await runtime.dispose();
    await server.close();
  });

  /** Compiles an authored version at the same module path. */
  function compile(contents: string) {
    return runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents }],
    }, { space });
  }

  it("preserves markerless legacy state until an authored update", async () => {
    const source = (value: string) => `
      import { pattern, Writable } from "commonfabric";
      export default pattern<Record<string, never>>(() => ({ slots: [0].map(() => new Writable("${value}")) }));
    `;
    const v1 = await compile(source("old-default"));
    const v2 = await compile(source("new-default"));
    const ref = runtime.patternManager.getArtifactEntryRef(v1)!;
    const piece = runtime.getCell(space, "legacy-generated");
    const seed = runtime.edit();
    piece.withTx(seed).setMetaRaw(
      "patternIdentity",
      ref,
      rawMetaWriteAuthorization,
    );
    await runtime.setup(seed, v1, {}, piece);
    expect((await seed.commit()).error).toBeUndefined();
    const descriptor = v1.derivedInternalCells!.find((d) =>
      isObjectNotArray(d.partialCause) && "$generated" in d.partialCause
    )!;
    const legacy = runtime.getCellFromLink<string>(
      getDerivedInternalCellLink(piece, descriptor),
    );
    expect(legacy.get()).toBe("old-default");
    expect(
      (await runtime.editWithRetry((tx) => {
        legacy.withTx(tx).set("legacy-user-value");
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
      })).error,
    ).toBeUndefined();
    await runtime.setup(undefined, v1, {}, piece);
    expect(legacy.get()).toBe("legacy-user-value");
    expect(piece.getMetaRaw("generatedCellIdentity")).toEqual({
      version: 0,
      ...ref,
    });
    expect(
      (await runtime.editWithRetry((tx) => {
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
      })).error,
    ).toBeUndefined();
    const expected = getPieceSourceSnapshot(piece)!;
    const baseline = await preparePieceSourceTransitionBaseline(
      runtime,
      piece,
      expected,
    );
    const update = runtime.edit();
    applyPieceSourceTransition(
      runtime,
      piece,
      update,
      runtime.patternManager.getArtifactEntryRef(v2)!,
      {
        expected,
        baseline,
        revisionId: "legacy-authored-update",
        timestamp: 1,
        operation: "origin-update",
        origin: null,
      },
    );
    expect(piece.withTx(update).getMetaRaw("generatedCellIdentity")).toEqual({
      version: 0,
      ...ref,
    });
    piece.withTx(update).setMetaRaw(
      "patternIdentity",
      runtime.patternManager.getArtifactEntryRef(v2)!,
      rawMetaWriteAuthorization,
    );
    expect((await update.commit()).error).toBeUndefined();
    // Recovery can commit the pointer before materializing its setup. The
    // retained format still describes the old data during that interval.
    expect(piece.getMetaRaw("generatedCellIdentity")).toEqual({
      version: 0,
      ...ref,
    });
    expect(await runtime.start(piece)).toBe(true);
    await runtime.runner.idlePieceInstantiationSettlements();
    const view = piece.asSchema<{ slots: string[] }>({
      type: "object",
      properties: { slots: { type: "array", items: { type: "string" } } },
    });
    expect(view.get().slots).toEqual(["new-default"]);
    expect(legacy.get()).toBe("legacy-user-value");
    expect(piece.getMetaRaw("generatedCellIdentity")).toEqual({
      version: 1,
      ...runtime.patternManager.getArtifactEntryRef(v2)!,
    });
    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.storageManager.synced();
    const reader = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    try {
      const reopened = reader.getCellFromLink(view.getAsNormalizedFullLink());
      await reopened.sync();
      expect(await reader.start(reopened)).toBe(true);
      expect(await reopened.pull()).toEqual({ slots: ["new-default"] });
    } finally {
      await reader.idle();
      await reader.dispose();
    }
  });

  it("aborts the selected namespace together with the manifest and projection", async () => {
    const source = (value: string) => `
      import { pattern, Writable } from "commonfabric";
      export default pattern<Record<string, never>>(() => ({ slots: [0].map(() => new Writable("${value}")) }));
    `;
    const v1 = await compile(source("old"));
    const v2 = await compile(source("new"));
    const piece = runtime.getCell(space, "aborted-generated");
    await runtime.setup(undefined, v1, {}, piece);
    const before = {
      identity: piece.getMetaRaw("generatedCellIdentity"),
      manifest: piece.getMetaRaw("internal"),
      projection: piece.getRaw(),
    };
    const tx = runtime.edit();
    await runtime.setup(tx, v2, {}, piece);
    expect(piece.withTx(tx).getMetaRaw("generatedCellIdentity")).not.toEqual(
      before.identity,
    );
    expect(tx.abort("candidate refused").error).toBeUndefined();
    expect(piece.getMetaRaw("generatedCellIdentity")).toEqual(before.identity);
    expect(piece.getMetaRaw("internal")).toEqual(before.manifest);
    expect(piece.getRaw()).toEqual(before.projection);
    await runtime.setup(undefined, v1, {}, piece);
    expect(piece.getMetaRaw("generatedCellIdentity")).toEqual(before.identity);
  });

  it("rotates anonymous computed addresses while retaining named output addresses", async () => {
    const source = (marker: string) => `
      import { computed, pattern } from "commonfabric";
      export default pattern<Record<string, never>, {
        marker: string; generatedMarkers: string[];
      }>(() => {
        const generatedMarkers = ["slot"].map(() => computed(() => "${marker}"));
        return { marker: computed(() => "${marker}"), generatedMarkers };
      });
    `;
    const raw1 = await compile(source("v1"));
    const raw2 = await compile(source("v2"));
    const v1 = prepareGeneratedCellIdentity(raw1, {
      version: 1,
      ...runtime.patternManager.getArtifactEntryRef(raw1)!,
    });
    const v2 = prepareGeneratedCellIdentity(raw2, {
      version: 1,
      ...runtime.patternManager.getArtifactEntryRef(raw2)!,
    });
    const ref1 = runtime.patternManager.getArtifactEntryRef(v1)!;
    const ref2 = runtime.patternManager.getArtifactEntryRef(v2)!;
    expect(ref1.identity).not.toBe(ref2.identity);
    expect(ref1.identity.startsWith("keyless:")).toBe(false);
    expect(ref2.identity.startsWith("keyless:")).toBe(false);

    const piece = runtime.getCell<
      { marker: string; generatedMarkers: string[] }
    >(
      space,
      "computed-update",
    );
    const descriptors1 = v1.derivedInternalCells!;
    const descriptors2 = v2.derivedInternalCells!;
    expect(descriptors1.map((d) => d.partialCause)).toEqual([
      ["__patternResult", "marker"],
      { $generated: 0 },
    ]);
    expect(descriptors2.map((d) => d.partialCause)).toEqual(
      descriptors1.map((d) => d.partialCause),
    );
    expect(descriptors1.map((d) => d.kind)).toEqual(["computed", "computed"]);
    expect(getDerivedInternalCellLink(piece, descriptors1[0]).id).toBe(
      getDerivedInternalCellLink(piece, descriptors2[0]).id,
    );
    expect(getDerivedInternalCellLink(piece, descriptors1[1]).id).not.toBe(
      getDerivedInternalCellLink(piece, descriptors2[1]).id,
    );

    await runtime.setup(undefined, v1, {}, piece);
    await runtime.start(piece);
    const cancel = piece.sink(() => {});
    try {
      await runtime.idle();
      expect(piece.get()).toEqual({ marker: "v1", generatedMarkers: ["v1"] });
      await runtime.setup(undefined, v2, {}, piece);
      await runtime.idle();
      await runtime.runner.idlePointerMaintenance();
      await runtime.idle();
      expect(piece.get()).toEqual({ marker: "v2", generatedMarkers: ["v2"] });
    } finally {
      cancel();
    }
  });

  it("isolates anonymous writable state across authored updates and reload", async () => {
    const source = (purpose: string, initial: string) => `
      import { pattern, Writable } from "commonfabric";
      export default pattern<Record<string, never>, {
        purpose: string; slots: Writable<string>[]; named: Writable<string>;
      }>(() => {
        const slots = ["slot"].map(() => new Writable<string>("${initial}"));
        const named = new Writable<string>("named-default").for("retained");
        return { purpose: "${purpose}", slots, named };
      });
    `;
    const raw1 = await compile(source("shipping-note", "shipping-default"));
    const raw2 = await compile(source("billing-note", "billing-default"));
    const v1 = prepareGeneratedCellIdentity(raw1, {
      version: 1,
      ...runtime.patternManager.getArtifactEntryRef(raw1)!,
    });
    const v2 = prepareGeneratedCellIdentity(raw2, {
      version: 1,
      ...runtime.patternManager.getArtifactEntryRef(raw2)!,
    });
    const piece = runtime.getCell(space, "writable-update");
    const anonymous1 = v1.derivedInternalCells!.find((d) =>
      isObjectNotArray(d.partialCause) &&
      "$generated" in d.partialCause
    )!;
    const anonymous2 = v2.derivedInternalCells!.find((d) =>
      isObjectNotArray(d.partialCause) &&
      "$generated" in d.partialCause
    )!;
    const named1 = v1.derivedInternalCells!.find((d) =>
      d.partialCause === "retained"
    )!;
    expect(anonymous1.partialCause).toEqual({ $generated: 0 });
    expect(anonymous1.kind).toBeUndefined();
    expect(anonymous2.partialCause).toEqual(anonymous1.partialCause);
    const oldLink = getDerivedInternalCellLink(piece, anonymous1);
    const newLink = getDerivedInternalCellLink(piece, anonymous2);
    expect(newLink.id).not.toBe(oldLink.id);

    await runtime.setup(undefined, v1, {}, piece);
    const oldCell = runtime.getCellFromLink<string>(oldLink);
    const namedCell = runtime.getCellFromLink<string>(
      getDerivedInternalCellLink(piece, named1),
    );
    expect(oldCell.get()).toBe("shipping-default");
    const write = await runtime.editWithRetry((tx) => {
      oldCell.withTx(tx).set("shipping-user-state");
      namedCell.withTx(tx).set("named-sentinel");
    });
    expect(write.error).toBeUndefined();
    await runtime.setup(undefined, v2, {}, piece);
    expect(runtime.getCellFromLink<string>(newLink).get()).toBe(
      "billing-default",
    );
    expect(oldCell.get()).toBe("shipping-user-state");
    expect(namedCell.get()).toBe("named-sentinel");
    const output = piece.asSchema<{
      purpose: string;
      slots: string[];
      named: string;
    }>({
      type: "object",
      properties: {
        purpose: { type: "string" },
        slots: { type: "array", items: { type: "string" } },
        named: { type: "string" },
      },
    }).get();
    expect(output.purpose).toBe("billing-note");
    expect(output.slots[0]).toBe("billing-default");
    expect(output.named).toBe("named-sentinel");

    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.storageManager.synced();
    const reader = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    try {
      const reopened = reader.getCellFromLink(piece.getAsNormalizedFullLink());
      await reopened.sync();
      expect(await reader.start(reopened)).toBe(true);
      const visible = reopened.asSchema<typeof output>({
        type: "object",
        properties: {
          purpose: { type: "string" },
          slots: { type: "array", items: { type: "string" } },
          named: { type: "string" },
        },
      });
      await visible.pull();
      expect(visible.get()).toEqual(output);
      await runtime.setup(undefined, v1, {}, piece);
      expect(oldCell.get()).toBe("shipping-user-state");
      expect(
        piece.asSchema<{ slots: string[] }>({
          type: "object",
          properties: { slots: { type: "array", items: { type: "string" } } },
        }).get().slots,
      ).toEqual(["shipping-user-state"]);
    } finally {
      await reader.idle();
      await reader.dispose();
    }
  });

  it("rotates the child anchor reached through an anonymous parent output coordinate", async () => {
    const source = (purpose: string) => `
      import { pattern, Writable } from "commonfabric";
      export const Child = pattern<Record<string, never>, {
        purpose: string; note: Writable<string>;
      }>(() => {
        const note = new Writable<string>("${purpose}-default").for("note");
        return { purpose: "${purpose}", note };
      });
      export default pattern<Record<string, never>, {
        children: { purpose: string; note: Writable<string> }[];
      }>(() => {
        const children = ["slot"].map(() => Child({}));
        return { children };
      });
    `;
    const raw1 = await compile(source("shipping"));
    const raw2 = await compile(source("billing"));
    const v1 = prepareGeneratedCellIdentity(raw1, {
      version: 1,
      ...runtime.patternManager.getArtifactEntryRef(raw1)!,
    });
    const v2 = prepareGeneratedCellIdentity(raw2, {
      version: 1,
      ...runtime.patternManager.getArtifactEntryRef(raw2)!,
    });
    const piece = runtime.getCell(space, "nested-update");
    const anonymous1 = v1.derivedInternalCells!.find((d) =>
      isObjectNotArray(d.partialCause) &&
      "$generated" in d.partialCause
    )!;
    const anonymous2 = v2.derivedInternalCells!.find((d) =>
      isObjectNotArray(d.partialCause) &&
      "$generated" in d.partialCause
    )!;
    expect(anonymous1.partialCause).toEqual({ $generated: 0 });
    const slot1 = getDerivedInternalCellLink(piece, anonymous1);
    const slot2 = getDerivedInternalCellLink(piece, anonymous2);
    expect(slot2.id).not.toBe(slot1.id);

    await runtime.setup(undefined, v1, {}, piece);
    await runtime.start(piece);
    const view = piece.asSchema<{
      children: { purpose: string; note: string }[];
    }>({
      type: "object",
      properties: {
        children: {
          type: "array",
          items: {
            type: "object",
            properties: {
              purpose: { type: "string" },
              note: { type: "string" },
            },
          },
        },
      },
    });
    const cancel = view.sink(() => {});
    try {
      await runtime.idle();
      const oldChild = view.get().children[0];
      expect(oldChild.purpose).toBe("shipping");
      const oldNote = view.key("children").key(0).key("note").resolveAsCell();
      const oldChildResult = getMetaLink(oldNote, "result")!;
      expect(oldChildResult).toBeDefined();
      expect(oldChildResult.id).not.toBe(slot1.id);
      const write = await runtime.editWithRetry((tx) => {
        oldNote.withTx(tx).set("shipping-child-user-state");
      });
      expect(write.error).toBeUndefined();
      await runtime.setup(undefined, v2, {}, piece);
      await runtime.idle();
      await runtime.runner.idlePointerMaintenance();
      await runtime.idle();
      const newChild = view.get().children[0];
      expect(newChild.purpose).toBe("billing");
      expect(newChild.note).toBe("billing-default");
      const newNote = view.key("children").key(0).key("note").resolveAsCell();
      expect(newNote.getAsNormalizedFullLink().id).not.toBe(
        oldNote.getAsNormalizedFullLink().id,
      );
      expect(getMetaLink(newNote, "result")!.id).not.toBe(
        oldChildResult.id,
      );
      expect(
        (await runtime.editWithRetry((tx) =>
          newNote.withTx(tx).set("billing-child-sentinel")
        )).error,
      ).toBeUndefined();
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.storageManager.synced();
      const reader = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: EmulatedStorageManager.connectTo(server, {
          as: signer,
        }),
      });
      const childId = getMetaLink(newNote, "result")!.id;
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const syncedIds: string[] = [];
      const syncCell = reader.storageManager.syncCell.bind(
        reader.storageManager,
      );
      reader.storageManager.syncCell = async (cell, options) => {
        const id = cell.getAsNormalizedFullLink().id;
        syncedIds.push(id);
        if (id === childId) {
          held.resolve();
          await release.promise;
        }
        return syncCell(cell, options);
      };
      try {
        const reopened = reader.getCellFromLink(
          piece.getAsNormalizedFullLink(),
        );
        await reopened.sync();
        const started = reader.start(reopened);
        await held.promise;
        expect(syncedIds).not.toContain(newNote.getAsNormalizedFullLink().id);
        release.resolve();
        expect(await started).toBe(true);
        const visible = reopened.asSchema<
          { children: { purpose: string; note: string }[] }
        >(view.schema!);
        await visible.pull();
        expect(visible.get().children[0]).toEqual({
          purpose: "billing",
          note: "billing-child-sentinel",
        });
        expect(
          visible.key("children").key(0).key("note").resolveAsCell()
            .getAsNormalizedFullLink().id,
        ).toBe(newNote.getAsNormalizedFullLink().id);
      } finally {
        release.resolve();
        await reader.idle();
        await reader.dispose();
      }
    } finally {
      cancel();
    }
  });
});
