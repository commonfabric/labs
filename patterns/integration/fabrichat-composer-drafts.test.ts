/**
 * FabriChat retains a refused composer's exact text for a keyboard retry,
 * and keeps drafts separate across the conversation and its threads.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";

import { ConsoleEvent } from "@astral/astral";
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { type DID, Identity } from "@commonfabric/identity";
import {
  createTestSpace,
  env,
  type Page,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import { getEntityId, isCell, UI } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { withStuckNet } from "@commonfabric/test-support/stuck-net";

import {
  clickMarked,
  clickTrustedAction,
  fillCfInput,
  markTargetsArgs,
  readCfInputValue,
  settleAndMarkTargets,
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
        main: join(
          import.meta.dirname!,
          "..",
          "system",
          "fabrichat",
          "room.tsx",
        ),
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
    const sidecar = cc.runtime.experimental.serverExecution
      ? await composerEvents(cc, result)
      : undefined;
    await sidecar?.sync();
    const previousEvents = new Set(
      sidecar?.get()?.entries?.map((entry) => entry.eventId),
    );
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
      if (sidecar) {
        const completed = await waitForCellValue<StreamEventsDocValue>(
          cc.runtime,
          sidecar,
          (value) =>
            value?.entries?.some((entry) =>
              !previousEvents.has(entry.eventId) &&
              entry.rendererTrusted === true && entry.consequenced === true &&
              entry.error?.includes(DELETED) === true
            ) === true,
          { stuckLabel: "the served deleted-quote send refusal" },
        );
        const submitted = completed.entries?.filter((entry) =>
          !previousEvents.has(entry.eventId)
        );
        expect(submitted).toHaveLength(1);
        expect(submitted?.[0]).toMatchObject({
          rendererTrusted: true,
          consequenced: true,
          error: expect.stringContaining(DELETED),
          payload: { target: { value: body } },
        });
      } else {
        await withStuckNet(refused.promise, "the deleted-quote send refusal");
      }
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

    const otherRoot = "Another thread's root";
    await fillCfInput(page, MAIN_INPUT, otherRoot);
    await submitViaEnter(page, MAIN_INPUT);
    await waitForSettledText(page, "#fabrichat-messages", otherRoot);
    const messages = result.key("messages").key("latest").key("messages");
    await waitForCellValue<string>(
      cc.runtime,
      messages.key(2).key("body"),
      (value) => value === otherRoot,
      { stuckLabel: "the second thread root's stored message" },
    );
    const [firstThreadKey, otherThreadKey] = [1, 2].map((index) => {
      const entity = getEntityId(messages.key(index).resolveAsCell());
      if (entity === undefined) {
        throw new Error("The thread root has no entity.");
      }
      return entityRefToString(entity);
    });

    const mainDraft = "  Still writing in the conversation.  ";
    const firstThreadDraft = "  Keep this in the first thread.  ";
    const threadBody = "  A separate thread reply.  ";
    await fillCfInput(page, MAIN_INPUT, mainDraft);
    await openThread(page, body, firstThreadKey);
    await fillCfInput(page, THREAD_INPUT, firstThreadDraft);
    await openThread(page, otherRoot, otherThreadKey);
    expect(await readCfInputValue(page, THREAD_INPUT)).toBe("");
    await fillCfInput(page, THREAD_INPUT, threadBody);
    await openThread(page, body, firstThreadKey);
    expect(await readCfInputValue(page, THREAD_INPUT)).toBe(firstThreadDraft);
    await openThread(page, otherRoot, otherThreadKey);
    expect(await readCfInputValue(page, THREAD_INPUT)).toBe(threadBody);
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
    await openThread(page, body, firstThreadKey);
    expect(await readCfInputValue(page, THREAD_INPUT)).toBe(firstThreadDraft);
    expect(await readCfInputValue(page, MAIN_INPUT)).toBe(mainDraft);
  });
});

/** The authoritative event log for the main composer's canonical stream. */
async function composerEvents(
  cc: PiecesController,
  result: ReturnType<PiecesController["getResult"]>,
) {
  const find = async (node: unknown): Promise<unknown> => {
    if (isCell(node)) {
      await node.pull();
      return await find(node.get());
    }
    if (!node || typeof node !== "object") return undefined;
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = await find(child);
        if (found) return found;
      }
      return undefined;
    }
    if ("$UI" in node) return await find(node.$UI);
    if ("name" in node && node.name === "cf-submit-input" && "props" in node) {
      const props = node.props;
      if (isCell(props)) {
        const inputId = await props.key("inputId").asSchema({ type: "string" })
          .pull();
        if (inputId === "fabrichat-message") {
          return props.key("onClick").resolveAsCell();
        }
      }
    }
    return "children" in node ? await find(node.children) : undefined;
  };
  const stream = await find(result.key(UI).asSchema(rendererVDOMSchema));
  if (!isCell(stream)) {
    throw new Error("The main composer's canonical stream was not found.");
  }
  const link = stream.resolveAsCell().getAsNormalizedFullLink();
  return cc.runtime.getCellFromEntityId<StreamEventsDocValue>(
    link.space,
    streamEntriesDocId(link),
  );
}

/** Opens the thread and waits for its own composer to be interactive. */
async function openThread(
  page: Page,
  body: string,
  threadKey: string,
): Promise<void> {
  const token = `fabrichat-thread-${crypto.randomUUID()}`;
  const args = markTargetsArgs(
    (probe, body: string) => {
      const within = (node: Node, ancestor: Node): boolean => {
        for (
          let at: Node | null = node;
          at;
          at = at.parentNode ?? (at instanceof ShadowRoot ? at.host : null)
        ) {
          if (at === ancestor) return true;
        }
        return false;
      };
      const messages = probe.collect("#fabrichat-messages")[0];
      if (!messages) return undefined;
      const row = probe.collect("cf-hover-reveal").find((candidate) =>
        within(candidate, messages) &&
        probe.deepText(candidate).includes(body.trim())
      );
      if (!row) return undefined;
      const button = probe.collect("cf-button").find((candidate) =>
        within(candidate, row) && candidate.textContent?.trim() === "Thread"
      );
      const control = button?.shadowRoot?.querySelector("[data-cf-button]");
      return control instanceof HTMLElement ? [control] : undefined;
    },
    [body],
    [token],
  );
  await waitForCondition(page, settleAndMarkTargets, { args });
  await clickMarked(page, {
    token,
    remark: { predicate: settleAndMarkTargets, args },
  });
  await waitForSettledText(page, "#fabrichat-thread cf-heading", body.trim());
  // The heading and composer arrive through separate reactive branches.
  await waitForCondition(page, (probe, key: string) => {
    const inputs = probe.collect("#fabrichat-thread-message");
    if (inputs.length !== 1) return false;
    const root = inputs[0].getRootNode();
    return root instanceof ShadowRoot &&
      root.host.getAttribute("data-thread-key") === key;
  }, { args: [threadKey] });
  await settleView(page);
}
