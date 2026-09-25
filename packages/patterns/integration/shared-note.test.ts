import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  env,
  type Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { ACLManager } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";

import {
  clickTrustedAction,
  fillCfInput,
  waitForActiveSpaceRoot,
  waitForRuntimeIdle,
} from "./cfc-browser-helpers.ts";
import {
  type PresenceRelay,
  startPresenceRelay,
} from "./code-editor-presence-relay.ts";
import {
  initializePiecesController,
  type PieceController,
  type PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;
const IMPORTED_FILE =
  "---\r\ncategory: team\r\n---\r\n\r\n# Shared plan\r\n\r\n- [ ] Café lunch 🥗\r\n\r\n";
const MARKDOWN = IMPORTED_FILE.replace(/\r\n?/g, "\n");
const TITLE_SELECTOR = 'cf-input[aria-label="Note title"]';

type EditorHost = Element & {
  participantName?: string;
  presenceUrl?: string;
  updateComplete?: Promise<unknown>;
  _presenceParticipantId?: string;
  _collaboration?: { active?: boolean };
  _editorView?: {
    focus(): void;
    state: {
      doc: { length: number; toString(): string };
      readOnly: boolean;
    };
    dispatch(spec: unknown): void;
  };
};

const editorReady = (probe: ProbeApi): boolean => {
  const editor = probe.collect("cf-code-editor")[0] as EditorHost | undefined;
  return editor?._collaboration?.active === true &&
    editor._editorView?.state.readOnly === false;
};

const editorEquals = (probe: ProbeApi, expected: string): boolean =>
  (probe.collect("cf-code-editor")[0] as EditorHost | undefined)
    ?._editorView?.state.doc.toString() === expected;

const profileResolved = (probe: ProbeApi, name: string): boolean =>
  (probe.collect("cf-code-editor")[0] as EditorHost | undefined)
      ?.participantName === name &&
  probe.collect("cf-profile-badge").some((badge) =>
    probe.deepText(badge).includes(name)
  );

const remoteSelectionVisible = (probe: ProbeApi, name: string): boolean =>
  probe.collect(".cm-remote-presence-name").some((element) =>
    element.textContent === name
  ) && probe.collect(".cm-remote-presence-selection").some((element) =>
    element.getAttribute("title") === `${name}'s selection`
  );

/** Reads the rendered editor, or changes its selection without writing text. */
async function editorState(
  page: Page,
  selection?: { anchor: number; head: number },
): Promise<string> {
  return await page.evaluate((selection) => {
    const collect = (root: Document | ShadowRoot): Element[] => {
      const found: Element[] = [];
      for (const element of root.querySelectorAll("*")) {
        found.push(element);
        if (element.shadowRoot) found.push(...collect(element.shadowRoot));
      }
      return found;
    };
    const editor = collect(document).find((element) =>
      element.localName === "cf-code-editor"
    ) as EditorHost | undefined;
    const view = editor?._editorView;
    if (!view) throw new Error("Shared note editor is not ready");
    if (selection) {
      view.focus();
      view.dispatch({ selection });
    }
    return view.state.doc.toString();
  }, { args: [selection] });
}

/** Supplies the host's presence service; the pattern supplies the identity. */
async function connectPresence(page: Page, url: string): Promise<void> {
  await page.evaluate(async (url) => {
    const collect = (root: Document | ShadowRoot): Element[] => {
      const found: Element[] = [];
      for (const element of root.querySelectorAll("*")) {
        found.push(element);
        if (element.shadowRoot) found.push(...collect(element.shadowRoot));
      }
      return found;
    };
    const editor = collect(document).find((element) =>
      element.localName === "cf-code-editor"
    ) as EditorHost | undefined;
    if (!editor) throw new Error("Shared note editor is not mounted");
    editor.presenceUrl = url;
    await editor.updateComplete;
    editor._editorView?.focus();
  }, { args: [url] });
  await waitForCondition(
    page,
    (probe) =>
      typeof (probe.collect("cf-code-editor")[0] as EditorHost | undefined)
        ?._presenceParticipantId === "string",
  );
}

async function createProfile(page: Page, name: string): Promise<void> {
  await fillCfInput(page, "#wish-profile-name-input", name);
  await clickTrustedAction(page, "CreateProfile");
  await waitForRuntimeIdle(page);
  await waitForCondition(page, profileResolved, { args: [name] });
}

describe("shared-note", () => {
  const adaShell = new ShellIntegration();
  const graceShell = new ShellIntegration();
  adaShell.bindLifecycle();
  graceShell.bindLifecycle();

  let ada: Identity;
  let grace: Identity;
  let controller: PiecesController;
  let piece: PieceController;
  let presence: PresenceRelay;
  let cancel: (() => void) | undefined;

  beforeAll(async () => {
    [ada, grace] = await Promise.all([
      Identity.generate({ implementation: "noble" }),
      Identity.generate({ implementation: "noble" }),
    ]);
    presence = startPresenceRelay();
    controller = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: ada,
    });
    await controller.ensureDefaultPattern();
    await new ACLManager(controller.runtime, controller.getSpace()).set(
      grace.did(),
      "OWNER",
    );
    const program = await resolveLocalProgram(
      (resolver) => controller.runtime.harness.resolve(resolver),
      {
        main: join(import.meta.dirname!, "..", "shared-note", "main.tsx"),
        root: join(import.meta.dirname!, ".."),
      },
    );
    piece = await controller.create(program, {
      input: { title: "Team plan", content: MARKDOWN },
      start: true,
    });
    cancel = controller.getResult(piece.getCell()).sink(() => {});
  });

  afterAll(async () => {
    cancel?.();
    await controller?.dispose();
    await presence?.close();
  });

  it("shares imported Markdown and edits while labeling cursors with each viewer's Fabric profile", async () => {
    const adaPage = adaShell.page();
    const gracePage = graceShell.page();
    const pages = [adaPage, gracePage];
    const view = { spaceName: SPACE_NAME, pieceId: piece.id };
    await Promise.all([
      adaShell.goto({ frontendUrl: FRONTEND_URL, view, identity: ada }),
      graceShell.goto({ frontendUrl: FRONTEND_URL, view, identity: grace }),
    ]);
    await Promise.all(pages.map(async (page) => {
      await waitForActiveSpaceRoot(page, controller.getSpace());
      await waitForRuntimeIdle(page);
      await waitForCondition(page, editorReady);
      expect(await editorState(page)).toBe(MARKDOWN);
    }));

    await Promise.all([
      createProfile(adaPage, "Ada Lovelace"),
      createProfile(gracePage, "Grace Hopper"),
    ]);
    await fillCfInput(adaPage, TITLE_SELECTOR, "Friday team plan");
    await waitForCondition(gracePage, (probe, selector, expected) => {
      const input = probe.collect(selector)[0]?.shadowRoot
        ?.querySelector("input");
      return input?.value === expected;
    }, { args: [TITLE_SELECTOR, "Friday team plan"] });

    const end = MARKDOWN.length;
    await Promise.all(
      pages.map((page) => editorState(page, { anchor: end, head: end })),
    );
    await Promise.all([
      adaPage.keyboard.type("α"),
      gracePage.keyboard.type("β"),
    ]);
    const result = controller.getResult(piece.getCell());
    const settled = await waitForCellValue<{ content: string }>(
      controller.runtime,
      result,
      (value) =>
        value?.content.includes("α") === true &&
        value.content.includes("β"),
      { stuckLabel: "both shared note edits materialize" },
    );
    expect([MARKDOWN + "αβ", MARKDOWN + "βα"]).toContain(settled.content);
    await Promise.all(
      pages.map((page) =>
        waitForCondition(page, editorEquals, { args: [settled.content] })
      ),
    );

    await Promise.all(pages.map((page) => connectPresence(page, presence.url)));
    await editorState(adaPage, {
      anchor: MARKDOWN.indexOf("Café"),
      head: MARKDOWN.indexOf("Café") + 4,
    });
    await waitForCondition(gracePage, remoteSelectionVisible, {
      args: ["Ada Lovelace"],
    });
    await editorState(gracePage, {
      anchor: MARKDOWN.indexOf("Shared plan"),
      head: MARKDOWN.indexOf("Shared plan") + 6,
    });
    await waitForCondition(adaPage, remoteSelectionVisible, {
      args: ["Grace Hopper"],
    });

    await adaPage.reload({ waitUntil: "load" });
    await adaPage.applyConsoleFormatter();
    await adaShell.login(ada);
    await waitForCondition(adaPage, editorReady);
    await waitForCondition(adaPage, profileResolved, {
      args: ["Ada Lovelace"],
    });
    await waitForCondition(adaPage, editorEquals, { args: [settled.content] });
    await waitForCondition(
      gracePage,
      (probe) =>
        probe.collect(".cm-remote-presence-name").every((element) =>
          element.textContent !== "Ada Lovelace"
        ),
    );
    await connectPresence(adaPage, presence.url);
    await editorState(adaPage, {
      anchor: MARKDOWN.indexOf("Café"),
      head: MARKDOWN.indexOf("Café") + 4,
    });
    await waitForCondition(gracePage, remoteSelectionVisible, {
      args: ["Ada Lovelace"],
    });

    await editorState(adaPage, {
      anchor: settled.content.length,
      head: settled.content.length,
    });
    await adaPage.keyboard.type("Undo this addition.");
    await waitForCondition(gracePage, editorEquals, {
      args: [settled.content + "Undo this addition."],
    });
    const modifier = Deno.build.os === "darwin" ? "Meta" : "Control";
    await adaPage.keyboard.down(modifier);
    await adaPage.keyboard.press("z");
    await adaPage.keyboard.up(modifier);
    await Promise.all(
      pages.map((page) =>
        waitForCondition(page, editorEquals, { args: [settled.content] })
      ),
    );
    await waitForCellValue<{ content: string }>(
      controller.runtime,
      result,
      (value) => value?.content === settled.content,
      { stuckLabel: "shared note undo materializes" },
    );
  });
});
