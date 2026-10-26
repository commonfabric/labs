/**
 * Measures a vote burst through five independent browser profiles, ending when
 * every page renders every voter's current swatch for every option. The real
 * poll's profile creation and joins, two warmups, and browser startup are
 * outside the samples. The authoring controller is disposed before browsers
 * open.
 *
 * Run with `deno run -A` against a source toolshed and a matching shell build,
 * using `API_URL` and `FRONTEND_URL`. `CF_LUNCH_POLL_VOTERS` and
 * `CF_LUNCH_POLL_OPTIONS` default to five; `CF_LUNCH_POLL_BROWSER_ROUNDS`
 * defaults to three measured rounds. `CF_LUNCH_POLL_BROWSER_OUT` optionally
 * saves the samples, client logger rows, and serving health snapshots as JSON.
 *
 * This is a separate series from the worker benchmark. It includes browser
 * control preparation and CDP click dispatch, with no intervening settle
 * between a page's clicks. Its endpoint is settled DOM followed by a paint
 * opportunity, not a measurement of pixels presented by a physical display.
 */

import { Identity } from "@commonfabric/identity";
import {
  Browser,
  createTestSpace,
  env,
  type Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import {
  disposePageRuntime,
  login,
  SHELL_VIEWPORT,
  waitForShellReady,
} from "@commonfabric/integration/shell-utils";
import { appViewToUrlPath } from "@commonfabric/navigation";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { maxOf } from "@commonfabric/utils/math";
import { join } from "@std/path";
import {
  clickCfButton,
  clickCfButtonsConcurrently,
  clickTrustedAction,
  fillCfInput,
  waitForActiveSpaceRoot,
  waitForRuntimeIdle,
  waitForSettledText,
} from "./cfc-browser-helpers.ts";
import { initializePiecesController } from "./pieces-controller.ts";

function size(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const names = Array.from(
  { length: size("CF_LUNCH_POLL_VOTERS", 5) },
  (_, i) => `Voter ${i + 1}`,
);
const titles = Array.from(
  { length: size("CF_LUNCH_POLL_OPTIONS", 5) },
  (_, i) => `Place ${i + 1}`,
);
const rounds = size("CF_LUNCH_POLL_BROWSER_ROUNDS", 3);
const colors = ["green", "yellow", "red"] as const;
const colorOf = (voter: number, option: number, round: number) =>
  colors[(voter + option + round) % colors.length];

/**
 * Checks exact option, name and color rows; a stale color or a duplicate
 * cannot pass.
 */
async function votesRendered(
  probe: ProbeApi,
  expected: readonly (readonly [string, string, string])[],
): Promise<boolean> {
  const shell = (globalThis as unknown as {
    commonfabric?: { viewSettled?: () => Promise<void> };
  }).commonfabric;
  if (!shell?.viewSettled) return false;
  await shell.viewSettled();
  const swatches = probe.collect("[data-vote-swatch-name]");
  if (swatches.length !== expected.length) return false;
  const titles = new Set(expected.map(([title]) => title));
  const actual = new Set(swatches.map((swatch) => {
    // Reconciler fragments add display-contents wrappers. Find the summary
    // row by its title rather than assuming a fixed number of ancestors.
    let row = swatch.parentElement;
    while (
      row && !titles.has(row.firstElementChild?.textContent?.trim() ?? "")
    ) {
      row = row.parentElement;
    }
    return JSON.stringify([
      row?.firstElementChild?.textContent?.trim(),
      swatch.getAttribute("data-vote-swatch-name"),
      swatch.getAttribute("aria-label"),
    ]);
  }));
  return actual.size === expected.length &&
    expected.every(([title, name, color]) =>
      actual.has(JSON.stringify([title, name, `${name}: ${color} vote`]))
    );
}

const browsers: Browser[] = [];
const pages: Page[] = [];
const browserErrors: string[] = [];

/**
 * The server's health stats, with the serving loop's realm's loggers under
 * `servingLoopRealm` when a loop runs there: that route answers 404 with the
 * loop off, which is this measurement's OFF arm.
 */
async function health(): Promise<unknown> {
  const response = await fetch(new URL("api/health/stats", env.API_URL));
  if (!response.ok) throw new Error(`Health stats returned ${response.status}`);
  const stats = await response.json() as Record<string, unknown>;
  const realm = await fetch(
    new URL("api/health/serving-loop-realm", env.API_URL),
  );
  if (realm.status === 404) return stats;
  if (!realm.ok) {
    throw new Error(`Serving-loop realm returned ${realm.status}`);
  }
  return { ...stats, servingLoopRealm: await realm.json() };
}

/** Full logger rows from both browser realms, outside the timed bursts. */
async function clientStats(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const diagnostics = globalThis.commonfabric as unknown as {
      rt: { getLoggerCounts(): Promise<unknown> };
      getTimingStatsBreakdown(): unknown;
      getLoggerCountsBreakdown(): unknown;
    };
    return {
      timeOrigin: performance.timeOrigin,
      mainTiming: diagnostics.getTimingStatsBreakdown(),
      mainCounts: diagnostics.getLoggerCountsBreakdown(),
      worker: await diagnostics.rt.getLoggerCounts(),
    };
  });
}

/**
 * Times one burst: once every page's runtime is idle, every voter clicks
 * `round`'s color on every option, and each page is timed until it renders
 * every vote and two animation frames pass. Returns the slowest page's time,
 * the driver's own, and each page's.
 */
async function burst(
  round: number,
): Promise<{ totalMs: number; driverMs: number; clientMs: number[] }> {
  const expected = names.flatMap((name, voter) =>
    titles.map((title, option) =>
      [title, name, colorOf(voter, option, round)] as const
    )
  );
  await Promise.all(pages.map(waitForRuntimeIdle));
  const start = performance.now();
  const observed = Promise.all(pages.map(async (page) => {
    await waitForCondition(page, votesRendered, { args: [expected] });
    // The first callback precedes paint; the second gives that updated DOM
    // a rendering opportunity. This does not assert compositor presentation.
    await page.evaluate(() =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
    );
    return performance.now() - start;
  }));
  const dispatched = clickCfButtonsConcurrently(
    pages.flatMap((page, voter) =>
      titles.map((title, option) => ({
        page,
        selector: `[data-option-title="${title}"] cf-button[data-vote="${
          colorOf(voter, option, round)
        }"]`,
      }))
    ),
  );
  const [, clientMs] = await Promise.all([dispatched, observed]);
  if (browserErrors.length) throw new Error(browserErrors.join("\n"));
  return {
    totalMs: maxOf(clientMs),
    driverMs: performance.now() - start,
    clientMs,
  };
}

const failures: unknown[] = [];
try {
  const identities = await Promise.all(
    names.map(() => Identity.generate({ implementation: "noble" })),
  );
  const spaceDid = await createTestSpace(identities[0], {
    apiUrl: new URL(env.API_URL),
    grants: Object.fromEntries(
      identities.slice(1).map((identity) => [identity.did(), "WRITE" as const]),
    ),
  });
  const controller = await initializePiecesController({
    apiUrl: new URL(env.API_URL),
    identity: identities[0],
    space: spaceDid,
  });
  let pieceId: string;
  try {
    await controller.ensureDefaultPattern();
    const root = join(import.meta.dirname!, "..");
    const program = await resolveLocalProgram(
      (resolver) => controller.runtime.harness.resolve(resolver),
      { main: join(root, "lunch-poll", "main.tsx"), root },
    );
    pieceId = (await controller.create(program, { start: true })).id;
    await controller.runtime.idle();
    await controller.synced();
  } finally {
    await controller.dispose();
  }

  const url =
    new URL(appViewToUrlPath({ spaceDid, pieceId }), env.FRONTEND_URL).href;
  for (let i = 0; i < identities.length; i++) {
    const browser = await Browser.launch({ headless: env.HEADLESS });
    browsers.push(browser);
    const page = await browser.newPage();
    pages.push(page);
    page.addEventListener(
      "pageerror",
      (event) => browserErrors.push(event.detail.message),
    );
    page.addEventListener("console", (event) => {
      if (event.detail.type === "error") browserErrors.push(event.detail.text);
    });
    await page.setViewportSize(SHELL_VIEWPORT);
    await page.goto(url);
    await page.applyConsoleFormatter();
    await waitForShellReady(page);
    await login(page, identities[i]);
    await waitForActiveSpaceRoot(page, spaceDid);
    await waitForRuntimeIdle(page);
    await fillCfInput(page, "#wish-profile-name-input", names[i]);
    await clickTrustedAction(page, "CreateProfile");
    await waitForRuntimeIdle(page);
    await clickCfButton(page, "#lp-join-button");
    await waitForSettledText(page, "body", `${i + 1} joined`);
  }
  for (const title of titles) {
    await fillCfInput(pages[0], "#lp-add-option-input", title);
    await clickCfButton(pages[0], "#lp-add-option-button");
    await Promise.all(
      pages.map((page) => waitForSettledText(page, "body", title)),
    );
  }
  for (let round = 0; round < 2; round++) await burst(round);
  const before = await health();
  const clientsBefore = await Promise.all(pages.map(clientStats));
  const samples = [];
  for (let round = 2; round < rounds + 2; round++) {
    const sample = await burst(round);
    samples.push(sample);
    console.log(
      JSON.stringify({
        measurement: "lunch-poll-browser-burst",
        round,
        voters: names.length,
        options: titles.length,
        ...sample,
      }),
    );
  }
  const report = {
    apiUrl: env.API_URL,
    frontendUrl: env.FRONTEND_URL,
    voters: names.length,
    options: titles.length,
    samples,
    before,
    after: await health(),
    clientsBefore,
    clientsAfter: await Promise.all(pages.map(clientStats)),
    meanMs: samples.reduce((sum, sample) => sum + sample.totalMs, 0) /
      samples.length,
  };
  console.log(
    JSON.stringify({
      measurement: "lunch-poll-browser-summary",
      meanMs: report.meanMs,
    }),
  );
  const out = Deno.env.get("CF_LUNCH_POLL_BROWSER_OUT");
  if (out) await Deno.writeTextFile(out, JSON.stringify(report, null, 2));
} catch (error) {
  failures.push(error);
} finally {
  const disposed = await Promise.allSettled(pages.map(disposePageRuntime));
  const closed = await Promise.allSettled(
    browsers.map((browser) => browser.close()),
  );
  for (const result of [...disposed, ...closed]) {
    if (result.status === "rejected") failures.push(result.reason);
  }
}
if (failures.length) {
  throw new AggregateError(failures, "Browser measurement or cleanup failed");
}
