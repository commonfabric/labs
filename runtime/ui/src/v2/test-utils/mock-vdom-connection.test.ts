import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { createRenderableCellHandle } from "./mock-vdom-connection.ts";

describe("createRenderableCellHandle()", () => {
  it("returns a handle on the asked ref, holding the value given", () => {
    const { cell } = createRenderableCellHandle({ a: 1 }, { id: "of:asked" });
    expect(cell.ref().id).toBe("of:asked");
    expect(cell.lastRead()).toEqual({ value: { a: 1 } });
  });

  it("returns a handle that has read nothing when given no value", () => {
    const { cell } = createRenderableCellHandle();
    expect(cell.lastRead()).toEqual({ unread: true });
  });

  it("returns a handle whose runtime finds no piece to open", async () => {
    const { cell } = createRenderableCellHandle({ a: 1 });
    expect(await cell.runtime().getPiece(cell.id(), cell.space(), true))
      .toBeNull();
  });
});
