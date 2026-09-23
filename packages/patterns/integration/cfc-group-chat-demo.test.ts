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
  fillCfInput,
  waitForDisabled,
  waitForRuntimeIdle,
  waitForText,
  waitForTextAbsent,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;
const IMPORTED_MESSAGE_MARKERS = [
  "Jumping in late here.",
  "I think we already covered this above.",
  "Can we loop back on the last point?",
  "Sharing a quick update from the thread.",
  "I might be missing context, but this seems fine.",
  "Content hidden by integrity policy",
] as const;

describe("cfc group chat demo integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let secondIdentity: Identity;
  let cc: PiecesController;
  let pieceId: string;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    secondIdentity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });

    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "cfc-group-chat-demo",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath, root: rootPath },
    );
    const piece = await cc.create(program, { start: true });
    pieceId = piece.id;
    const resultCell = cc.getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("gates sends through the trusted surface and lets authorship verification reject imported claims", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId,
      },
      identity,
    });
    await waitForRuntimeIdle(page);

    await waitForText(page, "#group-chat-manager-chip", "No profile");
    await waitForDisabled(page, "#trusted-send-button", true);

    await fillCfInput(
      page,
      "#trusted-profile-name",
      "Alice",
    );
    await waitForDisabled(page, "#trusted-profile-save", false);
    await clickCfButton(page, "#trusted-profile-save");
    await waitForText(page, "#trusted-profile-status", "Alice");
    await waitForText(
      page,
      "#group-chat-manager-chip",
      "Everyone is admin",
    );
    await waitForText(
      page,
      "#trusted-admin-manager-panel-status",
      "Everyone can add rooms",
    );
    await waitForRuntimeIdle(page);

    await fillCfInput(
      page,
      "#trusted-room-name",
      "Ops",
    );
    await waitForDisabled(page, "#trusted-room-add-button", false);
    await waitForText(
      page,
      '[data-ui-control="admin-user-toggle"]',
      "Admin via everyone",
    );
    await waitForDisabled(
      page,
      '[data-ui-control="admin-user-toggle"]',
      true,
    );
    await waitForRuntimeIdle(page);
    await clickCfButton(page, "#trusted-room-add-button");
    await waitForRuntimeIdle(page);
    await waitForText(page, "#rooms-panel", "1 room");
    await waitForText(page, "#rooms-panel", "Ops");

    await fillCfInput(
      page,
      "#host-message-draft",
      "Fake hello from Alice",
    );
    // Wait for the send button to ENABLE before clicking, exactly like the
    // trusted sends below (S-G, rootcause §2b): `hostSendDisabled` derives
    // from the draft, and under the server-execution ON arm that derivation
    // is a served round trip — clicking an interim-disabled cf-button
    // retargets the click to the host element and the send never fires.
    // Correct under the OFF arm too (the enable is just immediate there).
    await waitForDisabled(page, "#host-send-button", false);
    await clickCfButton(page, "#host-send-button");
    await waitForRuntimeIdle(page);
    await waitForTextAbsent(
      page,
      "#trusted-conversation-preview",
      "Fake hello from Alice",
    );

    await fillCfInput(
      page,
      "#trusted-message-draft",
      "Hello from Alice",
    );
    await waitForRuntimeIdle(page);
    await waitForDisabled(page, "#trusted-send-button", false);
    await clickCfButton(page, "#trusted-send-button");
    await waitForText(
      page,
      "#trusted-conversation-preview",
      "1 message",
    );
    await waitForAuthorshipState(
      page,
      "Hello from Alice",
      "#trusted-conversation-preview",
    );

    await shell.login(secondIdentity);
    await shell.waitForState({
      identity: secondIdentity,
      view: {
        spaceName: SPACE_NAME,
        pieceId,
      },
    });

    await waitForText(
      page,
      "#trusted-conversation-preview",
      "1 message",
    );
    await waitForAuthorshipState(
      page,
      "Hello from Alice",
      "#trusted-conversation-preview",
    );
    await waitForDisabled(page, "#trusted-send-button", true);

    await fillCfInput(
      page,
      "#trusted-profile-name",
      "Bob",
    );
    await waitForDisabled(page, "#trusted-profile-save", false);
    await clickCfButton(page, "#trusted-profile-save");
    await waitForText(page, "#trusted-profile-status", "Bob");
    await waitForRuntimeIdle(page);

    await fillCfInput(
      page,
      "#trusted-message-draft",
      "Hello from Bob",
    );
    await waitForRuntimeIdle(page);
    // Wait for the send button to ENABLE before clicking, exactly like
    // Alice's send above (S-G, rootcause §2b): `sendDisabled` derives from
    // the draft, and under the server-execution ON arm that derivation is
    // a served round trip — clicking an interim-disabled cf-button
    // retargets the click to the host element and the send never fires.
    // Correct under the OFF arm too (the enable is just immediate there).
    await waitForDisabled(page, "#trusted-send-button", false);
    await clickCfButton(page, "#trusted-send-button");
    await waitForText(
      page,
      "#trusted-conversation-preview",
      "2 messages",
    );
    await waitForAuthorshipState(
      page,
      "Hello from Bob",
      "#trusted-conversation-preview",
    );

    await clickCfButton(page, "#add-random-messages");

    await waitForText(
      page,
      "#trusted-conversation-preview",
      "4 messages",
    );
    await waitForTextAbsent(
      page,
      "#trusted-conversation-preview",
      "Invalid claim",
    );
    await waitForInvalidAuthorshipState(
      page,
      "#trusted-conversation-preview",
    );

    await fillCfInput(
      page,
      "#trusted-message-draft",
      "Bob after imported claims",
    );
    await waitForRuntimeIdle(page);
    await clickCfButton(page, "#trusted-send-button");
    await waitForText(
      page,
      "#trusted-conversation-preview",
      "5 messages",
    );
    await waitForAuthorshipState(
      page,
      "Bob after imported claims",
      "#trusted-conversation-preview",
    );
  });
});

async function waitForAuthorshipState(
  page: Page,
  expectedText: string,
  containerSelector?: string,
) {
  let probe: AuthorshipProbe | undefined;
  try {
    await waitForCondition(
      page,
      (_probe, targetContainerSelector: string | undefined, text: string) => {
        function collect(
          root: Document | ShadowRoot,
          result: Element[],
        ): void {
          for (const element of root.querySelectorAll("*")) {
            if (element.tagName.toLowerCase() === "cf-cfc-authorship") {
              result.push(element);
            }
            if (element.shadowRoot) {
              collect(element.shadowRoot, result);
            }
          }
        }

        function deepText(root: ParentNode): string {
          let text = root instanceof Element || root instanceof ShadowRoot
            ? root.textContent ?? ""
            : "";
          for (const element of root.querySelectorAll("*")) {
            if (element.shadowRoot) {
              text += ` ${deepText(element.shadowRoot)}`;
            }
          }
          return text;
        }

        function isWithinContainer(
          element: Element,
          selector: string | undefined,
        ): boolean {
          if (!selector) {
            return true;
          }

          let current: Node | null = element;
          while (current) {
            if (current instanceof Element) {
              try {
                if (current.matches(selector)) {
                  return true;
                }
              } catch {
                return false;
              }
            }
            const root = current.getRootNode();
            current = current.parentNode ??
              (root instanceof ShadowRoot ? root.host : null);
          }
          return false;
        }

        const collected: Element[] = [];
        collect(document, collected);
        const elements = collected.filter((element) =>
          isWithinContainer(element, targetContainerSelector)
        );
        return elements.some((element) => {
          const typedElement = element as unknown as {
            authorshipState?: string;
            textIntegrityState?: string;
          };
          return typedElement.authorshipState === "verified" &&
            typedElement.textIntegrityState === "ok" &&
            deepText(element).includes(text) &&
            element.shadowRoot?.querySelector(
                "[data-cfc-authorship-avatar]",
              ) !== null;
        });
      },
      {
        args: [containerSelector, expectedText],
      },
    );
  } catch (cause) {
    probe = await readAuthorshipProbe(page, containerSelector);
    throw new Error(
      `Timed out waiting for verified authorship row. ` +
        debugStr`Last probe: $quote,indent,long${probe}`,
      { cause },
    );
  }
}

async function waitForInvalidAuthorshipState(
  page: Page,
  containerSelector?: string,
) {
  let probe: AuthorshipProbe | undefined;
  try {
    await waitForCondition(
      page,
      (
        _probe,
        targetContainerSelector: string | undefined,
        markers: readonly string[],
      ) => {
        function collect(
          root: Document | ShadowRoot,
          result: Element[],
        ): void {
          for (const element of root.querySelectorAll("*")) {
            if (element.tagName.toLowerCase() === "cf-cfc-authorship") {
              result.push(element);
            }
            if (element.shadowRoot) {
              collect(element.shadowRoot, result);
            }
          }
        }

        function deepText(root: ParentNode): string {
          let text = root instanceof Element || root instanceof ShadowRoot
            ? root.textContent ?? ""
            : "";
          for (const element of root.querySelectorAll("*")) {
            if (element.shadowRoot) {
              text += ` ${deepText(element.shadowRoot)}`;
            }
          }
          return text;
        }

        function isWithinContainer(
          element: Element,
          selector: string | undefined,
        ): boolean {
          if (!selector) {
            return true;
          }

          let current: Node | null = element;
          while (current) {
            if (current instanceof Element) {
              try {
                if (current.matches(selector)) {
                  return true;
                }
              } catch {
                return false;
              }
            }
            const root = current.getRootNode();
            current = current.parentNode ??
              (root instanceof ShadowRoot ? root.host : null);
          }
          return false;
        }

        const collected: Element[] = [];
        collect(document, collected);
        const elements = collected.filter((element) =>
          isWithinContainer(element, targetContainerSelector)
        );
        return elements.some((element) => {
          const typedElement = element as unknown as {
            authorshipState?: string;
          };
          const state = typedElement.authorshipState;
          const hasTrustedAvatar = element.shadowRoot?.querySelector(
            "[data-cfc-authorship-avatar]",
          ) !== null;
          const renderedText = deepText(element);
          return (state === "unknown" || state === "unverified") &&
            !hasTrustedAvatar &&
            markers.some((marker) => renderedText.includes(marker));
        });
      },
      {
        args: [containerSelector, IMPORTED_MESSAGE_MARKERS],
      },
    );
  } catch (cause) {
    probe = await readAuthorshipProbe(page, containerSelector);
    throw new Error(
      `Timed out waiting for invalid authorship row. ` +
        debugStr`Last probe: $quote,indent,long${probe}`,
      { cause },
    );
  }
}

type AuthorshipProbe = {
  hosts: Array<{
    state: string | undefined;
    textIntegrityState: string | undefined;
    renderedText: string;
    hasTrustedAvatar: boolean;
    hasValue: boolean;
    valueType: string;
    hasValueGetCfcLabel: boolean;
    hasValueResolveAsCell: boolean;
    hasAuthor: boolean;
    authorType: string;
    authorClaim: unknown;
    valueRef: unknown;
    valueLabel: unknown;
    valueSourceRef: unknown;
    valueSourceLabel: unknown;
    resolvedValueRef: unknown;
    resolvedValueLabel: unknown;
    resolvedValueSourceRef: unknown;
    resolvedValueSourceLabel: unknown;
  }>;
};

async function readAuthorshipProbe(
  page: Page,
  containerSelector?: string,
): Promise<AuthorshipProbe> {
  return await page.evaluate((targetContainerSelector?: string) => {
    function collect(root: Document | ShadowRoot, result: Element[]): void {
      for (const element of root.querySelectorAll("*")) {
        if (element.tagName.toLowerCase() === "cf-cfc-authorship") {
          result.push(element);
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, result);
        }
      }
    }

    function deepText(root: ParentNode): string {
      let text = root instanceof Element || root instanceof ShadowRoot
        ? root.textContent ?? ""
        : "";
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) {
          text += ` ${deepText(element.shadowRoot)}`;
        }
      }
      return text;
    }

    function isWithinContainer(
      element: Element,
      selector: string | undefined,
    ): boolean {
      if (!selector) {
        return true;
      }

      let current: Node | null = element;
      while (current) {
        if (current instanceof Element) {
          try {
            if (current.matches(selector)) {
              return true;
            }
          } catch {
            return false;
          }
        }
        const root = current.getRootNode();
        current = current.parentNode ??
          (root instanceof ShadowRoot ? root.host : null);
      }
      return false;
    }

    const collected: Element[] = [];
    collect(document, collected);
    const elements = collected.filter((element) =>
      isWithinContainer(element, targetContainerSelector)
    );
    const hosts = elements.map(async (element) => {
      const typedElement = element as unknown as {
        authorshipState?: string;
        textIntegrityState?: string;
        value?: {
          getCfcLabel?: () => Promise<unknown>;
          ref?: () => unknown;
          getSourceCell?: () => {
            getCfcLabel?: () => Promise<unknown>;
            ref?: () => unknown;
          };
          resolveAsCell?: () => {
            getCfcLabel?: () => Promise<unknown>;
            ref?: () => unknown;
            getSourceCell?: () => {
              getCfcLabel?: () => Promise<unknown>;
              ref?: () => unknown;
            };
          };
        };
        author?: {
          get?: () => unknown;
          sync?: () => Promise<unknown>;
        };
      };
      const value = typedElement.value;
      const resolvedValue = typeof value?.resolveAsCell === "function"
        ? await value.resolveAsCell()
        : null;
      const valueSource = value?.getSourceCell?.() ?? null;
      const resolvedValueSource = resolvedValue?.getSourceCell?.() ?? null;
      const author = typedElement.author;
      return {
        state: typedElement.authorshipState,
        textIntegrityState: typedElement.textIntegrityState,
        renderedText: deepText(element),
        hasTrustedAvatar:
          element.shadowRoot?.querySelector("[data-cfc-authorship-avatar]") !==
            null,
        hasValue: value !== undefined,
        valueType: typeof value,
        hasValueGetCfcLabel: typeof value?.getCfcLabel === "function",
        hasValueResolveAsCell: typeof value?.resolveAsCell === "function",
        hasAuthor: author !== undefined,
        authorType: typeof author,
        authorClaim: typeof author?.sync === "function"
          ? await author.sync()
          : author?.get?.() ?? author ?? null,
        valueRef: value?.ref?.() ?? null,
        valueLabel: await value?.getCfcLabel?.() ?? null,
        valueSourceRef: valueSource?.ref?.() ?? null,
        valueSourceLabel: await valueSource?.getCfcLabel?.() ?? null,
        resolvedValueRef: resolvedValue?.ref?.() ?? null,
        resolvedValueLabel: await resolvedValue?.getCfcLabel?.() ?? null,
        resolvedValueSourceRef: resolvedValueSource?.ref?.() ?? null,
        resolvedValueSourceLabel: await resolvedValueSource?.getCfcLabel?.() ??
          null,
      };
    });

    return Promise.all(hosts).then((resolvedHosts) => ({
      hosts: resolvedHosts,
    }));
  }, { args: [containerSelector] });
}
