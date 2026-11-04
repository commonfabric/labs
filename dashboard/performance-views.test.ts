import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { CollectionProgress } from "./history-page-client.ts";
import {
  performanceViewHref,
  performanceViewNav,
  progressPanel,
} from "./performance-views.ts";

const state = {
  repo: "loom" as const,
  days: 14,
  sort: "job",
  stat: "p99",
};

Deno.test("performance view URLs share one canonical route and translate sort modes", () => {
  assertEquals(
    performanceViewHref("runtime", state),
    "/bench?view=runtime&amp;repo=loom&amp;days=14&amp;sort=file&amp;stat=p99",
  );
  assertEquals(
    performanceViewHref("ci", { ...state, sort: "file" }),
    "/bench?view=ci&amp;repo=loom&amp;days=14&amp;sort=job&amp;stat=p99",
  );
  assertEquals(
    performanceViewHref("gantt", state),
    "/bench?view=gantt&amp;repo=loom&amp;days=14&amp;sort=job&amp;stat=p99",
  );
});

Deno.test("performance view navigation marks one stable-size selector active", () => {
  const html = performanceViewNav("ci", state);

  assertStringIncludes(html, ">Runtime benchmarks</a>");
  assertStringIncludes(
    html,
    'aria-current="page">CI duration history</a>',
  );
  assertStringIncludes(html, ">CI run Gantt</a>");
});

Deno.test("performance progress panel says what the page's script says about a collection under way", () => {
  const collection = (
    phase: CollectionProgress["phase"],
    totalRuns = 9,
  ): CollectionProgress & { readonly warning?: string } => ({
    id: "a b",
    phase,
    totalRuns,
    completedRuns: 3,
    needsReload: false,
    error: "rate <limited>",
    warning: "Showing cached runs.",
  });
  const describe = (state: CollectionProgress) => ({
    title: `${state.phase} <title>`,
    total: `${state.completedRuns} of ${state.totalRuns}`,
    detail: "detail",
  });
  const panel = (
    progress?: CollectionProgress & { readonly warning?: string },
  ) =>
    progressPanel(progress, describe, {
      ariaLabel: "Test progress",
      progressPath: "/progress",
      lastRequestError: "earlier failure",
    });

  const fetching = panel(collection("fetching"));
  assertStringIncludes(
    fetching,
    '<strong id="fetch-title">fetching &lt;title&gt;</strong><span id="fetch-total">3 of 9</span>',
  );
  assertStringIncludes(fetching, '<progress id="fetch-bar" max="9" value="3"');
  assertStringIncludes(fetching, 'data-progress-url="/progress?id=a%20b"');
  assertStringIncludes(fetching, '<p id="fetch-detail">detail</p>');
  assert(!fetching.includes("data-last-request-error"));

  assertStringIncludes(
    panel(collection("discovering", 0)),
    '<progress id="fetch-bar" max="1" aria-label="Test progress">',
  );
  assertStringIncludes(
    panel(collection("discovering")),
    '<progress id="fetch-bar" max="9" aria-label="Test progress">',
  );

  const failed = panel(collection("error"));
  assertStringIncludes(failed, 'class="fetch-progress error"');
  assertStringIncludes(failed, 'data-last-request-error="rate &lt;limited&gt;"');
  assertStringIncludes(
    failed,
    '<strong id="fetch-title">Idle</strong><span id="fetch-total">0 outstanding</span>',
  );
  assertStringIncludes(
    failed,
    '<p id="fetch-detail">Last collection stopped: rate &lt;limited&gt;</p>',
  );

  const finished = panel(collection("complete"));
  assertStringIncludes(finished, 'class="fetch-progress warning"');
  assertStringIncludes(finished, '<p id="fetch-detail">Showing cached runs.</p>');
  assertStringIncludes(finished, 'max="1" value="0"');
  assert(!finished.includes("data-progress-url"));

  const none = panel();
  assertStringIncludes(none, 'class="fetch-progress error"');
  assertStringIncludes(
    none,
    '<p id="fetch-detail">Last collection stopped: earlier failure</p>',
  );
  assert(!none.includes("data-progress-url"));
});
