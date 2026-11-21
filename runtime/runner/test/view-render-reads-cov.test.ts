import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { collectViewRenderReads } from "../src/view-render-reads.ts";

const signer = await Identity.fromPassphrase("view render reads props");
const space = signer.did();

const walk = async (name: string, value: unknown) => {
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: StorageManager.emulate({ as: signer }),
  });
  try {
    const root = runtime.getCell<unknown>(space, name, undefined);
    await runtime.editWithRetry((tx) => root.withTx(tx).set(value));
    const id = root.getAsNormalizedFullLink().id;
    const result = collectViewRenderReads(
      runtime,
      space,
      {
        id: "view",
        revision: 0,
        mode: "speculate",
        componentContractVersion: "1",
        query: { roots: [{ id, selector: { path: [] } }] },
      },
      runtime.scopeKeyIdentity,
    );
    return {
      id,
      streams: result.streams.map((link) => ({ id: link.id, path: link.path })),
      bindings: result.bindings.map((read) => ({
        id: read.id,
        path: read.path,
      })),
    };
  } finally {
    await runtime.storageManager.synced();
    await runtime.dispose();
  }
};

describe("collectViewRenderReads()", () => {
  it("reports an event or binding prop holding a plain value at its own position in the props", async () => {
    const { id, streams, bindings } = await walk("plain props", {
      type: "vnode",
      name: "div",
      props: { onClick: "handler", $checked: true, title: "shown" },
    });

    expect(streams).toEqual([
      { id, path: ["props", "onClick"] },
      { id, path: ["props", "$checked"] },
    ]);
    expect(bindings).toEqual([{ id, path: ["value", "props", "$checked"] }]);
  });

  it("reports no stream or binding for a node with no props", async () => {
    const { streams, bindings } = await walk("no props", {
      type: "vnode",
      name: "div",
      children: ["text"],
    });

    expect(streams).toEqual([]);
    expect(bindings).toEqual([]);
  });
});
