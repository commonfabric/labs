import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { RequestType } from "@commonfabric/runtime-client";

import { Browser } from "../browser.ts";
import type { Page } from "../page.ts";
import {
  assertShellDocument,
  describeShellPage,
  readAndDescribeShellPage,
  readShellPageProbe,
  type ShellPageProbe,
} from "../shell-page-probe.ts";
import {
  describeStateWaitFailure,
  disposePageRuntime,
  login,
  waitForShellReady,
} from "../shell-utils.ts";
import { describeConditionWaitFailure, waitForCondition } from "../utils.ts";

// What the toolshed answers with when its fetch to the shell dev server fails.
const PROXY_FAILURE_TEXT =
  "Failed to proxy to http://localhost:6000/. Is the shell dev server running?";

// The part of the shell's entry document that matters here: a title, and the
// root element every shell wait afterwards depends on.
const SHELL_DOCUMENT = `<!DOCTYPE html>
<html><head><title>Common Fabric</title></head>
<body><x-root-view></x-root-view></body></html>`;

// The same document with the shell already booted far enough to have published
// itself, holding the home view and an identity named by its DID.
const BOOTED_SHELL_DOCUMENT = `<!DOCTYPE html>
<html><head><title>Common Fabric</title></head>
<body><x-root-view></x-root-view>
<script>
  globalThis.app = {
    serialize: () => ({
      view: { builtin: "home" },
      identityDid: "did:key:zBootedShellFixture",
    }),
  };
</script>
</body></html>`;

// A booted shell holding a runtime with two requests in flight, reported
// oldest first, which is the order the runtime keeps them in. The request
// types are the `RequestType` values a real report carries, which the
// assertions below name through the enum so that a change to either is caught
// here rather than diverging quietly.
//
// Its `dispose()` rejects, which is the cheapest way to reach the teardown's
// catch; what a teardown failure arrives as does not change what the catch
// then reports.
const UNRESPONSIVE_RUNTIME_DOCUMENT = `<!DOCTYPE html>
<html><head><title>Common Fabric</title></head>
<body><x-root-view></x-root-view>
<script>
  globalThis.app = {
    serialize: () => ({ view: { builtin: "home" }, identityDid: undefined }),
  };
  globalThis.commonfabric = {
    rt: {
      dispose: () => Promise.reject(new Error("the worker stopped answering")),
      getPendingRequests: () => [
        { msgId: 7, type: "dispose", ageMs: 41203 },
        { msgId: 9, type: "cell:subscribe", ageMs: 84 },
      ],
    },
  };
</script>
</body></html>`;

// A booted shell holding a runtime that answers: nothing is in flight, and a
// disposal returns.
const IDLE_RUNTIME_DOCUMENT = `<!DOCTYPE html>
<html><head><title>Common Fabric</title></head>
<body><x-root-view></x-root-view>
<script>
  globalThis.commonfabric = {
    rt: {
      dispose: () => Promise.resolve(),
      getPendingRequests: () => [],
      getLoggerCounts: () => Promise.resolve({ counts: { total: 0 } }),
    },
  };
</script>
</body></html>`;

// A booted shell whose runtime does not report what it is waiting on, and one
// whose report throws.
const SILENT_RUNTIME_DOCUMENT = `<!DOCTYPE html>
<html><head><title>Common Fabric</title></head>
<body><x-root-view></x-root-view>
<script>
  globalThis.commonfabric = { rt: {} };
</script>
</body></html>`;
const REFUSING_RUNTIME_DOCUMENT = `<!DOCTYPE html>
<html><head><title>Common Fabric</title></head>
<body><x-root-view></x-root-view>
<script>
  globalThis.commonfabric = {
    rt: {
      getPendingRequests: () => { throw new Error("the connection is gone"); },
    },
  };
</script>
</body></html>`;

// A booted shell whose runtime's worker has logged three kinds of warning or
// error, two of them with the same number of errors, and one message at `debug`
// only, which is neither. The counts are shaped as the worker
// reports them: by logger, then by message, with `total` beside each level.
const LOGGING_RUNTIME_DOCUMENT = `<!DOCTYPE html>
<html><head><title>Common Fabric</title></head>
<body><x-root-view></x-root-view>
<script>
  globalThis.commonfabric = {
    rt: {
      getPendingRequests: () => [],
      getLoggerCounts: () => Promise.resolve({
        counts: {
          total: 13,
          scheduler: {
            total: 2,
            "schedule-error": { debug: 0, info: 0, warn: 0, error: 2, total: 2 },
          },
          "storage.v2": {
            total: 5,
            "sync-load-failure": {
              debug: 0,
              info: 0,
              warn: 1,
              error: 3,
              total: 4,
            },
            "quiet": { debug: 1, info: 0, warn: 0, error: 0, total: 1 },
          },
          runner: {
            total: 6,
            "action-failed": { debug: 0, info: 0, warn: 4, error: 2, total: 6 },
          },
        },
      }),
    },
  };
</script>
</body></html>`;

// A booted shell whose runtime still reports its requests, but whose worker
// never answers the request for its logs, and one whose request is refused.
const WEDGED_WORKER_DOCUMENT = `<!DOCTYPE html>
<html><head><title>Common Fabric</title></head>
<body><x-root-view></x-root-view>
<script>
  globalThis.commonfabric = {
    rt: {
      getPendingRequests: () => [
        { msgId: 3, type: "runtime:getLoggerCounts", ageMs: 1200 },
      ],
      getLoggerCounts: () => new Promise(() => {}),
    },
  };
</script>
</body></html>`;
const REFUSING_WORKER_DOCUMENT = `<!DOCTYPE html>
<html><head><title>Common Fabric</title></head>
<body><x-root-view></x-root-view>
<script>
  globalThis.commonfabric = {
    rt: {
      getLoggerCounts: () => Promise.reject(new Error("the worker has gone")),
    },
  };
</script>
</body></html>`;

// A booted shell whose page answers until it is asked for the worker's logs,
// and then holds its main thread for good.
const WEDGING_WORKER_READ_DOCUMENT = `<!DOCTYPE html>
<html><head><title>Common Fabric</title></head>
<body><x-root-view></x-root-view>
<script>
  globalThis.commonfabric = {
    rt: {
      getPendingRequests: () => [],
      getLoggerCounts: () => {
        while (true) { /* hold the main thread */ }
      },
    },
  };
</script>
</body></html>`;

// A booted shell whose `setIdentity` refuses. The login reaches the page and
// fails there, which is the failure a report has to describe.
const REFUSING_SHELL_DOCUMENT = `<!DOCTYPE html>
<html><head><title>Common Fabric</title></head>
<body><x-root-view></x-root-view>
<script>
  globalThis.app = {
    state: () => ({}),
    serialize: () => ({ view: { builtin: "home" }, identityDid: undefined }),
    setIdentity: () => { throw new Error("the key store is not open"); },
  };
</script>
</body></html>`;

function handle(request: Request): Response {
  const { pathname } = new URL(request.url);
  switch (pathname) {
    case "/proxy-failure":
      return new Response(PROXY_FAILURE_TEXT, {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    case "/shell":
      return new Response(SHELL_DOCUMENT, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    case "/booted-shell":
      return new Response(BOOTED_SHELL_DOCUMENT, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    case "/refusing-shell":
      return new Response(REFUSING_SHELL_DOCUMENT, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    case "/unresponsive-runtime":
      return new Response(UNRESPONSIVE_RUNTIME_DOCUMENT, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    case "/idle-runtime":
      return new Response(IDLE_RUNTIME_DOCUMENT, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    case "/silent-runtime":
      return new Response(SILENT_RUNTIME_DOCUMENT, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    case "/refusing-runtime":
      return new Response(REFUSING_RUNTIME_DOCUMENT, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    case "/logging-runtime":
      return new Response(LOGGING_RUNTIME_DOCUMENT, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    case "/wedged-worker":
      return new Response(WEDGED_WORKER_DOCUMENT, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    case "/wedging-worker-read":
      return new Response(WEDGING_WORKER_READ_DOCUMENT, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    case "/refusing-worker":
      return new Response(REFUSING_WORKER_DOCUMENT, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
  }
  return new Response("not found", { status: 404 });
}

// `describeShellPage` rendered over a page holding nothing remarkable, split
// into its lines, with `fields` deciding what the case is about. The default
// carries a runtime, so a case about the absence of one says so.
function describedLines(fields: Partial<ShellPageProbe>): string[] {
  return describeShellPage({
    url: "http://localhost/shell",
    title: "Common Fabric",
    rootView: true,
    app: true,
    runtime: true,
    text: "",
    consoleTail: [],
    ...fields,
  }).split("\n");
}

// The message of the error `work` rejects with. Fails the test when it
// resolves, so a check on the message cannot pass vacuously.
async function rejectionMessage(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the call to throw, and it returned instead.");
}

/** The variable the wait reads its safety net's length from. */
const NET_VARIABLE = "CF_WAIT_FOR_CONDITION_TIMEOUT_MS";

// The stuck-condition safety net is five minutes, which no test can sit
// through. This drives it through the environment variable the wait reads for
// exactly that, and returns the message it gave up with. Everything past the
// first line of that message is what the wait assembles, which nothing else
// exercises.
async function shortNetRejectionMessage(
  work: () => Promise<unknown>,
): Promise<string> {
  // Put back whatever the run was started with, rather than removing it:
  // somebody running this file with a net of their own chose that, and a
  // test that dropped it would change every wait after itself.
  const before = Deno.env.get(NET_VARIABLE);
  Deno.env.set(NET_VARIABLE, "1500");
  try {
    return await rejectionMessage(work());
  } finally {
    if (before === undefined) Deno.env.delete(NET_VARIABLE);
    else Deno.env.set(NET_VARIABLE, before);
  }
}

describe("shell-failure-reports", () => {
  let server: Deno.HttpServer;
  let origin: string;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = Deno.serve({ port: 0, onListen: () => {} }, handle);
    origin = `http://localhost:${(server.addr as Deno.NetAddr).port}`;
    browser = await Browser.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await page.close();
    await browser.close();
    await server.shutdown();
  });

  // Loads `path` from the local server and installs the console formatter,
  // which is the state `ShellIntegration.goto` leaves a page in before it
  // starts waiting.
  const load = async (path: string): Promise<string> => {
    const url = `${origin}${path}`;
    await page.goto(url);
    await page.applyConsoleFormatter();
    return url;
  };

  describe("readShellPageProbe()", () => {
    it("returns the status and text of a document that is not the shell", async () => {
      await load("/proxy-failure");

      const probe = await readShellPageProbe(page);
      expect(probe.rootView).toBe(false);
      expect(probe.app).toBe(false);
      expect(probe.status).toBe(502);
      expect(probe.text).toBe(PROXY_FAILURE_TEXT);
    });

    it("returns the title and root element of the shell's own document", async () => {
      await load("/shell");

      const probe = await readShellPageProbe(page);
      expect(probe.rootView).toBe(true);
      expect(probe.title).toBe("Common Fabric");
      expect(probe.status).toBe(200);
      // Nothing has booted, so nothing has published `globalThis.app`.
      expect(probe.app).toBe(false);
    });

    it("returns the view and identity a booted shell holds", async () => {
      await load("/booted-shell");

      const probe = await readShellPageProbe(page);
      expect(probe.app).toBe(true);
      expect(probe.view).toEqual({ builtin: "home" });
      expect(probe.identityDid).toBe("did:key:zBootedShellFixture");
    });

    it("returns the requests the page's runtime is still waiting on", async () => {
      await load("/unresponsive-runtime");

      const probe = await readShellPageProbe(page);
      expect(probe.runtime).toBe(true);
      expect(probe.pendingRequests).toEqual([
        { msgId: 7, type: RequestType.Dispose, ageMs: 41203 },
        { msgId: 9, type: RequestType.CellSubscribe, ageMs: 84 },
      ]);
      expect(probe.pendingRequestsError).toBeUndefined();
    });

    it("returns an empty list for a runtime with nothing in flight", async () => {
      await load("/idle-runtime");

      const probe = await readShellPageProbe(page);
      expect(probe.runtime).toBe(true);
      // An empty list and an absent one are different answers, and the
      // boundary keeps them apart: a page's `undefined` property is dropped on
      // the way back, while an empty array survives as one.
      expect(probe.pendingRequests).toEqual([]);
    });

    it("returns no runtime for a page that carries none", async () => {
      await load("/booted-shell");

      const probe = await readShellPageProbe(page);
      expect(probe.runtime).toBe(false);
      expect(probe.pendingRequests).toBeUndefined();
    });

    it("returns a runtime that does not report its requests", async () => {
      await load("/silent-runtime");

      const probe = await readShellPageProbe(page);
      expect(probe.runtime).toBe(true);
      expect(probe.pendingRequests).toBeUndefined();
      expect(probe.pendingRequestsError).toBeUndefined();
    });

    it("returns the reason when the runtime refuses to report them", async () => {
      await load("/refusing-runtime");

      const probe = await readShellPageProbe(page);
      expect(probe.runtime).toBe(true);
      expect(probe.pendingRequests).toBeUndefined();
      expect(probe.pendingRequestsError).toContain("the connection is gone");
    });

    it("returns the worker's warnings and errors, most errors then most warnings first", async () => {
      await load("/logging-runtime");

      const probe = await readShellPageProbe(page);
      expect(probe.workerProblems).toEqual([
        {
          logger: "storage.v2",
          message: "sync-load-failure",
          warn: 1,
          error: 3,
        },
        { logger: "runner", message: "action-failed", warn: 4, error: 2 },
        { logger: "scheduler", message: "schedule-error", warn: 0, error: 2 },
      ]);
      expect(probe.workerProblemsError).toBeUndefined();
    });

    it("returns an empty list for a worker that has logged no warning or error", async () => {
      await load("/idle-runtime");

      const probe = await readShellPageProbe(page);
      expect(probe.workerProblems).toEqual([]);
    });

    it("returns no worker logs for a runtime that does not report them", async () => {
      await load("/silent-runtime");

      const probe = await readShellPageProbe(page);
      expect(probe.workerProblems).toBeUndefined();
      expect(probe.workerProblemsError).toBeUndefined();
    });

    it("returns the rest of the probe when the worker never answers", async () => {
      await load("/wedged-worker");

      const probe = await readShellPageProbe(page, { workerBudgetMs: 100 });
      expect(probe.workerProblems).toBeUndefined();
      expect(probe.workerProblemsError).toContain(
        "the worker did not answer within 100ms",
      );
      expect(probe.pendingRequests).toEqual([
        { msgId: 3, type: RequestType.GetLoggerCounts, ageMs: 1200 },
      ]);
    });

    it("returns the reason when the worker refuses to report its logs", async () => {
      await load("/refusing-worker");

      const probe = await readShellPageProbe(page);
      expect(probe.workerProblems).toBeUndefined();
      expect(probe.workerProblemsError).toContain("the worker has gone");
    });

    it("returns the page it read when the page stops answering during the worker read", async () => {
      // Its own browser, because the wedge below is permanent: the page's main
      // thread is held for good once the worker's logs are asked for.
      const wedged = await Browser.launch();
      try {
        const wedgedPage = await wedged.newPage(
          `${origin}/wedging-worker-read`,
        );
        const probe = await readShellPageProbe(wedgedPage, {
          workerBudgetMs: 100,
        });
        expect(probe.rootView).toBe(true);
        expect(probe.pendingRequests).toEqual([]);
        expect(probe.workerProblemsError).toContain(
          "the page did not answer within 10100ms",
        );
      } finally {
        await wedged.close();
      }
    });

    it("returns the console messages the page retained", async () => {
      await load("/booted-shell");
      await page.evaluate(() => {
        console.warn("the page said something before the wait gave up");
      });

      const probe = await readShellPageProbe(page);
      expect(probe.consoleTail.length).toBe(1);
      expect(probe.consoleTail[0]).toContain(
        "[warn] the page said something before the wait gave up",
      );
    });
  });

  describe("assertShellDocument()", () => {
    it("throws naming the document that loaded instead of the shell", async () => {
      const url = await load("/proxy-failure");

      const message = await rejectionMessage(assertShellDocument(page, url));
      expect(message).toContain(
        "the document that loaded is not the shell: it has no x-root-view",
      );
      expect(message).toContain("response status: 502");
      expect(message).toContain("globalThis.app: absent");
      expect(message).toContain(
        "document text: Failed to proxy to http://localhost:6000/",
      );
    });

    it("returns for the shell's own document", async () => {
      const url = await load("/shell");

      await assertShellDocument(page, url);
    });
  });

  describe("waitForShellReady()", () => {
    it("returns for a document that is not the shell", async () => {
      await load("/proxy-failure");

      await waitForShellReady(page);
    });

    it("returns for a shell that has published itself", async () => {
      await load("/booted-shell");

      await waitForShellReady(page);
    });

    it("names the shell whose bootstrap never published the handle", async () => {
      await load("/shell");

      const message = await shortNetRejectionMessage(() =>
        waitForShellReady(page)
      );
      expect(message).toBe(
        "The shell never published itself on globalThis.app.",
      );
    });

    it("waits for publication announced after an earlier readiness event", async () => {
      await load("/shell");
      await page.evaluate(() => {
        globalThis.setInterval = () => {
          throw new Error("The shell readiness wait must not poll.");
        };
        const target: EventTarget = globalThis;
        const add = target.addEventListener.bind(target);
        const remove = target.removeEventListener.bind(target);
        const listeners = new Set<EventListenerOrEventListenerObject>();
        let subscribed!: () => void;
        Object.defineProperty(globalThis, "shellReadinessSubscribed", {
          value: new Promise<void>((resolve) => subscribed = resolve),
        });
        target.addEventListener = (type, listener, options) => {
          add(type, listener, options);
          if (type === "cf-shell-ready" && listener) {
            listeners.add(listener);
            subscribed();
          }
        };
        target.removeEventListener = (type, listener, options) => {
          if (type === "cf-shell-ready" && listener) listeners.delete(listener);
          remove(type, listener, options);
        };
        Object.defineProperty(globalThis, "shellReadinessListeners", {
          get: () => listeners.size,
        });
      });

      const ready = waitForShellReady(page);
      await Promise.race([
        ready.then(() => {
          throw new Error("The shell was reported ready before publication.");
        }),
        page.evaluate(async () => {
          const fixture = globalThis as typeof globalThis & {
            shellReadinessSubscribed: Promise<void>;
          };
          await fixture.shellReadinessSubscribed;
        }),
      ]);

      await page.evaluate(() => {
        globalThis.dispatchEvent(new Event("cf-shell-ready"));
      });
      const beforePublication = await page.evaluate(() => {
        const fixture = globalThis as typeof globalThis & {
          shellReadinessListeners: number;
        };
        return {
          listeners: fixture.shellReadinessListeners,
          published: globalThis.app !== undefined,
        };
      });
      expect(beforePublication).toEqual({ listeners: 1, published: false });

      await page.evaluate(() => {
        globalThis.app = {
          serialize: () => ({ view: { builtin: "home" } }),
        } as typeof globalThis.app;
        globalThis.dispatchEvent(new Event("cf-shell-ready"));
      });
      await ready;

      const result = await page.evaluate(() => {
        const fixture = globalThis as typeof globalThis & {
          shellReadinessListeners: number;
        };
        return {
          listeners: fixture.shellReadinessListeners,
          view: globalThis.app.serialize().view,
        };
      });
      expect(result.view).toEqual({ builtin: "home" });
      expect(result.listeners).toBe(0);
    });
  });

  describe("describeConditionWaitFailure()", () => {
    it("returns a block naming the predicate, its arguments, and the page", async () => {
      await load("/booted-shell");

      const described = await describeConditionWaitFailure(
        page,
        "(probe, slug) => probe.collect(slug).length === 1",
        ["members-7"],
      );
      expect(described).toContain(
        "awaited condition: (probe, slug) => probe.collect(slug).length === 1",
      );
      expect(described).toContain('    [0] "members-7"');
      expect(described).toContain("x-root-view: present");
      expect(described).toContain("did:key:zBootedShellFixture");
    });

    it("gives each argument its own line, so shared predicates differ", async () => {
      await load("/shell");

      const described = await describeConditionWaitFailure(
        page,
        "(probe, ...rest) => rest",
        ["members-7", { member: "2" }],
      );
      expect(described).toContain("  condition arguments:\n");
      expect(described).toContain('    [0] "members-7"');
      expect(described).toContain('    [1] {"member":"2"}');
    });

    it("spells out the numbers JSON would render as something else", async () => {
      await load("/shell");

      // Rendered by JSON alone these read back as `null`, `null` and `0`,
      // so a wait told apart from its neighbours by one of them would be
      // told apart wrongly.
      const described = await describeConditionWaitFailure(
        page,
        "() => false",
        [NaN, Infinity, -0, { attempts: -Infinity }],
      );
      expect(described).toContain('    [0] "NaN"');
      expect(described).toContain('    [1] "Infinity"');
      expect(described).toContain('    [2] "-0"');
      expect(described).toContain('    [3] {"attempts":"-Infinity"}');
    });

    it("collapses a predicate written over several lines onto one", async () => {
      await load("/shell");

      const described = await describeConditionWaitFailure(
        page,
        "(probe) => {\n  return probe;\n}",
      );
      expect(described).toContain(
        "awaited condition: (probe) => { return probe; }",
      );
      expect(described).not.toContain("condition arguments:");
    });

    it("cuts a predicate at the length the report carries", async () => {
      await load("/shell");

      const described = await describeConditionWaitFailure(
        page,
        `() => ${"x".repeat(600)}`,
      );
      // Six characters of `() => ` precede the run, so the cut lands inside it.
      expect(described).toContain(`() => ${"x".repeat(394)}…\n`);
      expect(described).not.toContain("x".repeat(395));
    });

    it("cuts an argument at the same length", async () => {
      await load("/shell");

      const described = await describeConditionWaitFailure(
        page,
        "() => false",
        ["y".repeat(600)],
      );
      // A quote opens the rendered string, so 399 of the run reach the line.
      expect(described).toContain(`    [0] "${"y".repeat(399)}…`);
      expect(described).not.toContain("y".repeat(400));
    });
  });

  describe("waitForCondition()", () => {
    it("reports the predicate, its arguments, and the page it ran out against", async () => {
      await load("/booted-shell");

      const message = await shortNetRejectionMessage(() =>
        waitForCondition(page, (_probe, slug: string) => slug === "never", {
          args: ["members-7"],
        })
      );
      expect(message).toContain(
        "waitForCondition did not resolve within 1500ms.",
      );
      expect(message).toContain("awaited condition:");
      expect(message).toContain('    [0] "members-7"');
      expect(message).toContain("did:key:zBootedShellFixture");
      expect(message).not.toContain("predicate threw:");
    });

    it("names the throw a predicate made, which the page cannot show", async () => {
      await load("/booted-shell");

      const message = await shortNetRejectionMessage(() =>
        waitForCondition(page, () => {
          throw new Error("the predicate itself is broken");
        })
      );
      expect(message).toContain(
        "predicate threw: Error: the predicate itself is broken",
      );
    });
  });

  describe("describeShellPage()", () => {
    it("returns a block naming the view and identity the page holds", async () => {
      await load("/booted-shell");

      const described = describeShellPage(await readShellPageProbe(page));
      expect(described).toContain(
        'globalThis.app: present, holding view {"builtin":"home"} and ' +
          "did:key:zBootedShellFixture",
      );
      expect(described).toContain("x-root-view: present");
    });

    it("omits the document's text for a page that is the shell", async () => {
      await load("/shell");

      const described = describeShellPage(await readShellPageProbe(page));
      expect(described).not.toContain("document text:");
    });

    // The four pending-request cases render a probe built here rather than one
    // read from a page. `describeShellPage` is a function of that record
    // alone, and the four lines it chooses between differ by a few words, so
    // each case asserts a whole line: a check for "pending runtime requests:
    // none" is satisfied by three of the four.

    it("names each request the runtime is waiting on, and its age", () => {
      const lines = describedLines({
        pendingRequests: [
          { msgId: 7, type: RequestType.Dispose, ageMs: 41203 },
          { msgId: 9, type: RequestType.CellSubscribe, ageMs: 84 },
        ],
      });
      expect(lines).toContain("  pending runtime requests (2, oldest first):");
      expect(lines).toContain("    dispose (msgId 7), outstanding for 41203ms");
      expect(lines).toContain(
        "    cell:subscribe (msgId 9), outstanding for 84ms",
      );
    });

    it("reports that a runtime with nothing in flight has none", () => {
      expect(describedLines({ pendingRequests: [] })).toContain(
        "  pending runtime requests: none",
      );
    });

    it("reports that a page carrying no runtime has none", () => {
      expect(describedLines({ runtime: false })).toContain(
        "  pending runtime requests: none, the page carries no runtime",
      );
    });

    it("reports a runtime that does not report its requests", () => {
      expect(describedLines({})).toContain(
        "  pending runtime requests: this runtime does not report them",
      );
    });

    it("reports why the requests could not be read", () => {
      expect(
        describedLines({
          pendingRequestsError: "Error: the connection is gone",
        }),
      ).toContain(
        "  pending runtime requests: reading them threw: " +
          "Error: the connection is gone",
      );
    });

    describe("worker warnings and errors", () => {
      // These render a probe built here, as the pending-request cases do, and
      // assert a whole line for the same reason: the lines they choose between
      // differ by a few words.

      it("names each warning or error the worker logged, and its counts", () => {
        const lines = describedLines({
          workerProblems: [
            {
              logger: "storage.v2",
              message: "sync-load-failure",
              warn: 1,
              error: 3,
            },
            {
              logger: "scheduler",
              message: "schedule-error",
              warn: 0,
              error: 2,
            },
          ],
        });
        expect(lines).toContain(
          "  worker warnings and errors (2 kinds, most errors first):",
        );
        expect(lines).toContain(
          "    storage.v2 sync-load-failure: 3 error, 1 warn",
        );
        expect(lines).toContain(
          "    scheduler schedule-error: 2 error, 0 warn",
        );
      });

      it("lists twenty kinds of warning and error and counts the rest", () => {
        const lines = describedLines({
          workerProblems: Array.from({ length: 23 }, (_, index) => ({
            logger: "runner",
            message: `problem-${index}`,
            warn: 0,
            error: 23 - index,
          })),
        });
        expect(lines).toContain("    runner problem-19: 4 error, 0 warn");
        expect(lines).not.toContain("    runner problem-20: 3 error, 0 warn");
        expect(lines).toContain("    and 3 more");
      });

      it("names a single kind of warning or error without a plural", () => {
        expect(
          describedLines({
            workerProblems: [
              { logger: "runner", message: "action-failed", warn: 1, error: 0 },
            ],
          }),
        ).toContain(
          "  worker warnings and errors (1 kind, most errors first):",
        );
      });

      it("reports that a worker with no warning or error logged has none", () => {
        expect(describedLines({ workerProblems: [] })).toContain(
          "  worker warnings and errors: none",
        );
      });

      it("reports that a page carrying no runtime has no worker to ask", () => {
        expect(describedLines({ runtime: false })).toContain(
          "  worker warnings and errors: none, the page carries no runtime",
        );
      });

      it("reports a runtime that does not report its worker's logs", () => {
        expect(describedLines({})).toContain(
          "  worker warnings and errors: this runtime does not report them",
        );
      });

      it("reports why the worker's logs could not be read", () => {
        expect(
          describedLines({
            workerProblemsError:
              "Error: the worker did not answer within 30000ms",
          }),
        ).toContain(
          "  worker warnings and errors: reading them failed: " +
            "Error: the worker did not answer within 30000ms",
        );
      });
    });
  });

  describe("describeStateWaitFailure()", () => {
    it("returns a block naming the awaited view beside the view held", async () => {
      await load("/booted-shell");

      const described = await describeStateWaitFailure(
        page,
        { view: { spaceName: "some-space" } },
        undefined,
      );
      expect(described).toContain('awaited view: {"spaceName":"some-space"}');
      expect(described).toContain(
        "last state read: none (the page never yielded a state)",
      );
      expect(described).toContain(
        'globalThis.app: present, holding view {"builtin":"home"}',
      );
    });

    it("names both identity DIDs when an identity was awaited", async () => {
      await load("/booted-shell");

      const awaited = await Identity.generate();
      const held = await Identity.generate();
      const described = await describeStateWaitFailure(
        page,
        { view: { builtin: "home" }, identity: awaited },
        {
          view: { builtin: "home" },
          identityDid: held.did(),
          apiUrl: origin,
          config: {},
        },
      );
      expect(described).toContain(`awaited identity: ${awaited.did()}`);
      expect(described).toContain(
        `last state read: view {"builtin":"home"}, identity ${held.did()}`,
      );
    });

    it("names a document that is not the shell", async () => {
      await load("/proxy-failure");

      const described = await describeStateWaitFailure(
        page,
        { view: { builtin: "home" } },
        undefined,
      );
      expect(described).toContain("x-root-view: absent");
      expect(described).toContain("globalThis.app: absent");
      expect(described).toContain("response status: 502");
      expect(described).toContain("document text: Failed to proxy to ");
    });
  });

  describe("readAndDescribeShellPage()", () => {
    it("returns the same block describeShellPage() renders", async () => {
      await load("/booted-shell");

      expect(await readAndDescribeShellPage(page)).toBe(
        describeShellPage(await readShellPageProbe(page)),
      );
    });

    it("returns a reason rather than waiting out a page that never answers", async () => {
      // Its own browser, because the wedge below is permanent: the probe runs
      // in the page, and a page whose main thread never yields never answers
      // one. A report written for that state must still arrive, or the
      // failure it was describing never reaches the test runner at all.
      const wedged = await Browser.launch();
      try {
        const wedgedPage = await wedged.newPage(`${origin}/shell`);
        wedgedPage.evaluate(() => {
          while (true) { /* hold the main thread */ }
        }).catch(() => {});

        const described = await readAndDescribeShellPage(wedgedPage);
        expect(described).toContain("the page could not be probed:");
        expect(described).toContain("did not answer within");
      } finally {
        await wedged.close();
      }
    });

    it("returns the reason when the page cannot be read", async () => {
      const closed = await browser.newPage();
      await closed.close();

      const described = await readAndDescribeShellPage(closed);
      expect(described).toContain("the page could not be probed:");
    });
  });

  describe("disposePageRuntime()", () => {
    // The teardown reports through `console.warn` rather than throwing, so
    // each case reads what was warned. Collecting every warning and matching
    // on the text keeps a case from turning on how many other warnings the
    // browser produced.

    it("warns naming the requests the runtime was still waiting on", async () => {
      await load("/unresponsive-runtime");
      const warnings: string[] = [];
      using _warn = stub(console, "warn", (...args: unknown[]) => {
        warnings.push(args.join(" "));
      });

      await disposePageRuntime(page);

      const warned = warnings.join("\n");
      expect(warned).toContain(
        "Disposing the shell page runtime failed: Error: the worker stopped " +
          "answering",
      );
      expect(warned).toContain("pending runtime requests (2, oldest first):");
      expect(warned).toContain("dispose (msgId 7), outstanding for 41203ms");
    });

    it("drops a runtime that answers, and warns nothing", async () => {
      await load("/idle-runtime");
      const warnings: string[] = [];
      using _warn = stub(console, "warn", (...args: unknown[]) => {
        warnings.push(args.join(" "));
      });

      await disposePageRuntime(page);

      expect(warnings.join("\n")).not.toContain(
        "Disposing the shell page runtime failed",
      );
      expect(
        await page.evaluate(() => globalThis.commonfabric.rt === undefined),
      ).toBe(true);
    });
  });

  describe("login()", () => {
    it("throws naming the identity and the page it failed against", async () => {
      await load("/refusing-shell");
      const identity = await Identity.generate({ implementation: "noble" });

      const message = await rejectionMessage(login(page, identity));
      expect(message).toContain(
        `Logging in as ${identity.did()} failed: Error: the key store is not open`,
      );
      expect(message).toContain("x-root-view: present");
      expect(message).toContain(
        'globalThis.app: present, holding view {"builtin":"home"}',
      );
    });
  });
});
