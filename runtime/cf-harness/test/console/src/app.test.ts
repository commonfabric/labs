import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  ConsoleApp,
  consolePieceAfterTurn,
  freshConsoleRun,
  runTree,
} from "../../../console/src/app.ts";
import type {
  ConsoleListedRun,
  ConsoleRunSource,
} from "../../../console/run-store.ts";
import type { ConsoleFlow } from "../../../console/flow.ts";
import type {
  ConsoleChatEventEnvelope,
  ConsoleChatStructuredEvent,
} from "../../../console/turn-result.ts";
import {
  DEFAULT_HARNESS_CHAT_CAPABILITIES,
  DEFAULT_HARNESS_CHAT_POLICY,
  HARNESS_CHAT_EVENT_TYPE,
  HARNESS_CHAT_PROTOCOL_VERSION,
  type HarnessChatSessionStatus,
} from "../../../src/contracts/interactive-chat.ts";
import { BROWSER_SUBAGENT_PROFILE } from "../../../src/contracts/subagent.ts";
import { handlerOn, templateText } from "./lit-template.ts";

/** A row with the fields that decide which run a turn opens. */
const row = (
  runId: string,
  source: ConsoleRunSource,
  parentRunId?: string,
  overrides: Partial<ConsoleListedRun> = {},
): ConsoleListedRun => ({
  runId,
  source,
  parentRunId,
  status: "running",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  toolCallCount: 0,
  pieceSlugs: [],
  ...overrides,
});

/** The app, rendered on demand rather than into a DOM. */
class TestConsoleApp extends ConsoleApp {
  #waiting: { done: () => boolean; resolve: () => void }[] = [];

  rendered() {
    return this.render();
  }

  /** The rendered text, spaces folded. */
  text(): string {
    return templateText(this.rendered()).replace(/\s+/g, " ");
  }

  /** Calls the handler bound as `name` on the element whose text holds `text`. */
  fire(name: string, text = "", event?: unknown): unknown {
    return handlerOn(this.rendered(), name, text)(event);
  }

  /**
   * Committing a render needs a DOM. Lit runs `willUpdate` on the way to a
   * commit, and that is where the app reacts to a run being opened, so it
   * runs here and the commit is dropped.
   */
  protected override shouldUpdate(changed: Map<string, unknown>): boolean {
    this.willUpdate(changed);
    return false;
  }

  /**
   * Resolves once `done` holds. Every change the app makes is a property
   * write, so `done` is checked at each one rather than on a clock.
   */
  until(done: () => boolean): Promise<void> {
    if (done()) {
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#waiting.push({ done, resolve });
    return promise;
  }

  override requestUpdate(
    name?: PropertyKey,
    oldValue?: unknown,
    options?: never,
  ): void {
    super.requestUpdate(name, oldValue, options);
    // The base constructor writes properties before this subclass's own
    // fields are installed.
    if (!(#waiting in this)) {
      return;
    }
    this.#waiting = this.#waiting.filter((waiter) => {
      if (!waiter.done()) {
        return true;
      }
      waiter.resolve();
      return false;
    });
  }
}

/** One `EventSource` the test drives instead of a server. */
class FakeEventSource {
  static readonly CLOSED = 2;
  static opened: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  readonly listeners = new Map<string, (event: unknown) => void>();

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }

  addEventListener(kind: string, listener: (event: unknown) => void) {
    this.listeners.set(kind, listener);
  }

  close() {
    this.closed = true;
  }

  /** Delivers one event the way the server's `chat` frame does. */
  deliver(sequence: number, event: ConsoleChatStructuredEvent) {
    const envelope: ConsoleChatEventEnvelope = {
      type: HARNESS_CHAT_EVENT_TYPE,
      protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
      sessionId: "session-1",
      turnId: "turn-1",
      sequence,
      emittedAt: "2026-01-01T00:00:00.000Z",
      event,
    };
    this.listeners.get("chat")?.({ data: JSON.stringify(envelope) });
  }

  fail(readyState: number) {
    this.readyState = readyState;
    this.listeners.get("error")?.({});
  }
}

type Answer = () => Response | Promise<Response>;

/** The console server's routes, as much of them as a test stands up. */
class FakeServer {
  readonly requests: { path: string; body: unknown }[] = [];
  readonly #routes = new Map<string, Answer>();
  #waiting: { path: string; count: number; resolve: () => void }[] = [];

  route(path: string, answer: Answer): void {
    this.#routes.set(path, answer);
  }

  count(path: string): number {
    return this.requests.filter((request) => request.path === path).length;
  }

  bodies(path: string): unknown[] {
    return this.requests.filter((request) => request.path === path).map((
      request,
    ) => request.body);
  }

  /** Resolves once `path` has been asked for `count` times. */
  asked(path: string, count = 1): Promise<void> {
    if (this.count(path) >= count) {
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#waiting.push({ path, count, resolve });
    return promise;
  }

  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const path = String(input);
    this.requests.push({
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    this.#waiting = this.#waiting.filter((waiter) => {
      if (this.count(waiter.path) < waiter.count) {
        return true;
      }
      waiter.resolve();
      return false;
    });
    const answer = this.#routes.get(path);
    return Promise.resolve(
      answer === undefined
        ? new Response(`no route for ${path}`, { status: 404 })
        : answer(),
    );
  }
}

/** Puts `value` at `globalThis[name]`, and returns how to put it back. */
const stand = (name: string, value: unknown): () => void => {
  const real = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
  return () => {
    if (real === undefined) {
      Reflect.deleteProperty(globalThis, name);
    } else {
      Object.defineProperty(globalThis, name, real);
    }
  };
};

const flowOf = (text: string): ConsoleFlow => ({
  turns: [{ step: 0, text, nodes: [] }],
  failures: 0,
  denials: 0,
  unwiredPatterns: 0,
});

const sessionStatus = (activeTurnId?: string): HarnessChatSessionStatus => ({
  sessionId: "session-1",
  status: activeTurnId === undefined ? "idle" : "turn_running",
  reusable: true,
  turnCount: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  activeTurnId,
  capabilities: DEFAULT_HARNESS_CHAT_CAPABILITIES,
  policy: DEFAULT_HARNESS_CHAT_POLICY,
});

const TURN_STARTED: ConsoleChatStructuredEvent = {
  kind: "turn_started",
  turn: {
    turnId: "turn-1",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

const TOOL_COMPLETED: ConsoleChatStructuredEvent = {
  kind: "tool_completed",
  tool: { toolCallId: "call-1", toolId: "run_pattern" },
  status: "completed",
};

/**
 * The app connected at an address, against a fake server and stream, with
 * the two elements it looks up in its own markup stood in for.
 */
const appAt = (search: string, server: FakeServer) => {
  FakeEventSource.opened = [];
  const replaced: string[] = [];
  const location = { pathname: "/", search, href: `/${search}` };
  const restores = [
    stand("location", location),
    stand("history", {
      replaceState: (_data: unknown, _unused: string, url: string) => {
        replaced.push(url);
      },
    }),
    stand("EventSource", FakeEventSource),
    stand(
      "fetch",
      (input: string | URL | Request, init?: RequestInit) =>
        server.fetch(input, init),
    ),
  ];
  const task = { value: "" };
  const runView = {
    refreshes: 0,
    refresh(): Promise<void> {
      this.refreshes += 1;
      return Promise.resolve();
    },
  };
  const view = new TestConsoleApp();
  Object.defineProperty(view, "querySelector", {
    value: (selector: string) =>
      selector === "#task"
        ? task
        : selector === "console-run-view"
        ? runView
        : null,
  });
  const before = view.runs;
  const listed = view.until(() =>
    view.runs !== before || view.error !== undefined
  );
  view.connectedCallback();
  return {
    view,
    task,
    runView,
    replaced,
    location,
    /** Resolves once the first read of the run list has landed. */
    listed,
    /** Resolves at the next write of the run list. */
    relisted: () => {
      const now = view.runs;
      return view.until(() => view.runs !== now);
    },
    stream: () => FakeEventSource.opened.at(-1)!,
    [Symbol.dispose]: () => {
      view.disconnectedCallback();
      for (const restore of restores) restore();
    },
  };
};

/** A server whose run list is `runs`, and whose maps are `flows`. */
const serving = (
  runs: readonly ConsoleListedRun[] = [],
  flows: Record<string, ConsoleFlow> = {},
): FakeServer => {
  const server = new FakeServer();
  server.route("/api/runs", () => Response.json({ runs }));
  for (const [runId, flow] of Object.entries(flows)) {
    server.route(`/api/runs/${runId}/flow`, () => Response.json(flow));
  }
  return server;
};

describe("console/src/app", () => {
  describe("runTree()", () => {
    it("nests each child under its parent, ordered by run id", () => {
      const tree = runTree([
        row("run-a", "console"),
        row("run-a.2", "console", "run-a"),
        row("run-b", "ask"),
        row("run-a.1", "console", "run-a"),
      ]);

      expect(tree.map((node) => node.run.runId)).toEqual(["run-a", "run-b"]);
      expect(tree[0].children.map((node) => node.run.runId)).toEqual([
        "run-a.1",
        "run-a.2",
      ]);
      expect(tree[1].children).toEqual([]);
    });

    it("keeps a child whose parent is not listed at the top level", () => {
      expect(
        runTree([row("run-a.1", "console", "run-a")]).map((node) =>
          node.run.runId
        ),
      ).toEqual(["run-a.1"]);
    });
  });

  describe("consolePieceAfterTurn()", () => {
    const piece = (slug: string) => ({
      slug,
      url: `http://localhost:8000/did:key:z6MkApp/${slug}`,
    });

    it("returns the last piece a turn named", () => {
      expect(
        consolePieceAfterTurn(
          [piece("draft"), piece("final")],
          piece("earlier"),
        ),
      ).toEqual(piece("final"));
    });

    it("keeps the piece already shown when a turn named none", () => {
      expect(consolePieceAfterTurn([], piece("earlier"))).toEqual(
        piece("earlier"),
      );
      expect(consolePieceAfterTurn([], undefined)).toBeUndefined();
    });
  });

  describe("freshConsoleRun()", () => {
    it("opens a new console parent while external runs and children appear first", () => {
      const runs = [
        row("asked", "ask"),
        row("agent", "agent"),
        row("old", "console"),
        row("child", "console", "parent"),
        row("fresh", "console"),
      ];
      expect(freshConsoleRun(runs, new Set(["old"]))?.runId).toBe("fresh");
    });

    it("leaves the run closed when only external runs, children and existing parents are present", () => {
      expect(
        freshConsoleRun([
          row("asked", "ask"),
          row("agent", "agent"),
          row("old", "console"),
          row("child", "console", "old"),
        ], new Set(["old"])),
      ).toBeUndefined();
      expect(freshConsoleRun([], new Set())).toBeUndefined();
    });
  });

  describe("ConsoleApp", () => {
    it("registers itself as console-app", () => {
      expect(customElements.get("console-app")).toBe(ConsoleApp);
    });

    describe("run list", () => {
      it("draws the runs it lists, a child indented beneath its parent", async () => {
        using app = appAt(
          "",
          serving([
            row("run-a", "console", undefined, { title: "build a counter" }),
            row("run-a.1", "console", "run-a", { title: "style it" }),
          ]),
        );
        await app.listed;
        const text = app.view.text();

        expect(text).toContain("build a counter");
        expect(text).toContain("style it");
        expect(text.indexOf("build a counter")).toBeLessThan(
          text.indexOf("style it"),
        );
        expect(text).toContain("margin-left: 0rem");
        expect(text).toContain("margin-left: 0.75rem");
        expect(text).not.toContain("No run has been made yet.");
      });

      it("says no run has been made where the list is empty", async () => {
        using app = appAt("", serving());
        await app.listed;

        expect(app.view.text()).toContain("No run has been made yet.");
      });

      it("shows why the run list could not be read", async () => {
        const server = new FakeServer();
        server.route(
          "/api/runs",
          () => new Response("run store unreadable", { status: 500 }),
        );
        using app = appAt("", server);
        await app.listed;

        expect(app.view.error).toBe("run store unreadable");
        expect(app.view.text()).toContain(
          '<p class="empty bad">run store unreadable</p>',
        );
      });

      it("reads the list again when Refresh is clicked, clearing an earlier failure", async () => {
        const server = new FakeServer();
        server.route(
          "/api/runs",
          () => new Response("run store unreadable", { status: 500 }),
        );
        using app = appAt("", server);
        await app.listed;
        server.route(
          "/api/runs",
          () => Response.json({ runs: [row("run-a", "console")] }),
        );
        const relisted = app.relisted();
        app.view.fire("@click", "Refresh");
        await relisted;

        expect(app.view.runs.map((run) => run.runId)).toEqual(["run-a"]);
        expect(app.view.error).toBeUndefined();
      });

      it("labels a run another surface made, and not one the console made", async () => {
        using app = appAt(
          "",
          serving([
            row("run-a", "ask"),
            row("run-b", "agent"),
            row("run-c", "console"),
          ]),
        );
        await app.listed;
        const text = app.view.text();

        expect(text).toContain('<span class="run-source">/ask</span>');
        expect(text).toContain('<span class="run-source">agent()</span>');
        expect(text.match(/run-source/g)).toHaveLength(2);
      });

      it("marks a failed run bad, a completed run ok, and a canceled run neither", async () => {
        using app = appAt(
          "",
          serving([
            row("run-a", "console", undefined, { status: "failed" }),
            row("run-b", "console", undefined, { status: "completed" }),
            row("run-c", "console", undefined, { status: "canceled" }),
          ]),
        );
        await app.listed;
        const text = app.view.text();

        expect(text).toContain("class=bad > failed");
        expect(text).toContain("class=ok > completed");
        expect(text).toContain("class= > canceled");
      });

      it("counts a run's calls and the pieces it named", async () => {
        using app = appAt(
          "",
          serving([
            row("run-a", "console", undefined, {
              toolCallCount: 1,
              pieceSlugs: ["counter"],
            }),
            row("run-b", "console", undefined, { toolCallCount: 2 }),
          ]),
        );
        await app.listed;
        const text = app.view.text();

        expect(text).toContain("· 1 call ·");
        expect(text).toContain("· 2 calls");
        expect(text.match(/ piece</g)).toHaveLength(1);
        expect(text).toContain('<span class="ok">1 piece</span>');
      });
    });

    describe("surface", () => {
      it("shows the runs, and no session controls, at an address naming nothing", async () => {
        using app = appAt("", serving());
        await app.listed;
        const text = app.view.text();

        expect(app.view.view).toBe("console");
        // Light DOM, where the page's stylesheet reaches it.
        expect(app.view.renderRoot).toBe(app.view);
        expect(text).toContain('id="task"');
        expect(text).toContain("Start");
        expect(text).not.toContain("New session");
        expect(FakeEventSource.opened).toHaveLength(0);
      });

      it("opens on the Index view its address names", async () => {
        using app = appAt("?view=index", serving());
        await app.listed;
        const text = app.view.text();

        expect(app.view.view).toBe("index");
        expect(text).toContain("<console-index-view></console-index-view>");
        expect(text).not.toContain('id="task"');
        expect(text).toMatch(/class="tab on"[^<]*Index/);
        expect(text).not.toMatch(/class="tab on"[^<]*Runs/);
      });

      it("records the Index view and the session in the address when switching to it", async () => {
        using app = appAt("?sessionId=session-1", serving());
        await app.listed;
        app.view.fire("@click", "Index");

        expect(app.view.view).toBe("index");
        expect(app.replaced).toEqual(["?sessionId=session-1&view=index"]);
      });

      it("returns to the bare address when switching back with no session", async () => {
        using app = appAt("?view=index", serving());
        await app.listed;
        app.view.fire("@click", "Runs");

        expect(app.view.view).toBe("console");
        expect(app.replaced).toEqual(["/"]);
      });

      it("leaves the session's address for a fresh page on New session", async () => {
        using app = appAt("?sessionId=session-1", serving());
        await app.listed;
        app.view.fire("@click", "New session");

        expect(app.location.href).toBe("/");
      });
    });

    describe("live stream", () => {
      it("subscribes to the session its address names, from the first event", async () => {
        using app = appAt("?sessionId=session-1", serving());
        await app.listed;

        expect(app.view.sessionId).toBe("session-1");
        expect(FakeEventSource.opened.map((stream) => stream.url)).toEqual([
          "/api/events?sessionId=session-1&afterSequence=0",
        ]);
        expect(app.view.text()).toContain("Send");
      });

      it("opens no stream for an address with an empty session", async () => {
        using app = appAt("?sessionId=", serving());
        await app.listed;

        expect(app.view.sessionId).toBeUndefined();
        expect(FakeEventSource.opened).toHaveLength(0);
      });

      it("closes the stream when the page goes away", async () => {
        const server = serving();
        const app = appAt("?sessionId=session-1", server);
        await app.listed;
        const stream = app.stream();
        app[Symbol.dispose]();

        expect(stream.closed).toBe(true);
      });

      it("reports a turn as working once it starts", async () => {
        using app = appAt("?sessionId=session-1", serving());
        await app.listed;
        app.stream().deliver(1, TURN_STARTED);

        expect(app.view.turnId).toBe("turn-1");
        expect(app.view.running).toBe(true);
        expect(app.view.text()).toContain('<span id="state"> working </span>');
      });

      it("shows the call a running turn is making in place of its state", async () => {
        using app = appAt("?sessionId=session-1", serving());
        await app.listed;
        app.stream().deliver(1, TURN_STARTED);
        app.stream().deliver(2, {
          kind: "tool_started",
          tool: { toolCallId: "call-1", toolId: "run_pattern" },
        });

        expect(app.view.text()).toContain(
          '<span id="state"> calling run_pattern </span>',
        );
      });

      it("shows the profile a running turn delegated to", async () => {
        using app = appAt("?sessionId=session-1", serving());
        await app.listed;
        app.stream().deliver(1, TURN_STARTED);
        app.stream().deliver(2, {
          kind: "subagent_started",
          subagent: {
            parentToolCallId: "call-1",
            profile: BROWSER_SUBAGENT_PROFILE,
          },
        });

        expect(app.view.text()).toContain(
          `<span id="state"> delegating to ${BROWSER_SUBAGENT_PROFILE} </span>`,
        );
      });

      it("shows the state rather than an activity when no turn is running", async () => {
        using app = appAt("?sessionId=session-1", serving());
        await app.listed;
        app.stream().deliver(1, {
          kind: "tool_started",
          tool: { toolCallId: "call-1", toolId: "run_pattern" },
        });

        expect(app.view.activity).toBe("calling run_pattern");
        expect(app.view.text()).toContain('<span id="state"> idle </span>');
      });

      it("opens the turn's own run once a call completes, and re-reads what is open", async () => {
        const server = serving([], { "run-new": flowOf("build a counter") });
        using app = appAt("?sessionId=session-1", server);
        await app.listed;
        server.route("/api/runs", () =>
          Response.json({
            runs: [
              row("run-asked", "ask"),
              row("run-new", "console"),
            ],
          }));
        app.stream().deliver(1, TURN_STARTED);
        app.stream().deliver(2, TOOL_COMPLETED);

        expect(app.view.activity).toBe("run_pattern completed");
        await app.view.until(() => app.view.openRunId === "run-new");
        expect(app.runView.refreshes).toBe(1);
        await app.view.until(() => app.view.flow !== undefined);
        expect(app.view.flow).toEqual(flowOf("build a counter"));
      });

      it("keeps the run a reader opened when a call completes", async () => {
        const server = serving([row("run-a", "console")], {
          "run-a": flowOf("build a counter"),
        });
        using app = appAt("?sessionId=session-1", server);
        await app.listed;
        app.view.fire("@click", "run-a");
        server.route("/api/runs", () =>
          Response.json({
            runs: [row("run-a", "console"), row("run-new", "console")],
          }));
        const relisted = app.relisted();
        app.stream().deliver(1, TOOL_COMPLETED);
        await relisted;

        expect(app.view.openRunId).toBe("run-a");
      });

      it("raises the piece a completed turn named and reports it done", async () => {
        using app = appAt("?sessionId=session-1", serving());
        await app.listed;
        app.stream().deliver(1, TURN_STARTED);
        const relisted = app.relisted();
        app.stream().deliver(2, {
          kind: "turn_completed",
          turnId: "turn-1",
          result: {
            outcome: "completed",
            sessionId: "session-1",
            continuable: true,
            looms: [],
            pieces: [{
              slug: "counter",
              url: "http://localhost:8000/did:key:z6MkApp/counter",
            }],
            spaceName: "console-test",
            finalText: "built it",
          },
        });
        await relisted;
        const text = app.view.text();

        expect(app.view.running).toBe(false);
        expect(app.view.activity).toBeUndefined();
        expect(text).toContain('<span id="state"> done </span>');
        expect(text).toContain(
          'href=http://localhost:8000/did:key:z6MkApp/counter rel="noopener"',
        );
        expect(text).toContain(
          "counter — http://localhost:8000/did:key:z6MkApp/counter",
        );
      });

      it("raises no piece before a turn names one", async () => {
        using app = appAt("?sessionId=session-1", serving());
        await app.listed;

        expect(app.view.text()).not.toContain("Open your piece");
      });

      it("reports a canceled turn canceled once the session says it stopped", async () => {
        using app = appAt("?sessionId=session-1", serving());
        await app.listed;
        app.stream().deliver(1, TURN_STARTED);
        app.stream().deliver(2, { kind: "turn_canceled", turnId: "turn-1" });

        expect(app.view.state).toBe("canceling");
        expect(app.view.running).toBe(true);

        const relisted = app.relisted();
        app.stream().deliver(3, {
          kind: "status_changed",
          session: sessionStatus(),
        });
        await relisted;

        expect(app.view.state).toBe("canceled");
        expect(app.view.running).toBe(false);
      });

      it("reports a turn that stopped without a cancel idle", async () => {
        using app = appAt("?sessionId=session-1", serving());
        await app.listed;
        app.stream().deliver(1, TURN_STARTED);
        const relisted = app.relisted();
        app.stream().deliver(2, {
          kind: "status_changed",
          session: sessionStatus(),
        });
        await relisted;

        expect(app.view.state).toBe("idle");
        expect(app.view.running).toBe(false);
      });

      it("keeps a turn running while the session still names it active", async () => {
        const server = serving();
        using app = appAt("?sessionId=session-1", server);
        await app.listed;
        app.stream().deliver(1, TURN_STARTED);
        app.stream().deliver(2, {
          kind: "status_changed",
          session: sessionStatus("turn-1"),
        });

        expect(app.view.state).toBe("working");
        expect(app.view.running).toBe(true);
        expect(server.count("/api/runs")).toBe(1);
      });

      it("ignores a status change when no turn is running", async () => {
        const server = serving();
        using app = appAt("?sessionId=session-1", server);
        await app.listed;
        app.stream().deliver(1, {
          kind: "status_changed",
          session: sessionStatus(),
        });

        expect(app.view.state).toBe("idle");
        expect(server.count("/api/runs")).toBe(1);
      });

      it("reports a failed turn failed", async () => {
        using app = appAt("?sessionId=session-1", serving());
        await app.listed;
        app.stream().deliver(1, TURN_STARTED);
        const relisted = app.relisted();
        app.stream().deliver(2, {
          kind: "turn_failed",
          turnId: "turn-1",
          error: { code: "internal_error", message: "model unreachable" },
        });
        await relisted;

        expect(app.view.state).toBe("failed");
        expect(app.view.running).toBe(false);
      });

      it("resumes a closed stream from the last event, whatever its kind", async () => {
        using app = appAt("?sessionId=session-1", serving());
        await app.listed;
        app.stream().deliver(7, { kind: "session_closed" });

        expect(app.view.state).toBe("idle");

        app.stream().fail(FakeEventSource.CLOSED);

        expect(FakeEventSource.opened.map((stream) => stream.url)).toEqual([
          "/api/events?sessionId=session-1&afterSequence=0",
          "/api/events?sessionId=session-1&afterSequence=7",
        ]);
        expect(FakeEventSource.opened[0].closed).toBe(true);
      });

      it("holds a stream that reports an error it has not closed over", async () => {
        using app = appAt("?sessionId=session-1", serving());
        await app.listed;
        app.stream().fail(0);

        expect(FakeEventSource.opened).toHaveLength(1);
      });
    });

    describe("starting a task", () => {
      it("starts the task in a new session and follows it", async () => {
        const server = serving();
        server.route(
          "/api/task",
          () => Response.json({ sessionId: "session-9", turnId: "turn-9" }),
        );
        using app = appAt("", server);
        await app.listed;
        app.task.value = "  build a counter  ";
        await app.view.fire("@click", "Start");

        expect(server.bodies("/api/task")).toEqual([
          { text: "build a counter" },
        ]);
        expect(app.task.value).toBe("");
        expect(app.view.sessionId).toBe("session-9");
        expect(app.view.turnId).toBe("turn-9");
        expect(app.view.state).toBe("starting");
        expect(app.view.running).toBe(true);
        expect(app.replaced).toEqual(["?sessionId=session-9"]);
        expect(FakeEventSource.opened.map((stream) => stream.url)).toEqual([
          "/api/events?sessionId=session-9&afterSequence=0",
        ]);
      });

      it("drops the piece an earlier session raised when starting a new one", async () => {
        const server = serving();
        server.route(
          "/api/task",
          () => Response.json({ sessionId: "session-9", turnId: "turn-9" }),
        );
        using app = appAt("", server);
        await app.listed;
        app.view.piece = { slug: "old", url: "http://localhost:8000/x/old" };
        app.task.value = "build a counter";
        await app.view.fire("@click", "Start");

        expect(app.view.piece).toBeUndefined();
      });

      it("sends the task to the session the page already follows", async () => {
        const server = serving();
        server.route(
          "/api/task",
          () => Response.json({ sessionId: "session-1", turnId: "turn-2" }),
        );
        using app = appAt("?sessionId=session-1", server);
        await app.listed;
        const piece = { slug: "counter", url: "http://localhost:8000/x/c" };
        app.view.piece = piece;
        app.task.value = "now make it blue";
        await app.view.fire("@click", "Send");

        expect(server.bodies("/api/task")).toEqual([
          { text: "now make it blue", sessionId: "session-1" },
        ]);
        expect(app.view.turnId).toBe("turn-2");
        expect(app.view.piece).toBe(piece);
        expect(app.replaced).toEqual([]);
        expect(FakeEventSource.opened).toHaveLength(1);
      });

      it("starts nothing for a blank task", async () => {
        const server = serving();
        using app = appAt("", server);
        await app.listed;
        app.task.value = "   ";
        await app.view.fire("@click", "Start");

        expect(server.count("/api/task")).toBe(0);
        expect(app.view.running).toBe(false);
        expect(app.view.state).toBe("idle");
      });

      it("starts one turn for a second click that lands before the first returns", async () => {
        const server = serving();
        const held = Promise.withResolvers<Response>();
        server.route("/api/task", () => held.promise);
        using app = appAt("", server);
        await app.listed;
        app.task.value = "build a counter";
        const first = app.view.fire("@click", "Start");
        await app.view.fire("@click", "Start");
        held.resolve(Response.json({ sessionId: "session-9", turnId: "t" }));
        await first;

        expect(server.count("/api/task")).toBe(1);
      });

      it("reports a start the server refused", async () => {
        const server = serving();
        server.route(
          "/api/task",
          () =>
            Response.json({ error: "no model configured" }, { status: 503 }),
        );
        using app = appAt("", server);
        await app.listed;
        app.task.value = "build a counter";
        await app.view.fire("@click", "Start");

        expect(app.view.running).toBe(false);
        expect(app.view.state).toBe("failed");
        expect(app.view.sessionId).toBeUndefined();
        expect(app.view.text()).toContain(
          '<p class="empty bad">no model configured</p>',
        );
      });

      it("opens the run that appears after the task started, not one listed before", async () => {
        const server = serving([row("run-old", "console")]);
        server.route(
          "/api/task",
          () => Response.json({ sessionId: "session-9", turnId: "turn-9" }),
        );
        using app = appAt("", server);
        await app.listed;
        app.task.value = "build a counter";
        await app.view.fire("@click", "Start");
        server.route("/api/runs", () =>
          Response.json({
            runs: [row("run-old", "console"), row("run-new", "console")],
          }));
        app.stream().deliver(1, TOOL_COMPLETED);
        await app.view.until(() => app.view.openRunId !== undefined);

        expect(app.view.openRunId).toBe("run-new");
      });
    });

    describe("canceling", () => {
      it("asks nothing of the server with no session to cancel in", async () => {
        const server = serving();
        using app = appAt("", server);
        await app.listed;
        await app.view.fire("@click", "Cancel");

        expect(server.count("/api/cancel")).toBe(0);
        expect(app.view.state).toBe("idle");
      });

      it("asks the server to stop the running turn", async () => {
        const server = serving();
        server.route("/api/cancel", () => Response.json({}));
        using app = appAt("?sessionId=session-1", server);
        await app.listed;
        app.stream().deliver(1, TURN_STARTED);
        const canceled = app.view.fire("@click", "Cancel");

        expect(app.view.state).toBe("canceling");
        await canceled;
        expect(server.bodies("/api/cancel")).toEqual([{
          sessionId: "session-1",
          turnId: "turn-1",
          reason: "canceled from the console page",
        }]);
        expect(app.view.state).toBe("canceling");
        expect(app.view.error).toBeUndefined();
      });

      it("goes back to the turn's state, saying why, when the cancel is refused", async () => {
        const server = serving();
        server.route(
          "/api/cancel",
          () => Response.json({ error: "no turn is running" }, { status: 404 }),
        );
        using app = appAt("?sessionId=session-1", server);
        await app.listed;
        app.stream().deliver(1, TURN_STARTED);
        await app.view.fire("@click", "Cancel");

        expect(app.view.state).toBe("working");
        expect(app.view.error).toBe("no turn is running");
      });
    });

    describe("map", () => {
      it("asks for a run to be chosen before one is open", async () => {
        using app = appAt("", serving([row("run-a", "console")]));
        await app.listed;
        const text = app.view.text();

        expect(text).toContain("Choose a run to see how it went.");
        expect(text).not.toContain("<console-flow-view");
      });

      it("reads and draws the map of the run a reader opens", async () => {
        const server = serving([row("run-a", "console")], {
          "run-a": flowOf("build a counter"),
        });
        using app = appAt("", server);
        await app.listed;
        app.view.fire("@click", "run-a");
        await app.view.until(() => app.view.flow !== undefined);
        const text = app.view.text();

        expect(app.view.openRunId).toBe("run-a");
        expect(app.view.flow).toEqual(flowOf("build a counter"));
        expect(app.view.flowLoading).toBe(false);
        expect(text).toContain('class="run open"');
        expect(text).toContain("<console-flow-view");
        expect(text).not.toContain("Choose a run");
      });

      it("opens the run the timeline asks for, and moves to the step it picks", async () => {
        const server = serving([], {
          "run-a": flowOf("build a counter"),
          "run-b": flowOf("style it"),
        });
        using app = appAt("", server);
        await app.listed;
        app.view.fire(
          "@open-run",
          "",
          new CustomEvent("open-run", { detail: "run-a" }),
        );
        await app.view.until(() => app.view.flow !== undefined);
        app.view.fire(
          "@step-selected",
          "",
          new CustomEvent("step-selected", { detail: 4 }),
        );

        expect(app.view.focusStep).toBe(4);

        // Opening another run starts its map, and its timeline, afresh.
        app.view.fire(
          "@open-run",
          "",
          new CustomEvent("open-run", { detail: "run-b" }),
        );
        await app.view.until(() => app.view.focusStep === undefined);
        expect(app.view.flow).toBeUndefined();
        await app.view.until(() => app.view.flow !== undefined);
        expect(app.view.flow).toEqual(flowOf("style it"));
      });

      it("opens a child run from its node in the map, and moves to a step of the open one", async () => {
        const server = serving([], {
          "run-a": flowOf("build a counter"),
          "run-a.1": flowOf("style it"),
        });
        using app = appAt("", server);
        await app.listed;
        app.view.openRunId = "run-a";
        await app.view.until(() => app.view.flow !== undefined);
        const select = (detail: { runId?: string; step: number }) =>
          app.view.fire(
            "@flow-selected",
            "",
            new CustomEvent("flow-selected", { detail }),
          );

        select({ runId: "run-a", step: 3 });
        expect(app.view.openRunId).toBe("run-a");
        expect(app.view.focusStep).toBe(3);

        select({ step: 0 });
        expect(app.view.focusStep).toBe(0);

        select({ runId: "run-a.1", step: 2 });
        expect(app.view.openRunId).toBe("run-a.1");
      });

      it("says why a map could not be read, and reads it again on Try again", async () => {
        const server = serving();
        server.route(
          "/api/runs/run-a/flow",
          () => Response.json({ error: "map unreadable" }, { status: 500 }),
        );
        using app = appAt("", server);
        await app.listed;
        app.view.openRunId = "run-a";
        await app.view.until(() => app.view.flowError !== undefined);

        expect(app.view.flowError).toBe("map unreadable");
        expect(app.view.text()).toContain(
          '<p class="empty bad">map unreadable</p>',
        );
        expect(app.view.text()).not.toContain("<console-flow-view");

        server.route(
          "/api/runs/run-a/flow",
          () => Response.json(flowOf("build a counter")),
        );
        app.view.fire("@click", "Try again");
        await app.view.until(() => app.view.flow !== undefined);

        expect(app.view.flowError).toBeUndefined();
        expect(app.view.text()).toContain("<console-flow-view");
      });

      it("starts no second read on Try again while one is in flight", async () => {
        const server = serving();
        server.route(
          "/api/runs/run-a/flow",
          () => Response.json({ error: "map unreadable" }, { status: 500 }),
        );
        using app = appAt("", server);
        await app.listed;
        app.view.openRunId = "run-a";
        await app.view.until(() => app.view.flowError !== undefined);
        const held = Promise.withResolvers<Response>();
        server.route("/api/runs/run-a/flow", () => held.promise);
        app.view.fire("@click", "Try again");
        app.view.fire("@click", "Try again");

        expect(server.count("/api/runs/run-a/flow")).toBe(2);

        held.resolve(Response.json(flowOf("build a counter")));
        await app.view.until(() => app.view.flow !== undefined);
      });

      it("draws the map of the run opened last when an earlier read lands late", async () => {
        const server = serving();
        const first = Promise.withResolvers<Response>();
        const second = Promise.withResolvers<Response>();
        server.route("/api/runs/run-a/flow", () => first.promise);
        server.route("/api/runs/run-b/flow", () => second.promise);
        using app = appAt("", server);
        await app.listed;
        app.view.openRunId = "run-a";
        await server.asked("/api/runs/run-a/flow");
        app.view.openRunId = "run-b";
        await server.asked("/api/runs/run-b/flow");
        const seen: { flow?: ConsoleFlow; loading: boolean }[] = [];
        const settled = app.view.until(() => {
          seen.push({ flow: app.view.flow, loading: app.view.flowLoading });
          return !app.view.flowLoading;
        });
        // The first read is answered first, so it is done with before the
        // second is: both answers take the same path through the app.
        first.resolve(Response.json(flowOf("build a counter")));
        second.resolve(Response.json(flowOf("style it")));
        await settled;

        expect(seen.map((entry) => entry.flow)).not.toContainEqual(
          flowOf("build a counter"),
        );
        expect(seen.find((entry) => !entry.loading)?.flow).toEqual(
          flowOf("style it"),
        );
      });

      it("shows no error from an earlier run's map once another is open", async () => {
        const server = serving();
        const first = Promise.withResolvers<Response>();
        const second = Promise.withResolvers<Response>();
        server.route("/api/runs/run-a/flow", () => first.promise);
        server.route("/api/runs/run-b/flow", () => second.promise);
        using app = appAt("", server);
        await app.listed;
        app.view.openRunId = "run-a";
        await server.asked("/api/runs/run-a/flow");
        app.view.openRunId = "run-b";
        await server.asked("/api/runs/run-b/flow");
        const errors: (string | undefined)[] = [];
        const settled = app.view.until(() => {
          errors.push(app.view.flowError);
          return app.view.flow !== undefined;
        });
        first.resolve(Response.json({ error: "gone" }, { status: 404 }));
        second.resolve(Response.json(flowOf("style it")));
        await settled;

        expect(errors).not.toContain("gone");
        expect(app.view.flowError).toBeUndefined();
      });
    });
  });
});
