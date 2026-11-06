/**
 * A child piece that a parent's handler created, shown through `cf-render`,
 * computes in a viewer's runtime that never ran the handler. The parent's body
 * instantiates no child, so starting the parent starts none; only the display
 * starting the piece it shows makes the child's derived value follow its
 * input there.
 */

import { createTestSpace, env } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { type DID, Identity } from "@commonfabric/identity";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";
import { settleView, waitForSettledText } from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL } = env;

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "handler-child-render.tsx",
);

describe("cf-render-handler-child", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let spaceDid: DID;
  let parentId: string;
  let childId: string;
  // Opened without starting anything, so it computes nothing for the child.
  let writer: PiecesController | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    spaceDid = await createTestSpace(identity);

    // The runtime that runs the handler, and with it the child, goes away
    // before the viewer opens the parent, so no runtime is left running the
    // child.
    const creator = await initializePiecesController({
      space: spaceDid,
      apiUrl: new URL(API_URL),
      identity,
    });
    try {
      const parent = await creator.create(
        await Deno.readTextFile(PROGRAM_PATH),
        { start: true },
      );
      parentId = parent.id;
      const result = creator.getResult(parent.getCell());
      result.key("addChild").send({});
      await creator.runtime.idle();
      await creator.synced();
      // Under server execution the handler and the child's derivation run on
      // the server, which neither wait above covers, so the waits below are
      // on the values themselves. Sinking on `doubled` is also what demands
      // it of the server.
      const children = result.key("children");
      await waitForCellValue<unknown[]>(
        creator.runtime,
        children,
        (value) => (value?.length ?? 0) > 0,
        { stuckLabel: "the parent's first child" },
      );
      const child = new PieceController(
        creator,
        children.key(0).resolveAsCell(),
      );
      childId = child.id;
      const doubled = creator.getResult(child.getCell()).key("doubled");
      await waitForCellValue<number>(
        creator.runtime,
        doubled,
        (value) => value === 2,
        { stuckLabel: "the child's derived value" },
      );
      expect(await child.result.get(["doubled"])).toBe(2);
    } finally {
      await creator.dispose();
    }

    writer = await initializePiecesController({
      space: spaceDid,
      apiUrl: new URL(API_URL),
      identity,
    });
  });

  afterAll(async () => {
    if (writer) await writer.dispose();
  });

  it("computes the child's derived value from an input written after the display mounted", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid, pieceId: parentId },
      identity,
    });
    await waitForSettledText(page, "#child-doubled", "doubled 2");
    // The write follows a drawn view, so the wait below has a change to see.
    await settleView(page);

    const child = await writer!.get(childId, false);
    await child.input.set(21, ["n"]);

    await waitForSettledText(page, "#child-doubled", "doubled 42");
  });
});
