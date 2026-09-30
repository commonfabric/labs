import {
  awaitViewSettled,
  createLegacyTestSpace,
  env,
  Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { NAVIGATE_EVENT } from "@commonfabric/navigation";
import { assert, assertEquals } from "@std/assert";
import {
  collectSchedulerLoadSummary,
  waitForActiveSpaceRoot,
  waitForRuntimeIdle,
  waitForRuntimeSynced,
} from "../cfc-browser-helpers.ts";
import {
  clickButtonWithExactText,
  clickButtonWithText,
  clickButtonWithTitle,
} from "../note-button-helpers.ts";

const { FRONTEND_URL } = env;
describe("default-app notebook reload integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  // Re-enabled (CT-1623): map/flatmap/filter result containers (and nested
  // pattern result cells) are now identified by the reserved output spot — a
  // stable, position-derived identity — instead of the serialized `op` / inputs
  // cell, which dragged in the session-varying `program` and forced per-row
  // cell ids to churn across reloads.
  it("reloads every rapidly created notebook note in a separate shard", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const notebookSpaceName = globalThis.crypto.randomUUID();
    const notebookSpaceDid = await createLegacyTestSpace(
      identity,
      notebookSpaceName,
    );
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: notebookSpaceName },
      identity,
    });

    await waitForActiveSpaceRoot(page, notebookSpaceDid);
    await waitForRuntimeIdle(page);
    await clickButtonWithText(page, "Notes");
    await awaitViewSettled(page);
    await clickButtonWithText(page, "New Notebook");
    const notebookId = await waitForCondition(page, async () => {
      const commonfabric = globalThis.commonfabric as
        | { readCell?: (options: { id: string }) => Promise<unknown> }
        | undefined;
      const view = globalThis.app?.serialize?.()?.view;
      const pieceId = view && typeof view === "object" && "pieceId" in view &&
          typeof view.pieceId === "string"
        ? view.pieceId
        : undefined;
      if (!pieceId || !commonfabric?.readCell) return false;
      let current: unknown;
      const originalLog = console.log;
      try {
        console.log = () => {};
        current = await commonfabric.readCell({ id: pieceId });
      } finally {
        console.log = originalLog;
      }
      return (current as { isNotebook?: unknown } | undefined)
          ?.isNotebook === true
        ? pieceId
        : false;
    });

    assert(
      typeof notebookId === "string",
      "Expected a notebook piece identity",
    );

    await waitForCondition(
      page,
      () => typeof globalThis.commonfabric?.viewSettled === "function",
    );
    await awaitViewSettled(page);
    assert(
      await clickButtonWithTitle(page, "New Note"),
      "Expected New Note click to succeed",
    );

    const noteCreates = 7;
    for (let i = 0; i < noteCreates - 1; i++) {
      assert(
        await clickButtonWithText(page, "Create Another"),
        `Expected Create Another click ${i + 1} to succeed`,
      );
    }
    assert(
      await clickButtonWithExactText(page, "Create"),
      "Expected final Create click to succeed",
    );

    await waitForCondition(page, notebookSourceStateMatches, {
      args: [noteCreates, notebookId],
    });

    await waitForRuntimeSynced(page);
    // Speculative navigation can remain on a note even when the authoritative
    // handler stays in the notebook (server-side-execution/speculation.md §2).
    // Select the captured notebook before measuring its reload.
    await page.evaluate((eventName, spaceName, pieceId) => {
      globalThis.dispatchEvent(
        new CustomEvent(eventName, {
          detail: { spaceName, pieceId },
        }),
      );
    }, { args: [NAVIGATE_EVENT, notebookSpaceName, notebookId] });
    await waitForCondition(page, notebookReloadRendered, {
      args: [noteCreates, notebookId],
    });
    const beforeReload = await page.evaluate(() => ({
      url: location.href,
      view: globalThis.app?.serialize?.()?.view,
    }));
    assertEquals(
      beforeReload.view && "pieceId" in beforeReload.view
        ? beforeReload.view.pieceId
        : undefined,
      notebookId,
      `Expected the created notebook before reload: ${
        JSON.stringify(beforeReload)
      }`,
    );

    const startedAt = performance.now();
    await page.reload({ waitUntil: "load" });
    await page.applyConsoleFormatter();
    await shell.login(identity);

    try {
      const afterLogin = await page.evaluate(() => ({
        url: location.href,
        view: globalThis.app?.serialize?.()?.view,
      }));
      assertEquals(
        afterLogin.view && "pieceId" in afterLogin.view
          ? afterLogin.view.pieceId
          : undefined,
        notebookId,
        `Expected the same notebook after reload: ${
          JSON.stringify(afterLogin)
        }`,
      );
      await waitForCondition(page, notebookReloadRendered, {
        args: [noteCreates, notebookId],
      });
    } catch (cause) {
      const current = await page.evaluate(() => ({
        url: location.href,
        view: globalThis.app?.serialize?.()?.view,
      })).catch(() => undefined);
      const rendered = await collectNotebookRenderState(page)
        .catch(() => undefined);
      const diagnostic = JSON.stringify({
        notebookId,
        beforeReload,
        current,
        rendered,
      });
      // Teardown can report browser errors as well. Keep the failed condition's
      // evidence in the transcript even when teardown replaces its exception.
      console.log(`Notebook reload condition failed: ${diagnostic}`);
      throw new Error(`Notebook reload condition failed: ${diagnostic}`, {
        cause,
      });
    }
    await waitForRuntimeIdle(page);

    const reloadRenderState = await collectNotebookRenderState(page);
    assertEquals(reloadRenderState.noteCount, noteCreates);
    assertEquals(reloadRenderState.renderedNoteChips, noteCreates);
    const browserMetrics = await collectBrowserLoadMetrics(page);

    const schedulerSummary = await collectSchedulerLoadSummary(page);
    assert(
      schedulerSummary,
      "Expected notebook reload to expose scheduler load summary",
    );
    const reloadSummary = {
      reloadToRenderedMs: Number((performance.now() - startedAt).toFixed(3)),
      browser: browserMetrics,
      ...schedulerSummary,
    };
    console.log(
      "Notebook reload scheduler summary:",
      JSON.stringify(reloadSummary, null, 2),
    );
  });
});

// Captures real, user-perceived reload render timing — paint metrics
// (FCP/LCP = "time to pixel rendered"), long-task pressure, and a DOM
// quiet-period settle time — so reload perf is observable independently of
// scheduler action counts.
async function collectBrowserLoadMetrics(page: Page): Promise<{
  domContentLoadedEventEndMs?: number;
  loadEventEndMs?: number;
  firstPaintMs?: number;
  firstContentfulPaintMs?: number;
  largestContentfulPaintMs?: number;
  longTaskCount?: number;
  longTaskTotalMs?: number;
  postRenderStableMs: number;
}> {
  return await page.evaluate(async () => {
    const round = (value: number | undefined) =>
      value === undefined ? undefined : Number(value.toFixed(3));
    const supported = PerformanceObserver.supportedEntryTypes ?? [];
    const observeBuffered = async (type: string) => {
      if (!supported.includes(type)) return [] as PerformanceEntry[];
      const entries: PerformanceEntry[] = [];
      const observer = new PerformanceObserver((list) => {
        entries.push(...list.getEntries());
      });
      observer.observe({ type, buffered: true });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      observer.disconnect();
      return entries;
    };

    const navigation = performance.getEntriesByType("navigation")
      .at(-1) as PerformanceNavigationTiming | undefined;
    const paint = performance.getEntriesByType("paint");
    const firstPaint = paint.find((entry) => entry.name === "first-paint");
    const firstContentfulPaint = paint.find((entry) =>
      entry.name === "first-contentful-paint"
    );
    const largestContentfulPaint = (await observeBuffered(
      "largest-contentful-paint",
    )).at(-1);
    const longTasks = await observeBuffered("longtask");

    const postRenderStableMs = await new Promise<number>((resolve) => {
      let settled = false;
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (settled) return;
        settled = true;
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        observer.disconnect();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(performance.now()))
        );
      };
      const resetQuietTimer = () => {
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        quietTimer = setTimeout(done, 100);
      };
      const observer = new MutationObserver(resetQuietTimer);
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      resetQuietTimer();
      const maxTimer = setTimeout(done, 1_000);
    });

    return {
      domContentLoadedEventEndMs: round(navigation?.domContentLoadedEventEnd),
      loadEventEndMs: round(navigation?.loadEventEnd),
      firstPaintMs: round(firstPaint?.startTime),
      firstContentfulPaintMs: round(firstContentfulPaint?.startTime),
      largestContentfulPaintMs: round(largestContentfulPaint?.startTime),
      longTaskCount: longTasks.length,
      longTaskTotalMs: round(
        longTasks.reduce((sum, entry) => sum + entry.duration, 0),
      ),
      postRenderStableMs: round(postRenderStableMs)!,
    };
  });
}

// Serialized into the page by waitForCondition: drain the worker, read the
// captured notebook's argument and internal cells, and report whether all
// `expectedCount` notes have landed, the new-note prompt is closed, and the
// "create another" flag is cleared. The selection can independently show a note.
const notebookSourceStateMatches = async (
  _probe: ProbeApi,
  expectedCount: number,
  notebookEntityId: string,
): Promise<boolean> => {
  const api = globalThis.commonfabric as {
    rt?: { idle?: () => Promise<void> };
    readCell?: (options: {
      id: string;
      path?: string[];
      meta?: "argument" | "internal";
    }) => Promise<unknown>;
  } | undefined;
  await api?.rt?.idle?.();

  if (!api?.readCell) return false;

  const resolveInternalManifest = async (
    manifest: unknown,
  ): Promise<Record<string, unknown>> => {
    const resolved: Record<string, unknown> = {};
    if (!Array.isArray(manifest)) return resolved;
    for (const entry of manifest) {
      if (entry === null || typeof entry !== "object") continue;
      const { partialCause, link } = entry as {
        partialCause?: unknown;
        link?: { sync?: () => Promise<unknown> };
      };
      const key = typeof partialCause === "string"
        ? partialCause
        : JSON.stringify(partialCause) ?? String(partialCause);
      if (link && typeof link.sync === "function") {
        resolved[key] = await link.sync();
      }
    }
    return resolved;
  };

  let notebookArgument: unknown;
  let notebookInternalManifest: unknown;
  const originalLog = console.log;
  try {
    console.log = () => {};
    notebookArgument = await api.readCell({
      id: notebookEntityId,
      meta: "argument",
    });
    notebookInternalManifest = await api.readCell({
      id: notebookEntityId,
      meta: "internal",
    });
  } finally {
    console.log = originalLog;
  }
  const notebookInternal = await resolveInternalManifest(
    notebookInternalManifest,
  );

  const argumentNotes = (notebookArgument as { notes?: unknown } | undefined)
    ?.notes;
  const resolvedArgumentNotes = Array.isArray(argumentNotes)
    ? argumentNotes
    : argumentNotes !== null && typeof argumentNotes === "object" &&
        typeof (argumentNotes as { sync?: unknown }).sync === "function"
    ? await (argumentNotes as { sync: () => Promise<unknown> }).sync()
    : undefined;
  const argumentNotesLength = Array.isArray(resolvedArgumentNotes)
    ? resolvedArgumentNotes.length
    : undefined;
  const internal = notebookInternal as {
    noteCount?: unknown;
    showNewNotePrompt?: unknown;
    usedCreateAnotherNote?: unknown;
  };
  return argumentNotesLength === expectedCount &&
    internal.noteCount === expectedCount &&
    internal.showNewNotePrompt === false &&
    internal.usedCreateAnotherNote === false;
};

// Serialized into the page by waitForCondition: report whether the reloaded
// notebook has rehydrated to `expectedCount` notes — the piece cell reads back
// as a notebook with that noteCount, and that many "📝 New Note" chips are
// rendered across the document and every shadow root. Inlines the readCell and
// cf-chip collection that collectNotebookRenderState performs.
const notebookReloadRendered = async (
  probe: ProbeApi,
  expectedCount: number,
  expectedId: string,
): Promise<boolean> => {
  const commonfabric = globalThis.commonfabric as
    | { readCell?: (options: { id: string }) => Promise<unknown> }
    | undefined;
  const view = globalThis.app?.serialize?.()?.view;
  const pieceId = view && typeof view === "object" && "pieceId" in view &&
      typeof view.pieceId === "string"
    ? view.pieceId
    : undefined;
  if (pieceId !== expectedId || !commonfabric?.readCell) return false;
  let current: { isNotebook?: unknown; noteCount?: unknown } | undefined;
  const originalLog = console.log;
  try {
    console.log = () => {};
    current = await commonfabric.readCell({ id: pieceId }) as typeof current;
  } finally {
    console.log = originalLog;
  }
  if (current?.isNotebook !== true || current.noteCount !== expectedCount) {
    return false;
  }
  const renderedNoteChips = probe.collect("cf-chip").filter((element) => {
    const label = String(
      (element as { label?: unknown }).label ??
        element.getAttribute("label") ?? "",
    ).trim();
    return label.startsWith("📝 New Note");
  }).length;
  return renderedNoteChips === expectedCount;
};

async function collectNotebookRenderState(page: Page): Promise<{
  isNotebook: boolean;
  noteCount: number;
  notesLength: number;
  mentionableLength: number;
  showNewNotePrompt?: boolean;
  usedCreateAnotherNote?: boolean;
  storedUiNoteChips: number;
  storedUiNoteLabels: string[];
  renderedNoteChips: number;
  renderedNoteLabels: string[];
}> {
  return await page.evaluate(async () => {
    const commonfabric = globalThis.commonfabric as any;
    const appState = globalThis.app?.serialize?.();
    const view = appState?.view;
    const pieceId = view && typeof view === "object" && "pieceId" in view &&
        typeof view.pieceId === "string"
      ? view.pieceId
      : undefined;
    let current: any;
    if (pieceId) {
      const originalLog = console.log;
      try {
        console.log = () => {};
        current = await commonfabric?.readCell?.({ id: pieceId });
      } finally {
        console.log = originalLog;
      }
    }
    const notes = Array.isArray(current?.notes) ? current.notes : [];
    const mentionable = Array.isArray(current?.mentionable)
      ? current.mentionable
      : [];
    const collectStoredNoteLabels = (value: unknown) => {
      const labels: string[] = [];
      const seen = new WeakSet<object>();

      function visit(currentValue: unknown): void {
        if (currentValue === null || currentValue === undefined) return;
        if (typeof currentValue !== "object") return;
        if (seen.has(currentValue)) return;
        seen.add(currentValue);

        const record = currentValue as Record<string, unknown>;
        const label = typeof record.label === "string"
          ? record.label
          : typeof (record.props as { label?: unknown } | undefined)?.label ===
              "string"
          ? (record.props as { label: string }).label
          : undefined;
        if (label?.trim().startsWith("📝 New Note")) {
          labels.push(label.trim());
        }

        if (Array.isArray(currentValue)) {
          for (const item of currentValue) visit(item);
          return;
        }
        for (const item of Object.values(record)) visit(item);
      }

      visit(value);
      return labels;
    };
    const collectRenderedNoteLabels = (root: Document | ShadowRoot) => {
      const labels: string[] = [];

      function collect(currentRoot: Document | ShadowRoot): void {
        for (const el of currentRoot.querySelectorAll("*")) {
          if (el.localName === "cf-chip") {
            const label = ((el as any).label ?? el.getAttribute("label") ?? "")
              .trim();
            if (label.startsWith("📝 New Note")) {
              labels.push(label);
            }
          }
          if ((el as HTMLElement).shadowRoot) {
            collect((el as HTMLElement).shadowRoot!);
          }
        }
      }

      collect(root);
      return labels;
    };
    const noteLabels = collectRenderedNoteLabels(document);
    const storedUiNoteLabels = collectStoredNoteLabels(current?.["$UI"]);

    return {
      isNotebook: current?.isNotebook === true,
      noteCount: typeof current?.noteCount === "number"
        ? current.noteCount
        : -1,
      notesLength: notes.length,
      mentionableLength: mentionable.length,
      showNewNotePrompt: typeof current?.showNewNotePrompt === "boolean"
        ? current.showNewNotePrompt
        : undefined,
      usedCreateAnotherNote: typeof current?.usedCreateAnotherNote === "boolean"
        ? current.usedCreateAnotherNote
        : undefined,
      storedUiNoteChips: storedUiNoteLabels.length,
      storedUiNoteLabels,
      renderedNoteChips: noteLabels.length,
      renderedNoteLabels: noteLabels,
    };
  });
}
