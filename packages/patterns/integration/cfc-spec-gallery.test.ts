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
  clickTrustedActionAndWaitForText,
  waitForSettledText,
  waitForTextAbsent,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("cfc spec gallery integration test", () => {
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
      "cfc-spec-gallery",
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

  it("drives the trusted forward, command, and safe-link surfaces", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
      // The subject is what each trusted surface declares for itself. The
      // render ceiling denies author-supplied declassification, so this case
      // runs the profile without it; the render-ceiling case below runs the
      // same page with it.
      renderCeiling: false,
    });

    await clickTrustedActionAndWaitForText(
      page,
      "TrustedPrepareForward",
      "#trusted-forward-prepared",
      "Prepared for",
    );
    // Settled waits throughout: every stage indicator below is the
    // EFFECT of the preceding trusted click's served round trip, and a
    // plain DOM watch cannot pump the page's own pending pull work —
    // the state can sit one settle away from being drawn until the
    // stuck-condition net fires (docs/development/waiting-in-tests.md;
    // the cfc-staged-publish/#stage-pill and this file's own ON-lane
    // occurrence in the 2026-08-20 attribution ledger were this shape).
    await waitForSettledText(page, "#forward-stage", "prepared");
    await clickTrustedActionAndWaitForText(
      page,
      "TrustedForwardNote",
      "#trusted-forward-result",
      "Only the bounded itinerary excerpt will be forwarded.",
    );
    await waitForSettledText(page, "#forward-stage", "forwarded");

    await clickTrustedActionAndWaitForText(
      page,
      "TrustedCaptureDirectCommand",
      "#research-stage",
      "captured",
    );
    await waitForSettledText(page, "#research-stage", "captured");
    await clickTrustedActionAndWaitForText(
      page,
      "TrustedPrepareResearchBrief",
      "#trusted-command-prepared",
      "Prepared outbound",
    );
    await waitForSettledText(page, "#research-stage", "prepared");
    await clickTrustedActionAndWaitForText(
      page,
      "TrustedAuthorizeResearchSend",
      "#trusted-command-result",
      "Authorized outbound message",
    );
    await waitForSettledText(page, "#research-stage", "sent");

    await clickTrustedActionAndWaitForText(
      page,
      "TrustedPrepareSafeLink",
      "#trusted-safe-link-prepared",
      "?view=summary",
    );
    await waitForSettledText(page, "#safe-link-stage", "prepared");
    await clickTrustedActionAndWaitForText(
      page,
      "TrustedReleaseSafeLink",
      "#trusted-safe-link-result",
      "?view=summary",
    );
    await waitForSettledText(page, "#safe-link-stage", "released");
  });

  it("renders disclaimer-style labels without a trusted click", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
      // The subject is what a `cf-cfc-label` shows for each of these three
      // labels. Two of them sit outside the §8.10.6 display profile, so the
      // render ceiling blocks their cards and takes those labels with them;
      // this case runs the profile without the ceiling, and the case below
      // runs the same page with it. The key records an opt-out, so stating
      // `false` is what selects this profile; a page with no key at all takes
      // the ceiling.
      renderCeiling: false,
    });

    await waitForCfcLabelText(page, [
      "prompt-influence",
      "SourceProvenance",
      "fact-check-required",
    ]);
  });

  it("renders the admitted label and no other under the render ceiling", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
      renderCeiling: true,
    });

    // The ceiling admits the acting user's own identity atoms and the
    // influence-class caveat kinds, `prompt-influence` among them, so that
    // card's label renders and a blocked placeholder stands where the other
    // two cards were. The three strings below are the three the case above
    // waits for, so the pair states the same page under each profile.
    await waitForCfcLabelText(page, ["prompt-influence"]);
    await waitForSettledText(page, "cf-screen", "Content hidden by policy");
    await waitForTextAbsent(page, "cf-screen", "SourceProvenance");
    await waitForTextAbsent(page, "cf-screen", "fact-check-required");
  });
});

async function waitForCfcLabelText(page: Page, expected: string[]) {
  try {
    await waitForCondition(page, (probe, expected) => {
      const labels = probe.collect("cf-cfc-label").map((element) => {
        const shadowText = element.shadowRoot?.textContent ?? "";
        const lightText = element.textContent ?? "";
        return shadowText || lightText;
      });

      return expected.every((label) =>
        labels.some((rendered) => rendered.includes(label))
      );
    }, { args: [expected] });
  } catch (cause) {
    const probe = await readCfcLabelProbe(page);
    throw new Error(
      `Timed out waiting for CFC labels. ` +
        debugStr`Last probe: $quote,indent,long${probe}`,
      { cause },
    );
  }
}

type CfcLabelProbe = {
  registered: boolean;
  labels: string[];
  hosts: Array<{
    surface: string | null;
    lightText: string;
    shadowText: string;
    hasValue: boolean;
    hasGetCfcLabel: boolean;
    valueConstructor: string | undefined;
    ref: unknown;
    cfcLabel: unknown;
  }>;
};

async function readCfcLabelProbe(page: Page): Promise<CfcLabelProbe> {
  return await page.evaluate(async () => {
    function collect(root: Document | ShadowRoot, result: Element[]): void {
      for (const element of root.querySelectorAll("*")) {
        if (element.tagName.toLowerCase() === "cf-cfc-label") {
          result.push(element);
        }
        if (element.shadowRoot) {
          collect(element.shadowRoot, result);
        }
      }
    }

    const elements: Element[] = [];
    collect(document, elements);
    const hosts = await Promise.all(elements.map(async (element) => {
      const value = (element as unknown as { value?: unknown }).value;
      const ref = typeof (value as { ref?: unknown } | undefined)?.ref ===
          "function"
        ? (value as { ref(): unknown }).ref()
        : undefined;
      const cfcLabel = typeof (
          value as { getCfcLabel?: unknown } | undefined
        )?.getCfcLabel === "function"
        ? await (value as { getCfcLabel(): Promise<unknown> }).getCfcLabel()
          .catch((error) => String(error))
        : undefined;
      return {
        surface: element.getAttribute("data-cfc-label-surface"),
        lightText: element.textContent ?? "",
        shadowText: element.shadowRoot?.textContent ?? "",
        hasValue: value !== undefined,
        hasGetCfcLabel: typeof (
          value as { getCfcLabel?: unknown } | undefined
        )?.getCfcLabel === "function",
        valueConstructor: value && typeof value === "object"
          ? value.constructor?.name
          : undefined,
        ref,
        cfcLabel,
      };
    }));

    return {
      registered: customElements.get("cf-cfc-label") !== undefined,
      labels: hosts.map((host) => host.shadowText || host.lightText),
      hosts,
    };
  });
}
