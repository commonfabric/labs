// The memo a transaction keeps for derivations that read only its snapshot --
// link resolution and CFC label views. What it collapses, what a memoized call
// must still leave behind, and where it has to stand aside.

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { type JSONSchema } from "../src/builder/types.ts";
import {
  resolveLink,
  resolveLinkTracingDereferences,
} from "../src/link-resolution.ts";
import { createQueryResultProxy } from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import { createNonReactiveTransaction } from "../src/storage/extended-storage-transaction.ts";
import {
  machineryRead,
  markUiInputBlindWriteTx,
  unmarkUiInputBlindWriteTx,
} from "../src/storage/reactivity-log.ts";
import {
  cfcLabelViewForDereference,
  cfcLabelViewForDereferenceTraces,
} from "../src/cfc/label-view-state.ts";
import { seedStoredEnvelope } from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("snapshot memo test");
const space = signer.did();
const otherSpace = (await Identity.fromPassphrase("snapshot memo other")).did();

const STRING_SCHEMA = { type: "string" } as const satisfies JSONSchema;
const NUMBER_SCHEMA = { type: "number" } as const satisfies JSONSchema;

describe("snapshot memo", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  const readCount = (of: IExtendedStorageTransaction = tx): number =>
    [...(of.getReadActivities?.() ?? [])].length;

  const traceCount = (of: IExtendedStorageTransaction = tx): number =>
    of.getCfcState().dereferenceTraces.length;

  /** Reads of a document's stored CFC metadata, which sits at `["cfc"]`. */
  const cfcMetadataReadCount = (): number =>
    [...(tx.getReadActivities?.() ?? [])]
      .filter((read) => read.path.length === 1 && read.path[0] === "cfc")
      .length;

  /** A cell holding `{ target: <link to another cell's value> }`. */
  const linkingCell = (cause: string, targetCause: string) => {
    const target = runtime.getCell<{ value: string }>(
      space,
      targetCause,
      undefined,
      tx,
    );
    target.set({ value: targetCause });
    const holder = runtime.getCell<{ target: unknown }>(
      space,
      cause,
      undefined,
      tx,
    );
    holder.setRaw({ target: target.key("value").getAsLink() });
    return { holder, target };
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("issues no further reads for a link already resolved in the transaction", () => {
    const { holder } = linkingCell("repeat-holder", "repeat-target");
    const link = holder.key("target").getAsNormalizedFullLink();

    resolveLink(runtime, tx, link);
    const afterFirst = readCount();
    resolveLink(runtime, tx, link);

    expect(readCount()).toBe(afterFirst);
  });

  it("returns the same resolved link for a repeated resolution", () => {
    const { holder, target } = linkingCell("same-holder", "same-target");
    const link = holder.key("target").getAsNormalizedFullLink();

    const first = resolveLink(runtime, tx, link);
    const second = resolveLink(runtime, tx, link);

    expect(second).toEqual(first);
    expect(second.id).toBe(target.getAsNormalizedFullLink().id);
  });

  it("does not carry an edit of one resolution's result into the next", () => {
    const { holder } = linkingCell("copy-holder", "copy-target");
    const link = holder.key("target").getAsNormalizedFullLink();

    resolveLink(runtime, tx, link);
    const edited = resolveLink(runtime, tx, link);
    (edited as { id: string }).id = "of:tampered";

    expect(resolveLink(runtime, tx, link).id).not.toBe("of:tampered");
  });

  it("records the dereference trace on every resolution, memoized or not", () => {
    const { holder } = linkingCell("trace-holder", "trace-target");
    const link = holder.key("target").getAsNormalizedFullLink();

    const before = traceCount();
    resolveLink(runtime, tx, link);
    const afterFirst = traceCount();
    resolveLink(runtime, tx, link);

    expect(afterFirst - before).toBe(1);
    expect(traceCount() - afterFirst).toBe(1);
  });

  it("resolves to the new target after a write retargets the link", () => {
    const first = runtime.getCell<{ value: string }>(
      space,
      "retarget-first",
      undefined,
      tx,
    );
    first.set({ value: "first" });
    const second = runtime.getCell<{ value: string }>(
      space,
      "retarget-second",
      undefined,
      tx,
    );
    second.set({ value: "second" });
    const holder = runtime.getCell<{ target: unknown }>(
      space,
      "retarget-holder",
      undefined,
      tx,
    );
    holder.setRaw({ target: first.key("value").getAsLink() });
    const link = holder.key("target").getAsNormalizedFullLink();

    expect(resolveLink(runtime, tx, link).id).toBe(
      first.getAsNormalizedFullLink().id,
    );
    holder.setRaw({ target: second.key("value").getAsLink() });

    expect(resolveLink(runtime, tx, link).id).toBe(
      second.getAsNormalizedFullLink().id,
    );
  });

  it("resolves to the value in place after a write replaces the link", () => {
    const { holder } = linkingCell("replaced-holder", "replaced-target");
    const link = holder.key("target").getAsNormalizedFullLink();

    const followed = resolveLink(runtime, tx, link);
    expect(followed.id).not.toBe(holder.getAsNormalizedFullLink().id);
    holder.setRaw({ target: "a plain string, no longer a link" });

    const inPlace = resolveLink(runtime, tx, link);
    expect(inPlace.id).toBe(holder.getAsNormalizedFullLink().id);
    expect(inPlace.path).toEqual(["target"]);
  });

  it("keeps serving a resolution across a batch write holding no writes", () => {
    const { holder } = linkingCell("empty-batch-holder", "empty-batch-target");
    const link = holder.key("target").getAsNormalizedFullLink();

    resolveLink(runtime, tx, link);
    const afterFirst = readCount();
    // A batch with nothing in it writes nothing, so no value a resolution
    // depends on has changed.
    tx.writeValuesOrThrow!([]);
    resolveLink(runtime, tx, link);

    expect(readCount()).toBe(afterFirst);
  });

  it("keeps serving a resolution across a `set()` that changes nothing", () => {
    const { holder, target } = linkingCell(
      "same-set-holder",
      "same-set-target",
    );
    const link = holder.key("target").getAsNormalizedFullLink();

    resolveLink(runtime, tx, link);
    // The diff behind `set()` reads the stored value to find nothing to write,
    // so the count is taken after it.
    target.set({ value: "same-set-target" });
    const afterSet = readCount();
    resolveLink(runtime, tx, link);

    expect(readCount()).toBe(afterSet);
  });

  it("keeps apart two paths whose segments differ only in where a boundary falls", () => {
    // The two paths concatenate to the same characters; only their segment
    // boundaries differ. A key that joined segments with a separator a segment
    // may itself contain would name one entry for both.
    const doc = runtime.getCell<Record<string, unknown>>(
      space,
      "boundary-doc",
      undefined,
      tx,
    );
    doc.setRaw({ "a\0b": { c: "one" }, a: { "b\0c": "two" } });
    const base = doc.getAsNormalizedFullLink();

    const first = resolveLink(runtime, tx, { ...base, path: ["a\0b", "c"] });
    const second = resolveLink(runtime, tx, { ...base, path: ["a", "b\0c"] });

    expect(first.path).toEqual(["a\0b", "c"]);
    expect(second.path).toEqual(["a", "b\0c"]);
  });

  describe("inside an ambient-read-meta scope", () => {
    it("serves a resolution to a second one in the same scope", () => {
      const { holder } = linkingCell("scoped-holder", "scoped-target");
      const link = holder.key("target").getAsNormalizedFullLink();

      // Both resolutions journal their reads with the same metadata, so the
      // second has nothing to add that the first did not.
      let afterFirst = 0;
      tx.runWithAmbientReadMeta(machineryRead, () => {
        resolveLink(runtime, tx, link);
        afterFirst = readCount();
        resolveLink(runtime, tx, link);
      });

      expect(readCount()).toBe(afterFirst);
    });

    it("does not serve an entry made in the scope to a resolution outside it", () => {
      const { holder } = linkingCell("escape-holder", "escape-target");
      const link = holder.key("target").getAsNormalizedFullLink();

      tx.runWithAmbientReadMeta(machineryRead, () => {
        resolveLink(runtime, tx, link);
      });
      const afterScoped = readCount();
      resolveLink(runtime, tx, link);

      expect(readCount()).toBeGreaterThan(afterScoped);
    });
  });

  describe("at a read epoch", () => {
    /** A holder whose link the test retargets, with both targets. */
    const retargetable = (name: string) => {
      const first = runtime.getCell<{ value: string }>(
        space,
        `${name}-first`,
        undefined,
        tx,
      );
      first.set({ value: "first" });
      const second = runtime.getCell<{ value: string }>(
        space,
        `${name}-second`,
        undefined,
        tx,
      );
      second.set({ value: "second" });
      const holder = runtime.getCell<{ target: unknown }>(
        space,
        `${name}-holder`,
        undefined,
        tx,
      );
      holder.setRaw({ target: first.key("value").getAsLink() });
      return {
        link: holder.key("target").getAsNormalizedFullLink(),
        first,
        second,
        retarget: () =>
          holder.setRaw({ target: second.key("value").getAsLink() }),
      };
    };

    const resolveAt = (epoch: number, link: NormalizedFullLink) => {
      const previous = tx.enterReadEpoch(epoch);
      try {
        return resolveLink(runtime, tx, link);
      } finally {
        tx.exitReadEpoch(previous);
      }
    };

    it("serves a resolution made before a write to a read at the epoch the write displaced", () => {
      const { link, first, retarget } = retargetable("kept");
      const epoch = tx.issueReadEpoch()!;
      resolveLink(runtime, tx, link);

      retarget();
      const afterWrite = readCount();
      const atEpoch = resolveAt(epoch, link);

      expect(atEpoch.id).toBe(first.getAsNormalizedFullLink().id);
      expect(readCount()).toBe(afterWrite);
    });

    it("serves a resolution made at an epoch across a later write", () => {
      const { link, first, retarget } = retargetable("later");
      const epoch = tx.issueReadEpoch()!;
      retarget();
      resolveAt(epoch, link);

      retarget();
      const afterSecondWrite = readCount();
      const atEpoch = resolveAt(epoch, link);

      expect(atEpoch.id).toBe(first.getAsNormalizedFullLink().id);
      expect(readCount()).toBe(afterSecondWrite);
    });

    it("keeps an entry made at an epoch out of a resolution at the current instant", () => {
      const { link, second, retarget } = retargetable("current");
      const epoch = tx.issueReadEpoch()!;
      retarget();
      resolveAt(epoch, link);

      expect(resolveLink(runtime, tx, link).id).toBe(
        second.getAsNormalizedFullLink().id,
      );
    });

    it("keeps entries of two epochs apart", () => {
      const { link, first, second, retarget } = retargetable("two");
      const before = tx.issueReadEpoch()!;
      resolveLink(runtime, tx, link);
      retarget();
      const after = tx.issueReadEpoch()!;
      resolveLink(runtime, tx, link);

      expect(resolveAt(before, link).id).toBe(
        first.getAsNormalizedFullLink().id,
      );
      expect(resolveAt(after, link).id).toBe(
        second.getAsNormalizedFullLink().id,
      );
    });
  });

  it("keeps scoped label views at their read epoch after metadata changes", () => {
    const cell = runtime.getCell(space, "scoped-label-epochs", undefined, tx);
    const address = cell.getAsNormalizedFullLink();
    const writeLabel = (name: string) =>
      seedStoredEnvelope(tx, {
        space,
        id: address.id,
        type: "application/json",
        path: [],
      }, {
        value: "unchanged",
        cfc: {
          version: 1,
          schemaHash: "test-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { confidentiality: [name] },
            }],
          },
        },
      });
    const readLabel = () =>
      cfcLabelViewForDereference(tx, address, address)
        ?.entries[0].label.confidentiality;
    const scopedLabel = () =>
      tx.runWithAmbientReadMeta(machineryRead, readLabel);
    writeLabel("first");
    const epoch = tx.issueReadEpoch()!;
    expect(scopedLabel()).toEqual(["first"]);
    const afterFirst = cfcMetadataReadCount();
    expect(scopedLabel()).toEqual(["first"]);
    expect(cfcMetadataReadCount()).toBe(afterFirst);

    writeLabel("second");
    expect(scopedLabel()).toEqual(["second"]);
    const afterCurrent = cfcMetadataReadCount();
    const previous = tx.enterReadEpoch(epoch);
    try {
      expect(scopedLabel()).toEqual(["first"]);
      expect(cfcMetadataReadCount()).toBe(afterCurrent);
      expect(readLabel()).toEqual(["first"]);
      expect(cfcMetadataReadCount()).toBeGreaterThan(afterCurrent);
    } finally {
      tx.exitReadEpoch(previous);
    }
    expect(readLabel()).toEqual(["second"]);
  });

  it("journals label metadata separately for distinct ambient metadata objects", () => {
    const { holder } = linkingCell(
      "metadata-identity-holder",
      "metadata-identity-target",
    );
    const { traces } = resolveLinkTracingDereferences(
      runtime,
      tx,
      holder.key("target").getAsNormalizedFullLink(),
    );
    const firstMeta = { ...machineryRead };
    const secondMeta = { ...machineryRead };
    const readLabels = () => cfcLabelViewForDereferenceTraces(tx, traces);
    const before = cfcMetadataReadCount();
    tx.runWithAmbientReadMeta(firstMeta, readLabels);
    const afterFirst = cfcMetadataReadCount();
    expect(afterFirst).toBeGreaterThan(before);
    tx.runWithAmbientReadMeta(firstMeta, readLabels);
    expect(cfcMetadataReadCount()).toBe(afterFirst);
    tx.runWithAmbientReadMeta(secondMeta, readLabels);
    const afterSecond = cfcMetadataReadCount();
    expect(afterSecond).toBeGreaterThan(afterFirst);
    tx.runWithAmbientReadMeta(firstMeta, readLabels);
    expect(cfcMetadataReadCount()).toBe(afterSecond);
    tx.runWithAmbientReadMeta(secondMeta, readLabels);
    expect(cfcMetadataReadCount()).toBe(afterSecond);
    readLabels();
    expect(cfcMetadataReadCount()).toBeGreaterThan(afterSecond);
  });

  it("keeps resolutions of two paths in one document apart", () => {
    const first = runtime.getCell<{ value: string }>(
      space,
      "two-paths-first",
      undefined,
      tx,
    );
    first.set({ value: "first" });
    const second = runtime.getCell<{ value: string }>(
      space,
      "two-paths-second",
      undefined,
      tx,
    );
    second.set({ value: "second" });
    const holder = runtime.getCell<{ a: unknown; b: unknown }>(
      space,
      "two-paths-holder",
      undefined,
      tx,
    );
    holder.setRaw({
      a: first.key("value").getAsLink(),
      b: second.key("value").getAsLink(),
    });

    const viaA = resolveLink(
      runtime,
      tx,
      holder.key("a").getAsNormalizedFullLink(),
    );
    const viaB = resolveLink(
      runtime,
      tx,
      holder.key("b").getAsNormalizedFullLink(),
    );

    expect(viaA.id).toBe(first.getAsNormalizedFullLink().id);
    expect(viaB.id).toBe(second.getAsNormalizedFullLink().id);
  });

  it("keeps resolutions of the same link under different schemas apart", () => {
    const { holder } = linkingCell("schema-holder", "schema-target");
    const base = holder.key("target").getAsNormalizedFullLink();

    const asString = resolveLink(runtime, tx, {
      ...base,
      schema: STRING_SCHEMA,
    });
    const asNumber = resolveLink(runtime, tx, {
      ...base,
      schema: NUMBER_SCHEMA,
    });

    expect(asString.schema).toEqual(STRING_SCHEMA);
    expect(asNumber.schema).toEqual(NUMBER_SCHEMA);
  });

  it("keeps resolutions of the same link under different lastNode apart", () => {
    const { holder, target } = linkingCell("last-node-holder", "last-node-t");
    const link = holder.key("target").getAsNormalizedFullLink();

    // The stored link is a value link, so `writeRedirect` stops at the holder
    // while `value` follows through to the target.
    const stoppedAtHolder = resolveLink(runtime, tx, link, "writeRedirect");
    const followed = resolveLink(runtime, tx, link, "value");

    expect(stoppedAtHolder.id).toBe(holder.getAsNormalizedFullLink().id);
    expect(followed.id).toBe(target.getAsNormalizedFullLink().id);
  });

  it("keeps resolutions of the same link under different preserveOverwrite apart", () => {
    const target = runtime.getCell<{ value: string }>(
      space,
      "overwrite-target",
      undefined,
      tx,
    );
    target.set({ value: "kept" });
    const redirect = target.key("value").getAsWriteRedirectLink();
    const holder = runtime.getCell<{ target: unknown }>(
      space,
      "overwrite-holder",
      undefined,
      tx,
    );
    holder.setRaw({ target: redirect });
    const link = holder.key("target").getAsNormalizedFullLink();

    const preserved = resolveLink(runtime, tx, link, "writeRedirect", {
      preserveOverwrite: true,
    });
    const dropped = resolveLink(runtime, tx, link, "writeRedirect");

    expect(preserved.overwrite).toBe("redirect");
    // The key is deleted, not set to `undefined`, and a result carrying
    // `overwrite: undefined` is a shape a reader spreading it into a link
    // would carry along. `Object.hasOwn` is what decides that: reading the
    // property answers `undefined` either way, and `toHaveProperty` counts a
    // present-but-undefined key as absent.
    expect(Object.hasOwn(dropped, "overwrite")).toBe(false);
  });

  it("hands back the traces the transaction recorded for this resolution", () => {
    const { holder } = linkingCell("returned-holder", "returned-target");
    const link = holder.key("target").getAsNormalizedFullLink();

    const before = traceCount();
    const { traces } = resolveLinkTracingDereferences(runtime, tx, link);
    const recorded = tx.getCfcState().dereferenceTraces.slice(before);

    expect(traces.length).toBe(1);
    expect(traces).toEqual(recorded);
  });

  it("hands back the same traces on a memoized resolution", () => {
    const { holder } = linkingCell("returned2-holder", "returned2-target");
    const link = holder.key("target").getAsNormalizedFullLink();

    const first = resolveLinkTracingDereferences(runtime, tx, link);
    const before = traceCount();
    const second = resolveLinkTracingDereferences(runtime, tx, link);

    expect(second.traces).toEqual(first.traces);
    expect(tx.getCfcState().dereferenceTraces.slice(before)).toEqual(
      second.traces,
    );
  });

  it("kicks the cross-space pull again for a memoized resolution", async () => {
    // A transaction opens a writer for one space at a time, so the other
    // space's document is written in its own.
    const otherTx = runtime.edit();
    const target = runtime.getCell<{ value: string }>(
      otherSpace,
      "cross-space-target",
      undefined,
      otherTx,
    );
    target.set({ value: "over there" });
    await otherTx.commit().settled;
    const holder = runtime.getCell<{ target: unknown }>(
      space,
      "cross-space-holder",
      undefined,
      tx,
    );
    holder.setRaw({ target: target.key("value").getAsLink() });
    const link = holder.key("target").getAsNormalizedFullLink();
    // The origin server never pushes other-space documents, so the kick is
    // unreserved and fires on every resolution. A memoized one has to fire it
    // too, or a reader whose first resolution predates the arrival never asks
    // again.
    const kicks: unknown[] = [];
    const manager = runtime.storageManager as {
      trackUntilSettled: (work: Promise<unknown>) => void;
    };
    const tracked = manager.trackUntilSettled.bind(manager);
    manager.trackUntilSettled = (work) => {
      kicks.push(work);
      tracked(work);
    };
    try {
      resolveLink(runtime, tx, link);
      const afterFirst = kicks.length;
      resolveLink(runtime, tx, link);

      expect(afterFirst).toBeGreaterThan(0);
      expect(kicks.length).toBeGreaterThan(afterFirst);
    } finally {
      manager.trackUntilSettled = tracked;
    }
  });

  it("reads a document's stored labels once per dereference target", () => {
    const { holder } = linkingCell("labels-holder", "labels-target");
    const link = holder.key("target").getAsNormalizedFullLink();
    const { traces } = resolveLinkTracingDereferences(runtime, tx, link);

    cfcLabelViewForDereferenceTraces(tx, traces);
    const afterFirst = cfcMetadataReadCount();
    cfcLabelViewForDereferenceTraces(tx, traces);

    // One dereference names two addresses, and the first derivation read both.
    expect(afterFirst).toBeGreaterThan(0);
    expect(cfcMetadataReadCount()).toBe(afterFirst);
  });

  it("keeps the label views of two paths in one document apart", () => {
    const labeled = runtime.getCell(space, "labeled-doc", undefined, tx);
    const link = labeled.getAsNormalizedFullLink();
    seedStoredEnvelope(tx, {
      space,
      id: link.id,
      type: "application/json",
      path: [],
    }, {
      value: { a: "under a", b: "under b" },
      cfc: {
        version: 1,
        schemaHash: "test-schema",
        labelMap: {
          version: 1,
          entries: [
            { path: ["a"], label: { confidentiality: ["secret-a"] } },
            { path: ["b"], label: { confidentiality: ["secret-b"] } },
          ],
        },
      },
    });
    const at = (path: string[]) => ({
      space,
      id: link.id,
      scope: link.scope,
      path,
    });

    // A view is rebased onto the address it was asked for, so the same
    // document answers differently at each path.
    const viaA = cfcLabelViewForDereference(tx, at(["a"]), at(["a"]));
    const viaB = cfcLabelViewForDereference(tx, at(["b"]), at(["b"]));

    expect(viaA?.entries[0].label.confidentiality).toEqual(["secret-a"]);
    expect(viaB?.entries[0].label.confidentiality).toEqual(["secret-b"]);
  });

  it("re-reads a document's stored labels after a write", () => {
    const { holder } = linkingCell("labels2-holder", "labels2-target");
    const link = holder.key("target").getAsNormalizedFullLink();
    const { traces } = resolveLinkTracingDereferences(runtime, tx, link);

    cfcLabelViewForDereferenceTraces(tx, traces);
    const afterFirst = cfcMetadataReadCount();
    holder.setRaw({ target: "no longer a link" });
    cfcLabelViewForDereferenceTraces(tx, traces);

    expect(cfcMetadataReadCount()).toBeGreaterThan(afterFirst);
  });

  it("reads for real inside an ambient-read-meta scope", () => {
    const { holder } = linkingCell("ambient-holder", "ambient-target");
    const link = holder.key("target").getAsNormalizedFullLink();

    resolveLink(runtime, tx, link);
    const afterFirst = readCount();
    // The scope tags the reads it issues, and label derivation reads those
    // tags, so a resolution inside it cannot be served from an entry made
    // outside it.
    tx.runWithAmbientReadMeta(machineryRead, () => {
      resolveLink(runtime, tx, link);
    });

    expect(readCount()).toBeGreaterThan(afterFirst);
  });

  it("reads for real again after a blind UI-input write mode ends", () => {
    const { holder } = linkingCell("blind-holder", "blind-target");
    const link = holder.key("target").getAsNormalizedFullLink();

    // While marked, every read is journaled without a value-equality commit
    // precondition. An entry made under the mark must not stand in for the
    // reads a resolution after it is supposed to make.
    markUiInputBlindWriteTx(tx);
    resolveLink(runtime, tx, link);
    unmarkUiInputBlindWriteTx(tx);
    const afterBlind = readCount();
    resolveLink(runtime, tx, link);

    expect(readCount()).toBeGreaterThan(afterBlind);
  });

  it("reads for real after the narrowest read scope is reset", () => {
    const { holder } = linkingCell("reset-holder", "reset-target");
    const link = holder.key("target").getAsNormalizedFullLink();

    resolveLink(runtime, tx, link);
    const afterFirst = readCount();
    // The caller is about to take the scope of what it reads next; a
    // resolution that issued no reads would leave that answer too wide.
    tx.resetNarrowestReadScope();
    resolveLink(runtime, tx, link);

    expect(readCount()).toBeGreaterThan(afterFirst);
  });

  it("reads for real through a non-reactive transaction wrapper", () => {
    const { holder } = linkingCell("sample-holder", "sample-target");
    const link = holder.key("target").getAsNormalizedFullLink();

    // The wrapper marks its reads as ignored for scheduling. Serving them from
    // an entry a reactive resolution made would journal the reactive ones in
    // their place, and serving a reactive read from the wrapper's entry would
    // lose the dependency.
    resolveLink(runtime, tx, link);
    const afterFirst = readCount();
    const nonReactive = createNonReactiveTransaction(tx);
    resolveLink(runtime, nonReactive, link);

    expect(readCount()).toBeGreaterThan(afterFirst);
  });

  it("stops serving what it resolved once the transaction has finished", async () => {
    const { holder, target } = linkingCell("closed-holder", "closed-target");
    const link = holder.key("target").getAsNormalizedFullLink();

    expect(resolveLink(runtime, tx, link).id).toBe(
      target.getAsNormalizedFullLink().id,
    );
    await tx.commit().settled;

    // A finished transaction answers no reads, so it must not answer with what
    // it saw while it was open. Resolution falls through to a walk that finds
    // no link and leaves the address where it started.
    const afterCommit = resolveLink(runtime, tx, link);
    expect(afterCommit.id).toBe(holder.getAsNormalizedFullLink().id);
    expect(afterCommit.path).toEqual(["target"]);

    tx = runtime.edit();
  });

  describe("proxy views", () => {
    /** A list of links to one-field documents -- the shape a lift scans. */
    const linkedList = (cause: string, length: number) => {
      const entries = [];
      for (let index = 0; index < length; index++) {
        const entry = runtime.getCell<{ title: string }>(
          space,
          `${cause}-entry-${index}`,
          undefined,
          tx,
        );
        entry.set({ title: `Entry ${index}` });
        entries.push(entry);
      }
      const list = runtime.getCell<unknown[]>(space, cause, undefined, tx);
      list.set(entries as never);
      return list;
    };

    it("issues no further reads for an element already read in the transaction", () => {
      const list = linkedList("read-once", 3);
      const view = list.get() as unknown[];

      void view[0];
      const afterFirst = readCount();
      void view[0];

      expect(afterFirst).toBeGreaterThan(0);
      expect(readCount()).toBe(afterFirst);
    });

    it("returns the same element view on a repeated read", () => {
      const list = linkedList("same-view", 3);
      const view = list.get() as unknown[];

      expect(view[1]).toBe(view[1]);
    });

    it("reads a leaf value once per element in the transaction", () => {
      const list = linkedList("leaf-once", 3);
      const view = list.get() as { title: string }[];

      expect(view[2].title).toBe("Entry 2");
      const afterFirst = readCount();

      expect(view[2].title).toBe("Entry 2");
      expect(readCount()).toBe(afterFirst);
    });

    it("reads the new value after a write in the same transaction", () => {
      const list = linkedList("rewrite", 2);
      const view = list.get() as { title: string }[];
      expect(view[0].title).toBe("Entry 0");

      runtime.getCell<{ title: string }>(
        space,
        "rewrite-entry-0",
        undefined,
        tx,
      )
        .key("title").set("Edited");

      expect(view[0].title).toBe("Edited");
    });

    it("hands two readers of one element the same view", () => {
      const list = linkedList("shared", 2);
      const link = list.getAsNormalizedFullLink();
      const first = createQueryResultProxy<unknown[]>(runtime, tx, link);
      const second = createQueryResultProxy<unknown[]>(runtime, tx, link);

      // Consumers compare element views by identity -- FUSE matching a
      // callable against its own entry, a value whose element points back at
      // the array holding it. The index must hand back what the proxy cache
      // under it would, not a second object for the same element.
      expect(second[0]).toBe(first[0]);
    });

    it("reads the new value through a later transaction", async () => {
      linkedList("later", 2);
      const read = (of: IExtendedStorageTransaction) =>
        (runtime.getCell<{ title: string }[]>(space, "later", undefined, of)
          .get())[0].title;

      expect(read(tx)).toBe("Entry 0");
      await tx.commit().settled;

      // Each transaction memoizes for itself. A view taken in one is not an
      // answer any later one may give.
      tx = runtime.edit();
      runtime.getCell<{ title: string }>(space, "later-entry-0", undefined, tx)
        .key("title").set("Edited");

      expect(read(tx)).toBe("Edited");
    });
  });
});
