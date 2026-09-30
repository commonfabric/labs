import type { PendingRequestDiagnostic } from "@commonfabric/runtime-client";

import { describeThrown } from "./describe-thrown.ts";
import type { Page } from "./page.ts";

// How much of the document's text a probe carries back. Enough to read a
// server's error page, short enough to stay one line of a failure report.
const TEXT_LIMIT = 500;

// How many of the retained console messages a probe carries back.
const CONSOLE_TAIL_LIMIT = 40;

/**
 * How long a probe gives the worker to report its logged warnings and errors,
 * unless a caller names its own budget.
 *
 * Reading them is a round trip to the worker, and a request carries no
 * deadline of its own, so a worker that has stopped answering would hold the
 * report open for as long as the page lived. The size is the one the browser
 * load summary's `WORKER_STATS_BUDGET_MS` takes for the same read, in
 * `packages/patterns/integration/cfc-browser-helpers.ts`, for the same reason:
 * the counts cost the worker almost nothing, so a slow answer means a busy
 * worker, and the runs a report is most needed for are loaded ones. A budget
 * of seconds would fire on those; this one is reached only by a worker that
 * has stopped.
 */
const WORKER_LOG_BUDGET_MS = 30_000;

// How many kinds of worker warning and error a report lists.
const WORKER_PROBLEM_LIMIT = 20;

/**
 * One message a logger in the page's runtime worker has recorded at `warn` or
 * `error`, with how many times it did at each.
 */
export interface WorkerLogProblem {
  /** The name of the logger that recorded it. */
  logger: string;

  /** The message key the logger counts it under. */
  message: string;

  /** How many times it was recorded at `warn`. */
  warn: number;

  /** How many times it was recorded at `error`. */
  error: number;
}

/**
 * What a page held at the moment a wait or a navigation against it failed.
 *
 * Read with {@link readShellPageProbe} and rendered with
 * {@link describeShellPage}. Every field answers a question an investigator
 * asks of a failed browser test: is this the shell at all, did the server
 * answer with the document that was asked for, had the shell booted far enough
 * to publish itself, what was it showing, and what was it waiting on the
 * runtime worker for. A page that is not the shell answers the first of those
 * and is described by its own text.
 */
export interface ShellPageProbe {
  /** The document's own URL, which a redirect can make differ from the one requested. */
  url: string;

  /** The document's title. */
  title: string;

  /**
   * HTTP status of the navigation response, taken from the page's navigation
   * timing entry. Absent for a document that came from no network response.
   */
  status?: number;

  /** Whether the shell's root element, `x-root-view`, is in the document. */
  rootView: boolean;

  /** Whether the shell has published itself on `globalThis.app`. */
  app: boolean;

  /** The view `globalThis.app` holds, read from its serialized state. */
  view?: unknown;

  /** Why that state could not be read, when `app` is set and reading it threw. */
  viewError?: string;

  /** The DID of the identity that state carries, where it carries one. */
  identityDid?: string;

  /**
   * Whether the page carries a runtime on `globalThis.commonfabric.rt`. Every
   * page does not: the shell builds one at login.
   */
  runtime: boolean;

  /**
   * The requests that runtime has sent its worker and has no reply to, oldest
   * first, which is the order it reports them in. Reading these needs no
   * worker round trip, so a worker that has stopped answering is named here
   * all the same. Absent where there is no runtime to ask, and where the
   * runtime is one that does not report them.
   */
  pendingRequests?: PendingRequestDiagnostic[];

  /** Why those could not be read, when reading them threw. */
  pendingRequestsError?: string;

  /**
   * The messages the runtime's worker has recorded at `warn` or `error`, most
   * errors first, then most warnings. The worker's own console does not reach
   * the page, so these counts are what a report can say about the worker's
   * trouble. Absent where there is no runtime to ask, and where the runtime is
   * one that does not report them.
   */
  workerProblems?: WorkerLogProblem[];

  /**
   * Why those could not be read, when asking threw or the worker did not
   * answer in time.
   */
  workerProblemsError?: string;

  /** The start of the document's rendered text. */
  text: string;

  /**
   * The console messages `Page.applyConsoleFormatter` retained in the page,
   * oldest first, each prefixed with how long before the probe it was logged.
   * Empty for a document the formatter was never applied to.
   */
  consoleTail: string[];
}

/** What a caller of {@link readShellPageProbe} may set. */
export interface ShellPageProbeOptions {
  /**
   * How long the worker is given to report its logged warnings and errors.
   * A case that wants the unanswered worker exercised asks for a short one.
   */
  workerBudgetMs?: number;
}

/** Read {@link ShellPageProbe} from the document currently in `page`. */
export async function readShellPageProbe(
  page: Page,
  options: ShellPageProbeOptions = {},
): Promise<ShellPageProbe> {
  const probe = await readPageFields(page);
  if (!probe.runtime) return probe;
  return {
    ...probe,
    ...await readWorkerProblems(
      page,
      options.workerBudgetMs ?? WORKER_LOG_BUDGET_MS,
    ),
  };
}

/**
 * Helper for {@link readShellPageProbe}, which reads everything but the
 * worker's logs. It needs no worker, so it answers whenever the page's main
 * thread does.
 */
async function readPageFields(page: Page): Promise<ShellPageProbe> {
  return await page.evaluate((textLimit: number, tailLimit: number) => {
    const scope = globalThis as typeof globalThis & {
      app?: { serialize?: () => { view?: unknown; identityDid?: string } };
      commonfabric?: {
        rt?: { getPendingRequests?: () => PendingRequestDiagnostic[] };
      };
      __cfConsoleTail?: Array<{ t: number; method: string; text: string }>;
    };

    const navigation = performance.getEntriesByType("navigation")[0] as
      | (PerformanceNavigationTiming & { responseStatus?: number })
      | undefined;
    const status = typeof navigation?.responseStatus === "number"
      ? navigation.responseStatus
      : undefined;

    const app = typeof scope.app?.serialize === "function";
    let view: unknown;
    let viewError: string | undefined;
    let identityDid: string | undefined;
    if (app) {
      try {
        const state = scope.app!.serialize!();
        view = state.view;
        identityDid = state.identityDid;
      } catch (error) {
        viewError = String(error);
      }
    }

    const rt = scope.commonfabric?.rt;
    let pendingRequests: PendingRequestDiagnostic[] | undefined;
    let pendingRequestsError: string | undefined;
    if (rt?.getPendingRequests) {
      try {
        pendingRequests = rt.getPendingRequests();
      } catch (error) {
        pendingRequestsError = String(error);
      }
    }

    const body = document.body;
    const text = (body?.innerText ?? body?.textContent ?? "").trim()
      .slice(0, textLimit);

    const now = Date.now();
    const consoleTail = (scope.__cfConsoleTail ?? []).slice(-tailLimit).map(
      (entry) => `${now - entry.t}ms ago [${entry.method}] ${entry.text}`,
    );

    return {
      url: location.href,
      title: document.title,
      status,
      rootView: !!document.querySelector("x-root-view"),
      app,
      view,
      viewError,
      identityDid,
      runtime: rt !== undefined,
      pendingRequests,
      pendingRequestsError,
      text,
      consoleTail,
    };
  }, { args: [TEXT_LIMIT, CONSOLE_TAIL_LIMIT] });
}

/**
 * Helper for {@link readShellPageProbe}, which asks the page's runtime for the
 * messages its worker has logged at `warn` or `error`. It never rejects: a
 * worker that does not answer within `budgetMs`, a runtime that refuses, a page
 * that cannot be asked, and a page whose main thread stops answering all come
 * back as the reason.
 *
 * The page enforces `budgetMs` itself, which it cannot do once its main thread
 * has stopped, so the whole read is also bounded here, at that budget plus the
 * time {@link PROBE_READ_LIMIT_MS} gives a page to answer.
 */
async function readWorkerProblems(
  page: Page,
  budgetMs: number,
): Promise<Pick<ShellPageProbe, "workerProblems" | "workerProblemsError">> {
  const pageLimitMs = budgetMs + PROBE_READ_LIMIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unanswered = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`the page did not answer within ${pageLimitMs}ms`)),
      pageLimitMs,
    );
  });
  try {
    return await Promise.race([
      readWorkerProblemsInPage(page, budgetMs),
      unanswered,
    ]);
  } catch (error) {
    return { workerProblemsError: describeThrown(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Helper for {@link readWorkerProblems}, which is the read in the page. */
async function readWorkerProblemsInPage(
  page: Page,
  budgetMs: number,
): Promise<Pick<ShellPageProbe, "workerProblems" | "workerProblemsError">> {
  return await page.evaluate(async (budgetMs: number) => {
    type LogCountsByMessage = Record<
      string,
      number | { warn?: number; error?: number }
    >;
    const rt = (globalThis as typeof globalThis & {
      commonfabric?: {
        rt?: {
          getLoggerCounts?: () => Promise<{
            counts: Record<string, number | LogCountsByMessage>;
          }>;
        };
      };
    }).commonfabric?.rt;
    let workerProblems: WorkerLogProblem[] | undefined;
    let workerProblemsError: string | undefined;
    if (rt?.getLoggerCounts) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const unanswered = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `the worker did not answer within ${budgetMs}ms`,
                ),
              ),
            budgetMs,
          );
        });
        const { counts } = await Promise.race([
          rt.getLoggerCounts(),
          unanswered,
        ]);
        // `total` is reserved at both levels of the counts, as the sum of
        // what sits beside it.
        workerProblems = [];
        for (const [logger, byMessage] of Object.entries(counts)) {
          if (logger === "total" || typeof byMessage !== "object") continue;
          for (const [message, levels] of Object.entries(byMessage)) {
            if (message === "total" || typeof levels !== "object") continue;
            const warn = levels.warn ?? 0;
            const error = levels.error ?? 0;
            if (warn > 0 || error > 0) {
              workerProblems.push({ logger, message, warn, error });
            }
          }
        }
        workerProblems.sort((a, b) => b.error - a.error || b.warn - a.warn);
      } catch (error) {
        workerProblems = undefined;
        workerProblemsError = String(error);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    return { workerProblems, workerProblemsError };
  }, { args: [budgetMs] });
}

/**
 * Helper for {@link describeShellPage}, which renders what the page's runtime
 * is still waiting on, one line per request.
 *
 * No runtime to ask, a runtime that does not report, a report that threw, and
 * a runtime with nothing in flight are four different diagnoses that would
 * otherwise render alike, so each says which it is.
 */
function describePendingRequests(probe: ShellPageProbe): string[] {
  if (!probe.runtime) {
    return ["  pending runtime requests: none, the page carries no runtime"];
  }
  if (probe.pendingRequestsError !== undefined) {
    return [
      "  pending runtime requests: reading them threw: " +
      probe.pendingRequestsError,
    ];
  }
  const pending = probe.pendingRequests;
  if (pending === undefined) {
    return ["  pending runtime requests: this runtime does not report them"];
  }
  if (pending.length === 0) return ["  pending runtime requests: none"];
  return [
    `  pending runtime requests (${pending.length}, oldest first):`,
    ...pending.map((request) =>
      `    ${request.type} (msgId ${request.msgId}), outstanding for ` +
      `${request.ageMs}ms`
    ),
  ];
}

/**
 * Helper for {@link describeShellPage}, which renders the warnings and errors
 * the page's runtime worker has recorded, one line per message, most errors
 * first.
 *
 * As with the pending requests, no runtime, a runtime that does not report, a
 * report that failed, and a worker with nothing recorded each say which they
 * are.
 */
function describeWorkerProblems(probe: ShellPageProbe): string[] {
  const heading = "  worker warnings and errors";
  if (!probe.runtime) {
    return [`${heading}: none, the page carries no runtime`];
  }
  if (probe.workerProblemsError !== undefined) {
    return [`${heading}: reading them failed: ${probe.workerProblemsError}`];
  }
  const problems = probe.workerProblems;
  if (problems === undefined) {
    return [`${heading}: this runtime does not report them`];
  }
  if (problems.length === 0) return [`${heading}: none`];
  const shown = problems.slice(0, WORKER_PROBLEM_LIMIT);
  const lines = [
    `${heading} (${problems.length} ` +
    `${problems.length === 1 ? "kind" : "kinds"}, most errors first):`,
    ...shown.map((problem) =>
      `    ${problem.logger} ${problem.message}: ` +
      `${problem.error} error, ${problem.warn} warn`
    ),
  ];
  if (problems.length > shown.length) {
    lines.push(`    and ${problems.length - shown.length} more`);
  }
  return lines;
}

/**
 * Render `probe` as the indented block of detail lines that follows the first
 * line of a failure message.
 *
 * The document's text is included only when the document is not the shell.
 * For the shell it is the whole rendered application, which says less about a
 * stalled wait than the view and the console tail already do.
 */
export function describeShellPage(probe: ShellPageProbe): string {
  const lines: string[] = [
    `  document URL: ${probe.url}`,
    `  document title: ${probe.title || "(none)"}`,
  ];
  if (probe.status !== undefined) {
    lines.push(`  response status: ${probe.status}`);
  }
  lines.push(`  x-root-view: ${probe.rootView ? "present" : "absent"}`);
  if (probe.viewError !== undefined) {
    lines.push(
      `  globalThis.app: present, but reading its state threw: ${probe.viewError}`,
    );
  } else if (probe.app) {
    lines.push(
      `  globalThis.app: present, holding view ${JSON.stringify(probe.view)}` +
        ` and ${probe.identityDid ?? "no identity"}`,
    );
  } else {
    lines.push("  globalThis.app: absent");
  }
  lines.push(...describePendingRequests(probe));
  lines.push(...describeWorkerProblems(probe));
  if (!probe.rootView) {
    const text = probe.text.replace(/\s+/g, " ");
    lines.push(`  document text: ${text || "(empty)"}`);
  }
  if (probe.consoleTail.length === 0) {
    lines.push("  console tail: empty");
  } else {
    lines.push(`  console tail (${probe.consoleTail.length} most recent):`);
    for (const entry of probe.consoleTail) lines.push(`    ${entry}`);
  }
  return lines.join("\n");
}

// How long a failure report waits for the page to answer its probe. The probe
// runs in the page, so a wedged main thread never answers it, and a wedged main
// thread is one of the states a report is written for. This bounds the report
// and nothing a test is waiting to succeed at.
const PROBE_READ_LIMIT_MS = 10_000;

/**
 * Read `page` and render it as the detail block of a failure message,
 * reporting the reason instead when the page cannot be read.
 *
 * This is the whole of what a failure report needs from the page. A page that
 * has closed, a browser that has gone away, and a main thread that never gets
 * around to the probe must none of them replace the failure being reported
 * with a second one, or hold it back, so the read is guarded here rather than
 * at each call site.
 */
export async function readAndDescribeShellPage(page: Page): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const unanswered = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `the page did not answer within ${PROBE_READ_LIMIT_MS}ms`,
            ),
          ),
        PROBE_READ_LIMIT_MS,
      );
    });
    const probe = await Promise.race([readPageFields(page), unanswered]);
    // The worker read carries its own budget, which is longer than this bound,
    // and bounds itself against a page that stops answering.
    const worker = probe.runtime
      ? await readWorkerProblems(page, WORKER_LOG_BUDGET_MS)
      : {};
    return describeShellPage({ ...probe, ...worker });
  } catch (error) {
    return `  the page could not be probed: ${describeThrown(error)}`;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Whether the document in `page` is the shell, decided by the same
 * `x-root-view` element {@link assertShellDocument} looks for.
 */
export async function isShellDocument(page: Page): Promise<boolean> {
  return await page.evaluate(() => !!document.querySelector("x-root-view"));
}

/**
 * Fail unless the document in `page` is the shell.
 *
 * The shell's entry document carries an `x-root-view` element, so a document
 * without one came from somewhere else: the toolshed's proxy failure page when
 * it cannot reach the shell dev server, a 404 from a server that serves no
 * shell, a browser error page. Everything a shell test waits for afterwards is
 * read through `globalThis.app`, which such a document never defines, so the
 * wait runs to its bound and reports only that time ran out. Checking here
 * reports the document that arrived instead, at the moment it arrived.
 */
export async function assertShellDocument(
  page: Page,
  requestedUrl: string,
): Promise<void> {
  if (await isShellDocument(page)) return;
  const probe = await readShellPageProbe(page);
  throw new Error(
    `Navigated to ${requestedUrl}, but the document that loaded is not the ` +
      `shell: it has no x-root-view element.\n${describeShellPage(probe)}`,
  );
}
