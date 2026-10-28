/**
 * FabriChat retains a refused composer's exact text for a keyboard retry,
 * and keeps the main conversation's draft separate from a thread's draft.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";

import { ConsoleEvent } from "@astral/astral";
import { type DID, Identity } from "@commonfabric/identity";
import { createTestSpace, env } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { withStuckNet } from "@commonfabric/test-support/stuck-net";

import {
  clickTrustedAction,
  fillCfInput,
  readCfInputValue,
  settleView,
  submitViaEnter,
  waitForSettledText,
} from "./cfc-browser-helpers.ts";
import { clickButtonWithExactText } from "./note-button-helpers.ts";
import {
  initializePiecesController,
  type PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL } = env;
const MAIN_INPUT = "#fabrichat-message";
const THREAD_INPUT = "#fabrichat-thread-message";
const DELETED = "That message was deleted.";

describe("fabrichat-composer-drafts", () => {
  const shell = new ShellIntegration({ allowedConsoleErrors: [DELETED] });
  shell.bindLifecycle();

  let identity: Identity;
  let spaceDid: DID;
  let cc: PiecesController;
  let pieceId: string;
  let result: ReturnType<PiecesController["getResult"]>;
  let cancelSink: (() => void) | undefined;

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
        main: join(import.meta.dirname!, "..", "fabrichat", "room.tsx"),
        root: join(import.meta.dirname!, ".."),
      },
    );
    const piece = await cc.create(program, { start: true });
    pieceId = piece.id;
    result = cc.getResult(piece.getCell());
    cancelSink = result.sink(() => {});
  });

  afterAll(async () => {
    cancelSink?.();
    await cc?.dispose();
  });

  it("retains refused text for an Enter retry and clears only the successful composer's draft", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid, pieceId },
      identity,
    });
    await fillCfInput(page, "#wish-profile-name-input", "Ada Lovelace");
    await clickTrustedAction(page, "CreateProfile");

    await fillCfInput(page, MAIN_INPUT, "A message to quote");
    await clickTrustedAction(page, "ChatSend");
    await waitForSettledText(page, "#fabrichat-messages", "A message to quote");
    await clickButtonWithExactText(page, "Reply");
    await clickTrustedAction(page, "ChatDelete");
    await waitForSettledText(
      page,
      "#fabrichat-messages",
      "This message was deleted.",
    );

    const body = "  Keep these spaces, please.  ";
    await fillCfInput(page, MAIN_INPUT, body);
    const refused = Promise.withResolvers<void>();
    const observeRefusal = (event: Event): void => {
      if (
        event instanceof ConsoleEvent && event.detail.text.includes(DELETED)
      ) {
        refused.resolve();
      }
    };
    page.addEventListener("console", observeRefusal);
    try {
      await clickTrustedAction(page, "ChatSend");
      await withStuckNet(refused.promise, "the deleted-quote send refusal");
      await settleView(page);
      expect(await readCfInputValue(page, MAIN_INPUT)).toBe(body);
    } finally {
      page.removeEventListener("console", observeRefusal);
    }

    await clickButtonWithExactText(page, "Cancel");
    await submitViaEnter(page, MAIN_INPUT);
    await waitForSettledText(page, "#fabrichat-messages", body.trim());
    expect(await readCfInputValue(page, MAIN_INPUT)).toBe("");
    await waitForCellValue<string>(
      cc.runtime,
      result.key("messages").key("latest").key("messages").key(1).key("body"),
      (value) => value === body,
      { stuckLabel: "the accepted message retains its exact submitted text" },
    );

    const mainDraft = "  Still writing in the conversation.  ";
    const threadBody = "  A separate thread reply.  ";
    await fillCfInput(page, MAIN_INPUT, mainDraft);
    await clickButtonWithExactText(page, "Thread");
    await fillCfInput(page, THREAD_INPUT, threadBody);
    await submitViaEnter(page, THREAD_INPUT);
    await waitForSettledText(page, "#fabrichat-thread", threadBody.trim());
    expect(await readCfInputValue(page, THREAD_INPUT)).toBe("");
    expect(await readCfInputValue(page, MAIN_INPUT)).toBe(mainDraft);
    await waitForCellValue<string>(
      cc.runtime,
      result.key("messages").key("threads").key(0).key("messages").key(1).key(
        "body",
      ),
      (value) => value === threadBody,
      { stuckLabel: "the thread reply retains its exact submitted text" },
    );
  });
});
