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

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("cfc authorship chat integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let piece: Awaited<ReturnType<PiecesController["create"]>>;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });

    // Pre-create the space-root (default) pattern so the browser's
    // `pattern:getSpaceRoot` storage-RESUMEs it instead of taking the create
    // path and cold-compiling default-app inside its worker — see the
    // beforeAll comment in lunch-poll-vote.test.ts.
    await cc.ensureDefaultPattern();

    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "cfc-authorship-chat",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath, root: rootPath },
    );
    piece = await cc.create(program, { start: true });

    const resultCell = cc.getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("renders trusted avatars only for content whose author claim matches integrity", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });

    await waitForAuthorshipStates(page, {
      verified: "verified",
      forged: "unverified",
      unsigned: "unknown",
    });
  });
});

async function waitForAuthorshipStates(
  page: Page,
  expected: Record<string, "verified" | "unverified" | "unknown">,
) {
  let probe: AuthorshipProbe | undefined;
  try {
    await waitForCondition(
      page,
      (_probe, expectedEntries: Array<[string, string]>) => {
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

        const elements: Element[] = [];
        collect(document, elements);
        const hosts = elements.map((element) => {
          const typedElement = element as unknown as {
            authorshipState?: string;
            textIntegrityState?: string;
          };
          return {
            surface: element.getAttribute("data-authorship-surface"),
            state: typedElement.authorshipState,
            textIntegrityState: typedElement.textIntegrityState,
            lightText: element.textContent ?? "",
            renderedText: deepText(element),
            hasTrustedAvatar: element.shadowRoot?.querySelector(
              "[data-cfc-authorship-avatar]",
            ) !== null,
          };
        });

        return expectedEntries.every(([surface, state]) =>
          hosts.some((host) =>
            host.surface === surface &&
            host.state === state &&
            (state === "verified"
              ? host.hasTrustedAvatar
              : !host.hasTrustedAvatar) &&
            (surface === "verified"
              ? host.textIntegrityState === "ok" &&
                host.renderedText.includes("signed off")
              : host.textIntegrityState === "blocked" &&
                host.renderedText.includes(
                  "Content hidden by integrity policy",
                )) &&
            !host.lightText.includes("Project chat") &&
            !host.lightText.includes("Imported ticket thread")
          )
        );
      },
      { args: [Object.entries(expected)] },
    );
  } catch (cause) {
    probe = await readAuthorshipProbe(page);
    throw new Error(
      `Timed out waiting for CFC authorship states. ` +
        debugStr`Last probe: $quote,indent,long${probe}`,
      { cause },
    );
  }
}

type AuthorshipProbe = {
  registered: boolean;
  hosts: Array<{
    surface: string | null;
    state: string | undefined;
    textIntegrityState: string | undefined;
    shadowText: string;
    lightText: string;
    renderedText: string;
    hasTrustedAvatar: boolean;
  }>;
};

async function readAuthorshipProbe(page: Page): Promise<AuthorshipProbe> {
  return await page.evaluate(() => {
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

    const elements: Element[] = [];
    collect(document, elements);
    const hosts = elements.map((element) => {
      const typedElement = element as unknown as {
        authorshipState?: string;
        textIntegrityState?: string;
      };
      return {
        surface: element.getAttribute("data-authorship-surface"),
        state: typedElement.authorshipState,
        textIntegrityState: typedElement.textIntegrityState,
        shadowText: element.shadowRoot?.textContent ?? "",
        lightText: element.textContent ?? "",
        renderedText: deepText(element),
        hasTrustedAvatar:
          element.shadowRoot?.querySelector("[data-cfc-authorship-avatar]") !==
            null,
      };
    });

    return {
      registered: customElements.get("cf-cfc-authorship") !== undefined,
      hosts,
    };
  });
}
