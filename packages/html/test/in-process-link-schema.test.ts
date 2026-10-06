import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { type JSONSchema, Runtime, UI } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { renderInProcess } from "../src/in-process.ts";
import { MockDoc } from "../src/mock-doc.ts";

const signer = await Identity.fromPassphrase("in-process link schema");
const space = signer.did();

/** A narrow view of a piece, which names one of its keys and not `[UI]`. */
const narrowSchema = {
  type: "object",
  properties: { about: { type: "string" } },
} as const satisfies JSONSchema;

describe("in-process-link-schema", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await storageManager.synced();
    await runtime.dispose();
    await storageManager.close();
  });

  it("renders the `[UI]` of a piece mounted through a narrowly typed link", async () => {
    const tx = runtime.edit();
    const piece = runtime.getCell(space, "piece", undefined, tx);
    piece.setRaw({
      about: "Room",
      [UI]: { type: "vnode", name: "p", props: {}, children: ["Room"] },
    });
    const link = piece.getAsNormalizedFullLink();
    const holder = runtime.getCell(space, "holder", undefined, tx);
    holder.setRaw(
      linkRefFrom({
        id: link.id,
        space: link.space,
        scope: link.scope,
        path: [...link.path],
        schema: narrowSchema,
      }) as never,
    );
    await tx.commit().settled;
    const mock = new MockDoc(
      '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
    );
    const container = mock.document.getElementById("root")!;
    const errors: Error[] = [];

    const render = renderInProcess(container, holder.withTx(undefined), {
      document: mock.document,
      setProp: mock.renderOptions.setProp,
      onError: (error) => errors.push(error),
    });
    await runtime.idle();
    render.flush();
    const html = container.innerHTML;
    render.cancel();

    expect(errors).toEqual([]);
    expect(html).toBe("<p>Room</p>");
  });
});
