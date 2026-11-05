import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { createSession, Identity } from "@commonfabric/identity";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import type { Cell } from "../../runner/src/builder/types.ts";

import { PiecesController } from "../src/ops/pieces-controller.ts";
import { installCustomRoot } from "./install-custom-root.ts";

const identity = await Identity.fromPassphrase("Home recreation protection");
const program: RuntimeProgram = {
  main: "/home.tsx",
  files: [{
    name: "/home.tsx",
    contents: `
import { pattern, Writable } from "commonfabric";
export default pattern(() => {
  const saved = new Writable({ favorite: "retained" }).for("account");
  return { saved };
});`,
  }],
};

// An identity Home is created once, on first open, and changed only in place.
// Nothing here may create, replace or unlink its root, however the space is
// found: absent, installed, or pointing at a target that will not load.
describe("Home root recreation", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let controller: PiecesController;

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: identity });
    runtime = new Runtime({
      apiUrl: new URL("https://home.example"),
      storageManager: storage,
      experimental: { serverExecution: false },
    });
    controller = new PiecesController(
      createSession({
        identity,
        spaceDid: identity.did(),
      }),
      runtime,
    );
    await controller.synced();
  });

  afterEach(async () => {
    await controller.dispose();
    await storage.close();
  });

  it("refuses to create a Home, before compiling or writing anything", async () => {
    using compiled = spy(runtime.patternManager, "compilePattern");
    using edited = spy(runtime, "editWithRetry");
    for (const options of [undefined, { customProgram: program }]) {
      await expect(controller.recreateDefaultPattern(options)).rejects
        .toThrow("Cannot recreate an identity Home root");
    }
    expect(compiled.calls).toHaveLength(0);
    expect(edited.calls).toHaveLength(0);
    expect(await controller.getDefaultPattern(false)).toBeUndefined();
    expect(controller.getSpaceCellContents().key("defaultPattern").getRaw())
      .toBeUndefined();
  });

  it("refuses to replace an existing Home, before stopping or compiling it", async () => {
    const home = await installCustomRoot(runtime, controller, program);
    const before = await home.asSchema(true).pull();
    expect(before).toMatchObject({ saved: { favorite: "retained" } });
    using stopped = spy(runtime.runner, "stop");
    using compiled = spy(runtime.patternManager, "compilePattern");
    for (const options of [undefined, { customProgram: program }]) {
      await expect(controller.recreateDefaultPattern(options)).rejects
        .toThrow("Cannot recreate an identity Home root");
      expect((await controller.getDefaultPattern(false))?.equals(home))
        .toBe(true);
      expect(home.asSchema(true).get()).toEqual(before);
    }
    expect(stopped.calls).toHaveLength(0);
    expect(compiled.calls).toHaveLength(0);
  });

  it("protects an existing root pointer whose target has no loaded value", async () => {
    const unavailable = runtime.getCell(identity.did(), "unavailable-home");
    await controller.linkDefaultPattern(unavailable);
    const root = controller.getSpaceCellContents().key("defaultPattern");
    const before = root.getRaw();
    expect(before).toBeDefined();
    await expect(controller.recreateDefaultPattern({ customProgram: program }))
      .rejects.toThrow("Cannot recreate an identity Home root");
    const other = runtime.getCell(identity.did(), "another-home");
    await expect(controller.linkDefaultPattern(other)).rejects.toThrow(
      "Cannot replace an identity Home root",
    );
    expect(root.getRaw()).toEqual(before);
  });

  it("refuses to link another root over a Home's", async () => {
    // Linking is how a root comes to be, so it is refused only once a Home
    // holds one: the low-level replace is the same drop as recreation.
    const home = await installCustomRoot(runtime, controller, program);
    const other = runtime.getCell(identity.did(), "another-home");
    await expect(controller.linkDefaultPattern(other)).rejects.toThrow(
      "Cannot replace an identity Home root",
    );
    expect((await controller.getDefaultPattern(false))?.equals(home)).toBe(
      true,
    );
  });

  it("refuses to unlink a Home root", async () => {
    // The low-level unlink is the one public door left that could drop the
    // pointer without replacing it, so it carries the same refusal.
    await installCustomRoot(runtime, controller, program);
    const root = controller.getSpaceCellContents().key("defaultPattern");
    const before = root.getRaw();
    expect(before).toBeDefined();
    await expect(controller.unlinkDefaultPattern()).rejects.toThrow(
      "Cannot unlink an identity Home root",
    );
    expect(root.getRaw()).toEqual(before);
  });

  /** A root that lists its pieces in a writable registry, as a custom Home may. */
  function registryRoot() {
    const { commonfabric: { handler, pattern } } = createBuilder();
    const addPiece = handler<
      { piece: Cell<unknown> },
      { pieceRegistry: Cell<Cell<unknown>[]> }
    >(
      true,
      {
        type: "object",
        properties: { pieceRegistry: { type: "array", asCell: ["cell"] } },
      },
      ({ piece }, { pieceRegistry }) => {
        pieceRegistry.push(piece);
      },
    );
    return pattern<{ pieceRegistry: Cell<unknown>[] }>(
      ({ pieceRegistry }) => ({
        pieceRegistry,
        addPiece: addPiece({ pieceRegistry }),
      }),
    );
  }

  it("refuses to remove a Home's own root from its registry", async () => {
    // A registry that lists the root makes ordinary piece removal a way to
    // drop the root pointer, so that removal carries the unlink refusal.
    const root = await controller.runPersistent(
      registryRoot(),
      { pieceRegistry: [] },
      "registry-home",
    );
    await controller.linkDefaultPattern(root);
    await runtime.idle();
    await controller.synced();
    await controller.add([root]);
    await runtime.idle();
    await controller.synced();
    const pointer = controller.getSpaceCellContents().key("defaultPattern");
    const before = pointer.getRaw();
    expect(before).toBeDefined();
    await expect(controller.remove(root)).rejects.toThrow(
      "Cannot unlink an identity Home root",
    );
    expect(pointer.getRaw()).toEqual(before);
    expect((await controller.getDefaultPattern(false))?.equals(root)).toBe(
      true,
    );
    const registry = await controller.getPieceRegistry();
    expect(registry.get().some((member) => member.equals(root))).toBe(true);
  });

  it("still removes a space's own root from its registry when the space is not a Home", async () => {
    const other = new PiecesController(
      createSession({ identity, spaceDid: await runtime.createSpace() }),
      runtime,
    );
    try {
      await other.synced();
      const root = await other.runPersistent(
        registryRoot(),
        { pieceRegistry: [] },
        "registry-root",
      );
      await other.linkDefaultPattern(root);
      await runtime.idle();
      await other.synced();
      await other.add([root]);
      await runtime.idle();
      await other.synced();
      expect(await other.remove(root)).toBe(true);
      expect(await other.getDefaultPattern(false)).toBeUndefined();
    } finally {
      await other.dispose();
    }
  });

  it("still replaces the root of a space that is not a Home", async () => {
    // The refusal is about the Home, not about recreation: another space's
    // root is the deploy-time repair it always was.
    const other = new PiecesController(
      createSession({ identity, spaceDid: await runtime.createSpace() }),
      runtime,
    );
    try {
      await other.synced();
      const first = await other.recreateDefaultPattern({
        customProgram: program,
      });
      const second = await other.recreateDefaultPattern({
        customProgram: program,
      });
      expect(second.getCell().equals(first.getCell())).toBe(false);
      expect(
        (await other.getDefaultPattern(false))?.equals(second.getCell()),
      ).toBe(true);
    } finally {
      await other.dispose();
    }
  });
});
