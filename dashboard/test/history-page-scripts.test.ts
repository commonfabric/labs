/**
 * What an open performance history page does as the server behind it changes
 * and as the browser leaves and restores it. Each page runs its own script, as
 * the server renders it, against a stand-in for the browser built from the
 * page's own markup, and the test answers the requests the script makes.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ciJobHistoryPage } from "../ci-job-history.ts";
import { benchPage } from "../tiles/benchmark.ts";
import { SERVING_VERSION, VERSION_HEADER } from "../version.ts";

const ANOTHER_VERSION = `${SERVING_VERSION}-next`;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

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
  textContent = "";
  value = "";
  checked = false;
  min = "";
  max = "";
  form?: FakeElement;
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
    this.value = attributes.get("value") ?? "";
    this.checked = attributes.has("checked");
    this.min = attributes.get("min") ?? "";
    this.max = attributes.get("max") ?? "";
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
  requestSubmit(): void {}
}

/** The document of the stand-in browser. */
class FakeDocument extends FakeTarget {
  readonly body: FakeElement;
  activeElement: FakeElement | null = null;
  readonly visibilityState = "visible";

  constructor(readonly elements: Map<string, FakeElement>) {
    super();
    this.body = new FakeElement("", new Map(), elements);
  }

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }
  querySelectorAll(): FakeElement[] {
    return [];
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
  const form = new FakeElement("", new Map(), elements);
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
      attributes.set(
        name,
        (value ?? "").replace(/&(?:amp|quot|#39|lt|gt);/g, (entity) =>
          ENTITIES[entity]),
      );
    }
    const id = attributes.get("id");
    if (id === undefined) continue;
    const element = new FakeElement(id, attributes, elements, [
      index,
      endOf(html, tag, index + text.length),
    ]);
    element.form = form;
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
  /** Whether the response never arrives, so the request ends only if aborted. */
  pending?: boolean;
  body: string;
}

/**
 * How the stand-in server answers a page's update checks. `snapshot` is the
 * data version it reports, the page's own by default, and `firstPending` holds
 * back the response to the first check.
 */
type CheckAnswer = Omit<Answer, "body" | "pending"> & {
  snapshot?: string;
  firstPending?: boolean;
};

/** A page whose script is running in the stand-in browser. */
interface RunningPage {
  /** The elements of the markup the page loaded with, by id. */
  readonly elements: Map<string, FakeElement>;
  /** Every URL the page fetched, in order. */
  readonly requests: string[];
  /** Every navigation the page started: "reload", or the URL it loaded. */
  readonly navigations: string[];
  /** Every address the page put in its history without loading it. */
  readonly pushes: string[];
  readonly document: FakeDocument;
  readonly window: FakeTarget;
  /** Starts the page's periodic update check. */
  startCheck(): void;
  /** Runs the page's periodic update check and waits for it to finish. */
  check(): Promise<void>;
  /** Changes the address, as going back or forward within the page does. */
  address(href: string): void;
  /** Fires `type` at `target` and waits for what it starts. */
  dispatch(target: FakeTarget, type: string, event?: object): Promise<void>;
}

/**
 * Runs the last script in `html` as the page at `href`. `answer` responds to
 * each request the script makes.
 */
async function run(
  html: string,
  href: string,
  answer: (url: string) => Answer,
): Promise<RunningPage> {
  const elements = elementsOf(html);
  const requests: string[] = [];
  const navigations: string[] = [];
  const intervals: (() => unknown)[] = [];
  const pushes: string[] = [];
  const location = {
    href,
    origin: new URL(href).origin,
    pathname: new URL(href).pathname,
    search: new URL(href).search,
    reload: () => navigations.push("reload"),
    assign: (url: string) => navigations.push(url),
  };
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
      if (!pending) {
        queueMicrotask(() => signal?.aborted ? abort() : resolve(response));
      }
    });
  };
  class DOMParser {
    parseFromString(markup: string) {
      const parsed = elementsOf(markup);
      return { getElementById: (id: string) => parsed.get(id) ?? null };
    }
  }
  class EventSource {
    addEventListener(): void {}
    close(): void {}
  }
  const ignore = () => {};
  const window = new FakeTarget();
  const document = new FakeDocument(elements);
  const history = {
    pushState: (_state: unknown, _title: string, url: string) => {
      pushes.push(url);
      const next = new URL(url, location.href);
      location.href = next.href;
      location.pathname = next.pathname;
      location.search = next.search;
    },
  };
  const script = html.split("<script>").at(-1)!.split("</script>")[0];
  new Function(
    "document",
    "window",
    "location",
    "history",
    "fetch",
    "DOMParser",
    "EventSource",
    "sessionStorage",
    "setInterval",
    "requestAnimationFrame",
    script,
  )(
    document,
    window,
    location,
    history,
    fetch,
    DOMParser,
    EventSource,
    { getItem: () => null, setItem: ignore },
    (callback: () => unknown) => intervals.push(callback),
    queueMicrotask,
  );
  // Every answer above settles without waiting on anything, so one turn of
  // the event loop lets whatever the script started run to the end.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  await settle();
  const startCheck = () => {
    for (const callback of intervals) callback();
  };
  return {
    elements,
    requests,
    navigations,
    pushes,
    document,
    window,
    startCheck,
    async check() {
      startCheck();
      await settle();
    },
    address(next) {
      const url = new URL(next, location.href);
      location.href = url.href;
      location.pathname = url.pathname;
      location.search = url.search;
    },
    async dispatch(target, type, event) {
      target.dispatch(type, event);
      await settle();
    },
  };
}

const HISTORY_PAGES = [
  {
    name: "runtime benchmark history",
    href: "http://dashboard.test/bench?view=runtime&days=14",
    page: () => benchPage("p99", "file", 14),
    fragment: () =>
      benchPage("p99", "file", 7, Date.now(), "labs", { fragment: true }),
  },
  {
    name: "CI duration history",
    href: "http://dashboard.test/bench?view=ci&repo=labs&days=14",
    page: () => ciJobHistoryPage(null, "job", undefined, { days: 14 }),
    fragment: () =>
      ciJobHistoryPage(null, "job", undefined, { days: 7, fragment: true }),
  },
];

/**
 * `history`, with its update check answered by `check`, and the window of
 * history it asks for answered by `fragment`.
 */
function openHistory(
  history: (typeof HISTORY_PAGES)[number],
  check: CheckAnswer,
  fragment: Omit<Answer, "body"> = {},
): Promise<RunningPage> {
  const html = history.page();
  const loaded = elementsOf(html).get("fetch-progress")!.dataset
    .snapshotVersion!;
  let checks = 0;
  return run(html, history.href, (url) =>
    url.startsWith("/bench/check?")
      ? {
        ...check,
        pending: check.firstPending === true && checks++ === 0,
        body: JSON.stringify({
          version: check.snapshot ?? loaded,
          progress: null,
          lastRequestError: null,
        }),
      }
      : { ...fragment, body: history.fragment() });
}

describe("history page scripts", () => {
  for (const history of HISTORY_PAGES) {
    describe(history.name, () => {
      const open = (
        check: CheckAnswer,
        fragment: Omit<Answer, "body"> = {},
      ) => openHistory(history, check, fragment);
      const replacementOf = (page: RunningPage) =>
        page.elements.get("range-content")!.replacement?.id;
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
          target: {
            closest: () => ({ href: "http://dashboard.test/", target: "" }),
          },
          button: 0,
        });

        expect(page.navigations).toEqual([]);
      });

      it("returns to the window it showed when restored from the back/forward cache", async () => {
        const page = await open({});
        await choose(page, "7");
        await page.dispatch(page.window, "pagehide");
        await page.dispatch(page.window, "pageshow", { persisted: true });

        expect(page.elements.get("days")!.value).toBe("7");
        expect(page.navigations).toEqual([]);
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
        page.address(windowHref("7"));
        page.window.dispatch("popstate");
        await page.dispatch(page.window, "pagehide");
        await page.dispatch(page.window, "pageshow", { persisted: true });

        expect(page.elements.get("days")!.value).toBe("7");
        expect(replacementOf(page)).toBe("range-content");
        expect(page.navigations).toEqual([]);
      });

      it("checks at once when restored from the back/forward cache with a check still waiting", async () => {
        const page = await open({ firstPending: true });
        page.startCheck();
        await page.dispatch(page.window, "pagehide");
        await page.dispatch(page.window, "pageshow", { persisted: true });

        expect(page.requests.filter((url) => url.startsWith("/bench/check?")))
          .toHaveLength(2);
      });

      it("puts a newly chosen window in place when the same version serves it", async () => {
        const page = await open({});
        await choose(page, "7");

        expect(page.navigations).toEqual([]);
        expect(page.pushes).toEqual([windowHref("7")]);
        expect(replacementOf(page)).toBe("range-content");
      });

      it("keeps its window slider out of the browser's form restoration", async () => {
        const page = await open({});

        expect(page.elements.get("days")!.attributes.get("autocomplete"))
          .toBe("off");
      });
    });
  }

  describe("CI duration history repository picker", () => {
    it("shows the repository the page was served for when shown again", async () => {
      const page = await openHistory(HISTORY_PAGES[1], {});
      const picker = page.elements.get("repo")!;
      for (const option of picker.options) {
        option.selected = option.value === "loom";
      }
      await page.dispatch(page.window, "pageshow", { persisted: true });

      expect(picker.options.filter((option) => option.selected).map((
        option,
      ) => option.value)).toEqual(["labs"]);
      expect(picker.attributes.get("autocomplete")).toBe("off");
    });
  });
});
