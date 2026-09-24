/**
 * FabriChat in a browser, with real profiles: two people each create one
 * through the form FabriChat offers, send, and see each other's messages.
 */
import { env, Page } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
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
  waitForText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

// Trusted action names: the runtime's profile create form, and FabriChat's
// send (`fabrichat/chat.tsx`).
const PROFILE_CREATE_ACTION = "CreateProfile";
const SEND_ACTION = "FabriChatSend";

describe("fabrichat integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let firstIdentity: Identity;
  let secondIdentity: Identity;
  let cc: PiecesController;
  let pieceId: string;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    firstIdentity = await Identity.generate({ implementation: "noble" });
    secondIdentity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: firstIdentity,
    });
    await cc.ensureDefaultPattern();

    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      {
        main: join(import.meta.dirname!, "..", "fabrichat", "main.tsx"),
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

  it("lets each person join with their own profile and send", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME, pieceId },
      identity: firstIdentity,
    });
    await createProfile(page, "Ada Lovelace");
    await send(page, "Hello from Ada");

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME, pieceId },
      identity: secondIdentity,
    });
    await waitForText(page, "#fabrichat-messages", "Hello from Ada");
    await createProfile(page, "Grace Hopper");
    await send(page, "Hi Ada, Grace here");
    await waitForText(page, "#fabrichat-messages", "Ada Lovelace");
    await waitForText(page, "#fabrichat-messages", "Grace Hopper");
  });
});

/** Creates the viewer's profile through the form FabriChat offers. */
async function createProfile(page: Page, name: string): Promise<void> {
  await waitForRuntimeIdle(page);
  await fillCfInput(page, "#wish-profile-name-input", name);
  await clickTrustedAction(page, PROFILE_CREATE_ACTION);
  await waitForRuntimeIdle(page);
}

/** Sends `body` from the composer, and waits for it to appear. */
async function send(page: Page, body: string): Promise<void> {
  await fillCfInput(page, "#fabrichat-message", body);
  await clickTrustedAction(page, SEND_ACTION);
  await waitForText(page, "#fabrichat-messages", body);
}
