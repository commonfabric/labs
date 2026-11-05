/**
 * A new person's Home, shown in the shell and otherwise left to itself: the
 * header menu is never opened, nothing is favorited and no space is created,
 * so showing Home is the only bring-up of Home the shell's worker makes. The
 * person creates a profile from Home's Profile tab. Read from a runtime of the
 * test's own, as the same identity, Home then holds a private inbox, and the
 * profile points at it.
 */

import type { JSONSchema } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { env } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { inboxPieceLinkSchema } from "@commonfabric/piece/ops";
import type { Cell } from "@commonfabric/runner";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  clickCfButton,
  clickTrustedAction,
  fillCfInput,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";
import { initializePiecesController } from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL } = env;

// Trusted action name of the runtime's profile create form.
const PROFILE_CREATE_ACTION = "CreateProfile";

/** An inbox pointer, as Home holds one and as a profile holds one. */
const pointerSchema = {
  type: "object",
  properties: { piece: inboxPieceLinkSchema },
} as const satisfies JSONSchema;

/** The parts of Home's result this test reads. */
const homeSchema = {
  type: "object",
  properties: {
    privateInbox: pointerSchema,
    profiles: {
      type: "array",
      items: { type: "object", properties: { inbox: pointerSchema } },
    },
  },
} as const satisfies JSONSchema;

describe("home-private-inbox", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("gives a Home shown without its header menu a private inbox, and points its profile at it", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { builtin: "home" },
      identity,
    });
    await clickCfButton(page, 'cf-tab[value="profile"]');
    await fillCfInput(page, "#wish-profile-picker-name-input", "Ada Lovelace");
    await clickTrustedAction(page, PROFILE_CREATE_ACTION);
    await waitForRuntimeIdle(page);
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");

    const controller = await initializePiecesController({
      space: identity.did(),
      apiUrl: new URL(API_URL),
      identity,
    });
    try {
      const root = await controller.getDefaultPattern(false);
      if (root === undefined) {
        throw new Error("The home space has no default pattern.");
      }
      const home = root.asSchema(homeSchema);
      const runtime = controller.runtime;

      // Home's fields and the profiles reach what they hold through links,
      // to documents of their own and into the profiles' spaces, which a sink
      // does not load. One pull of each loads every hop, and the waits then
      // watch the documents the pointers are stored in.
      await home.key("privateInbox").pull();
      await home.key("profiles").pull();
      const held = home.key("privateInbox").resolveAsCell().key("piece");
      const profiles = home.key("profiles").resolveAsCell();
      expect(profiles.getRaw()).toHaveLength(1);
      const pointer = profiles.key(0).resolveAsCell().key("inbox")
        .resolveAsCell().key("piece");

      await waitForCellValue(runtime, held, () => held.getRaw() !== undefined, {
        stuckLabel: "Home's private inbox",
      });
      await waitForCellValue(
        runtime,
        pointer,
        () => pointer.getRaw() !== undefined,
        { stuckLabel: "the profile's inbox pointer" },
      );

      const inbox = await documentOf(held);
      expect(inbox.space).not.toBe(identity.did());
      expect(await documentOf(pointer)).toEqual(inbox);
    } finally {
      await controller.dispose();
    }
  });
});

/**
 * The document `link` reaches, once every link along the way is loaded and
 * followed.
 */
async function documentOf(
  link: Cell<unknown>,
): Promise<{ id: string; space: string }> {
  await link.pull();
  const { id, space } = link.resolveAsCell().getAsNormalizedFullLink();
  return { id, space };
}
