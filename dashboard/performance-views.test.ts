import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  performanceViewHref,
  performanceViewNav,
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
