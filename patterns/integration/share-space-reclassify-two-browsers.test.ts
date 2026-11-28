/**
 * Two-browser test of the share-space experiment
 * (`patterns/dev/test/share-space-declassify/`, README finding 7).
 *
 * The owner's location fixes carry the connector's `User{owner}` label. The
 * owner's browser places `share-live.tsx` in a new space that grants a second
 * identity READ, then records the fixes. The share computes the last five
 * minutes as `Reclassified<Fix[], typeof shareSpaceRules>`. The reader's
 * browser opens the share and is checked for what its display shows: the
 * window and its published copy, and not the source, which stays the owner's
 * alone.
 *
 * `cf test` runs one identity and no display, so it cannot show that a reader
 * of the share space sees the window. This test can.
 *
 * Which arm runs is decided by the environment every process inherits: with
 * `EXPERIMENTAL_PIECE_CREATOR_RECORD` and
 * `EXPERIMENTAL_CFC_PATTERN_RECLASSIFICATION` both `true`, the reader sees
 * the window; otherwise the window stays the owner's alone and the reader sees
 * none of it. The owner sees the window and the source on either arm.
 *
 * The window's flow join reads the owner's fixes from the owner's space, so
 * label-metadata protection stores its policy's subject as a commitment. The
 * reader's display finds the share space as the membership candidate for it
 * because the label was read from that space and the commitment is its digest
 * (`membershipSpacesInConfidentiality`). Continuous integration runs the other
 * arm; run the reclassifying one by hand.
 *
 * The share needs server execution: its lift runs in the share space with the
 * owner offline, which only a serving runtime does. With
 * `EXPERIMENTAL_SERVER_EXECUTION` off nothing computes the window, so the
 * suite is skipped rather than left waiting for it.
 */

import { createTestSpace, env, type Page } from "@commonfabric/integration";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { type Cell, cellEntityIdString } from "@commonfabric/runner";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import {
  afterAll,
  beforeAll,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickCfButtonAndWaitForText,
  readTextProbe,
  settleView,
  waitForRuntimeIdle,
  waitForSettledText,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL } = env;

const SERVER_EXECUTION = (() => {
  const raw = Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION");
  return raw === undefined ? SERVER_EXECUTION_DEFAULT_ENABLED : raw === "true";
})();

const RECLASSIFYING =
  Deno.env.get("EXPERIMENTAL_PIECE_CREATOR_RECORD") === "true" &&
  Deno.env.get("EXPERIMENTAL_CFC_PATTERN_RECLASSIFICATION") === "true";

/** The fixes inside the window, and every fix. */
const RECENT = "37.1, 37.2";
const ALL = "37, 37.1, 37.2";
/** A fragment every rendered latitude holds. */
const ANY_FIX = "37";

/** Where screenshots go, when the run names a directory. */
const SCREENSHOT_DIR = Deno.env.get("CF_SHARE_SCREENSHOT_DIR");

/** The element's text, with its whitespace collapsed, or undefined. */
const textOf = async (
  page: Page,
  selector: string,
): Promise<string | undefined> => {
  const probe = await readTextProbe(page, selector);
  return probe.matches[0]?.text.replace(/\s+/g, " ").trim();
};

const screenshot = async (page: Page, name: string) => {
  if (!SCREENSHOT_DIR) return;
  await page.screenshot(join(SCREENSHOT_DIR, `${name}.png`));
};

/** Resolves once `cell` holds a value `ready` accepts. */
const valueWhere = <T>(cell: Cell<T>, ready: (value: T) => boolean) =>
  new Promise<void>((resolve) => {
    // The sink can call back before it returns its cancel, so the callback
    // only marks the value seen and the cancel runs once both exist.
    let done = false;
    let subscribed = false;
    const cancel: () => void = cell.sink((value) => {
      if (done || !ready(value)) return;
      done = true;
      resolve();
      if (subscribed) cancel();
    });
    subscribed = true;
    if (done) cancel();
  });

describe(
  {
    name: `share-space reclassification across two browsers (${
      RECLASSIFYING ? "reclassifying" : "flags off"
    })`,
    ignore: !SERVER_EXECUTION,
  },
  () => {
    const ownerShell = new ShellIntegration();
    const readerShell = new ShellIntegration();
    ownerShell.bindLifecycle();
    readerShell.bindLifecycle();

    let owner: Identity;
    let reader: Identity;
    let homeController: PiecesController;
    let shareController: PiecesController | undefined;
    let ownerPieceId: string;
    let ownerResult: Cell<Record<string, unknown>>;
    let sinkCancel: (() => void) | undefined;

    beforeAll(async () => {
      owner = await Identity.generate({ implementation: "noble" });
      reader = await Identity.generate({ implementation: "noble" });
      homeController = await initializePiecesController({
        space: await createTestSpace(owner),
        apiUrl: new URL(API_URL),
        identity: owner,
      });
      await homeController.ensureDefaultPattern();

      const fixtureDir = join(
        import.meta.dirname!,
        "..",
        "dev",
        "test",
        "share-space-declassify",
      );
      const program = await resolveLocalProgram(
        (resolver) => homeController.runtime.harness.resolve(resolver),
        { main: join(fixtureDir, "share-owner.tsx"), root: fixtureDir },
      );
      const piece = await homeController.create(program, {
        input: { reader: reader.did() },
        start: true,
      });
      ownerPieceId = piece.id;
      ownerResult = homeController.getResult(piece.getCell()) as Cell<
        Record<string, unknown>
      >;
      sinkCancel = ownerResult.sink(() => {});
    });

    afterAll(async () => {
      sinkCancel?.();
      await shareController?.dispose();
      await homeController?.dispose();
    });

    it("shows the reader the window and not the source", async () => {
      const ownerPage = ownerShell.page();
      const readerPage = readerShell.page();

      // The owner shares, then records the fixes.
      await ownerShell.goto({
        frontendUrl: FRONTEND_URL,
        view: { spaceDid: homeController.getSpace(), pieceId: ownerPieceId },
        identity: owner,
      });
      await waitForRuntimeIdle(ownerPage);
      await clickCfButtonAndWaitForText(
        ownerPage,
        "#owner-share-button",
        "#owner-share-status",
        "shared",
      );
      await clickCfButtonAndWaitForText(
        ownerPage,
        "#owner-record-button",
        "#owner-fix-count",
        "3 fixes",
      );

      // Where the share was placed.
      const live = ownerResult.key("share").key("live") as Cell<unknown>;
      await valueWhere(live, (value) => value !== undefined);
      const shareCell = live.resolveAsCell();
      const shareSpace = shareCell.getAsNormalizedFullLink().space;
      const sharePieceId = cellEntityIdString(shareCell);
      if (!sharePieceId) throw new Error("The share has no piece id.");
      assertEquals(
        shareSpace === homeController.getSpace(),
        false,
        "The share is in a space of its own.",
      );

      // The reader holds READ only, so the owner brings the share space's
      // root into being before either browser opens it.
      shareController = await initializePiecesController({
        space: shareSpace,
        apiUrl: new URL(API_URL),
        identity: owner,
      });
      await shareController.ensureDefaultPattern();
      const shareView = { spaceDid: shareSpace, pieceId: sharePieceId };
      console.log(
        `[share-two-browsers] owner=${owner.did()} reader=${reader.did()} ` +
          `home=${homeController.getSpace()} share=${shareSpace} ` +
          `piece=${sharePieceId}`,
      );

      // The owner sees the window and the source on either arm, and
      // publishes the window.
      await ownerShell.goto({
        frontendUrl: FRONTEND_URL,
        view: shareView,
        identity: owner,
      });
      await waitForSettledText(ownerPage, "#share-window", RECENT, {
        exact: true,
      });
      await waitForSettledText(ownerPage, "#share-source", ALL, {
        exact: true,
      });
      if (RECLASSIFYING) {
        await clickCfButtonAndWaitForText(
          ownerPage,
          "#share-publish-button",
          "#share-shared",
          RECENT,
        );
      }
      await screenshot(ownerPage, "owner-share");

      // The reader opens the share.
      await readerShell.goto({
        frontendUrl: FRONTEND_URL,
        view: shareView,
        identity: reader,
      });
      await waitForText(
        readerPage,
        "#share-heading",
        "Shared location, last five minutes",
      );
      await screenshot(readerPage, "reader-share-opened");
      if (RECLASSIFYING) {
        await waitForSettledText(readerPage, "#share-window", RECENT, {
          exact: true,
        });
        await waitForSettledText(readerPage, "#share-shared", RECENT, {
          exact: true,
        });
      }
      await waitForRuntimeIdle(readerPage);
      await settleView(readerPage);
      await screenshot(readerPage, "reader-share");

      const readerWindow = await textOf(readerPage, "#share-window");
      const readerShared = await textOf(readerPage, "#share-shared");
      const readerSource = await textOf(readerPage, "#share-source");
      console.log(
        `[share-two-browsers] arm=${
          RECLASSIFYING ? "reclassifying" : "off"
        } reader window=${JSON.stringify(readerWindow)} shared=${
          JSON.stringify(readerShared)
        } source=${JSON.stringify(readerSource)}`,
      );

      // The source is the owner's alone on either arm.
      assertEquals(
        readerSource?.includes(ANY_FIX) ?? false,
        false,
        `The reader sees the source: ${readerSource}`,
      );
      if (RECLASSIFYING) {
        assertEquals(readerWindow, RECENT);
      } else {
        // Without reclassification the window is the owner's alone too.
        assertEquals(
          readerWindow?.includes(ANY_FIX) ?? false,
          false,
          `The reader sees the window: ${readerWindow}`,
        );
        assertEquals(
          readerShared?.includes(ANY_FIX) ?? false,
          false,
          `The reader sees a published window: ${readerShared}`,
        );
      }
    });
  },
);
