import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { CfcConfClause } from "@commonfabric/memory/v2/cfc-release-authority";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("array element handle");
const A = { type: "https://commonfabric.org/cfc/atom/User", subject: "A" };
const B = { type: "https://commonfabric.org/cfc/atom/User", subject: "B" };

describe("resolveAsCell()", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let writer: Runtime;
  const readers: Runtime[] = [];

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    writer = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: storage,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    for (const reader of readers.splice(0)) await reader.dispose();
    await writer.dispose();
    await storage.close();
  });

  const readerFor = (ceiling: readonly CfcConfClause[]) => {
    const reader = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: storage,
      cfcReadMaxConfidentiality: ceiling,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    readers.push(reader);
    return reader;
  };

  // A handle into an array element is named by a snapshot of the element,
  // whose id is derived from the element's content. A reader the read
  // ceiling withholds the document from must learn nothing of that content,
  // so its handle names the element by the path it was reached through.

  const seedList = async () => {
    const tx = writer.edit();
    const cell = writer.getCell(signer.did(), crypto.randomUUID(), {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object", properties: { x: { type: "number" } } },
        },
      },
      ifc: { confidentiality: [B] },
    }, tx);
    cell.setRaw({ items: [{ x: 1 }] });
    expect((await tx.commit().settled).error).toBeUndefined();
    await cell.sync();
    return cell.getAsNormalizedFullLink();
  };

  const elementHandle = async (
    ceiling: readonly CfcConfClause[],
    link: Awaited<ReturnType<typeof seedList>>,
  ) => {
    const reader = readerFor(ceiling);
    const list = reader.getCellFromLink(link);
    await list.sync();
    return list.key("items").key(0).key("x").resolveAsCell();
  };

  it("names an element by its path for a reader the ceiling withholds the document from", async () => {
    const link = await seedList();

    const handle = await elementHandle([A], link);

    expect(handle.getAsNormalizedFullLink()).toMatchObject({
      id: link.id,
      path: ["items", "0", "x"],
    });
    expect(() => handle.get()).toThrow(
      "the runtime read ceiling withholds this value",
    );
  });

  it("names an element by a snapshot of its content for a reader the ceiling admits", async () => {
    const link = await seedList();

    const handle = await elementHandle([B], link);

    const named = handle.getAsNormalizedFullLink();
    expect(named.id).not.toBe(link.id);
    expect(named.id.startsWith("snapshot:")).toBe(true);
    expect(named.path).toEqual(["x"]);
    expect(handle.get()).toBe(1);
  });
});
