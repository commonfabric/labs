import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";

import { componentReadSchema } from "../src/component-read-contract.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  collectViewRenderReads,
  ViewRenderWalkMemo,
} from "../src/view-render-reads.ts";

const signer = await Identity.fromPassphrase("view renderer reads");
const space = signer.did();

describe("view render reads", () => {
  it("reads visible bindings and children without following fields outside the rendered UI", async () => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
    });
    try {
      const draft = runtime.getCell<string>(space, "draft", { type: "string" });
      const hidden = runtime.getCell<string>(space, "hidden", {
        type: "string",
      });
      const label = runtime.getCell<string>(space, "label", { type: "string" });
      const payloadLabel = runtime.getCell<string>(space, "payload label", {
        type: "string",
      });
      const payload = runtime.getCell(space, "attribute payload", {
        type: "object",
        properties: { label: { type: "string" } },
      });
      const event = runtime.getCell<unknown>(space, "click event", {
        asCell: ["stream"],
      });
      const root = runtime.getCell(space, "view", undefined);
      await runtime.editWithRetry((tx) => {
        draft.withTx(tx).set("text");
        hidden.withTx(tx).set("secret");
        label.withTx(tx).set("visible");
        payloadLabel.withTx(tx).set("payload only");
        payload.withTx(tx).set({ label: payloadLabel });
        root.withTx(tx).set({
          $UI: {
            type: "vnode",
            name: "cf-input",
            props: {
              $value: draft,
              title: label,
              "@payload": payload,
              onClick: event,
            },
            children: [label],
          },
          offscreen: hidden,
        });
      });
      const result = collectViewRenderReads(
        runtime,
        space,
        {
          id: "view",
          revision: 0,
          mode: "speculate",
          componentContractVersion: "1",
          query: {
            roots: [{
              id: root.getAsNormalizedFullLink().id,
              selector: { path: [] },
            }],
          },
        },
        runtime.scopeKeyIdentity,
      );
      expect(result.bindings.map((read) => read.id)).toContain(
        draft.getAsNormalizedFullLink().id,
      );
      const readIds = result.reads.map((read) => read.id);
      expect(readIds).toContain(draft.getAsNormalizedFullLink().id);
      expect(readIds).toContain(label.getAsNormalizedFullLink().id);
      expect(readIds).toContain(payload.getAsNormalizedFullLink().id);
      expect(readIds).toContain(payloadLabel.getAsNormalizedFullLink().id);
      expect(readIds).not.toContain(hidden.getAsNormalizedFullLink().id);
      expect(result.streams.map((stream) => stream.id)).toContain(
        event.getAsNormalizedFullLink().id,
      );
      expect(result.streams.map((stream) => stream.id)).not.toContain(
        payload.getAsNormalizedFullLink().id,
      );
    } finally {
      await runtime.storageManager.synced();
      await runtime.dispose();
    }
  });

  it("walks again only the cells whose documents changed when given a memo", async () => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
    });
    try {
      const label = runtime.getCell(space, "memo label", undefined);
      const other = runtime.getCell(space, "memo other", undefined);
      const root = runtime.getCell(space, "memo root", undefined);
      await runtime.editWithRetry((tx) => {
        label.withTx(tx).set("one");
        other.withTx(tx).set("two");
        root.withTx(tx).set({
          type: "vnode",
          name: "div",
          props: {},
          children: [
            { type: "vnode", name: "span", props: {}, children: [label] },
            { type: "vnode", name: "span", props: {}, children: [other] },
          ],
        });
      });
      const view = {
        id: "memo",
        revision: 0,
        mode: "speculate" as const,
        componentContractVersion: "1",
        query: {
          roots: [{
            id: root.getAsNormalizedFullLink().id,
            selector: { path: [] },
          }],
        },
      };
      const memo = new ViewRenderWalkMemo(runtime.scopeKeyIdentity);
      runtime.storageManager.subscribe({
        next: (notification) => {
          memo.notify(notification);
          return { done: false };
        },
      });
      const first = collectViewRenderReads(
        runtime,
        space,
        view,
        runtime.scopeKeyIdentity,
        memo,
      );
      // The root, each child node the renderer schema hands back as a cell
      // of the root's document, and the two cells those nodes hold.
      expect(memo.accessForTestingOnly.walked).toBe(5);
      const again = collectViewRenderReads(
        runtime,
        space,
        view,
        runtime.scopeKeyIdentity,
        memo,
      );
      expect(memo.accessForTestingOnly.walked).toBe(5);
      expect(again).toEqual(first);

      await runtime.editWithRetry((tx) => label.withTx(tx).set("changed"));
      await runtime.idle();
      const afterChange = collectViewRenderReads(
        runtime,
        space,
        view,
        runtime.scopeKeyIdentity,
        memo,
      );
      // Only the cell whose document changed, and the node holding it, whose
      // read resolved the link to that document, were walked again; the
      // walk reads what a walk without the memo reads.
      expect(memo.accessForTestingOnly.walked).toBe(7);
      const fresh = collectViewRenderReads(
        runtime,
        space,
        view,
        runtime.scopeKeyIdentity,
      );
      // The order the reads come in follows the schema traversal, which a
      // repeated walk may take differently; the set is what the plan uses.
      const keyed = (
        reads: readonly { id: string; path: readonly string[] }[],
      ) => reads.map((read) => `${read.id} ${read.path.join("/")}`).toSorted();
      expect(keyed(afterChange.reads)).toEqual(keyed(fresh.reads));
      expect(keyed(afterChange.shallowReads)).toEqual(
        keyed(fresh.shallowReads),
      );
      expect(afterChange.bindings).toEqual(fresh.bindings);
      expect(afterChange.streams).toEqual(fresh.streams);
    } finally {
      await runtime.storageManager.synced();
      await runtime.dispose();
    }
  });

  it("forgets the cells a later walk no longer reaches", async () => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
    });
    try {
      const kept = runtime.getCell(space, "prune kept", undefined);
      const dropped = runtime.getCell(space, "prune dropped", undefined);
      const root = runtime.getCell(space, "prune root", undefined);
      await runtime.editWithRetry((tx) => {
        kept.withTx(tx).set("kept");
        dropped.withTx(tx).set("dropped");
        root.withTx(tx).set({
          type: "vnode",
          name: "div",
          props: {},
          children: [kept, dropped],
        });
      });
      const view = {
        id: "prune",
        revision: 0,
        mode: "speculate" as const,
        componentContractVersion: "1",
        query: {
          roots: [{
            id: root.getAsNormalizedFullLink().id,
            selector: { path: [] },
          }],
        },
      };
      const memo = new ViewRenderWalkMemo(runtime.scopeKeyIdentity);
      runtime.storageManager.subscribe({
        next: (notification) => {
          memo.notify(notification);
          return { done: false };
        },
      });
      collectViewRenderReads(
        runtime,
        space,
        view,
        runtime.scopeKeyIdentity,
        memo,
      );
      const before = memo.accessForTestingOnly.size;

      await runtime.editWithRetry((tx) =>
        root.withTx(tx).set({
          type: "vnode",
          name: "div",
          props: {},
          children: [kept],
        })
      );
      await runtime.idle();
      const after = collectViewRenderReads(
        runtime,
        space,
        view,
        runtime.scopeKeyIdentity,
        memo,
      );
      expect(after.reads.map((read) => read.id)).not.toContain(
        dropped.getAsNormalizedFullLink().id,
      );
      expect(memo.accessForTestingOnly.size).toBeLessThan(before);
    } finally {
      await runtime.storageManager.synced();
      await runtime.dispose();
    }
  });

  it("walks nested visible arrays and inline object properties", async () => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
    });
    try {
      const label = runtime.getCell(space, "array label", undefined);
      const property = runtime.getCell(space, "property label", undefined);
      const hidden = runtime.getCell(space, "offscreen label", undefined);
      const root = runtime.getCell(space, "array root", undefined);
      await runtime.editWithRetry((tx) => {
        label.withTx(tx).set("visible");
        property.withTx(tx).set("payload");
        hidden.withTx(tx).set("offscreen");
        root.withTx(tx).set([[{
          type: "vnode",
          name: "div",
          offscreen: hidden,
          props: { payload: { nested: property }, style: { color: "red" } },
        }], label]);
      });
      const result = collectViewRenderReads(runtime, space, {
        id: "arrays",
        revision: 0,
        mode: "speculate",
        componentContractVersion: "1",
        query: {
          roots: [{
            id: root.getAsNormalizedFullLink().id,
            selector: { path: [] },
          }, { id: root.getAsNormalizedFullLink().id, selector: { path: [] } }],
        },
      }, runtime.scopeKeyIdentity);
      expect(result.reads.map((read) => read.id)).toContain(
        label.getAsNormalizedFullLink().id,
      );
      expect(result.reads.map((read) => read.id)).not.toContain(
        hidden.getAsNormalizedFullLink().id,
      );
      expect(result.reads.map((read) => read.id)).toContain(
        property.getAsNormalizedFullLink().id,
      );
      expect(result.bindings).toEqual([]);
      expect(result.streams).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("reads the `[UI]` of a piece a root reaches through a narrowly typed link", async () => {
    // The holder's link carries a stored schema naming `about` and not
    // `[UI]`, and the piece's `[UI]` lives in a document of its own, so the
    // reads contain that document exactly when the walk read `[UI]`.

    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
    });
    try {
      const ui = runtime.getCell(space, "narrow ui", undefined);
      const piece = runtime.getCell(space, "narrow piece", undefined);
      const holder = runtime.getCell(space, "narrow holder", undefined);
      await runtime.editWithRetry((tx) => {
        ui.withTx(tx).set({
          type: "vnode",
          name: "p",
          props: {},
          children: ["Room"],
        });
        piece.withTx(tx).setRaw({ about: "Room", $UI: ui.getAsLink() });
        const link = piece.getAsNormalizedFullLink();
        holder.withTx(tx).setRaw(
          linkRefFrom({
            id: link.id,
            space: link.space,
            scope: link.scope,
            path: [...link.path],
            schema: {
              type: "object",
              properties: { about: { type: "string" } },
            },
          }) as never,
        );
      });

      const result = collectViewRenderReads(runtime, space, {
        id: "narrow",
        revision: 0,
        mode: "speculate",
        componentContractVersion: "1",
        query: {
          roots: [{
            id: holder.getAsNormalizedFullLink().id,
            selector: { path: [] },
          }],
        },
      }, runtime.scopeKeyIdentity);

      expect(result.reads.map((read) => read.id)).toContain(
        ui.getAsNormalizedFullLink().id,
      );
    } finally {
      await runtime.storageManager.synced();
      await runtime.dispose();
    }
  });

  it("returns no binding contract for an undeclared component property", () => {
    expect(
      componentReadSchema("custom-component", "value", { type: "string" }, {}),
    ).toBeUndefined();
    expect(componentReadSchema("cf-input", "unknown", { type: "string" }, {}))
      .toBeUndefined();
    expect(componentReadSchema("cf-input", "value", { type: "string" }, {}))
      .toEqual({ type: "string" });
  });
});
