/**
 * Runs a performance history page, the runtime benchmark or CI duration
 * history under /bench, in the browser. The page carries `followHistoryPage`
 * serialized (`historyPageScript`) and hands it the browser's `window`; a test
 * hands it a stand-in.
 *
 * The page shows one window of history, chosen with a slider, inside its
 * `#range-content`. Choosing another window fetches that window's charts, puts
 * them in place, and adds the window to the browser's history. The page checks
 * the server every `checkMs` and whenever it is shown, follows a collection
 * under way over that collection's progress stream, and fetches its charts
 * again when the data behind them changes. A response from another version of
 * the dashboard loads the whole page instead, so charts from one version never
 * run under another version's script and styles.
 */

/** What a progress panel says about a collection under way. */
export interface ProgressText {
  readonly title: string;
  readonly total: string;
  readonly detail: string;
}

/** The parts of a collection's progress that every history page reads. */
export interface CollectionProgress {
  readonly id: string;
  readonly phase: "discovering" | "fetching" | "saving" | "complete" | "error";
  readonly totalRuns: number;
  readonly completedRuns: number;
  readonly needsReload: boolean;
  readonly error?: string;
}

/** What one history page tells its script. */
export interface HistoryPage {
  /** The version of the dashboard that served the page. */
  readonly version: string;
  /** The response header that names the version that served a response. */
  readonly versionHeader: string;
  /** How often, in milliseconds, the page checks the server for new data. */
  readonly checkMs: number;
  /** The `sessionStorage` key that remembers whether green rows are hidden. */
  readonly hideGreenKey: string;
  /** Where a collection's progress streams from, given its `id`. */
  readonly progressPath: string;
  /** What the history is of, as in "checking for new CI data". */
  readonly subject: string;
}

/** What the server's update check answers. */
export interface UpdateCheck<P extends CollectionProgress> {
  readonly version: string;
  readonly progress: P | null;
  readonly lastRequestError?: string | null;
}

/** The parts of the browser's `window` that a history page uses. */
export type HistoryBrowser = Pick<
  Window & typeof globalThis,
  | "document"
  | "location"
  | "history"
  | "sessionStorage"
  | "DOMParser"
  | "EventSource"
  | "Element"
  | "fetch"
  | "setInterval"
  | "requestAnimationFrame"
  | "addEventListener"
>;

/**
 * Runs the history page `page` in `browser`, describing a collection under
 * way with `describeProgress`. It reads only what `browser` hands it, and the
 * page carries it serialized, so it refers to nothing outside itself.
 */
export function followHistoryPage<P extends CollectionProgress>(
  browser: HistoryBrowser,
  page: HistoryPage,
  describeProgress: (state: P) => ProgressText,
): void {
  const { document, location, history, sessionStorage } = browser;
  const found = <T>(value: T | null | undefined, what: string): T => {
    if (value === null || value === undefined) {
      throw new Error("A history page needs " + what + ".");
    }
    return value;
  };
  const element = <E extends Element>(root: ParentNode, id: string) =>
    found(root.querySelector<E>("#" + id), "an element #" + id);
  const hg = element<HTMLInputElement>(document, "hg");
  const days = element<HTMLInputElement>(document, "days");
  const daysv = element<HTMLOutputElement>(document, "daysv");
  const controls = found(days.form, "a form around its window slider");
  const DEFAULT_DAYS = days.value;
  let rangeContent = element<HTMLElement>(document, "range-content");
  let fetchProgress: HTMLElement, title: Element, total: Element;
  let detail: Element, bar: Element, pageVersion: string | undefined;
  let appliedDays = days.value;
  let navigating = false, pendingRefresh = false;
  let checkRequest: AbortController | null = null;
  let eventStream: EventSource | null = null, connectedProgressUrl = "";
  let snapshotChanged = false, collectionFailed = false;
  let transportFailed = false, rangeRequest: AbortController | null = null;
  let rangeRequestDays = "", rangeSequence = 0, viewRevision = 0;
  const servedByAnotherVersion = (response: Response) => {
    const version = response.headers.get(page.versionHeader);
    return version !== null && version !== page.version;
  };
  const apply = () => document.body.classList.toggle("hide-green", hg.checked);
  hg.checked = sessionStorage.getItem(page.hideGreenKey) === "1";
  apply();
  hg.addEventListener("change", () => {
    sessionStorage.setItem(page.hideGreenKey, hg.checked ? "1" : "0");
    apply();
  });
  // Every other control in the form chooses another page.
  controls.addEventListener("change", (event) => {
    if (event.target !== days && event.target !== hg) controls.requestSubmit();
  });
  const syncDayLinks = () => {
    const links = document.querySelectorAll<HTMLAnchorElement>(
      'a[href^="/bench?"]',
    );
    for (const link of links) {
      const target = new URL(link.href);
      target.searchParams.set("days", days.value);
      link.href = target.pathname + "?" + target.searchParams.toString();
    }
  };
  const labelDays = () =>
    daysv.value = days.value + (days.value === "1" ? " day" : " days");
  days.addEventListener("input", () => {
    labelDays();
    syncDayLinks();
  });
  const applyDays = () => {
    if (days.value !== appliedDays) {
      if (!rangeRequest || rangeRequestDays !== days.value) {
        void loadRange("push");
      }
    } else if (rangeRequest && rangeRequestDays !== days.value) {
      void loadRange("restore");
    } else if (pendingRefresh && !rangeRequest) {
      pendingRefresh = false;
      void loadRange("refresh");
    }
  };
  days.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyDays();
    }
  });
  days.addEventListener("change", applyDays);
  const isSameTabLink = (event: MouseEvent, link: HTMLAnchorElement) =>
    link.target !== "_blank" && event.button === 0 && !event.metaKey &&
    !event.ctrlKey && !event.shiftKey && !event.altKey;
  const isSameDocumentFragment = (link: HTMLAnchorElement) => {
    const url = new URL(link.href);
    return url.origin === location.origin &&
      url.pathname === location.pathname &&
      url.search === location.search &&
      url.hash !== "";
  };
  document.addEventListener("click", (event) => {
    const link = event.target instanceof browser.Element
      ? event.target.closest<HTMLAnchorElement>("a[href]")
      : null;
    if (
      link && isSameTabLink(event, link) && !isSameDocumentFragment(link)
    ) navigating = true;
  }, true);
  controls.addEventListener("submit", () => navigating = true);
  browser.addEventListener("pagehide", () => {
    navigating = true;
    rangeRequest?.abort();
    checkRequest?.abort();
    checkRequest = null;
    closeProgress();
  });
  // Shows a panel with nothing outstanding.
  const showSettled = (heading: string, message: string) => {
    title.textContent = heading;
    total.textContent = "0 outstanding";
    bar.setAttribute("max", "1");
    bar.setAttribute("value", "0");
    detail.textContent = message;
  };
  const renderIdle = (
    lastRequestError = fetchProgress.dataset.lastRequestError || "",
  ) => {
    collectionFailed = Boolean(lastRequestError);
    transportFailed = false;
    if (lastRequestError) {
      fetchProgress.dataset.lastRequestError = lastRequestError;
    } else delete fetchProgress.dataset.lastRequestError;
    fetchProgress.classList.toggle("error", collectionFailed);
    showSettled(
      "Idle",
      lastRequestError
        ? "Last collection stopped: " + lastRequestError
        : "No requests in progress.",
    );
  };
  const refreshRangeWhenIdle = () => {
    if (navigating) return;
    if (
      days.value !== appliedDays ||
      rangeContent.contains(document.activeElement) || rangeRequest
    ) {
      pendingRefresh = true;
      return;
    }
    void loadRange("refresh");
  };
  document.addEventListener("focusout", () => {
    browser.requestAnimationFrame(() => {
      if (
        pendingRefresh && !navigating && !rangeRequest &&
        !rangeContent.contains(document.activeElement)
      ) {
        pendingRefresh = false;
        refreshRangeWhenIdle();
      }
    });
  });
  const closeProgress = () => {
    eventStream?.close();
    eventStream = null;
    connectedProgressUrl = "";
  };
  const renderProgress = (state: P) => {
    collectionFailed = state.phase === "error";
    transportFailed = false;
    fetchProgress.classList.remove("error");
    if (collectionFailed) {
      fetchProgress.dataset.lastRequestError = state.error || "unknown error";
    } else delete fetchProgress.dataset.lastRequestError;
    const text = describeProgress(state);
    title.textContent = text.title;
    total.textContent = text.total;
    detail.textContent = text.detail;
    if (state.phase === "discovering") bar.removeAttribute("value");
    else {
      bar.setAttribute("max", String(Math.max(1, state.totalRuns)));
      bar.setAttribute("value", String(state.completedRuns));
    }
    if (state.phase === "error") {
      closeProgress();
      renderIdle();
    } else if (state.phase === "complete") {
      closeProgress();
      if (
        state.needsReload || snapshotChanged ||
        fetchProgress.dataset.refreshOnComplete === "1"
      ) refreshRangeWhenIdle();
      else renderIdle();
    }
  };
  const connectProgress = (url: string | undefined) => {
    if (!url || connectedProgressUrl === url) return;
    eventStream?.close();
    connectedProgressUrl = url;
    const stream = new browser.EventSource(url);
    eventStream = stream;
    const fail = (message: string) => {
      closeProgress();
      transportFailed = true;
      fetchProgress.classList.add("error");
      title.textContent = message;
    };
    stream.addEventListener("progress", (event) => {
      if (eventStream !== stream) return;
      try {
        renderProgress(JSON.parse(event.data));
      } catch {
        fail("Could not read collection progress");
      }
    });
    stream.addEventListener("error", () => {
      if (eventStream !== stream) return;
      fail("Progress connection closed; collection continues on the server");
    });
  };
  const checkForUpdates = async () => {
    if (checkRequest || navigating || document.visibilityState === "hidden") {
      return;
    }
    const controller = new AbortController();
    checkRequest = controller;
    const revision = viewRevision;
    try {
      const response = await browser.fetch(
        found(fetchProgress.dataset.checkUrl, "an update check address"),
        { headers: { accept: "application/json" }, signal: controller.signal },
      );
      if (servedByAnotherVersion(response)) {
        refreshRangeWhenIdle();
        return;
      }
      if (!response.ok) throw new Error("HTTP " + response.status);
      const state: UpdateCheck<P> = await response.json();
      if (revision !== viewRevision) return;
      snapshotChanged ||= state.version !== pageVersion;
      if (state.progress) {
        connectProgress(
          page.progressPath + "?id=" + encodeURIComponent(state.progress.id),
        );
        renderProgress(state.progress);
      } else if (snapshotChanged) refreshRangeWhenIdle();
      else if ("lastRequestError" in state) {
        renderIdle(state.lastRequestError || "");
      } else if (!collectionFailed) renderIdle();
    } catch {
      if (controller.signal.aborted) return;
      if (!eventStream && !collectionFailed && !transportFailed) renderIdle();
    } finally {
      if (checkRequest === controller) checkRequest = null;
    }
  };
  const bindRangeContent = () => {
    viewRevision++;
    rangeContent.removeAttribute("aria-busy");
    fetchProgress = element<HTMLElement>(rangeContent, "fetch-progress");
    title = element(rangeContent, "fetch-title");
    total = element(rangeContent, "fetch-total");
    detail = element(rangeContent, "fetch-detail");
    bar = element(rangeContent, "fetch-bar");
    pageVersion = fetchProgress.dataset.snapshotVersion;
    snapshotChanged = false;
    collectionFailed = false;
    transportFailed = false;
    if (fetchProgress.dataset.progressUrl) {
      connectProgress(fetchProgress.dataset.progressUrl);
    } else renderIdle();
  };
  const showRangeLoading = (requestedDays: string) => {
    rangeContent.setAttribute("aria-busy", "true");
    fetchProgress.classList.remove("error");
    title.textContent = "Loading " + requestedDays + "-day view…";
    total.textContent = "updating";
    bar.removeAttribute("value");
    detail.textContent = "Reading cached history and checking for new " +
      page.subject + " data.";
  };
  const loadRange = async (mode: "push" | "restore" | "refresh" | "pop") => {
    if (navigating) return;
    if (rangeRequest) {
      if (mode === "refresh") {
        pendingRefresh = true;
        return;
      }
      rangeRequest.abort();
    }
    const requestedDays = days.value;
    const url = new URL(location.href);
    url.searchParams.set("days", requestedDays);
    const sequence = ++rangeSequence;
    const controller = new AbortController();
    rangeRequest = controller;
    rangeRequestDays = requestedDays;
    let loaded = false;
    showRangeLoading(requestedDays);
    try {
      const requestUrl = new URL(url);
      requestUrl.searchParams.set("fragment", "range");
      const response = await browser.fetch(
        requestUrl.pathname + requestUrl.search,
        {
          cache: "no-store",
          headers: { accept: "text/html" },
          signal: controller.signal,
        },
      );
      if (servedByAnotherVersion(response)) {
        if (navigating) return;
        navigating = true;
        if (mode === "push") location.assign(url.pathname + url.search);
        else location.reload();
        return;
      }
      if (!response.ok) throw new Error("HTTP " + response.status);
      const replacement = new browser.DOMParser()
        .parseFromString(await response.text(), "text/html")
        .getElementById("range-content");
      if (!replacement) {
        throw new Error("Range content was missing from the response.");
      }
      if (sequence !== rangeSequence || navigating) return;
      closeProgress();
      rangeContent.replaceWith(replacement);
      rangeContent = replacement;
      appliedDays = requestedDays;
      const target = url.pathname + url.search;
      if (mode === "push" && target !== location.pathname + location.search) {
        history.pushState(null, "", target);
      }
      bindRangeContent();
      syncDayLinks();
      loaded = true;
    } catch (error) {
      if (controller.signal.aborted || sequence !== rangeSequence) return;
      pendingRefresh = false;
      rangeContent.removeAttribute("aria-busy");
      fetchProgress.classList.add("error");
      showSettled(
        "Could not update the history window",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (sequence === rangeSequence) {
        rangeRequest = null;
        rangeRequestDays = "";
        if (loaded && pendingRefresh) {
          pendingRefresh = false;
          refreshRangeWhenIdle();
        }
      }
    }
  };
  const daysFromLocation = () => {
    const parameter = new URL(location.href).searchParams.get("days");
    if (parameter === null || parameter.trim() === "") return DEFAULT_DAYS;
    const value = Number(parameter);
    if (!Number.isFinite(value)) return DEFAULT_DAYS;
    return String(
      Math.max(Number(days.min), Math.min(Number(days.max), Math.floor(value))),
    );
  };
  const restoreDays = () => {
    days.value = daysFromLocation();
    labelDays();
    syncDayLinks();
  };
  browser.addEventListener("popstate", () => {
    restoreDays();
    void loadRange("pop");
  });
  browser.addEventListener("pageshow", (event) => {
    navigating = false;
    if (event.persisted) {
      // The browser can restore the page with its controls as someone left
      // them rather than as the charts it holds were chosen. Hiding green rows
      // chooses no charts, so that switch stays as it was.
      const hideGreen = hg.checked;
      controls.reset();
      hg.checked = hideGreen;
      restoreDays();
      bindRangeContent();
      if (days.value !== appliedDays) void loadRange("pop");
      else void checkForUpdates();
    }
  });
  bindRangeContent();
  browser.setInterval(checkForUpdates, page.checkMs);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForUpdates();
  });
}

/**
 * The script that runs `followHistoryPage` on the page `page`, describing a
 * collection under way with `describeProgress`, which therefore also refers to
 * nothing outside itself.
 */
export function historyPageScript<P extends CollectionProgress>(
  page: HistoryPage,
  describeProgress: (state: P) => ProgressText,
): string {
  return `<script>(${followHistoryPage.toString()})(window, ${
    JSON.stringify(page)
  }, ${describeProgress.toString()});</script>`;
}
