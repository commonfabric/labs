/**
 * Browser-level coverage for a verb an iframe guest sends to. The verb list's
 * guest adds an item only by sending the pattern's `addItem` stream an event,
 * which reaches it as a `stream` resource of the frame; the item reaches the
 * guest again as the frame's input. The test acts on the guest's own controls
 * through a second CDP client, and reads the list from the piece.
 */

import { createTestSpace, env } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { type DID, Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { waitForRuntimeIdle } from "./cfc-browser-helpers.ts";
import { GuestDomDriver, waitForGuestFrame } from "./iframe-guest-driver.ts";
import {
  initializePiecesController,
  type PieceController,
  PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL } = env;

/** A reader for `GuestDomDriver.waitFor` of the row whose text is `text`. */
function rowReader(text: string): string {
  return `() => {
    const row = [...document.querySelectorAll('#items li')].find((item) =>
      item.querySelector('span')?.textContent === ${JSON.stringify(text)}
    );
    return row ? { id: row.dataset.itemId ?? '' } : false;
  }`;
}

describe("iframe verb list", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let spaceDid: DID;
  let cc: PiecesController;
  let piece: PieceController;
  let resultSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    spaceDid = await createTestSpace(identity);
    cc = await initializePiecesController({
      space: spaceDid,
      apiUrl: new URL(API_URL),
      identity,
    });
    await cc.ensureDefaultPattern();

    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      {
        main: join(import.meta.dirname!, "..", "iframe-verb-list", "main.tsx"),
        root: join(import.meta.dirname!, ".."),
      },
    );
    piece = await cc.create(program, { start: true });
    resultSinkCancel = cc.getResult(piece.getCell()).sink(() => {});
  });

  afterAll(async () => {
    resultSinkCancel?.();
    await cc?.dispose();
  });

  it("adds an item through the pattern's verb and shows the guest the verb's items", async () => {
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid, pieceId: piece.id },
      identity,
    });
    const page = shell.page();
    await waitForRuntimeIdle(page);
    await waitForGuestFrame(page);

    const guest = await GuestDomDriver.connect(
      shell.wsEndpoint(),
      "#new-item",
    );
    try {
      await guest.waitFor<boolean>(`() =>
        !document.querySelector('#new-item').disabled
      `);
      await guest.setValue("#new-item", "  Milk  ");
      await guest.click("#add");

      // The guest's own write path is the verb: the item it shows is the
      // one the verb stored, trimmed, under the id the guest minted.
      const sent = await guest.waitFor<{ id: string }>(rowReader("Milk"));
      expect(sent.id).not.toBe("");
      // The send settles once the verb's run has committed, which the guest
      // may hear after the item has reached it as input; it clears the field
      // then.
      expect(
        await guest.waitFor<string>(`() => {
          const row = document.querySelector('#add-row');
          const field = document.querySelector('#new-item');
          return row.getAttribute('aria-busy') === 'false' ? field.value : false;
        }`),
      ).toBe("");
      await cc.synced();
      expect(await piece.result.get(["items"])).toEqual([
        { id: sent.id, text: "Milk" },
      ]);

      // An item another caller adds through the same verb reaches the guest
      // as the frame's input.
      cc.getResult(piece.getCell()).key("addItem").send({
        id: "from-another-caller",
        text: "Eggs",
      });
      const added = await guest.waitFor<{ id: string }>(rowReader("Eggs"));
      expect(added.id).toBe("from-another-caller");
    } finally {
      guest.close();
    }
  });
});
