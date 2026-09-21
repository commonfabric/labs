import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CellHandle, type CellRef } from "@commonfabric/runtime-client";

import { createMockCellHandle, pushUpdate } from "./mock-cell-handle.ts";

describe("mock-cell-handle", () => {
  it("reads the current worker value through a stale root or nested handle", async () => {
    const root = createMockCellHandle({ draft: { text: "initial" } });
    const child = root.key("draft").key("text");
    const stale = new CellHandle(root.runtime(), root.ref(), {
      draft: { text: "stale" },
    });
    await child.setForUI("hello");
    expect(await stale.sync()).toEqual({ draft: { text: "hello" } });
    expect(await child.sync()).toBe("hello");
    pushUpdate(root, { draft: { text: "remote" } });
    expect(await child.sync()).toBe("remote");
  });

  it("returns undefined for a nested read beneath a missing parent", async () => {
    const root = createMockCellHandle<{ draft?: { text: string } }>({});
    const draft = root.key("draft").asSchema<{ text: string }>({
      type: "object",
      properties: { text: { type: "string" } },
    });
    expect(await draft.key("text").sync()).toBeUndefined();
  });

  it("keeps a linked target's write separate from the mock root", async () => {
    const root = createMockCellHandle({
      piece: { $link: { id: "of:target", path: [], space: "did:key:mock" } },
    });
    const target = await root.key("piece").resolveAsCell();
    expect(target.ref().id).toBe("of:target");
    await target.asSchema<string>({ type: "string" }).setForUI("hello");
    expect(await target.sync()).toBeUndefined();
    expect(root.get()?.piece.$link.id).toBe("of:target");
  });

  it("leaves a primitive root intact when an invalid nested reference writes", async () => {
    const root = createMockCellHandle("initial");
    const ref: CellRef = { ...root.ref(), path: ["missing"] };
    const child = new CellHandle<string>(root.runtime(), ref);
    await child.setForUI("hello");
    expect(root.get()).toBe("initial");
    expect(await child.sync()).toBeUndefined();
  });
});
