/**
 * FabriChat in a browser, with real profiles: two people each create one
 * through the form FabriChat offers, send, and see each other's messages marked
 * as verified. One of them reacts to the other's message, and both see it.
 */
import { debugStr } from "@commonfabric/data-model";
import { env, Page, waitForCondition } from "@commonfabric/integration";
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
  clickCfButton,
  clickTrustedAction,
  fillCfInput,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

// Trusted action names: the runtime's profile create form, and FabriChat's
// send and reaction (`fabrichat/chat.tsx`).
const PROFILE_CREATE_ACTION = "CreateProfile";
const SEND_ACTION = "FabriChatSend";
const REACT_ACTION = "FabriChatReact";

// The control on each message that opens its reaction picker. The first one
// enabled is on the oldest message.
const ADD_REACTION = 'cf-button[aria-label="Add reaction"]';

/** What one rendered message's authorship element reports. */
interface AuthorshipReport {
  /** The element's authorship state: `verified`, `unverified` or `unknown`. */
  state: string | undefined;

  /** The message text the element wraps. */
  text: string;

  /** The label view read from the element's author claim. */
  authorLabel: unknown;

  /** The label view read from the element's value, the message body. */
  valueLabel: unknown;
}

describe("fabrichat integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let firstIdentity: Identity;
  let secondIdentity: Identity;
  let cc: PiecesController;
  let pieceId: string;
  let pieceSinkCancel: (() => void) | undefined;
  let storedBodies: () => string[];

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
    const result = cc.getResult(piece.getCell());
    pieceSinkCancel = result.sink(() => {});
    storedBodies = () =>
      ((result.get() as { messages?: { body?: string }[] } | undefined)
        ?.messages ?? []).map((message) => message?.body ?? "");
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("lets each person join with their own profile, send, and react", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME, pieceId },
      identity: firstIdentity,
    });
    await createProfile(page, "Ada Lovelace");
    await send(page, "Hello from Ada", storedBodies);
    await waitForVerified(page, "Hello from Ada");

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME, pieceId },
      identity: secondIdentity,
    });
    await waitForText(page, "#fabrichat-messages", "Hello from Ada");
    await createProfile(page, "Grace Hopper");
    await send(page, "Hi Ada, Grace here", storedBodies);
    await waitForText(page, "#fabrichat-messages", "Ada Lovelace");
    await waitForText(page, "#fabrichat-messages", "Grace Hopper");
    await waitForVerified(page, "Hi Ada, Grace here");
    await waitForVerified(page, "Hello from Ada");

    // With the picker open on Ada's message, and no reactions yet, the first
    // reaction control on the page is the picker's first cat.
    await clickCfButton(page, ADD_REACTION);
    await clickTrustedAction(page, REACT_ACTION);
    await waitForText(page, "#fabrichat-messages", "😺 1");

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME, pieceId },
      identity: firstIdentity,
    });
    await waitForText(page, "#fabrichat-messages", "😺 1");
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
 * Sends `body` from the composer, and waits for it to appear. If it does not,
 * the error lists what the piece has stored, as the controller's subscription
 * has seen it through `storedBodies`, which can lag the server: a stored body
 * that never appeared was not rendered, and one that was never stored was
 * refused, lost, or not yet synced.
 */
async function send(
  page: Page,
  body: string,
  storedBodies: () => string[],
): Promise<void> {
  await fillCfInput(page, "#fabrichat-message", body);
  await clickTrustedAction(page, SEND_ACTION);
  try {
    await waitForText(page, "#fabrichat-messages", body);
  } catch (cause) {
    let stored: string[] | undefined;
    try {
      stored = storedBodies();
    } catch {
      // The timeout is the failure to report, whatever the read does.
    }
    throw new Error(
      `"${body}" never appeared. ` +
        (stored === undefined
          ? "The piece's stored messages could not be read."
          : debugStr`Stored message bodies: $quote,long${stored}`),
      { cause },
    );
  }
}

/** Waits until the message whose text includes `body` reads as verified. */
async function waitForVerified(page: Page, body: string): Promise<void> {
  try {
    await waitForCondition(
      page,
      (_probe, text: string) => {
        // Each page function is serialized into the page on its own, so it
        // brings its own copy of `collect()`.
        function collect(root: Document | ShadowRoot, found: Element[]) {
          for (const element of root.querySelectorAll("*")) {
            if (element.tagName.toLowerCase() === "cf-cfc-authorship") {
              found.push(element);
            }
            if (element.shadowRoot) {
              collect(element.shadowRoot, found);
            }
          }
        }
        const found: Element[] = [];
        collect(document, found);
        return found.some((element) =>
          (element as unknown as { authorshipState?: string })
              .authorshipState === "verified" &&
          (element.textContent ?? "").includes(text)
        );
      },
      { args: [body] },
    );
  } catch (cause) {
    const reports = await readAuthorship(page).catch(() => undefined);
    throw new Error(
      `Timed out waiting for "${body}" to read as verified. ` +
        debugStr`Messages: $quote,indent,long${reports}`,
      { cause },
    );
  }
}

/** Reports every rendered message's authorship state and label views. */
async function readAuthorship(page: Page): Promise<AuthorshipReport[]> {
  return await page.evaluate(async () => {
    function collect(root: Document | ShadowRoot, found: Element[]) {
      for (const element of root.querySelectorAll("*")) {
        if (element.tagName.toLowerCase() === "cf-cfc-authorship") {
          found.push(element);
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, found);
        }
      }
    }
    type Labeled = { getCfcLabel?: () => Promise<unknown> };
    const found: Element[] = [];
    collect(document, found);
    return await Promise.all(found.map(async (element) => {
      const typed = element as unknown as {
        authorshipState?: string;
        author?: Labeled;
        value?: Labeled;
      };
      return {
        state: typed.authorshipState,
        text: element.textContent ?? "",
        authorLabel: await typed.author?.getCfcLabel?.() ?? null,
        valueLabel: await typed.value?.getCfcLabel?.() ?? null,
      };
    }));
  });
}
