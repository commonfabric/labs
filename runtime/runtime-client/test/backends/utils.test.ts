import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { createCellRef } from "@/backends/utils.ts";

const signer = await Identity.fromPassphrase("backend utils cell refs");
const space = signer.did();

describe("createCellRef()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL("http://localhost"),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("names the cell's document, space, scope and path", () => {
    const cell = runtime.getCell(space, "named document").key("a").key("b");
    const ref = createCellRef(cell);
    const { id } = cell.getAsNormalizedFullLink();

    expect(ref).toEqual({ id, space, scope: "space", path: ["a", "b"] });
  });

  it("keeps the scope of a cell that is not space-scoped", () => {
    const { id } = runtime.getCell(space, "scoped document")
      .getAsNormalizedFullLink();
    const userCell = runtime.getCellFromLink({
      id,
      space,
      scope: "user",
      path: ["x"],
    });
    const spaceCell = runtime.getCellFromLink({
      id,
      space,
      scope: "space",
      path: ["x"],
    });

    expect(createCellRef(userCell)).toEqual({
      id,
      space,
      scope: "user",
      path: ["x"],
    });
    expect(createCellRef(spaceCell).scope).toBe("space");
  });

  it("carries no overwrite, even for a cell reached by a write redirect", () => {
    const { id } = runtime.getCell(space, "redirected document")
      .getAsNormalizedFullLink();
    const cell = runtime.getCellFromLink({
      id,
      space,
      scope: "space",
      path: [],
      overwrite: "redirect",
    });

    const ref = createCellRef(cell);
    expect(ref).toEqual({ id, space, scope: "space", path: [] });
    expect("overwrite" in ref).toBe(false);
  });

  it("sends the schema it is given in place of the cell's own", () => {
    const typed = runtime.getCell(space, "typed document", { type: "number" });
    const untyped = runtime.getCell(space, "untyped document");

    expect(createCellRef(typed).schema).toBeDefined();
    expect(createCellRef(untyped).schema).toBeUndefined();
    expect(createCellRef(typed, { type: "string" }).schema).toEqual({
      type: "string",
    });
  });
});
