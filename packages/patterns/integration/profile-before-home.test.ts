import { createTestSpace, env } from "@commonfabric/integration";
import { type DID, Identity } from "@commonfabric/identity";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { isLink } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickCfButton,
  clickTrustedAction,
  fillCfInput,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL } = env;

const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

describe("profile-before-home integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let spaceDid: DID;
  let cc: PiecesController;
  let pieceId: string;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    spaceDid = await createTestSpace(identity);
    cc = await initializePiecesController({
      space: spaceDid,
      apiUrl: new URL(API_URL),
      identity,
    });
    // The space the piece runs in gets its root here, so the browser resumes
    // it rather than compiling one. The identity's Home is left with none.
    await cc.ensureDefaultPattern();

    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      {
        main: join(
          import.meta.dirname!,
          "fixtures",
          "profile-create-surface.tsx",
        ),
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

  it("creates a profile through a wish before Home exists, after which Home opens and lists it", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid, pieceId },
      identity,
    });
    await waitForRuntimeIdle(page);

    await fillCfInput(page, "#wish-profile-name-input", "Ada Lovelace");
    await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
    await waitForRuntimeIdle(page);

    // Home links a root, and a runtime that never saw the browser opens it.
    const home = await initializePiecesController({
      space: identity.did(),
      apiUrl: new URL(API_URL),
      identity,
    });
    try {
      const spaceCell = home.runtime.getCell(identity.did(), identity.did());
      await spaceCell.sync();
      const slot = (spaceCell.getRaw() as { defaultPattern?: unknown })
        .defaultPattern;
      expect(isLink(slot)).toBe(true);
      const root = (await home.ensureDefaultPattern()).getCell();
      const profiles = root.key("profiles" as never).resolveAsCell();
      await profiles.sync();
      expect(profiles.getRaw()).toHaveLength(1);
    } finally {
      await home.dispose();
    }

    // The shell opens Home, whose profile tab lists the profile.
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { builtin: "home" },
      identity,
    });
    await clickCfButton(page, 'cf-tab[value="profile"]');
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");
  });
});
