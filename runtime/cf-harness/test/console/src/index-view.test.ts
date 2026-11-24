import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  PatternIndexListedPattern,
  PatternIndexPattern,
  PatternIndexSearchResult,
} from "@commonfabric/pattern-index/client";
import type { TemplateResult } from "lit";
import { ConsoleIndexView } from "../../../console/src/index-view.ts";
import { bindingOn, handlerOn, templateText } from "./lit-template.ts";

/** Exposes the component's render result without connecting it to a page. */
class TestIndexView extends ConsoleIndexView {
  /** The read of the listing the component started last. */
  refreshed: Promise<void> = Promise.resolve();

  /** Returns the template the component renders. */
  view(): TemplateResult {
    return this.render();
  }

  /** The rendered page's text, with whitespace folded. */
  text(): string {
    return templateText(this.render()).replace(/\s+/g, " ");
  }

  /**
   * A property write schedules an update, and committing one needs a DOM to
   * write into. These tests render by calling `view()` themselves.
   */
  protected override performUpdate(): void {}

  override refresh(): Promise<void> {
    this.refreshed = super.refresh();
    return this.refreshed;
  }
}

const realFetch = globalThis.fetch;

/** One call the view made to the server's index route, held unanswered. */
interface IndexCall {
  path: string;
  fn: string;
  body: unknown;
  answer: (response: Response) => void;
}

/**
 * A fetch that holds every call until the test answers it, in whatever order
 * it likes. The view starts each call before it first awaits, so a call is
 * here as soon as the method that makes it returns.
 */
const heldIndex = (): readonly IndexCall[] => {
  const calls: IndexCall[] = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const { fn, body } = JSON.parse(String(init?.body));
    const pending = Promise.withResolvers<Response>();
    calls.push({ path: String(input), fn, body, answer: pending.resolve });
    return pending.promise;
  };
  return calls;
};

const refused = (error: string): Response =>
  Response.json({ error }, { status: 502 });

const listed = (
  overrides: Partial<PatternIndexListedPattern> = {},
): PatternIndexListedPattern => ({
  patternId: "pat-1",
  description: "Reads donut orders",
  hashtags: [],
  keywords: [],
  handle: "p-a1b2c3d4e5",
  createdAt: null,
  events: {},
  score: 0,
  ...overrides,
});

const detailed = (
  overrides: Partial<PatternIndexPattern> = {},
): PatternIndexPattern => ({
  patternId: "pat-1",
  handle: "p-q1w2e3r4t5",
  createdAt: "2026-08-01T00:00:00.000Z",
  description: "Reads donut orders",
  hashtags: [],
  dependencies: [],
  ...overrides,
});

const hit = (
  overrides: Partial<PatternIndexSearchResult> = {},
): PatternIndexSearchResult => ({
  patternId: "pat-hit",
  description: "Counts donuts",
  hashtags: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  dependencies: [],
  kind: "app",
  quality: "unproven",
  ...overrides,
});

/** `markup` as a page shows it: tags stripped and spaces folded. */
const folded = (markup: string): string =>
  markup.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

/**
 * The folded text of every `tag` element whose class list holds `className`.
 * Not for a tag that nests inside itself, whose first closing tag ends the
 * match.
 */
const classText = (
  rendered: string,
  className: string,
  tag = "span",
): string[] =>
  [
    ...rendered.matchAll(
      new RegExp(
        `<${tag}\\b[^>]*\\bclass="(?:[^"]*\\s)?${className}(?:\\s[^"]*)?"[^>]*>([\\s\\S]*?)</${tag}>`,
        "g",
      ),
    ),
  ].map((match) => folded(match[1]));

/**
 * The body rows of the rendered table that has a `column` header, each as
 * its cells' folded text keyed by their column's header. A row with a cell
 * for every column is a body row; the header row, which has none, and a
 * detail row spanning them all are not.
 */
const tableRows = (
  rendered: string,
  column: string,
): Record<string, string>[] => {
  const cells = (markup: string, tag: string): string[] =>
    [...markup.matchAll(
      new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g"),
    )]
      .map((match) => folded(match[1]));
  const table = [...rendered.matchAll(/<table\b[\s\S]*?<\/table>/g)]
    .map(([markup]) => markup)
    .find((markup) => cells(markup, "th").includes(column));
  if (table === undefined) throw new Error(`no table has a ${column} column`);
  const headers = cells(table, "th");
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => cells(row, "td"))
    .filter((row) => row.length === headers.length)
    .map((row) =>
      Object.fromEntries(row.map((cell, index) => [headers[index], cell]))
    );
};

describe("console/src/index-view", () => {
  it("renders one badge per event type, carrying its count and no author", () => {
    const view = new TestIndexView();
    view.patterns = [listed({
      events: { thumbs_up: 3, instantiated: 1 },
      // An older deployment's author breakdown is not shown.
      eventAuthors: { thumbs_up: { "did:key:zRun": 3 } },
    })];

    const rendered = templateText(view.view());

    expect(classText(rendered, "badge")).toEqual([
      "instantiated ×1",
      "thumbs_up ×3",
    ]);
    expect(rendered).not.toContain("did:key:zRun");
  });

  it("renders each pattern's owner by handle, marking the caller's own", () => {
    const view = new TestIndexView();
    view.patterns = [
      listed({ patternId: "pat-mine", handle: "p-a1b2c3d4e5", mine: true }),
      listed({ patternId: "pat-other", handle: "p-z9y8x7w6v5", score: 1 }),
    ];

    const rendered = templateText(view.view());

    // The caller's pattern ranks second, so its owner cell is the one marked.
    expect(tableRows(rendered, "owner").map((row) => row.owner)).toEqual([
      "p-z9y8x7w6v5",
      "p-a1b2c3d4e5 you",
    ]);
    expect(classText(rendered, "index-mine")).toEqual(["you"]);
  });

  it("renders the owner's DID for a deployment that predates handles", () => {
    const view = new TestIndexView();
    const { handle: _handle, ...legacy } = listed({ ownerDid: "did:key:zOld" });
    view.patterns = [legacy];

    expect(templateText(view.view())).toContain("did:key:zOld");
  });

  it("renders each pattern's listing state and bucket in its own column", () => {
    const view = new TestIndexView();
    view.patterns = [
      listed({ patternId: "pat-1", listing: "passed", bucket: "main" }),
      listed({ patternId: "pat-2", listing: "held", score: 1 }),
    ];

    const rows = tableRows(templateText(view.view()), "listing");

    expect(rows.map((row) => [row.pattern, row.listing])).toEqual([
      ["pat-2", "held"],
      ["pat-1", "passed · main"],
    ]);
  });

  it("renders the opened pattern's owner by handle, and no events of its own", () => {
    const view = new TestIndexView();
    view.patterns = [listed({ handle: "p-a1b2c3d4e5" })];
    view.open = {
      patternId: "pat-1",
      pattern: {
        patternId: "pat-1",
        handle: "p-q1w2e3r4t5",
        mine: true,
        createdAt: "2026-08-01T00:00:00.000Z",
        description: "Reads donut orders",
        hashtags: [],
        dependencies: [],
      },
    };

    const rendered = templateText(view.view());
    const detail = rendered.slice(rendered.indexOf(`class="index-detail"`));

    expect(detail).toContain("p-q1w2e3r4t5");
    expect(classText(detail, "index-mine")).toEqual(["you"]);
    expect(rendered).not.toContain("its events");
    expect(rendered).not.toContain("Your events");
  });

  describe("refresh", () => {
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it("renders the listing and the event weights the index reported once connected", async () => {
      const calls = heldIndex();
      const view = new TestIndexView();

      view.connectedCallback();
      calls[0].answer(Response.json({
        patterns: [listed()],
        eventTypes: { thumbs_up: 2, instantiated: 1 },
      }));
      await view.refreshed;

      expect(calls.map(({ path, fn }) => ({ path, fn }))).toEqual([
        { path: "/api/index/call", fn: "listPatterns" },
      ]);
      expect(view.renderRoot).toBe(view);
      expect(view.loaded).toBe(true);
      expect(classText(templateText(view.view()), "index-weights")).toEqual([
        "thumbs_up=2 instantiated=1",
      ]);
      expect(view.text()).toContain("Reads donut orders");
      view.disconnectedCallback();
    });

    it("renders no weights for a listing that reports no event types", async () => {
      const calls = heldIndex();
      const view = new TestIndexView();

      const refreshed = view.refresh();
      calls[0].answer(Response.json({ patterns: [listed()] }));
      await refreshed;

      expect(view.eventTypes).toEqual({});
      expect(templateText(view.view())).not.toContain("index-weights");
    });

    it("renders a reading notice before the first answer and an empty notice after it", async () => {
      const calls = heldIndex();
      const view = new TestIndexView();

      const refreshed = view.refresh();
      expect(view.text()).toContain("Reading…");
      calls[0].answer(Response.json({ patterns: [], eventTypes: {} }));
      await refreshed;

      expect(view.text()).toContain("The index holds no patterns.");
      expect(view.text()).not.toContain("Reading…");
    });

    it("renders the error a refused listing reported, in place of the table", async () => {
      const calls = heldIndex();
      const view = new TestIndexView();
      view.patterns = [listed()];

      const refreshed = view.refresh();
      calls[0].answer(refused("index unreachable"));
      await refreshed;

      expect(view.loaded).toBe(true);
      expect(classText(view.text(), "bad", "p")).toEqual(["index unreachable"]);
      expect(view.text()).not.toContain("Reads donut orders");
    });

    it("clears an earlier error when a later listing answers", async () => {
      const calls = heldIndex();
      const view = new TestIndexView();
      view.patternsError = "index unreachable";

      const refreshed = view.refresh();
      calls[0].answer(Response.json({ patterns: [listed()], eventTypes: {} }));
      await refreshed;

      expect(view.patternsError).toBeUndefined();
      expect(view.text()).toContain("Reads donut orders");
    });

    it("re-reads the listing when Refresh is clicked", async () => {
      const calls = heldIndex();
      const view = new TestIndexView();

      const clicked = handlerOn(view.view(), "@click", "Refresh")();
      calls[0].answer(Response.json({
        patterns: [listed({ description: "Bakes bread" })],
        eventTypes: {},
      }));
      await clicked;

      expect(calls.map(({ fn }) => fn)).toEqual(["listPatterns"]);
      expect(view.text()).toContain("Bakes bread");
    });

    it("keeps the newest listing when an earlier read answers after it", async () => {
      const calls = heldIndex();
      const view = new TestIndexView();
      const first = view.refresh();
      const second = view.refresh();

      calls[1].answer(Response.json({
        patterns: [listed({ description: "Newer" })],
        eventTypes: {},
      }));
      await second;
      calls[0].answer(Response.json({
        patterns: [listed({ description: "Older" })],
        eventTypes: { stale: 1 },
      }));
      await first;

      expect(view.text()).toContain("Newer");
      expect(view.text()).not.toContain("Older");
      expect(view.eventTypes).toEqual({});
    });

    it("keeps the newest listing when an earlier read fails after it", async () => {
      const calls = heldIndex();
      const view = new TestIndexView();
      const first = view.refresh();
      const second = view.refresh();

      calls[1].answer(Response.json({ patterns: [listed()], eventTypes: {} }));
      await second;
      calls[0].answer(refused("index unreachable"));
      await first;

      expect(view.patternsError).toBeUndefined();
      expect(view.text()).toContain("Reads donut orders");
    });

    it("stays reading while a newer read is in flight after an older one answers", async () => {
      const calls = heldIndex();
      const view = new TestIndexView();
      const first = view.refresh();
      view.refresh();

      calls[0].answer(Response.json({ patterns: [listed()], eventTypes: {} }));
      await first;

      expect(view.loaded).toBe(false);
      expect(view.text()).toContain("Reading…");
      expect(view.text()).not.toContain("Reads donut orders");
    });
  });

  describe("render()", () => {
    it("renders each pattern's hashtags", () => {
      const view = new TestIndexView();
      view.patterns = [listed({ hashtags: ["food", "orders"] })];

      expect(classText(templateText(view.view()), "index-tag")).toEqual([
        "#food",
        "#orders",
      ]);
    });

    it("renders the inherited share of a score and the pattern it came from", () => {
      const view = new TestIndexView();
      view.patterns = [listed({
        score: 7,
        signals: {
          uses: 0,
          score: 7,
          inherited: {
            priorPatternId: "pat-ancestor-0123456789",
            asOf: "2026-07-01T12:30:45.000Z",
            events: {},
            score: 4,
          },
        },
      })];

      const text = view.text();

      expect(text).toContain("Includes 4 inherited from");
      expect(bindingOn(view.view(), "title", "pat-ancest…")).toBe(
        "pat-ancestor-0123456789",
      );
      expect(text).toContain("as of 2026-07-01 12:30:45");
    });

    it("renders no inherited share for a score that has none", () => {
      const view = new TestIndexView();
      view.patterns = [listed({ score: 3, signals: { uses: 0, score: 3 } })];

      expect(view.text()).not.toContain("inherited");
    });

    it("renders a dash for an owner with neither a handle nor a DID", () => {
      const view = new TestIndexView();
      const { handle: _handle, ...anonymous } = listed();
      view.patterns = [anonymous];

      expect(tableRows(view.text(), "owner").map((row) => row.owner))
        .toEqual(["—"]);
    });
  });

  describe("opening a pattern", () => {
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    /** Clicks the table row whose text holds `text`. */
    const clickRow = (view: TestIndexView, text: string): unknown =>
      handlerOn(view.view(), "@click", text, "tr")();

    it("renders a reading notice under the row, then the pattern the index returned", async () => {
      const calls = heldIndex();
      const view = new TestIndexView();
      view.patterns = [listed()];

      const opened = clickRow(view, "Reads donut orders");
      expect(classText(view.text(), "open", "tr")).toEqual([
        expect.stringContaining("Reads donut orders"),
      ]);
      expect(classText(view.text(), "index-detail-row", "tr")).toEqual([
        "Reading…",
      ]);
      calls[0].answer(Response.json(detailed({
        priorPatternId: "pat-prior",
        dependencies: ["pat-dep-a", "pat-dep-b"],
        argumentSchema: { type: "object" },
        resultSchema: { type: "string" },
      })));
      await opened;

      const detail = view.text().slice(view.text().indexOf("index-detail"));
      expect(calls[0].fn).toBe("getPattern");
      expect(calls[0].body).toEqual({ patternId: "pat-1" });
      expect(detail).not.toContain("Reading…");
      expect(detail).toContain("created 2026-08-01 00:00:00");
      expect(detail).toContain("· revises");
      expect(bindingOn(view.view(), "title", "pat-prior")).toBe("pat-prior");
      expect(detail).toContain("pat-dep-a, pat-dep-b");
      expect(detail).toContain("argument schema");
      expect(detail).toContain(`"type": "object"`);
      expect(detail).toContain("result schema");
      expect(detail).toContain(`"type": "string"`);
    });

    it("renders no revision, no dependencies and no schemas for a pattern that has none", async () => {
      const calls = heldIndex();
      const view = new TestIndexView();
      view.patterns = [listed()];

      const opened = clickRow(view, "Reads donut orders");
      calls[0].answer(Response.json(detailed()));
      await opened;

      const detail = view.text().slice(view.text().indexOf("index-detail"));
      expect(detail).not.toContain("revises");
      expect(classText(detail, "tool")).toEqual(["none"]);
      expect(detail).not.toContain("schema");
    });

    it("renders the error a refused read reported, and no reading notice", async () => {
      const calls = heldIndex();
      const view = new TestIndexView();
      view.patterns = [listed()];

      const opened = clickRow(view, "Reads donut orders");
      calls[0].answer(refused("no such pattern"));
      await opened;

      const detail = view.text().slice(view.text().indexOf("index-detail"));
      expect(view.open).toEqual({
        patternId: "pat-1",
        error: "no such pattern",
      });
      expect(classText(detail, "bad", "p")).toEqual(["no such pattern"]);
      expect(detail).not.toContain("Reading…");
    });

    it("closes the open row when it is clicked again, without reading it", async () => {
      const calls = heldIndex();
      const view = new TestIndexView();
      view.patterns = [listed()];
      const opened = clickRow(view, "Reads donut orders");
      calls[0].answer(Response.json(detailed()));
      await opened;

      await clickRow(view, "Reads donut orders");

      expect(calls).toHaveLength(1);
      expect(view.open).toBeUndefined();
      expect(view.text()).not.toContain("index-detail");
    });

    it("leaves a row closed when its read answers after it was closed", async () => {
      const calls = heldIndex();
      const view = new TestIndexView();
      view.patterns = [listed()];
      const opened = clickRow(view, "Reads donut orders");

      await clickRow(view, "Reads donut orders");
      calls[0].answer(Response.json(detailed()));
      await opened;

      expect(view.open).toBeUndefined();
    });

    it("keeps the row opened last when an earlier row's read answers after it", async () => {
      const calls = heldIndex();
      const view = new TestIndexView();
      view.patterns = [
        listed({ patternId: "pat-1", description: "First" }),
        listed({ patternId: "pat-2", description: "Second" }),
      ];
      const first = clickRow(view, "First");
      const second = clickRow(view, "Second");

      calls[1].answer(
        Response.json(detailed({ patternId: "pat-2", handle: "p-second" })),
      );
      await second;
      calls[0].answer(Response.json(detailed({ handle: "p-first" })));
      await first;

      expect(view.open?.patternId).toBe("pat-2");
      expect(view.open?.pattern?.handle).toBe("p-second");
    });
  });

  describe("copying an identifier", () => {
    afterEach(() => {
      Reflect.deleteProperty(navigator, "clipboard");
    });

    it("copies the whole identifier, says so in the cell, and does not open the row", () => {
      const written: string[] = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            written.push(text);
            return Promise.resolve();
          },
        },
      });
      const view = new TestIndexView();
      view.patterns = [listed({ patternId: "pat-0123456789abcdef" })];
      let stopped = false;

      handlerOn(view.view(), "@click", "pat-012345…", "button")({
        stopPropagation: () => {
          stopped = true;
        },
      });

      expect(written).toEqual(["pat-0123456789abcdef"]);
      expect(stopped).toBe(true);
      expect(view.copied).toBe("pat-0123456789abcdef");
      expect(view.open).toBeUndefined();
      expect(view.text()).toContain("copied");
      expect(view.text()).not.toContain("pat-012345…");
    });

    it("marks the copied cell where the page has no clipboard to write to", () => {
      const view = new TestIndexView();
      view.patterns = [listed()];

      handlerOn(view.view(), "@click", "p-a1b2c3d4e5", "button")({
        stopPropagation: () => {},
      });

      // Only the cell that was clicked changes its label.
      expect(view.copied).toBe("p-a1b2c3d4e5");
      expect(bindingOn(view.view(), "title", "copied")).toBe("p-a1b2c3d4e5");
      expect(bindingOn(view.view(), "title", "pat-1", "button")).toBe("pat-1");
    });
  });

  describe("search", () => {
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    /** A view whose search boxes hold `fields`, keyed by selector. */
    const searchView = (fields: Record<string, string>): TestIndexView => {
      const view = new TestIndexView();
      Object.defineProperty(view, "querySelector", {
        value: (selector: string) =>
          selector in fields ? { value: fields[selector] } : null,
      });
      return view;
    };

    const clickSearch = (view: TestIndexView): unknown =>
      handlerOn(view.view(), "@click", "Search", "button")();

    it("renders a notice that no query has run, and a dash for the request", () => {
      const text = new TestIndexView().text();

      expect(text).toContain("No query has been run yet.");
      expect(classText(text, "raw", "pre")).toEqual(["—"]);
    });

    it("sends the request the boxes compose and renders it beside the hits", async () => {
      const calls = heldIndex();
      const view = searchView({
        "#index-tags": "food, orders",
        "#index-text": " donuts ",
        "#index-limit": "5",
      });

      const searched = clickSearch(view);
      calls[0].answer(Response.json({
        results: [
          hit({
            hashtags: ["food"],
            matchedTerms: 1,
            queryTerms: 2,
            signals: { uses: 9, score: 0 },
          }),
          hit({ patternId: "pat-other", description: "Counts bagels" }),
        ],
      }));
      await searched;

      const request = { tags: ["food", "orders"], text: "donuts", limit: 5 };
      expect(calls[0].fn).toBe("searchPatterns");
      expect(calls[0].body).toEqual(request);
      expect(view.searchRequest).toBe(JSON.stringify(request, null, 2));
      expect(tableRows(view.text(), "uses")).toEqual([
        {
          match: "1/2",
          pattern: "pat-hit",
          description: "Counts donuts",
          hashtags: "#food",
          uses: "9",
        },
        {
          match: "—",
          pattern: "pat-other",
          description: "Counts bagels",
          hashtags: "",
          uses: "0",
        },
      ]);
      expect(classText(view.text(), "index-tag")).toEqual(["#food"]);
    });

    it("sends an empty request when the boxes are missing", async () => {
      const calls = heldIndex();
      const view = searchView({});

      const searched = clickSearch(view);
      calls[0].answer(Response.json({ results: [] }));
      await searched;

      expect(calls[0].body).toEqual({});
      expect(view.text()).toContain("No pattern matched.");
    });

    it("disables Search and refuses a second click while a search is in flight", async () => {
      const calls = heldIndex();
      const view = searchView({ "#index-text": "donuts" });

      const searched = clickSearch(view);
      expect(view.searching).toBe(true);
      expect(bindingOn(view.view(), "?disabled", "Search")).toBe(true);
      await clickSearch(view);
      expect(calls).toHaveLength(1);
      calls[0].answer(Response.json({ results: [] }));
      await searched;

      expect(view.searching).toBe(false);
      expect(bindingOn(view.view(), "?disabled", "Search")).toBe(false);
    });

    it("renders the error a refused search reported, and drops the earlier hits", async () => {
      const calls = heldIndex();
      const view = searchView({ "#index-text": "donuts" });
      view.searchResults = [hit()];

      const searched = clickSearch(view);
      calls[0].answer(refused("search failed"));
      await searched;

      expect(view.searchResults).toBeUndefined();
      expect(classText(view.text(), "bad", "p")).toEqual(["search failed"]);
      expect(view.text()).not.toContain("Counts donuts");
      expect(view.searching).toBe(false);
    });

    it("clears an earlier search error when a later search answers", async () => {
      const calls = heldIndex();
      const view = searchView({ "#index-text": "donuts" });
      view.searchError = "search failed";

      const searched = clickSearch(view);
      calls[0].answer(Response.json({ results: [hit()] }));
      await searched;

      expect(view.searchError).toBeUndefined();
      expect(view.text()).toContain("Counts donuts");
    });
  });
});
