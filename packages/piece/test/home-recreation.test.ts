import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";

import { createSession, Identity } from "@commonfabric/identity";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

import { PiecesController } from "../src/ops/pieces-controller.ts";

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

  it("creates the first Home when no root is installed", async () => {
    const home = await controller.recreateDefaultPattern({
      customProgram: program,
    });
    expect((await controller.getDefaultPattern(false))?.equals(home.getCell()))
      .toBe(true);
    expect(await home.getCell().asSchema(true).pull()).toMatchObject({
      saved: { favorite: "retained" },
    });
  });

  it("refuses replacement before stopping or compiling an existing Home", async () => {
    const home = await controller.recreateDefaultPattern({
      customProgram: program,
    });
    const before = await home.getCell().asSchema(true).pull();
    expect(before).toMatchObject({ saved: { favorite: "retained" } });
    using stopped = spy(runtime.runner, "stop");
    using compiled = spy(runtime.patternManager, "compilePattern");
    for (const options of [undefined, { customProgram: program }]) {
      await expect(controller.recreateDefaultPattern(options)).rejects
        .toThrow("Cannot replace an existing Home root");
      expect(
        (await controller.getDefaultPattern(false))?.equals(home.getCell()),
      )
        .toBe(true);
      expect(home.getCell().asSchema(true).get()).toEqual(before);
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
      .rejects.toThrow("Cannot replace an existing Home root");
    expect(root.getRaw()).toEqual(before);
  });

  it("retains a Home installed while another initializer compiles", async () => {
    const entered = defer<void>();
    const release = defer<void>();
    const compile = runtime.patternManager.compilePattern.bind(
      runtime.patternManager,
    );
    using _held = stub(
      runtime.patternManager,
      "compilePattern",
      async (...args) => {
        entered.resolve();
        await release.promise;
        return await compile(...args);
      },
    );
    const pending = controller.recreateDefaultPattern({
      customProgram: program,
    });
    const refusal = expect(pending).rejects.toThrow(
      "Cannot replace an existing Home root",
    );
    try {
      await entered.promise;
      const winner = runtime.getImmutableCell(identity.did(), {
        saved: { favorite: "another initializer" },
      });
      await controller.linkDefaultPattern(winner);
      const root = controller.getSpaceCellContents().key("defaultPattern");
      const installed = root.getRaw();
      expect(installed).toBeDefined();
      release.resolve();
      await refusal;
      expect(root.getRaw()).toEqual(installed);
      expect(winner.get()).toEqual({
        saved: { favorite: "another initializer" },
      });
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  });
});
