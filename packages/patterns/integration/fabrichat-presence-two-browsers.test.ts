/**
 * Who is present in a FabriChat room's Loom, across two browsers. Ada and
 * Grace open one room, each in a browser of their own, and create a profile
 * through the form the room offers. Each then sees the other in the room's
 * presence roster, and when Grace's browser leaves the room, Ada's roster
 * empties. The roster is `cf-loom-presence` bound to the room's own result
 * cell, so this covers the binding the renderer hands the element, the
 * runtime client's Loom room, and the memory server's relay between two
 * browsers.
 */

import {
  createTestSpace,
  env,
  type Page,
  waitForCondition,
} from "@commonfabric/integration";
import { type DID, Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickTrustedAction,
  fillCfInput,
  waitForRuntimeIdle,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL } = env;

/** The runtime's profile create form's trusted action. */
const PROFILE_CREATE_ACTION = "CreateProfile";

describe("fabrichat presence across two browsers", () => {
  const adaShell = new ShellIntegration({
    presentation: { id: "ada", label: "Ada" },
  });
  const graceShell = new ShellIntegration({
    presentation: { id: "grace", label: "Grace" },
  });
  [adaShell, graceShell].forEach((shell) => shell.bindLifecycle());

  let adaIdentity: Identity;
  let graceIdentity: Identity;
  let spaceDid: DID;
  let cc: PiecesController;
  let pieceId: string;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    adaIdentity = await Identity.generate({ implementation: "noble" });
    graceIdentity = await Identity.generate({ implementation: "noble" });
    spaceDid = await createTestSpace(adaIdentity, {
      grants: { [graceIdentity.did()]: "WRITE" },
    });
    cc = await initializePiecesController({
      space: spaceDid,
      apiUrl: new URL(API_URL),
      identity: adaIdentity,
    });
    await cc.ensureDefaultPattern();

    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      {
        main: join(import.meta.dirname!, "..", "fabrichat", "room.tsx"),
        root: join(import.meta.dirname!, ".."),
      },
    );
    const piece = await cc.create(program, { start: true });
    pieceId = piece.id;
    pieceSinkCancel = cc.getResult(piece.getCell()).sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("shows each person the other, and drops one whose browser leaves", async () => {
    const view = { spaceDid, pieceId };
    const ada = adaShell.page();
    const grace = graceShell.page();

    await adaShell.goto({
      frontendUrl: FRONTEND_URL,
      view,
      identity: adaIdentity,
    });
    await createProfile(ada, "Ada Lovelace");
    await graceShell.goto({
      frontendUrl: FRONTEND_URL,
      view,
      identity: graceIdentity,
    });
    await createProfile(grace, "Grace Hopper");

    await waitForRoster(ada, ["Grace Hopper"], "Ada Lovelace");
    await waitForRoster(grace, ["Ada Lovelace"], "Grace Hopper");

    // Leaving the room's page ends Grace's session, and with it her
    // membership; the relay tells Ada.
    await grace.goto("about:blank");
    await waitForRoster(ada, [], "Grace Hopper");
  });
});

/** Creates the viewer's profile through the form FabriChat offers. */
async function createProfile(page: Page, name: string): Promise<void> {
  await waitForRuntimeIdle(page);
  await fillCfInput(page, "#wish-profile-name-input", name);
  await clickTrustedAction(page, PROFILE_CREATE_ACTION);
  await waitForRuntimeIdle(page);
}

/**
 * Waits until the room's presence roster in `page` names each of `present`
 * and not `absent`, which is the viewer's own name where the roster is
 * expected to hold someone, and the name of whoever left where it is
 * expected to be empty.
 */
async function waitForRoster(
  page: Page,
  present: readonly string[],
  absent: string,
): Promise<void> {
  await waitForCondition(
    page,
    (probe, expected: readonly string[], excluded: string) => {
      const roster = probe.collect("cf-loom-presence")[0];
      if (!roster) return false;
      const text = probe.deepText(roster);
      return expected.every((name) => text.includes(name)) &&
        !text.includes(excluded) &&
        (expected.length > 0 || text.trim() === "");
    },
    { args: [present, absent] },
  );
}
