import { debugStr } from "@commonfabric/data-model";
import { env, Page } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickTrustedAction,
  fillCfInput,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;
const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

describe("shared profile integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let secondIdentity: Identity;
  let cc: PiecesController;
  let sharedSpaceDid: string;
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
    sharedSpaceDid = cc.getSpace();

    // Pre-create the space-root (default) pattern so each browser boot's
    // `pattern:getSpaceRoot` storage-RESUMEs it instead of taking the create
    // path and cold-compiling default-app inside its worker — see the
    // beforeAll comment in lunch-poll-vote.test.ts.
    await cc.ensureDefaultPattern();

    // Resolve the demo through the harness (content-addressed program) and
    // create from that, mirroring the other CFC integration tests. Passing raw
    // source text with a random suffix instead produced a flaky piece-load race
    // (the started piece's data was not reliably durable when the shell loaded
    // it) under the content-addressed module identity scheme.
    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "shared-profile-demo",
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

  it("uses each user's home profile when rendering a shared pattern", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: sharedSpaceDid as `did:${string}:${string}`, pieceId },
      identity,
    });
    await waitForText(page, "#shared-profile-name", "No profile");

    await submitProfileCreate(
      page,
      "#wish-profile-name-input",
      "Ada Lovelace",
    );
    await waitForText(page, "#shared-profile-name", "Ada Lovelace");
    await waitForSelector(page, "#shared-profile-wish-ui cf-cell-link");

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      identity: secondIdentity,
      view: { spaceDid: sharedSpaceDid as `did:${string}:${string}`, pieceId },
    });
    await waitForText(page, "#shared-profile-name", "No profile");

    await submitProfileCreate(
      page,
      "#wish-profile-name-input",
      "Grace Hopper",
    );
    await waitForText(page, "#shared-profile-name", "Grace Hopper");
    await waitForSelector(page, "#shared-profile-wish-ui cf-cell-link");
  });
});

async function waitForSelector(page: Page, selector: string) {
  try {
    await page.waitForSelector(selector, {
      strategy: "pierce",
    });
  } catch (cause) {
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "")
      .catch(() => "");
    const probe = await readProfileCreateProbe(page).catch(() => undefined);
    throw new Error(
      `Unable to find ${selector}. Body: ${bodyText.slice(0, 1000)} ` +
        debugStr`Probe: $quote,indent,long${probe}`,
      { cause },
    );
  }
}

async function submitProfileCreate(
  page: Page,
  inputSelector: string,
  message: string,
) {
  // The create surface is a `cf-submit-input` whose inner input carries the id
  // passed as `inputId` by the #profile create launch (see runner wish.ts:
  // `inputId: "wish-profile-name-input"`). `fillCfInput` drives the DOM like a
  // user and calls the host's `commit()` (a no-op for a cell-less submit input),
  // then the trusted submit click carries the typed text as event.target.value.
  await fillCfInput(page, inputSelector, message);
  await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
  await waitForRuntimeIdle(page);
}

async function readProfileCreateProbe(page: Page) {
  return await page.evaluate(async () => {
    function collect(root: Document | ShadowRoot, result: Element[]): void {
      for (const element of root.querySelectorAll("*")) {
        result.push(element);
        if (element.shadowRoot) {
          collect(element.shadowRoot, result);
        }
      }
    }

    function deepText(root: Document | ShadowRoot | Element): string {
      let text = root.textContent ?? "";
      const elements = "querySelectorAll" in root
        ? Array.from(root.querySelectorAll("*"))
        : [];
      for (const element of elements) {
        if (element.shadowRoot) {
          text += ` ${deepText(element.shadowRoot)}`;
        }
      }
      return text.replace(/\s+/g, " ").trim();
    }

    const elements: Element[] = [];
    collect(document, elements);
    const home = await (async () => {
      try {
        type ProbeCell = {
          sync?: () => Promise<unknown>;
          ref?: () => unknown;
          key?: (path: string) => ProbeCell;
          resolveAsCell?: () => Promise<ProbeCell>;
        };
        const rt = (globalThis as unknown as {
          commonfabric?: {
            rt?: { getHomeSpaceCell?: () => Promise<ProbeCell> };
          };
        }).commonfabric?.rt;
        const homeCell = await rt?.getHomeSpaceCell?.();
        const defaultPattern = await homeCell?.key?.("defaultPattern")
          .resolveAsCell?.();
        // Multi-profile model: profiles[] + defaultProfile + mru (no single
        // `profile`/`profileName`). Best-effort diagnostic only.
        const defaultProfile = defaultPattern?.key?.("defaultProfile");
        const resolvedDefault = await defaultProfile?.resolveAsCell?.().catch((
          error: unknown,
        ) => ({
          ref: () => undefined,
          sync: () =>
            Promise.resolve(
              error instanceof Error ? error.message : String(error),
            ),
        }));
        return {
          defaultPattern: defaultPattern?.ref?.(),
          profiles: await defaultPattern?.key?.("profiles").sync?.(),
          defaultProfile: await defaultProfile?.sync?.(),
          mru: await defaultPattern?.key?.("mru").sync?.(),
          resolvedDefault: {
            ref: resolvedDefault?.ref?.(),
            value: await resolvedDefault?.sync?.(),
          },
        };
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    return {
      text: deepText(document).slice(0, 2000),
      home,
      tags: elements
        .map((element) => element.tagName.toLowerCase())
        .filter((tag) =>
          tag.startsWith("cf-") || tag === "input" || tag === "button"
        )
        .slice(0, 200),
      renders: Array.from(elements)
        .filter((element) => element.tagName.toLowerCase() === "cf-render")
        .map((element) => {
          const render = element as HTMLElement & {
            cell?: {
              id?: () => string;
              get?: () => unknown;
              sync?: () => Promise<unknown>;
            };
          };
          let value: unknown;
          try {
            value = render.cell?.get?.();
          } catch (error) {
            value = error instanceof Error ? error.message : String(error);
          }
          return {
            id: render.cell?.id?.(),
            value: typeof value === "object" && value !== null
              ? Object.keys(value as Record<string, unknown>)
              : value,
            attrs: Array.from(element.attributes).map((attr) => [
              attr.name,
              attr.value,
            ]),
            text: deepText(element).slice(0, 500),
          };
        }),
      links: Array.from(elements)
        .filter((element) => element.tagName.toLowerCase() === "cf-cell-link")
        .map((element) => {
          const link = element as HTMLElement & {
            cell?: {
              id?: () => string;
              get?: () => unknown;
              key?: (path: string) => { get?: () => unknown };
            };
          };
          return {
            id: link.cell?.id?.(),
            name: link.cell?.key?.("name")?.get?.(),
            initialNameApplied: link.cell?.key?.("initialNameApplied")?.get?.(),
            keys: (() => {
              const value = link.cell?.get?.();
              return typeof value === "object" && value !== null
                ? Object.keys(value as Record<string, unknown>)
                : value;
            })(),
            text: deepText(element).slice(0, 500),
          };
        }),
      wishText: Array.from(elements)
        .filter((element) => element.id === "shared-profile-wish-ui")
        .map((element) => deepText(element).slice(0, 1000)),
    };
  });
}
