import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { componentReadSchema } from "../src/component-read-contract.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { collectViewRenderReads } from "../src/view-render-reads.ts";

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
