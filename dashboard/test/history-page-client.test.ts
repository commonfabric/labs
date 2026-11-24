/**
 * What an open performance history page does as the server behind it changes
 * and as the browser leaves and restores it. Each page's script runs against a
 * stand-in for the browser built from the page's own markup, and the test
 * answers the requests the script makes.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  CI_HISTORY_PAGE,
  type CiJobFetchProgress,
  ciJobHistoryPage,
  describeCiProgress,
} from "../ci-job-history.ts";
import {
  type CollectionProgress,
  followHistoryPage,
  type HistoryBrowser,
  historyPageScript,
  type ProgressText,
} from "../history-page-client.ts";
import {
  type BenchmarkFetchProgress,
  benchPage,
  describeBenchmarkProgress,
  RUNTIME_HISTORY_PAGE,
} from "../tiles/benchmark.ts";
import { SERVING_VERSION, VERSION_HEADER } from "../version.ts";

const ANOTHER_VERSION = `${SERVING_VERSION}-next`;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

const decode = (text: string) =>
  text.replace(/&(?:amp|quot|#39|lt|gt);/g, (entity) => ENTITIES[entity]);

/** Something in the stand-in browser that listeners can be added to. */
class FakeTarget {
  readonly listeners = new Map<string, ((event: object) => void)[]>();

  addEventListener(type: string, listener: (event: object) => void): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  dispatch(type: string, event: object = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** The form around a page's controls. */
class FakeForm extends FakeTarget {
  submits = 0;

  constructor(readonly elements: Map<string, FakeElement>) {
    super();
  }

  requestSubmit(): void {
    this.submits++;
  }
  reset(): void {
    for (const element of this.elements.values()) {
      if (element.form === this) element.reset();
    }
  }
}

/**
 * An element of the stand-in browser, with the parts the scripts reach. `span`
 * is where it starts and ends in the markup it came from, and the elements it
 * contains are those of the same markup that start inside it.
 */
class FakeElement extends FakeTarget {
  readonly dataset: Record<string, string | undefined> = {};
  readonly classes = new Set<string>();
  readonly classList = {
    add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
    remove: (...names: string[]) =>
      names.forEach((name) => this.classes.delete(name)),
    toggle: (name: string, on: boolean) =>
      on ? this.classes.add(name) : this.classes.delete(name),
  };
  textContent: string | null = "";
  value = "";
  checked = false;
  readonly defaultValue: string;
  readonly defaultChecked: boolean;
  readonly min: string;
  readonly max: string;
  form: FakeForm | null = null;
  replacement?: FakeElement;
  /** A `<select>`'s options, each selected as the markup says by default. */
  options: { value: string; defaultSelected: boolean; selected: boolean }[] =
    [];

  constructor(
    readonly id: string,
    readonly attributes: Map<string, string>,
    readonly markup: Map<string, FakeElement>,
    readonly span: readonly [number, number] = [0, 0],
  ) {
    super();
    for (const [name, value] of attributes) {
      if (name.startsWith("data-")) {
        this.dataset[
          name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
        ] = value;
      }
    }
    this.defaultValue = attributes.get("value") ?? "";
    this.defaultChecked = attributes.has("checked");
    this.min = attributes.get("min") ?? "";
    this.max = attributes.get("max") ?? "";
    this.reset();
  }

  /** Puts the element back as its markup has it, as resetting a form does. */
  reset(): void {
    this.value = this.defaultValue;
    this.checked = this.defaultChecked;
    for (const option of this.options) option.selected = option.defaultSelected;
  }
  querySelector(selector: string): FakeElement | null {
    return this.markup.get(selector.replace(/^#/, "")) ?? null;
  }
  contains(element: FakeElement | null): boolean {
    return element !== null && element.markup === this.markup &&
      element.span[0] >= this.span[0] && element.span[0] < this.span[1];
  }
  replaceWith(element: FakeElement): void {
    this.replacement = element;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

/** A link of the stand-in browser, whose address reads back absolute. */
class FakeLink {
  #href = "";
  readonly target = "";

  constructor(href: string, readonly base: string) {
    this.href = href;
  }

  get href(): string {
    return this.#href;
  }
  set href(href: string) {
    this.#href = new URL(href, this.base).href;
  }
}

/** Something inside a link to `href`, as a click's target. */
const inside = (href: string) =>
  Object.assign(new FakeTarget(), {
    closest: () => ({ href, target: "" }),
  });

/** The document of the stand-in browser. */
class FakeDocument extends FakeTarget {
  readonly body: FakeElement;
  activeElement: FakeElement | null = null;
  readonly visibilityState = "visible";

  constructor(
    readonly elements: Map<string, FakeElement>,
    readonly links: FakeLink[],
  ) {
    super();
    this.body = new FakeElement("", new Map(), elements);
  }

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }
  querySelector(selector: string): FakeElement | null {
    return this.elements.get(selector.replace(/^#/, "")) ?? null;
  }
  querySelectorAll(selectors: string): FakeLink[] {
    if (selectors !== 'a[href^="/bench?"]') {
      throw new Error(`The stand-in document cannot select ${selectors}`);
    }
    return this.links;
  }
}

/** A progress stream the page opened. */
class FakeStream extends FakeTarget {
  readonly readyState = 0;
  closed = false;

  constructor(readonly url: string) {
    super();
  }

  close(): void {
    this.closed = true;
  }
}

const VOID_ELEMENTS = new Set(["br", "hr", "img", "input", "link", "meta"]);

/** Where the element whose start tag ends at `from` ends in `html`. */
function endOf(html: string, tag: string, from: number): number {
  if (VOID_ELEMENTS.has(tag)) return from;
  const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  tags.lastIndex = from;
  let depth = 1;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return tags.lastIndex;
  }
  throw new Error(`<${tag}> is never closed`);
}

/** Every element of `html` that has an id, by id, each with its attributes. */
function elementsOf(html: string): Map<string, FakeElement> {
  const elements = new Map<string, FakeElement>();
  const form = new FakeForm(elements);
  const formStart = html.search(/<form\b/);
  const formEnd = formStart < 0
    ? -1
    : endOf(html, "form", html.indexOf(">", formStart) + 1);
  for (
    const { 0: text, 1: tag, 2: attributeText, index } of html.matchAll(
      /<([a-z][\w-]*)((?:\s[^>]*)?)>/g,
    )
  ) {
    const attributes = new Map<string, string>();
    for (
      const [, name, value] of attributeText.matchAll(
        /([^\s=/]+)(?:="([^"]*)")?/g,
      )
    ) {
      attributes.set(name, decode(value ?? ""));
    }
    const id = attributes.get("id");
    if (id === undefined) continue;
    const element = new FakeElement(id, attributes, elements, [
      index,
      endOf(html, tag, index + text.length),
    ]);
    element.form = index >= formStart && index < formEnd ? form : null;
    if (tag === "select") {
      const options = html.slice(...element.span).matchAll(
        /<option value="([^"]*)"( selected)?>/g,
      );
      element.options = [...options].map(([, value, selected]) => ({
        value,
        defaultSelected: selected !== undefined,
        selected: selected !== undefined,
      }));
    }
    elements.set(id, element);
  }
  return elements;
}

/**
 * A response the stand-in `fetch` hands the page. `version` is the version it
 * names, and `null` names none, as a proxy's error page does.
 */
interface Answer {
  status?: number;
  version?: string | null;
  /** Whether the response is held back until the test releases it. */
  pending?: boolean;
  body: string;
}

/** A page whose script is running in the stand-in browser. */
interface RunningPage {
  /** The elements of the markup the page loaded with, by id. */
  readonly elements: Map<string, FakeElement>;
  /** The form around the page's controls. */
  readonly form: FakeForm;
  /** Every URL the page fetched, in order. */
  readonly requests: string[];
  /** Every navigation the page started: "reload", or the URL it loaded. */
  readonly navigations: string[];
  /** Every address the page put in its history without loading it. */
  readonly pushes: string[];
  /** Every progress stream the page opened, in order. */
  readonly streams: FakeStream[];
  /** What the page keeps in the tab's `sessionStorage`. */
  readonly storage: Map<string, string>;
  /** How often each of the page's periodic callbacks runs, in milliseconds. */
  readonly intervals: number[];
  readonly document: FakeDocument;
  readonly window: FakeTarget;
  /** Puts `href` in the address bar without telling the page. */
  visit(href: string): void;
  /** Starts the page's periodic update check. */
  startCheck(): void;
  /** Lets every held-back response arrive and waits for what it starts. */
  release(): Promise<void>;
  /** Runs the page's periodic update check and waits for it to finish. */
  check(): Promise<void>;
  /** Fires `type` at `target` and waits for what it starts. */
  dispatch(target: FakeTarget, type: string, event?: object): Promise<void>;
}

/**
 * Starts the page `html` at `href` in the stand-in browser with `start`, and
 * responds to each request the page makes with `answer`. The tab's
 * `sessionStorage` holds `storage`.
 */
async function run(
  html: string,
  href: string,
  start: (browser: HistoryBrowser) => void,
  answer: (url: string) => Answer,
  storage = new Map<string, string>(),
): Promise<RunningPage> {
  const elements = elementsOf(html);
  const requests: string[] = [];
  const navigations: string[] = [];
  const callbacks: (() => unknown)[] = [];
  const intervals: number[] = [];
  const pushes: string[] = [];
  const streams: FakeStream[] = [];
  const location = {
    href,
    origin: new URL(href).origin,
    pathname: new URL(href).pathname,
    search: new URL(href).search,
    reload: () => navigations.push("reload"),
    assign: (url: string) => navigations.push(url),
  };
  const visit = (url: string) => {
    const next = new URL(url, location.href);
    location.href = next.href;
    location.pathname = next.pathname;
    location.search = next.search;
  };
  const held: (() => void)[] = [];
  const fetch = (url: string, init?: { signal?: AbortSignal }) => {
    requests.push(url);
    const { status = 200, version = SERVING_VERSION, pending, body } = answer(
      url,
    );
    const headers = new Headers();
    if (version !== null) headers.set(VERSION_HEADER, version);
    const response = {
      ok: status >= 200 && status < 300,
      status,
      headers,
      json: () => Promise.resolve(JSON.parse(body)),
      text: () => Promise.resolve(body),
    };
    // The response arrives after whatever runs alongside the request, which
    // can abort it first.
    return new Promise<typeof response>((resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      signal?.addEventListener("abort", abort);
      const arrive = () => signal?.aborted ? abort() : resolve(response);
      if (pending) held.push(arrive);
      else queueMicrotask(arrive);
    });
  };
  class DOMParser {
    parseFromString(markup: string) {
      const parsed = elementsOf(markup);
      return { getElementById: (id: string) => parsed.get(id) ?? null };
    }
  }
  class EventSource extends FakeStream {
    constructor(url: string) {
      super(url);
      streams.push(this);
    }
  }
  const window = new FakeTarget();
  const links = [...html.matchAll(/<a\s[^>]*href="(\/bench\?[^"]*)"/g)].map((
    [, link],
  ) => new FakeLink(decode(link), href));
  const document = new FakeDocument(elements, links);
  start({
    document,
    location,
    history: {
      pushState: (_data: null, _unused: string, url: string) => {
        pushes.push(url);
        visit(url);
      },
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    DOMParser,
    EventSource,
    fetch,
    setInterval: (callback: () => unknown, timeout: number) => {
      callbacks.push(callback);
      intervals.push(timeout);
    },
    requestAnimationFrame: (callback: () => void) => queueMicrotask(callback),
    Element: FakeTarget,
    addEventListener: (type: string, listener: (event: object) => void) =>
      window.addEventListener(type, listener),
    // The stand-in has only the parts of `window` that a history page uses.
  } as unknown as HistoryBrowser);
  // Every answer above settles without waiting on anything, so one turn of
  // the event loop lets whatever the script started run to the end.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  await settle();
  const startCheck = () => {
    for (const callback of callbacks) callback();
  };
  return {
    elements,
    form: elements.get("days")!.form!,
    requests,
    navigations,
    pushes,
    streams,
    storage,
    intervals,
    document,
    window,
    visit,
    startCheck,
    async release() {
      for (const arrive of held.splice(0)) arrive();
      await settle();
    },
    async check() {
      startCheck();
      await settle();
    },
    async dispatch(target, type, event) {
      target.dispatch(type, event);
      await settle();
    },
  };
}

/** A collection's progress, and what a page's progress panel says about it. */
interface DescribedProgress {
  readonly state: CollectionProgress;
  readonly text: ProgressText;
}

const COLLECTION_ID = "collection under way";

function benchmarkProgress(
  phase: CollectionProgress["phase"],
  error?: string,
): BenchmarkFetchProgress {
  return {
    id: COLLECTION_ID,
    phase,
    totalRuns: 9,
    cachedRuns: 2,
    requestsMade: 5,
    responsesReceived: 4,
    successfulResponses: 4,
    failedResponses: 0,
    completedRuns: 6,
    queuedRuns: 3,
    outstandingRequests: 1,
    needsReload: false,
    updatedAt: 0,
    error,
  };
}

function ciProgress(
  phase: CollectionProgress["phase"],
  error?: string,
): CiJobFetchProgress {
  return {
    id: COLLECTION_ID,
    source: "labs",
    days: 14,
    phase,
    discoveryRequestsMade: 2,
    discoveryResponsesReceived: 2,
    discoveryOutstandingRequests: 0,
    totalRuns: 9,
    cachedRuns: 2,
    requestsMade: 5,
    responsesReceived: 3,
    sharedRequests: 1,
    sharedResponses: 1,
    successfulResponses: 4,
    failedResponses: 0,
    completedRuns: 6,
    queuedRuns: 3,
    outstandingRequests: 1,
    needsReload: false,
    updatedAt: 0,
    error,
  };
}

const HISTORY_PAGES = [
  {
    name: "runtime benchmark history",
    href: "http://dashboard.test/bench?view=runtime&days=14",
    page: () => benchPage("p99", "file", 14),
    collecting: () =>
      benchPage("p99", "file", 14, Date.now(), "labs", {
        progress: benchmarkProgress("fetching"),
      }),
    fragment: () =>
      benchPage("p99", "file", 7, Date.now(), "labs", { fragment: true }),
    script: historyPageScript(RUNTIME_HISTORY_PAGE, describeBenchmarkProgress),
    progressPath: RUNTIME_HISTORY_PAGE.progressPath,
    hideGreenKey: RUNTIME_HISTORY_PAGE.hideGreenKey,
    start: (browser: HistoryBrowser) =>
      followHistoryPage(
        browser,
        RUNTIME_HISTORY_PAGE,
        describeBenchmarkProgress,
      ),
    progress: (
      phase: CollectionProgress["phase"],
      error?: string,
    ): DescribedProgress => {
      const state = benchmarkProgress(phase, error);
      return { state, text: describeBenchmarkProgress(state) };
    },
    chooser: "key-only",
    picked: (chooser: FakeElement) => String(chooser.checked),
    pickAnother: (chooser: FakeElement) => {
      chooser.checked = !chooser.checked;
    },
  },
  {
    name: "CI duration history",
    href: "http://dashboard.test/bench?view=ci&repo=labs&days=14",
    page: () => ciJobHistoryPage(null, "job", undefined, { days: 14 }),
    collecting: () =>
      ciJobHistoryPage(null, "job", undefined, {
        days: 14,
        progress: ciProgress("fetching"),
      }),
    fragment: () =>
      ciJobHistoryPage(null, "job", undefined, { days: 7, fragment: true }),
    script: historyPageScript(CI_HISTORY_PAGE, describeCiProgress),
    progressPath: CI_HISTORY_PAGE.progressPath,
    hideGreenKey: CI_HISTORY_PAGE.hideGreenKey,
    start: (browser: HistoryBrowser) =>
      followHistoryPage(browser, CI_HISTORY_PAGE, describeCiProgress),
    progress: (
      phase: CollectionProgress["phase"],
      error?: string,
    ): DescribedProgress => {
      const state = ciProgress(phase, error);
      return { state, text: describeCiProgress(state) };
    },
    chooser: "repo",
    picked: (chooser: FakeElement) =>
      chooser.options.filter((option) => option.selected).map((option) =>
        option.value
      ).join(),
    pickAnother: (chooser: FakeElement) => {
      for (const option of chooser.options) option.selected = !option.selected;
    },
  },
];

/** How a test answers a page's update check. */
interface Check extends Omit<Answer, "body"> {
  /** The data version the check names, the page's own when absent. */
  snapshot?: string;
  /** The collection under way that the check reports. */
  progress?: CollectionProgress;
  /** Why the last collection stopped; `undefined` leaves the field out. */
  lastRequestError?: string | null;
  /** Whether the response to the first check is held back. */
  firstPending?: boolean;
}

/** How a test answers a page's request for its charts. */
type Fragment = Omit<Answer, "body"> & { body?: string };

/**
 * `html`, a rendering of `history`, with its update check answered by `check`
 * and the window of history it asks for answered by `fragment`. Each request
 * reads its answer as it arrives, so a test can change it between requests.
 * `serialized` runs the script the page carries rather than the one it
 * imports, and the tab's `sessionStorage` holds `storage`.
 */
function openHistory(
  history: (typeof HISTORY_PAGES)[number],
  check: Check,
  fragment: Fragment = {},
  { html = history.page(), serialized = false, storage = new Map() } = {},
): Promise<RunningPage> {
  const loaded = elementsOf(html).get("fetch-progress")!.dataset
    .snapshotVersion!;
  const start = serialized
    ? (browser: HistoryBrowser) => {
      const script = html.split("<script>").at(-1)!.split("</script>")[0];
      new Function("window", script)(browser);
    }
    : history.start;
  let checks = 0;
  return run(html, history.href, start, (url) =>
    url.startsWith("/bench/check?")
      ? {
        ...check,
        pending: check.firstPending === true && checks++ === 0,
        body: JSON.stringify({
          version: check.snapshot ?? loaded,
          progress: check.progress ?? null,
          lastRequestError: "lastRequestError" in check
            ? check.lastRequestError
            : null,
        }),
      }
      : { ...fragment, body: fragment.body ?? history.fragment() }, storage);
}

describe("history-page-client", () => {
  for (const history of HISTORY_PAGES) {
    describe(history.name, () => {
      const replacementOf = (page: RunningPage) =>
        page.elements.get("range-content")!.replacement?.id;
      const panel = (page: RunningPage) => ({
        title: page.elements.get("fetch-title")!.textContent,
        total: page.elements.get("fetch-total")!.textContent,
        detail: page.elements.get("fetch-detail")!.textContent,
      });
      const failed = (page: RunningPage) =>
        page.elements.get("fetch-progress")!.classes.has("error");
      // Moves the window slider to `days` without applying it.
      const slide = (page: RunningPage, days: string) =>
        page.elements.get("days")!.value = days;
      const choose = (page: RunningPage, days: string) => {
        slide(page, days);
        return page.dispatch(page.elements.get("days")!, "change");
      };
      const windowHref = (days: string) => {
        const url = new URL(history.href);
        url.searchParams.set("days", days);
        return url.pathname + url.search;
      };
      // The window each request for charts asked for, in order.
      const windowsOf = (page: RunningPage) =>
        page.requests.filter((request) => request.includes("fragment=range"))
          .map((request) =>
            new URL(request, history.href).searchParams.get("days")
          );

      it("carries the shared history script with its own settings", () => {
        expect(history.page()).toContain(history.script);
      });

      it("throws, naming what is missing, when its markup lacks an element it needs", async () => {
        await expect(
          run("<main></main>", history.href, history.start, () => ({ body: "" })),
        ).rejects.toThrow("A history page needs an element #hg.");
      });

      for (const serialized of [false, true]) {
        describe(serialized ? "as the page carries its script" : "as imported", () => {
          const open = (
            check: Check,
            fragment: Fragment = {},
            storage = new Map<string, string>(),
          ) => openHistory(history, check, fragment, { storage, serialized });
          const openCollecting = (check: Check = {}) =>
            openHistory(history, check, {}, {
              html: history.collecting(),
              serialized,
            });

          it("checks the server once a minute", async () => {
            const page = await open({});

            expect(page.intervals).toEqual([60_000]);
          });

          it("replaces only the charts when the same version has new data", async () => {
            const page = await open({ snapshot: "newer-data" });
            await page.check();

            expect(page.navigations).toEqual([]);
            expect(page.requests).toHaveLength(2);
            expect(page.requests[1]).toContain("fragment=range");
            expect(replacementOf(page)).toBe("range-content");
          });

          it("changes nothing when neither the version nor the data changed", async () => {
            const page = await open({});
            await page.check();

            expect(page.navigations).toEqual([]);
            expect(page.requests).toHaveLength(1);
            expect(replacementOf(page)).toBeUndefined();
          });

          it("checks the server at once when its tab becomes visible", async () => {
            const page = await open({});
            await page.dispatch(page.document, "visibilitychange");

            expect(page.requests).toHaveLength(1);
            expect(page.requests[0]).toMatch(/^\/bench\/check\?/);
          });

          it("reloads the whole page, once, when the check reports another version", async () => {
            const page = await open(
              { version: ANOTHER_VERSION },
              { version: ANOTHER_VERSION },
            );
            await page.check();

            expect(page.navigations).toEqual(["reload"]);
            expect(page.requests).toHaveLength(2);
            expect(replacementOf(page)).toBeUndefined();

            await page.check();
            expect(page.navigations).toEqual(["reload"]);
            expect(page.requests).toHaveLength(2);
          });

          it("waits for a chosen window, and loads it as a whole page, when the check reports another version", async () => {
            const page = await open(
              { version: ANOTHER_VERSION },
              { version: ANOTHER_VERSION },
            );
            slide(page, "7");
            await page.check();

            expect(page.navigations).toEqual([]);
            expect(page.requests).toHaveLength(1);

            await choose(page, "7");
            expect(page.navigations).toEqual([windowHref("7")]);
          });

          it("waits for focus to leave the charts, then reloads, when the check reports another version", async () => {
            const page = await open(
              { version: ANOTHER_VERSION },
              { version: ANOTHER_VERSION },
            );
            page.document.activeElement = page.elements.get("fetch-title")!;
            await page.check();

            expect(page.navigations).toEqual([]);
            expect(page.requests).toHaveLength(1);

            page.document.activeElement = null;
            await page.dispatch(page.document, "focusout");
            expect(page.navigations).toEqual(["reload"]);
          });

          it("does not wait for focus outside the charts when the check reports another version", async () => {
            const page = await open(
              { version: ANOTHER_VERSION },
              { version: ANOTHER_VERSION },
            );
            page.document.activeElement = page.elements.get("days")!;
            await page.check();

            expect(page.navigations).toEqual(["reload"]);
          });

          it("leaves a link clicked while another version's window is loading to navigate", async () => {
            const page = await open({}, { version: ANOTHER_VERSION });
            slide(page, "7");
            page.elements.get("days")!.dispatch("change");
            await page.dispatch(page.document, "click", {
              target: inside("http://dashboard.test/"),
              button: 0,
            });

            expect(page.navigations).toEqual([]);
          });

          it("keeps checking after a link to a part of the same page is clicked, and stops once a link leaves it", async () => {
            const page = await open({});
            const click = (href: string) =>
              page.dispatch(page.document, "click", {
                target: inside(href),
                button: 0,
              });
            await click(`${history.href}#fetch-progress`);
            await page.check();

            expect(page.requests).toHaveLength(1);

            await click("http://dashboard.test/");
            await page.check();
            expect(page.requests).toHaveLength(1);
          });

          it("stops checking once its form is submitted", async () => {
            const page = await open({});
            await page.dispatch(page.form, "submit");
            await page.check();

            expect(page.requests).toEqual([]);
          });

          it("hides green rows, and remembers that for the tab, when the hide-green switch is turned on", async () => {
            const hidden = await open({});
            const hideGreen = hidden.elements.get("hg")!;
            hideGreen.checked = true;
            await hidden.dispatch(hideGreen, "change");

            expect(hidden.document.body.classes.has("hide-green")).toBe(true);
            expect(hidden.storage.get(history.hideGreenKey)).toBe("1");

            const shown = await open({}, {}, hidden.storage);
            expect(shown.elements.get("hg")!.checked).toBe(true);
            expect(shown.document.body.classes.has("hide-green")).toBe(true);
          });

          it("submits its form when a control that chooses another page changes", async () => {
            const page = await open({});
            for (const id of ["days", "hg"]) {
              await page.dispatch(page.form, "change", {
                target: page.elements.get(id),
              });
            }

            expect(page.form.submits).toBe(0);

            await page.dispatch(page.form, "change", {
              target: page.elements.get(history.chooser),
            });
            expect(page.form.submits).toBe(1);
          });

          it("returns to the window it showed when restored from the back/forward cache", async () => {
            const page = await open({});
            await choose(page, "7");
            slide(page, "9");
            await page.dispatch(page.window, "pagehide");
            await page.dispatch(page.window, "pageshow", { persisted: true });

            expect(page.elements.get("days")!.value).toBe("7");
            expect(page.elements.get("daysv")!.value).toBe("7 days");
            expect(page.navigations).toEqual([]);
          });

          it("shows the controls it was served with, and the hide-green switch as it was, when restored from the back/forward cache", async () => {
            const page = await open({});
            const hideGreen = page.elements.get("hg")!;
            const chooser = page.elements.get(history.chooser)!;
            const served = history.picked(chooser);
            hideGreen.checked = true;
            history.pickAnother(chooser);

            expect(history.picked(chooser)).not.toBe(served);

            await page.dispatch(page.window, "pageshow", { persisted: true });
            expect(hideGreen.checked).toBe(true);
            expect(history.picked(chooser)).toBe(served);
          });

          it("stays loaded when the server fails without naming a version", async () => {
            const page = await open(
              { status: 502, version: null },
              { status: 502, version: null },
            );
            await page.check();

            expect(page.navigations).toEqual([]);
            expect(page.requests).toHaveLength(1);
          });

          it("reloads the whole page when another version rejects the check", async () => {
            const page = await open(
              { status: 400, version: ANOTHER_VERSION },
              { version: ANOTHER_VERSION },
            );
            await page.check();

            expect(page.navigations).toEqual(["reload"]);
          });

          it("loads a newly chosen window as a whole page when another version serves it", async () => {
            const page = await open({}, { version: ANOTHER_VERSION });
            await choose(page, "7");

            expect(page.navigations).toEqual([windowHref("7")]);
            expect(replacementOf(page)).toBeUndefined();
          });

          it("reloads at its own window when restored from the back/forward cache onto another version", async () => {
            const page = await open(
              { version: ANOTHER_VERSION },
              { version: ANOTHER_VERSION },
            );
            await choose(page, "7");
            await page.dispatch(page.window, "pagehide");
            await page.dispatch(page.window, "pageshow", { persisted: true });

            expect(page.elements.get("days")!.value).toBe("14");
            expect(page.navigations).toEqual([windowHref("7"), "reload"]);
          });

          it("returns to its own window, no longer busy, when restored from the back/forward cache after leaving mid-load", async () => {
            const page = await open({});
            slide(page, "7");
            page.elements.get("days")!.dispatch("change");
            await page.dispatch(page.window, "pagehide");
            await page.dispatch(page.window, "pageshow", { persisted: true });

            const charts = page.elements.get("range-content")!;
            expect(page.elements.get("days")!.value).toBe("14");
            expect(charts.attributes.has("aria-busy")).toBe(false);
            expect(charts.replacement).toBeUndefined();
            expect(page.navigations).toEqual([]);
          });

          it("loads the window its address names when restored from the back/forward cache after leaving mid-load", async () => {
            const page = await open({});
            page.visit(windowHref("7"));
            page.window.dispatch("popstate");
            await page.dispatch(page.window, "pagehide");
            await page.dispatch(page.window, "pageshow", { persisted: true });

            expect(page.elements.get("days")!.value).toBe("7");
            expect(windowsOf(page)).toEqual(["7", "7"]);
            expect(replacementOf(page)).toBe("range-content");
            expect(page.navigations).toEqual([]);
          });

          it("checks at once when restored from the back/forward cache with a check still waiting", async () => {
            const page = await open({ firstPending: true });
            page.startCheck();
            await page.dispatch(page.window, "pagehide");
            await page.dispatch(page.window, "pageshow", { persisted: true });

            expect(
              page.requests.filter((url) => url.startsWith("/bench/check?")),
            ).toHaveLength(2);
          });

          it("leaves the progress panel as it was when leaving the page stops a check", async () => {
            const page = await open({ firstPending: true });
            const title = page.elements.get("fetch-title")!;
            title.textContent = "Saving completed responses…";
            page.startCheck();
            await page.dispatch(page.window, "pagehide");
            await page.release();

            expect(title.textContent).toBe("Saving completed responses…");
          });

          it("puts a newly chosen window in place when the same version serves it", async () => {
            const page = await open({});
            await choose(page, "7");

            expect(page.navigations).toEqual([]);
            expect(page.pushes).toEqual([windowHref("7")]);
            expect(replacementOf(page)).toBe("range-content");
          });

          it("applies the window on the slider when Enter is pressed on it", async () => {
            const page = await open({});
            const days = page.elements.get("days")!;
            let prevented = 0;
            const press = (key: string) =>
              page.dispatch(days, "keydown", {
                key,
                preventDefault: () => prevented++,
              });
            slide(page, "7");
            await press("ArrowLeft");

            expect(page.requests).toEqual([]);

            await press("Enter");
            expect(prevented).toBe(1);
            expect(page.pushes).toEqual([windowHref("7")]);
          });

          it("labels the slider's window and carries it into its links to other views as the slider moves", async () => {
            const page = await open({});
            slide(page, "1");
            await page.dispatch(page.elements.get("days")!, "input");

            expect(page.elements.get("daysv")!.value).toBe("1 day");
            expect(page.document.links.length).toBeGreaterThan(0);
            expect(
              page.document.links.map((link) =>
                new URL(link.href).searchParams.get("days")
              ),
            ).toEqual(page.document.links.map(() => "1"));
            expect(page.requests).toEqual([]);
          });

          it("shows the window an earlier history entry names when the browser goes back", async () => {
            const page = await open({});
            await choose(page, "7");
            page.visit(history.href);
            await page.dispatch(page.window, "popstate");

            expect(page.elements.get("days")!.value).toBe("14");
            expect(page.elements.get("daysv")!.value).toBe("14 days");
            expect(windowsOf(page)).toEqual(["7", "14"]);
            expect(page.pushes).toEqual([windowHref("7")]);
          });

          it("shows the nearest window it can when the address names one it cannot show", async () => {
            const page = await open({});
            const days = page.elements.get("days")!;
            const backTo = async (window: string) => {
              page.visit(windowHref(window));
              await page.dispatch(page.window, "popstate");
              return days.value;
            };

            expect(await backTo("many")).toBe("14");
            expect(await backTo(" ")).toBe("14");
            expect(await backTo("1000")).toBe(days.max);
            expect(await backTo("0")).toBe(days.min);
            expect(await backTo("7.5")).toBe("7");
          });

          it("goes back to the window it shows when the slider returns there while another loads", async () => {
            const page = await open({});
            slide(page, "7");
            page.elements.get("days")!.dispatch("change");
            await choose(page, "14");

            expect(windowsOf(page)).toEqual(["7", "14"]);
            expect(page.pushes).toEqual([]);
            expect(replacementOf(page)).toBe("range-content");
          });

          it("fetches its charts again once a chosen window is in place when new data arrived before it was applied", async () => {
            const page = await open({ snapshot: "newer-data" });
            slide(page, "7");
            await page.check();
            await choose(page, "7");

            expect(windowsOf(page)).toEqual(["7", "7"]);
            expect(page.pushes).toEqual([windowHref("7")]);
          });

          it("fetches its charts again when the slider returns to the shown window after new data arrived", async () => {
            const page = await open({ snapshot: "newer-data" });
            slide(page, "7");
            await page.check();
            await choose(page, "14");

            expect(windowsOf(page)).toEqual(["14"]);
            expect(page.pushes).toEqual([]);
            expect(replacementOf(page)).toBe("range-content");
          });

          it("says it could not update its window when the server fails to serve it", async () => {
            const page = await open({}, { status: 500 });
            await choose(page, "7");

            expect(panel(page)).toEqual({
              title: "Could not update the history window",
              total: "0 outstanding",
              detail: "HTTP 500",
            });
            expect(failed(page)).toBe(true);
            expect(page.elements.get("range-content")!.attributes.has("aria-busy"))
              .toBe(false);
            expect(page.pushes).toEqual([]);
          });

          it("says the charts were missing when the server's answer holds none", async () => {
            const page = await open({}, { body: "<p>No charts.</p>" });
            await choose(page, "7");

            expect(panel(page).detail).toBe(
              "Range content was missing from the response.",
            );
            expect(replacementOf(page)).toBeUndefined();
          });

          it("puts no window in place, and asks for none, once a link has been clicked", async () => {
            const page = await open({}, { pending: true });
            slide(page, "7");
            page.elements.get("days")!.dispatch("change");
            await page.dispatch(page.document, "click", {
              target: inside("http://dashboard.test/"),
              button: 0,
            });
            await page.release();

            expect(windowsOf(page)).toEqual(["7"]);
            expect(replacementOf(page)).toBeUndefined();
            expect(page.pushes).toEqual([]);

            await choose(page, "9");
            expect(windowsOf(page)).toEqual(["7"]);
          });

          it("takes nothing from a check that a newly chosen window arrived during", async () => {
            const page = await open({ firstPending: true, snapshot: "newer-data" });
            page.startCheck();
            await choose(page, "7");
            await page.release();

            expect(windowsOf(page)).toEqual(["7"]);
            expect(page.pushes).toEqual([windowHref("7")]);
          });

          it("keeps its window slider and the control that chooses another page out of the browser's form restoration", async () => {
            const page = await open({});

            for (const id of ["days", history.chooser]) {
              expect(page.elements.get(id)!.attributes.get("autocomplete"))
                .toBe("off");
            }
          });

          it("leaves its controls alone when first shown", async () => {
            const page = await open({});
            await choose(page, "7");
            await page.dispatch(page.window, "pageshow", { persisted: false });

            expect(page.elements.get("days")!.value).toBe("7");
            expect(page.requests).toHaveLength(1);
          });

          describe("collection progress", () => {
            it("shows a collection's progress as the server streams it", async () => {
              const page = await openCollecting();
              const [stream] = page.streams;
              const fetching = history.progress("fetching");
              await page.dispatch(stream, "progress", {
                data: JSON.stringify(fetching.state),
              });

              const bar = page.elements.get("fetch-bar")!;
              expect(stream.url).toBe(
                `${history.progressPath}?id=${encodeURIComponent(COLLECTION_ID)}`,
              );
              expect(panel(page)).toEqual(fetching.text);
              expect([bar.attributes.get("max"), bar.attributes.get("value")])
                .toEqual(["9", "6"]);

              await page.dispatch(stream, "progress", {
                data: JSON.stringify(history.progress("discovering").state),
              });
              expect(panel(page)).toEqual(history.progress("discovering").text);
              expect(bar.attributes.has("value")).toBe(false);

              await page.dispatch(stream, "progress", {
                data: JSON.stringify(fetching.state),
              });
              expect(bar.attributes.get("value")).toBe("6");

              await page.dispatch(stream, "progress", {
                data: JSON.stringify({ ...fetching.state, totalRuns: 0 }),
              });
              expect(bar.attributes.has("value")).toBe(false);
            });

            it("loads the charts when a collection finishes on a page served before any data", async () => {
              const page = await openCollecting();
              const [stream] = page.streams;
              await page.dispatch(stream, "progress", {
                data: JSON.stringify(history.progress("complete").state),
              });

              expect(stream.closed).toBe(true);
              expect(page.requests).toHaveLength(1);
              expect(page.requests[0]).toContain("fragment=range");
              expect(replacementOf(page)).toBe("range-content");
            });

            it("goes idle when a collection the check reports finishes with nothing new", async () => {
              const page = await open({
                progress: history.progress("fetching").state,
              });
              await page.check();
              const [stream] = page.streams;

              expect(stream.url).toBe(
                `${history.progressPath}?id=${encodeURIComponent(COLLECTION_ID)}`,
              );
              expect(panel(page)).toEqual(history.progress("fetching").text);

              await page.dispatch(stream, "progress", {
                data: JSON.stringify(history.progress("complete").state),
              });
              expect(stream.closed).toBe(true);
              expect(panel(page)).toEqual({
                title: "Idle",
                total: "0 outstanding",
                detail: "No requests in progress.",
              });
              expect(page.requests).toHaveLength(1);
            });

            it("says why a collection stopped until the server reports that none has", async () => {
              const check: Check = {};
              const page = await openCollecting(check);
              const [stream] = page.streams;
              await page.dispatch(stream, "progress", {
                data: JSON.stringify(
                  history.progress("error", "GitHub refused").state,
                ),
              });
              const stopped = {
                title: "Idle",
                total: "0 outstanding",
                detail: "Last collection stopped: GitHub refused",
              };

              expect(stream.closed).toBe(true);
              expect(panel(page)).toEqual(stopped);
              expect(failed(page)).toBe(true);

              check.lastRequestError = undefined;
              await page.check();
              expect(panel(page)).toEqual(stopped);

              check.lastRequestError = "GitHub refused again";
              await page.check();
              expect(panel(page).detail).toBe(
                "Last collection stopped: GitHub refused again",
              );

              check.lastRequestError = null;
              await page.check();
              expect(panel(page).detail).toBe("No requests in progress.");
              expect(failed(page)).toBe(false);
            });

            it("says its progress connection closed, and keeps saying so through failed checks", async () => {
              const check: Check = {};
              const page = await openCollecting(check);
              const [stream] = page.streams;
              await page.dispatch(stream, "error");
              const closed =
                "Progress connection closed; collection continues on the server";

              expect(stream.closed).toBe(true);
              expect(panel(page).title).toBe(closed);
              expect(failed(page)).toBe(true);

              check.status = 500;
              await page.check();
              expect(panel(page).title).toBe(closed);
            });

            it("keeps following its progress stream when a check reports the collection it follows", async () => {
              const page = await openCollecting({
                progress: history.progress("fetching").state,
              });
              await page.check();

              expect(page.streams).toHaveLength(1);
              expect(page.streams[0].closed).toBe(false);
              expect(panel(page)).toEqual(history.progress("fetching").text);
            });

            it("ignores a progress stream it has closed", async () => {
              const page = await open({
                progress: history.progress("fetching").state,
              });
              await page.check();
              const [stream] = page.streams;
              await page.dispatch(stream, "progress", {
                data: JSON.stringify(history.progress("complete").state),
              });
              const idle = panel(page);

              await page.dispatch(stream, "progress", {
                data: JSON.stringify(history.progress("error", "late").state),
              });
              await page.dispatch(stream, "error");

              expect(panel(page)).toEqual(idle);
              expect(failed(page)).toBe(false);
            });

            it("asks for no charts when a collection finishes with new data after a link was clicked", async () => {
              const page = await openCollecting();
              const [stream] = page.streams;
              await page.dispatch(page.document, "click", {
                target: inside("http://dashboard.test/"),
                button: 0,
              });
              await page.dispatch(stream, "progress", {
                data: JSON.stringify({
                  ...history.progress("complete").state,
                  needsReload: true,
                }),
              });

              expect(stream.closed).toBe(true);
              expect(page.requests).toEqual([]);
            });

            it("goes idle when a check after its progress connection closed reports no collection and leaves out why the last one stopped", async () => {
              const page = await openCollecting({ lastRequestError: undefined });
              await page.dispatch(page.streams[0], "error");
              await page.check();

              expect(panel(page)).toEqual({
                title: "Idle",
                total: "0 outstanding",
                detail: "No requests in progress.",
              });
              expect(failed(page)).toBe(false);
            });

            it("says it could not read a progress update it cannot parse", async () => {
              const page = await openCollecting();
              const [stream] = page.streams;
              await page.dispatch(stream, "progress", { data: "{" });

              expect(stream.closed).toBe(true);
              expect(panel(page).title).toBe("Could not read collection progress");
              expect(failed(page)).toBe(true);
            });
          });
        });
      }
    });
  }
});
