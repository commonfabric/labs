import { expect } from "@std/expect";
import { join, resolve } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import type { DID } from "@commonfabric/identity";
import {
  createTestSpace,
  env,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { writeTempIdentity } from "@commonfabric/integration/temp-identity";

import "../src/globals.ts";

import { clickPierce } from "./shadow-dom.ts";

const { API_URL, FRONTEND_URL } = env;
const REPO_ROOT = resolve(import.meta.dirname!, "../../..");
const decoder = new TextDecoder();

type MeasuredRect = { x: number; y: number; width: number; height: number };

async function createNestedPiece(
  identityPath: string,
  space: DID,
  slug: string,
): Promise<void> {
  const command = new Deno.Command(Deno.execPath(), {
    cwd: REPO_ROOT,
    args: [
      "run",
      "-A",
      join(REPO_ROOT, "packages", "cli", "mod.ts"),
      "piece",
      "new",
      join(import.meta.dirname!, "fixtures", "nested-piece.tsx"),
      "--identity",
      identityPath,
      "--api-url",
      API_URL,
      "--space",
      space,
      "--slug",
      slug,
    ],
    env: { CF_LOG_LEVEL: "error" },
  });
  const result = await command.output();
  if (result.success) return;
  throw new Error(
    `cf piece new failed with ${result.code}\nstdout:\n${
      decoder.decode(result.stdout)
    }\nstderr:\n${decoder.decode(result.stderr)}`,
  );
}

/** Wait until the space root piece has rendered into the body view. */
async function waitForRenderedPiece(
  page: ReturnType<ShellIntegration["page"]>,
): Promise<void> {
  await waitForCondition(page, () => {
    const rootView = document.querySelector("x-root-view");
    const appView = rootView?.shadowRoot?.querySelector("x-app-view");
    const bodyView = appView?.shadowRoot?.querySelector("x-body-view");
    return !!bodyView?.shadowRoot?.querySelector("cf-render");
  });
}

/**
 * Right-click the rendered piece. The click is dispatched on the `cf-render`
 * element itself, which is what a real right-click on the piece reaches.
 */
async function rightClickRenderedPiece(
  page: ReturnType<ShellIntegration["page"]>,
): Promise<{
  highlighted: boolean;
  before: MeasuredRect;
  after: MeasuredRect;
  overlay: MeasuredRect;
  visual: {
    opacity: string;
    pointerEvents: string;
    position: string;
    zIndex: string;
    hostPositionBefore: string;
    hostPosition: string;
    hostIsolationBefore: string;
    hostIsolation: string;
    stackIsolation: string;
    contentIsolation: string;
    backgroundImage: string;
    boxShadow: string;
    animationName: string;
    animationIterationCount: string;
    reducedMotion: boolean;
  };
}> {
  return await page.evaluate(() => {
    const rootView = document.querySelector("x-root-view");
    const appView = rootView?.shadowRoot?.querySelector("x-app-view");
    const bodyView = appView?.shadowRoot?.querySelector("x-body-view");
    const render = bodyView?.shadowRoot?.querySelector("cf-render");
    if (!render) throw new Error("no rendered piece to right-click");
    const highlight = render.shadowRoot?.querySelector(
      ".piece-menu-highlight",
    );
    const stack = render.shadowRoot?.querySelector(".render-stack");
    const content = render.shadowRoot?.querySelector(".render-container");
    if (!highlight || !stack || !content) {
      throw new Error("no piece highlight layer");
    }
    const measure = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const before = measure(render);
    const hostStyleBefore = getComputedStyle(render);
    const hostPositionBefore = hostStyleBefore.position;
    const hostIsolationBefore = hostStyleBefore.isolation;
    render.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        composed: true,
        cancelable: true,
        clientX: 80,
        clientY: 80,
      }),
    );
    const highlightStyle = getComputedStyle(highlight);
    return {
      highlighted: render.hasAttribute("data-cf-piece-menu-open"),
      before,
      after: measure(render),
      overlay: measure(highlight),
      visual: {
        opacity: highlightStyle.opacity,
        pointerEvents: highlightStyle.pointerEvents,
        position: highlightStyle.position,
        zIndex: highlightStyle.zIndex,
        hostPositionBefore,
        hostPosition: getComputedStyle(render).position,
        hostIsolationBefore,
        hostIsolation: getComputedStyle(render).isolation,
        stackIsolation: getComputedStyle(stack).isolation,
        contentIsolation: getComputedStyle(content).isolation,
        backgroundImage: highlightStyle.backgroundImage,
        boxShadow: highlightStyle.boxShadow,
        animationName: highlightStyle.animationName,
        animationIterationCount: highlightStyle.animationIterationCount,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      },
    };
  });
}

/** Measure the chip baseline and box before and during its highlight. */
async function measureChipHighlightLayout(
  page: ReturnType<ShellIntegration["page"]>,
): Promise<{
  before: MeasuredRect;
  after: MeasuredRect;
  overlay: MeasuredRect;
  lineBefore: MeasuredRect;
  lineAfter: MeasuredRect;
  outerBaselineBefore: number;
  outerBaselineAfter: number;
  innerBaselineBefore: number;
  innerBaselineAfter: number;
}> {
  return await page.evaluate(async () => {
    const line = document.createElement("div");
    line.style.cssText = [
      "position: fixed",
      "left: 0",
      "top: 0",
      "visibility: hidden",
      "white-space: nowrap",
      "font: 20px/24px sans-serif",
    ].join(";");
    const chip = document.createElement("cf-render") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    chip.setAttribute("variant", "chip");
    const baselineProbe = () => {
      const probe = document.createElement("span");
      probe.style.cssText = [
        "display: inline-block",
        "width: 0",
        "height: 0",
        "padding: 0",
        "margin: 0",
        "border: 0",
      ].join(";");
      return probe;
    };
    const outerProbe = baselineProbe();
    line.append("before ", chip, outerProbe, " after");
    document.body.appendChild(line);

    try {
      await chip.updateComplete;
      const content = chip.shadowRoot?.querySelector(".render-container");
      const highlight = chip.shadowRoot?.querySelector(
        ".piece-menu-highlight",
      );
      if (!content || !highlight) throw new Error("no chip highlight layer");
      const innerProbe = baselineProbe();
      content.append("chip", innerProbe);
      const measure = (element: Element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      const baseline = (probe: Element) => probe.getBoundingClientRect().top;
      const before = measure(chip);
      const lineBefore = measure(line);
      const outerBaselineBefore = baseline(outerProbe);
      const innerBaselineBefore = baseline(innerProbe);

      chip.setAttribute("data-cf-piece-menu-open", "");
      return {
        before,
        after: measure(chip),
        overlay: measure(highlight),
        lineBefore,
        lineAfter: measure(line),
        outerBaselineBefore,
        outerBaselineAfter: baseline(outerProbe),
        innerBaselineBefore,
        innerBaselineAfter: baseline(innerProbe),
      };
    } finally {
      line.remove();
    }
  });
}

/** Retarget a followed piece while its menu is open. */
async function retargetHighlightedPiece(
  page: ReturnType<ShellIntegration["page"]>,
): Promise<{
  before: { highlighted: boolean; menuHidden: boolean };
  duringReplacementRender: { highlighted: boolean; menuHidden: boolean };
  after: { highlighted: boolean; menuHidden: boolean };
  replacementRendered: boolean;
}> {
  return await page.evaluate(async () => {
    const rootView = document.querySelector("x-root-view");
    const appView = rootView?.shadowRoot?.querySelector("x-app-view");
    const bodyView = appView?.shadowRoot?.querySelector("x-body-view");
    const existing = bodyView?.shadowRoot?.querySelector("cf-render") as
      | (HTMLElement & {
        _pieceTarget(): {
          equals(other: unknown): boolean;
          key(name: string): unknown;
          space(): unknown;
        } | undefined;
      })
      | null;
    const firstTarget = existing?._pieceTarget();
    if (!firstTarget) throw new Error("no piece target for retarget test");

    const cellPrototype = Object.getPrototypeOf(firstTarget);
    const secondTarget = firstTarget.key(
      "piece-menu-retarget-test",
    ) as typeof firstTarget;
    const link = {
      equals(other: unknown) {
        return other === link;
      },
      id() {
        return "of:fid1:followed-piece";
      },
      ref() {
        return { path: ["piece"] };
      },
      space() {
        return firstTarget.space();
      },
    };
    Object.setPrototypeOf(link, cellPrototype);
    let publish: ((value: typeof firstTarget) => void) | undefined;
    (link as typeof link & {
      asSchema(): {
        sync(): Promise<typeof firstTarget>;
        subscribe(callback: (value: typeof firstTarget) => void): () => void;
      };
    }).asSchema = () => ({
      sync: () => Promise.resolve(firstTarget),
      subscribe(callback) {
        callback(firstTarget);
        publish = callback;
        return () => {};
      },
    });

    const fixture = document.createElement("div");
    fixture.style.cssText = "position: fixed; visibility: hidden";
    const render = document.createElement("cf-render") as HTMLElement & {
      cell?: unknown;
      updateComplete: Promise<unknown>;
      _cleanupLinkTargetSubscription(): void;
      _renderCell(): Promise<void>;
      _resolvedCell?: unknown;
      _watchLinkTarget(cell: unknown, resolved: unknown): Promise<unknown>;
    };
    let observeReplacement = false;
    let duringReplacementRender:
      | { highlighted: boolean; menuHidden: boolean }
      | undefined;
    let replacementRendered = false;
    render._renderCell = () => {
      if (observeReplacement) {
        const menu = document.querySelector("cf-piece-menu") as
          | HTMLElement
          | null;
        if (!menu) throw new Error("piece menu missing at replacement render");
        duringReplacementRender = {
          highlighted: render.hasAttribute("data-cf-piece-menu-open"),
          menuHidden: Boolean(menu.hidden),
        };
        const content = render.shadowRoot?.querySelector(".render-container");
        if (!content) throw new Error("replacement render has no container");
        content.textContent = "replacement rendered";
        replacementRendered = true;
      }
      return Promise.resolve();
    };
    fixture.appendChild(render);
    document.body.appendChild(fixture);

    try {
      render.cell = link;
      await render.updateComplete;
      render._resolvedCell = await render._watchLinkTarget(link, firstTarget);
      render.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
      const menu = document.querySelector("cf-piece-menu") as
        | (HTMLElement & { updateComplete: Promise<unknown> })
        | null;
      if (!menu || !publish) {
        throw new Error("followed piece menu did not open");
      }
      await menu.updateComplete;
      const before = {
        highlighted: render.hasAttribute("data-cf-piece-menu-open"),
        menuHidden: Boolean(menu.hidden),
      };

      observeReplacement = true;
      publish(secondTarget);
      observeReplacement = false;
      await menu.updateComplete;
      if (!duringReplacementRender) {
        throw new Error("replacement render did not start");
      }
      return {
        before,
        duringReplacementRender,
        after: {
          highlighted: render.hasAttribute("data-cf-piece-menu-open"),
          menuHidden: Boolean(menu.hidden),
        },
        replacementRendered,
      };
    } finally {
      render._cleanupLinkTargetSubscription();
      fixture.remove();
    }
  });
}

/** Close a panel and then its menu with the two corresponding Escape presses. */
async function closePieceMenu(
  page: ReturnType<ShellIntegration["page"]>,
): Promise<{ whileOpen: boolean; afterClose: boolean }> {
  return await page.evaluate(() => {
    const rootView = document.querySelector("x-root-view");
    const appView = rootView?.shadowRoot?.querySelector("x-app-view");
    const bodyView = appView?.shadowRoot?.querySelector("x-body-view");
    const render = bodyView?.shadowRoot?.querySelector("cf-render");
    const whileOpen = render?.hasAttribute("data-cf-piece-menu-open") ?? false;
    globalThis.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
    );
    globalThis.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
    );
    return {
      whileOpen,
      afterClose: render?.hasAttribute("data-cf-piece-menu-open") ?? false,
    };
  });
}

/** Disconnect the highlighted renderer and report its menu's resulting state. */
async function disconnectRenderedPiece(
  page: ReturnType<ShellIntegration["page"]>,
): Promise<{ afterDisconnect: boolean; menuHidden: boolean }> {
  return await page.evaluate(() => {
    const rootView = document.querySelector("x-root-view");
    const appView = rootView?.shadowRoot?.querySelector("x-app-view");
    const bodyView = appView?.shadowRoot?.querySelector("x-body-view");
    const render = bodyView?.shadowRoot?.querySelector("cf-render");
    const menu = document.querySelector("cf-piece-menu") as HTMLElement | null;
    if (!render || !menu) throw new Error("piece menu is not open");
    render.remove();
    return {
      afterDisconnect: render.hasAttribute("data-cf-piece-menu-open"),
      menuHidden: Boolean(menu.hidden),
    };
  });
}

/** Clear and restore the renderer's piece, reporting the open menu after clear. */
async function replaceRenderedPieceCell(
  page: ReturnType<ShellIntegration["page"]>,
): Promise<{ highlighted: boolean; menuHidden: boolean }> {
  return await page.evaluate(async () => {
    const rootView = document.querySelector("x-root-view");
    const appView = rootView?.shadowRoot?.querySelector("x-app-view");
    const bodyView = appView?.shadowRoot?.querySelector("x-body-view");
    const render = bodyView?.shadowRoot?.querySelector("cf-render") as
      | (HTMLElement & { cell?: unknown; updateComplete: Promise<unknown> })
      | null;
    const menu = document.querySelector("cf-piece-menu") as HTMLElement | null;
    if (!render || !menu) throw new Error("piece menu is not open");
    const cell = render.cell;
    render.cell = undefined;
    await render.updateComplete;
    const state = {
      highlighted: render.hasAttribute("data-cf-piece-menu-open"),
      menuHidden: Boolean(menu.hidden),
    };
    render.cell = cell;
    await render.updateComplete;
    return state;
  });
}

/** The text of the piece menu's panel, once a panel with `testId` is open. */
async function waitForPanelText(
  page: ReturnType<ShellIntegration["page"]>,
  testId: string,
  expected: string,
): Promise<void> {
  await waitForCondition(
    page,
    (probe, id: string, text: string) =>
      probe.collect(`[test-id="${id}"]`).some((el) =>
        probe.deepText(el).includes(text)
      ),
    { args: [testId, expected] },
  );
}

/** Wait until the current identity's access row shows the expected level. */
async function waitForCurrentIdentityAccess(
  page: ReturnType<ShellIntegration["page"]>,
  expected: "READ" | "WRITE" | "OWNER",
): Promise<void> {
  await waitForCondition(page, (probe, access: string) => {
    const root = document.querySelector("cf-piece-menu")?.shadowRoot;
    const row = [...(root?.querySelectorAll("tbody tr") ?? [])].find((entry) =>
      probe.deepText(entry).includes("(you)")
    );
    return row?.querySelector<HTMLSelectElement>(".access-select")?.value ===
      access;
  }, { args: [expected] });
}

/** Choose an access level in the current identity's rendered ACL row. */
async function changeCurrentIdentityAccess(
  page: ReturnType<ShellIntegration["page"]>,
  access: "READ" | "WRITE" | "OWNER",
): Promise<void> {
  await page.evaluate((nextAccess: string) => {
    const root = document.querySelector("cf-piece-menu")?.shadowRoot;
    const row = [...(root?.querySelectorAll("tbody tr") ?? [])].find((entry) =>
      entry.textContent?.includes("(you)")
    );
    const select = row?.querySelector<HTMLSelectElement>(".access-select");
    if (!select) throw new Error("current identity access row is unavailable");
    select.value = nextAccess;
    select.dispatchEvent(
      new Event("change", { bubbles: true, composed: true }),
    );
  }, { args: [access] });
}

/** Add one ACL entry through the rendered access form. */
async function addSpaceAccessEntry(
  page: ReturnType<ShellIntegration["page"]>,
  user: string,
): Promise<void> {
  await page.evaluate((identity: string) => {
    const root = document.querySelector("cf-piece-menu")?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>(".access-input");
    const form = root?.querySelector<HTMLFormElement>(".access-add-form");
    if (!input || !form) throw new Error("space access form is unavailable");
    input.value = identity;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    form.requestSubmit();
  }, { args: [user] });
}

/** Remove the ACL row for `user` through its rendered button. */
async function removeSpaceAccessEntry(
  page: ReturnType<ShellIntegration["page"]>,
  user: string,
): Promise<void> {
  await waitForCondition(page, (probe, identity: string) => {
    const root = document.querySelector("cf-piece-menu")?.shadowRoot;
    const row = [...(root?.querySelectorAll("tbody tr") ?? [])].find((entry) =>
      probe.deepText(entry).includes(identity)
    );
    const button = row?.querySelector<HTMLButtonElement>(
      '[test-id="space-access-remove"]',
    );
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, { args: [user] });
}

describe("piece context menu", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("shows a piece's source, origin, and space access rights", async () => {
    // The menu and its panels are cf-piece-menu's, mounted on document.body by
    // cf-render. Driving them through a real right-click is what proves the
    // announcement, the portalled overlay, and the worker read all line up.

    const page = shell.page();
    await using tempIdentity = await writeTempIdentity({
      implementation: "noble",
    });
    const { identity } = tempIdentity;

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: await createTestSpace(identity) },
      identity,
    });
    await waitForRenderedPiece(page);

    const chipLayout = await measureChipHighlightLayout(page);
    expect(chipLayout.after).toEqual(chipLayout.before);
    expect(chipLayout.overlay).toEqual(chipLayout.after);
    expect(chipLayout.lineAfter).toEqual(chipLayout.lineBefore);
    expect(
      Math.abs(
        chipLayout.innerBaselineBefore - chipLayout.outerBaselineBefore,
      ) < 0.01,
    ).toBe(true);
    expect(chipLayout.outerBaselineAfter).toBe(
      chipLayout.outerBaselineBefore,
    );
    expect(chipLayout.innerBaselineAfter).toBe(
      chipLayout.innerBaselineBefore,
    );
    expect(await retargetHighlightedPiece(page)).toEqual({
      before: { highlighted: true, menuHidden: false },
      duringReplacementRender: { highlighted: false, menuHidden: true },
      after: { highlighted: false, menuHidden: true },
      replacementRendered: true,
    });

    const highlight = await rightClickRenderedPiece(page);
    expect(highlight.highlighted).toBe(true);
    expect(highlight.after).toEqual(highlight.before);
    expect(highlight.overlay).toEqual(highlight.after);
    expect(highlight.visual.opacity).toBe("1");
    expect(highlight.visual.pointerEvents).toBe("none");
    expect(highlight.visual.position).toBe("static");
    expect(highlight.visual.zIndex).toBe("1");
    expect(highlight.visual.hostPosition).toBe(
      highlight.visual.hostPositionBefore,
    );
    expect(highlight.visual.hostIsolation).toBe(
      highlight.visual.hostIsolationBefore,
    );
    expect(highlight.visual.stackIsolation).toBe("isolate");
    expect(highlight.visual.contentIsolation).toBe("isolate");
    expect(highlight.visual.backgroundImage).not.toBe("none");
    expect(highlight.visual.boxShadow).not.toBe("none");
    if (highlight.visual.reducedMotion) {
      expect(highlight.visual.animationName).toBe("none");
    } else {
      expect(highlight.visual.animationName).toBe("cf-piece-menu-shine");
      expect(highlight.visual.animationIterationCount).toBe("1");
    }
    await clickPierce(page, '[test-id="piece-menu-source"]');
    // The space root runs the default app, so its entry file is that pattern.
    await waitForPanelText(
      page,
      "piece-panel-source",
      "/api/patterns/system/default-app.tsx",
    );

    await rightClickRenderedPiece(page);
    await clickPierce(page, '[test-id="piece-menu-origin"]');
    // The root's origin is the `system:` ref naming the default app, which is
    // a pattern this deployment serves rather than an endpoint outside it.
    await waitForPanelText(page, "piece-panel-origin", "Deployment pattern");
    await waitForPanelText(
      page,
      "piece-panel-origin",
      "/api/patterns/system/default-app.tsx",
    );

    await rightClickRenderedPiece(page);
    await clickPierce(page, '[test-id="piece-menu-space-access"]');
    await waitForPanelText(
      page,
      "piece-panel-access",
      "you have OWNER access",
    );
    await waitForCurrentIdentityAccess(page, "OWNER");
    // The space was created granting its creator alone, so the one row is
    // this identity's, and there is no wildcard entry.
    await waitForCondition(
      page,
      (probe, owner: string) =>
        probe.collect('[test-id="piece-panel-access"]').some((panel) => {
          const text = probe.deepText(panel);
          return probe.isRendered(panel) && text.includes(`${owner} (you)`) &&
            !text.includes("Anyone (*)");
        }),
      { args: [identity.did()] },
    );

    await changeCurrentIdentityAccess(page, "READ");
    await waitForPanelText(
      page,
      "piece-panel-access",
      "Could not change access rights",
    );
    await waitForCurrentIdentityAccess(page, "OWNER");

    const reader = "did:key:z6Mk-piece-menu-integration-reader";
    await addSpaceAccessEntry(page, reader);
    await waitForPanelText(page, "piece-panel-access", reader);
    await removeSpaceAccessEntry(page, reader);
    await waitForCondition(
      page,
      (probe, identity: string) =>
        probe.collect('[test-id="piece-panel-access"]').some((panel) =>
          probe.isRendered(panel) && !probe.deepText(panel).includes(identity)
        ),
      { args: [reader] },
    );

    expect(await closePieceMenu(page)).toEqual({
      whileOpen: true,
      afterClose: false,
    });

    expect((await rightClickRenderedPiece(page)).highlighted).toBe(true);
    expect(await replaceRenderedPieceCell(page)).toEqual({
      highlighted: false,
      menuHidden: true,
    });

    expect((await rightClickRenderedPiece(page)).highlighted).toBe(true);
    expect(await disconnectRenderedPiece(page)).toEqual({
      afterDisconnect: false,
      menuHidden: true,
    });
  });

  it("targets and highlights the innermost nested piece", async () => {
    const page = shell.page();
    const slug = `nested-piece-menu-${crypto.randomUUID()}`;
    await using tempIdentity = await writeTempIdentity({
      implementation: "noble",
    });
    const { identity, path: identityPath } = tempIdentity;
    const spaceDid = await createTestSpace(identity);

    await createNestedPiece(identityPath, spaceDid, slug);
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid, pieceSlug: slug },
      identity,
    });
    await waitForCondition(
      page,
      (probe) => probe.collect("#inner-piece-button").length === 1,
    );

    const result = await page.evaluate(async () => {
      const rootView = document.querySelector("x-root-view");
      const appView = rootView?.shadowRoot?.querySelector("x-app-view");
      const bodyView = appView?.shadowRoot?.querySelector("x-body-view");
      const render = bodyView?.shadowRoot?.querySelector("cf-render") as
        | (HTMLElement & {
          cell?: { id(): string };
        })
        | null;
      const inner = render?.shadowRoot?.querySelector(
        "#inner-piece-root",
      ) as HTMLElement | null;
      const middle = render?.shadowRoot?.querySelector(
        "#middle-piece-root",
      ) as HTMLElement | null;
      const button = render?.shadowRoot?.querySelector(
        "#inner-piece-button",
      );
      const clip = render?.shadowRoot?.querySelector(
        "#nested-piece-clip",
      ) as HTMLElement | null;
      if (!render || !inner || !middle || !button || !clip) {
        throw new Error("nested piece fixture did not render");
      }

      const measure = (element: Element): MeasuredRect => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      const outerBefore = measure(render);
      const middleBefore = measure(middle);
      const innerBefore = measure(inner);
      const clipBorder = clip.getBoundingClientRect();
      const clipScaleX = clipBorder.width / clip.offsetWidth;
      const clipScaleY = clipBorder.height / clip.offsetHeight;
      const clipBefore = {
        x: clipBorder.x + clip.clientLeft * clipScaleX,
        y: clipBorder.y + clip.clientTop * clipScaleY,
        width: clip.clientWidth * clipScaleX,
        height: clip.clientHeight * clipScaleY,
      };
      let middlePieceId: string | undefined;
      render.addEventListener("cf-piece-context-menu", (event) => {
        event.preventDefault();
        middlePieceId = (event as CustomEvent<{ pieceId: string }>).detail
          .pieceId;
      }, { once: true });
      middle.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );

      let innerPieceId: string | undefined;
      render.addEventListener("cf-piece-context-menu", (event) => {
        event.preventDefault();
        innerPieceId = (event as CustomEvent<{ pieceId: string }>).detail
          .pieceId;
      }, { once: true });
      inner.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );

      let announcedPieceId: string | undefined;
      render.addEventListener("cf-piece-context-menu", (event) => {
        announcedPieceId = (event as CustomEvent<{ pieceId: string }>).detail
          .pieceId;
      }, { once: true });

      button.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          composed: true,
          cancelable: true,
          clientX: innerBefore.x + 4,
          clientY: innerBefore.y + 4,
        }),
      );
      const menu = document.querySelector("cf-piece-menu") as
        | (HTMLElement & { updateComplete: Promise<unknown> })
        | null;
      if (!menu) throw new Error("nested piece menu did not open");
      await menu.updateComplete;
      const overlay = menu.shadowRoot?.querySelector(
        ".nested-piece-highlight",
      );
      if (!overlay) throw new Error("nested highlight did not render");
      const overlayStyle = getComputedStyle(overlay);
      const outerAfter = measure(render);
      const middleAfter = measure(middle);
      const innerAfter = measure(inner);
      const overlayBeforeScroll = measure(overlay);
      clip.scrollLeft = 24;
      clip.dispatchEvent(new Event("scroll"));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );
      await menu.updateComplete;
      const innerAfterScroll = measure(inner);
      const overlayAfterScroll = measure(overlay);

      return {
        outerId: render.cell?.id(),
        middleId: middlePieceId,
        innerId: innerPieceId,
        announcedPieceId,
        outerMarked: render.hasAttribute("data-cf-piece-menu-open"),
        innerMarked: inner.hasAttribute("data-cf-piece-menu-open"),
        outerBefore,
        outerAfter,
        middleBefore,
        middleAfter,
        innerBefore,
        innerAfter,
        clipBefore,
        overlayBeforeScroll,
        innerAfterScroll,
        overlayAfterScroll,
        visual: {
          position: overlayStyle.position,
          pointerEvents: overlayStyle.pointerEvents,
          backgroundImage: overlayStyle.backgroundImage,
          boxShadow: overlayStyle.boxShadow,
          animationName: overlayStyle.animationName,
          animationIterationCount: overlayStyle.animationIterationCount,
          reducedMotion: matchMedia("(prefers-reduced-motion: reduce)")
            .matches,
        },
      };
    });

    expect(result.outerId).toBeDefined();
    expect(result.middleId).toBeDefined();
    expect(result.innerId).toBeDefined();
    expect(result.innerId).not.toBe(result.middleId);
    expect(result.innerId).not.toBe(result.outerId);
    expect(result.middleId).not.toBe(result.outerId);
    expect(result.announcedPieceId).toBe(result.innerId);
    expect(result.outerMarked).toBe(false);
    expect(result.innerMarked).toBe(false);
    expect(result.outerAfter).toEqual(result.outerBefore);
    expect(result.middleAfter).toEqual(result.middleBefore);
    expect(result.innerAfter).toEqual(result.innerBefore);
    const visibleRect = (inner: MeasuredRect, clip: MeasuredRect) => {
      const x = Math.max(inner.x, clip.x);
      const y = Math.max(inner.y, clip.y);
      const right = Math.min(inner.x + inner.width, clip.x + clip.width);
      const bottom = Math.min(inner.y + inner.height, clip.y + clip.height);
      return { x, y, width: right - x, height: bottom - y };
    };
    expect(result.overlayBeforeScroll).toEqual(
      visibleRect(result.innerBefore, result.clipBefore),
    );
    expect(result.overlayAfterScroll).toEqual(
      visibleRect(result.innerAfterScroll, result.clipBefore),
    );
    expect(result.visual.position).toBe("fixed");
    expect(result.visual.pointerEvents).toBe("none");
    expect(result.visual.backgroundImage).not.toBe("none");
    expect(result.visual.boxShadow).not.toBe("none");
    if (result.visual.reducedMotion) {
      expect(result.visual.animationName).toBe("none");
    } else {
      expect(result.visual.animationName).toBe(
        "cf-nested-piece-menu-shine",
      );
      expect(result.visual.animationIterationCount).toBe("1");
    }
  });
});
