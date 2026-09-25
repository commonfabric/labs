import type { PendingRequestDiagnostic } from "@commonfabric/runtime-client";

import { describeThrown } from "./describe-thrown.ts";
import type { Page } from "./page.ts";

// How much of the document's text a probe carries back. Enough to read a
// server's error page, short enough to stay one line of a failure report.
const TEXT_LIMIT = 500;

// How many of the retained console messages a probe carries back.
const CONSOLE_TAIL_LIMIT = 40;

// How long a probe waits for the worker to report its logged warnings and
// errors. Reading them is a round trip to the worker, and a worker that has
// stopped answering is one of the states a report is written for, so this
// bounds that one read and not the rest of the probe, which needs no worker.
const WORKER_LOG_READ_LIMIT_MS = 2_000;

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

/** Read {@link ShellPageProbe} from the document currently in `page`. */
export async function readShellPageProbe(page: Page): Promise<ShellPageProbe> {
  return await page.evaluate(async (
    textLimit: number,
    tailLimit: number,
    workerLogLimitMs: number,
  ) => {
    type LogCountsByMessage = Record<
      string,
      number | { warn?: number; error?: number }
    >;
    const scope = globalThis as typeof globalThis & {
      app?: { serialize?: () => { view?: unknown; identityDid?: string } };
      commonfabric?: {
        rt?: {
          getPendingRequests?: () => PendingRequestDiagnostic[];
          getLoggerCounts?: () => Promise<{
            counts: Record<string, number | LogCountsByMessage>;
          }>;
        };
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
                  `the worker did not answer within ${workerLogLimitMs}ms`,
                ),
              ),
            workerLogLimitMs,
          );
        });
        const { counts } = await Promise.race([
          rt.getLoggerCounts(),
          unanswered,
        ]);
        // `total` is reserved at both levels of the counts, as the sum of what
        // sits beside it.
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
      workerProblems,
      workerProblemsError,
      text,
      consoleTail,
    };
  }, {
    args: [TEXT_LIMIT, CONSOLE_TAIL_LIMIT, WORKER_LOG_READ_LIMIT_MS],
  });
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
    return describeShellPage(
      await Promise.race([readShellPageProbe(page), unanswered]),
    );
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
  const probe = await readShellPageProbe(page);
  if (probe.rootView) return;
  throw new Error(
    `Navigated to ${requestedUrl}, but the document that loaded is not the ` +
      `shell: it has no x-root-view element.\n${describeShellPage(probe)}`,
  );
}
