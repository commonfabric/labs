/**
 * Browser-level coverage for the assets a pattern ships to its iframe guest.
 * The donut menu hands its guest every file in its `assets/` directory with
 * `dataFile.urls()`. The guest's document shows the SVG logo through a
 * `cf-asset:` reference, the guest's script builds the menu from each PNG's
 * URL, and it draws the favorite onto a canvas from the PNG's decoded image,
 * all under the guest's Content Security Policy, which admits images from
 * `data:` URLs. The logo's URL runs past 1,024 characters, so setup stores it
 * in the result document as a link to a code document
 * (`docs/specs/iframe-static-assets.md`, part 1), and its arrival covers that
 * link reaching `cf-iframe`; the PNGs' URLs are short enough to stay inline.
 * The test reads the guest through a second CDP client.
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

describe("iframe donut menu", () => {
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
        main: join(
          import.meta.dirname!,
          "..",
          "examples",
          "iframe-donut-menu",
          "main.tsx",
        ),
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

  it("shows the pattern's pictures in the guest and draws the favorite", async () => {
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
      "canvas#favorite",
    );
    try {
      // `decode()` settles once an image has loaded, and rejects for one the
      // policy refused, so each width here is a picture that arrived.
      expect(
        await guest.evaluate<[string, string, number][]>(`Promise.all(
          [...document.querySelectorAll('img')].map((image) =>
            image.decode().then(() => [
              image.id || image.dataset.picture,
              image.src.slice(0, image.src.indexOf(',')),
              image.naturalWidth,
            ])
          )
        )`),
      ).toEqual([
        ["logo", "data:image/svg+xml;base64", 64],
        ["glazed", "data:image/png;base64", 32],
        ["chocolate", "data:image/png;base64", 32],
      ]);
      // The logo is the asset stored by reference only while its URL is this
      // long.
      expect(
        await guest.evaluate<number>(
          `document.getElementById('logo').src.length`,
        ),
      ).toBeGreaterThanOrEqual(1024);

      await guest.waitFor<boolean>(`() =>
        !document.querySelector('button[data-donut="glazed"]').disabled
      `);
      // The guest shows its own write at once, so the piece's state is what
      // says the write was stored.
      const stored = Promise.withResolvers<void>();
      const cancelStored = cc.getResult(piece.getCell()).key("state").key(
        "favorite",
      ).sink((favorite: unknown) => {
        if (favorite === "glazed") stored.resolve();
      });
      await guest.click('button[data-donut="glazed"]');

      // A pixel of the donut's ring, which is opaque in the picture and
      // transparent on a cleared canvas.
      expect(
        await guest.waitFor<number>(`() => {
          const canvas = document.querySelector('#favorite');
          if (canvas.dataset.drawn !== 'glazed') return false;
          return canvas.getContext('2d').getImageData(3, 16, 1, 1).data[3];
        }`),
      ).toBe(255);
      await stored.promise;
      cancelStored();
    } finally {
      guest.close();
    }
  });
});
