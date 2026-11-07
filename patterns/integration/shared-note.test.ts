import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";

import { type DID, Identity } from "@commonfabric/identity";
import {
  createTestSpace,
  env,
  type Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";

import {
  clickCfButton,
  clickTrustedAction,
  fillCfInput,
  fillCfTextarea,
  waitForActiveSpaceRoot,
  waitForDisabled,
  waitForRuntimeIdle,
} from "./cfc-browser-helpers.ts";
import {
  initializePiecesController,
  type PieceController,
  type PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL } = env;
const IMPORTED_FILE =
  "---\r\ncategory: team\r\n---\r\n\r\n# Shared plan\r\n\r\n- [ ] Café lunch 🥗\r\n\r\n";
const MARKDOWN = IMPORTED_FILE.replace(/\r\n?/g, "\n");
const TITLE_SELECTOR = 'cf-input[aria-label="Note title"]';

type EditorHost = Element & {
  participantName?: string;
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

/**
 * The editor has joined the shared field's presence room. The pattern names the
 * viewer from their Fabric profile, and the editor joins over its connection to
 * the memory server.
 */
const presenceJoined = (probe: ProbeApi): boolean =>
  typeof (probe.collect("cf-code-editor")[0] as EditorHost | undefined)
    ?._presenceParticipantId === "string";

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
        if (element.shadowRoot) {
          for (const nested of collect(element.shadowRoot)) found.push(nested);
        }
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

async function createProfile(page: Page, name: string): Promise<void> {
  await fillCfInput(page, "#wish-profile-name-input", name);
  await clickTrustedAction(page, "CreateProfile");
  await waitForRuntimeIdle(page);
  await waitForCondition(page, profileResolved, { args: [name] });
}

/**
 * Gives the viewer the Fabric profile `name`, unless an earlier test already
 * did.
 */
async function ensureProfile(page: Page, name: string): Promise<void> {
  const state = await waitForCondition(
    page,
    (probe, name) => {
      const editor = probe.collect("cf-code-editor")[0] as
        | { participantName?: string }
        | undefined;
      if (
        editor?.participantName === name &&
        probe.collect("cf-profile-badge").some((badge) =>
          probe.deepText(badge).includes(name)
        )
      ) {
        return "resolved";
      }
      return probe.collect("#wish-profile-name-input").some((element) =>
          probe.isRendered(element)
        )
        ? "missing"
        : false;
    },
    { args: [name] },
  );
  if (state === "missing") await createProfile(page, name);
}

/** Whether the editor draws exactly one comment mark, over `text`. */
const marksOnly = (probe: ProbeApi, text: string): boolean => {
  const marks = probe.collect(".cm-highlight");
  return marks.length === 1 && marks[0].textContent === text;
};

/**
 * The range between the two anchors of the one comment `anchors` holds, or
 * an empty tuple where it holds neither.
 */
const anchoredRange = (
  anchors: Record<string, number> | undefined,
): [number, number] | [] => {
  const ids = Object.keys(anchors ?? {});
  const from = ids.find((id) => id.endsWith(":from"));
  const to = ids.find((id) => id.endsWith(":to"));
  return anchors === undefined || from === undefined || to === undefined
    ? []
    : [anchors[from], anchors[to]];
};

/** Whether the comments panel shows `text`. */
/** Whether the comment composer is shown. */
const composerShown = (probe: ProbeApi): boolean =>
  probe.collect("#shared-note-composer").some((composer) =>
    getComputedStyle(composer).display !== "none"
  );

const commentShown = (probe: ProbeApi, text: string): boolean =>
  probe.collect("#shared-note-comments").some((panel) =>
    probe.deepText(panel).includes(text)
  );

async function expectNoteFits(page: Page, width: number): Promise<void> {
  const layout = await page.evaluate(() => {
    const collect = (root: Document | ShadowRoot | Element): Element[] => {
      const found: Element[] = [];
      for (const element of root.querySelectorAll("*")) {
        found.push(element);
        if (element.shadowRoot) {
          for (const nested of collect(element.shadowRoot)) found.push(nested);
        }
      }
      return found;
    };
    const elements = collect(document);
    const editor = elements.find((element) =>
      element.localName === "cf-code-editor"
    );
    const note = editor?.parentElement;
    if (!note) throw new Error("Shared note is not mounted");
    const bounds = note.getBoundingClientRect();
    const controls = [
      editor,
      ...collect(note).filter((element) =>
        element.matches("cf-input, cf-submit-input, input, cf-button")
      ),
    ];
    return {
      width: bounds.width,
      overflowingControls: controls.flatMap((element) => {
        if (!element) return [];
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return [];
        return rect.left < bounds.left - 1 || rect.right > bounds.right + 1
          ? [{ tag: element.localName, left: rect.left, right: rect.right }]
          : [];
      }),
    };
  });
  expect(layout.width).toBeLessThanOrEqual(width);
  expect(layout.width).toBeGreaterThan(0);
  expect(layout.overflowingControls).toEqual([]);
}

describe("shared-note", () => {
  const adaShell = new ShellIntegration();
  const graceShell = new ShellIntegration();
  adaShell.bindLifecycle();
  graceShell.bindLifecycle();

  let ada: Identity;
  let grace: Identity;
  let spaceDid: DID;
  let controller: PiecesController;
  let piece: PieceController;
  let cancel: (() => void) | undefined;

  beforeAll(async () => {
    [ada, grace] = await Promise.all([
      Identity.generate({ implementation: "noble" }),
      Identity.generate({ implementation: "noble" }),
    ]);
    spaceDid = await createTestSpace(ada, {
      grants: { [grace.did()]: "OWNER" },
    });
    controller = await initializePiecesController({
      space: spaceDid,
      apiUrl: new URL(API_URL),
      identity: ada,
    });
    await controller.ensureDefaultPattern();
    const program = await resolveLocalProgram(
      (resolver) => controller.runtime.harness.resolve(resolver),
      {
        main: join(
          import.meta.dirname!,
          "..",
          "apps",
          "shared-note",
          "main.tsx",
        ),
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
  });

  it("shares imported Markdown and edits while labeling cursors with each viewer's Fabric profile", async () => {
    const adaPage = adaShell.page();
    const gracePage = graceShell.page();
    const pages = [adaPage, gracePage];
    const view = { spaceDid, pieceId: piece.id };
    await Promise.all([
      adaShell.goto({ frontendUrl: FRONTEND_URL, view, identity: ada }),
      graceShell.goto({ frontendUrl: FRONTEND_URL, view, identity: grace }),
    ]);
    await Promise.all(pages.map(async (page) => {
      await waitForActiveSpaceRoot(page, spaceDid);
      await waitForRuntimeIdle(page);
      await waitForCondition(page, editorReady);
      expect(await editorState(page)).toBe(MARKDOWN);
    }));

    await adaPage.setViewportSize({ width: 360, height: 800 });
    await waitForCondition(
      adaPage,
      (probe) =>
        probe.collect("#wish-profile-name-input").some((element) =>
          probe.isRendered(element)
        ),
    );
    await expectNoteFits(adaPage, 360);

    await Promise.all([
      createProfile(adaPage, "Ada Lovelace"),
      createProfile(gracePage, "Grace Hopper"),
    ]);
    await expectNoteFits(adaPage, 360);
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

    await Promise.all(
      pages.map((page) => waitForCondition(page, presenceJoined)),
    );
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
    await waitForCondition(adaPage, presenceJoined);
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

  it("keeps a comment on its text while both viewers type ahead of it", async () => {
    const adaPage = adaShell.page();
    const gracePage = graceShell.page();
    const pages = [adaPage, gracePage];
    const view = { spaceDid, pieceId: piece.id };
    await Promise.all([
      adaShell.goto({ frontendUrl: FRONTEND_URL, view, identity: ada }),
      graceShell.goto({ frontendUrl: FRONTEND_URL, view, identity: grace }),
    ]);
    await Promise.all(pages.map(async (page) => {
      await waitForActiveSpaceRoot(page, spaceDid);
      await waitForRuntimeIdle(page);
      await waitForCondition(page, editorReady);
    }));
    await Promise.all([
      ensureProfile(adaPage, "Ada Lovelace"),
      ensureProfile(gracePage, "Grace Hopper"),
    ]);

    // Ada selects "Café" and comments on it.
    const before = await editorState(adaPage);
    const cafe = before.indexOf("Café");
    expect(cafe).toBeGreaterThan(-1);
    await editorState(adaPage, { anchor: cafe, head: cafe + "Café".length });
    await waitForDisabled(adaPage, "#shared-note-comment-button", false);
    await clickCfButton(adaPage, "#shared-note-comment-button");
    // A person types once the composer is shown; typing before then writes
    // the draft ahead of the handler that opens the composer.
    await waitForCondition(adaPage, composerShown);
    await fillCfTextarea(
      adaPage,
      "#shared-note-comment-draft",
      "Which café?",
    );

    // Grace types ahead of "Café" while Ada's composer is open. The composer
    // anchored the selection when it opened, so Memory moves the anchors
    // through Grace's edit.
    await editorState(gracePage, { anchor: 0, head: 0 });
    await gracePage.keyboard.type("G0 ");
    await waitForCondition(
      adaPage,
      (probe) =>
        (probe.collect("cf-code-editor")[0] as EditorHost | undefined)
          ?._editorView?.state.doc.toString().startsWith("G0 ") === true,
    );
    await clickCfButton(adaPage, "#shared-note-post-button");
    await Promise.all(
      pages.map(async (page) => {
        await waitForCondition(page, marksOnly, { args: ["Café"] });
        await waitForCondition(page, commentShown, { args: ["Which café?"] });
      }),
    );

    // Both type ahead of it at once; the mark stays on "Café" in both
    // editors, and Memory's anchors hold it in the stored text.
    await Promise.all(
      pages.map((page) => editorState(page, { anchor: 0, head: 0 })),
    );
    await Promise.all([
      adaPage.keyboard.type("①"),
      gracePage.keyboard.type("②"),
    ]);
    const result = controller.getResult(piece.getCell());
    const settled = await waitForCellValue<{
      content: string;
      commentAnchors?: Record<string, number>;
    }>(
      controller.runtime,
      result,
      (value) => {
        const [from, to] = anchoredRange(value?.commentAnchors);
        return value?.content.includes("①") === true &&
          value.content.includes("②") &&
          value.content.includes("G0 ") && from !== undefined &&
          value.content.slice(from, to) === "Café";
      },
      { stuckLabel: "the comment's anchors follow both edits" },
    );
    expect(Object.keys(settled.commentAnchors ?? {})).toHaveLength(2);
    await Promise.all(
      pages.map((page) =>
        waitForCondition(page, editorEquals, { args: [settled.content] })
      ),
    );
    await Promise.all(
      pages.map((page) =>
        waitForCondition(page, marksOnly, { args: ["Café"] })
      ),
    );
  });
});
