/**
 * Unit tests for the pure helpers. No network, subprocess, or filesystem.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { maxOf, minOf } from "@commonfabric/utils/math";
import { budgetStatus, ciDurationSub, clampInt, compactSpan, concDot, daysLabel, durationTag, escapeHtml, friendlyError, groupDigits, humanDur, humanSpan, jsonFromZip, landingHref, lighten, median, multiSparkline, readBudget, sparkline, STALE_RUNS_ERROR, strip, thin, usd } from "./lib.ts";
import { artifactZip, bytes, makeZip } from "./test/artifact-zip.ts";

Deno.test("landingHref: squash-merge trailing (#N) -> the PR", () => {
  assertEquals(
    landingHref("packages/ts-transformers tests (#4435)", "sha", "commonfabric/labs"),
    "https://github.com/commonfabric/labs/pull/4435",
  );
});

Deno.test("landingHref: merge commit -> the PR", () => {
  assertEquals(landingHref("Merge pull request #12 from x/y", "sha", "o/r"), "https://github.com/o/r/pull/12");
});

Deno.test("landingHref: a mid-message #ref does NOT mislink -> commit page", () => {
  assertEquals(landingHref("fix: follow-ups from #4401 review", "sha1", "o/r"), "https://github.com/o/r/commit/sha1");
});

Deno.test("landingHref: parses only the first line", () => {
  assertEquals(landingHref("title (#7)\n\nbody mentioning (#999)", "sha", "o/r"), "https://github.com/o/r/pull/7");
});

Deno.test("concDot: only genuine failures are red", () => {
  assertEquals(concDot("success", 1), "green");
  assertEquals(concDot("success", 2), "gray"); // passed only on retry
  assertEquals(concDot("failure", 1), "red");
  assertEquals(concDot("timed_out", 1), "red");
  assertEquals(concDot("cancelled", 1), "gray"); // non-verdict, not a failure
  assertEquals(concDot(null, 1), "gray");
});

Deno.test("compactSpan: minutes, then hours, then days", () => {
  assertEquals(compactSpan(0), "0m");
  assertEquals(compactSpan(12 * 60_000), "12m");
  assertEquals(compactSpan(3_600_000), "1h");
  assertEquals(compactSpan(28 * 3_600_000), "28h");
  assertEquals(compactSpan(48 * 3_600_000), "2d");
  assertEquals(compactSpan(7 * 86_400_000), "7d");
  assertEquals(compactSpan(-5_000), "0m");
});

Deno.test("groupDigits: separates thousands, rounding first", () => {
  assertEquals(groupDigits(78101), "78,101");
  assertEquals(groupDigits(999), "999");
  assertEquals(groupDigits(1000), "1,000");
  assertEquals(groupDigits(1234567), "1,234,567");
  assertEquals(groupDigits(0), "0");
  assertEquals(groupDigits(30.6), "31");
});

Deno.test("ciDurationSub: counts the runs in the time window or the most recent ones", () => {
  assertEquals(ciDurationSub(25, 6), "median of 25 PR runs in 6h");
  assertEquals(ciDurationSub(1, 6), "median of 1 PR run in 6h");
  assertEquals(ciDurationSub(20), "median of last 20 PR runs");
  assertEquals(ciDurationSub(1), "median of last 1 PR run");
  assertEquals(ciDurationSub(0), "no passing PR runs");
  assertEquals(ciDurationSub(0, 6), "no passing PR runs");
});

Deno.test("daysLabel: consistent 'x days' text", () => {
  assertEquals(daysLabel(5), "5 days");
  assertEquals(daysLabel(1), "1 day");
  assertEquals(daysLabel(0), "<1 day");
});

Deno.test("humanSpan: days, else hours, else minutes", () => {
  assertEquals(humanSpan(5 * 86_400_000), "5 days"); // >= 1 day -> daysLabel
  assertEquals(humanSpan(86_400_000), "1 day");
  assertEquals(humanSpan(8 * 3_600_000), "8 hours"); // sub-day -> hours
  assertEquals(humanSpan(3_600_000), "1 hour");
  assertEquals(humanSpan(30 * 60_000), "30 min"); // sub-hour -> minutes
  assertEquals(humanSpan(0), "1 min");
});

Deno.test("humanDur", () => {
  assertEquals(humanDur(5 * 60_000), "5m");
  assertEquals(humanDur(90 * 60_000), "1h 30m");
  assertEquals(humanDur(26 * 3_600_000), "1d 2h");
});

Deno.test("clampInt: clamps to bounds and falls back on empty/invalid", () => {
  assertEquals(clampInt("50", 60, 10, 150), 50);
  assertEquals(clampInt("500", 60, 10, 150), 150);
  assertEquals(clampInt("5", 60, 10, 150), 10);
  assertEquals(clampInt("", 60, 10, 150), 60);
  assertEquals(clampInt(null, 60, 10, 150), 60);
  assertEquals(clampInt("abc", 60, 10, 150), 60);
});

Deno.test("friendlyError: raw errors become short calm phrases", () => {
  assertEquals(
    friendlyError("GitHub API repos/o/r/actions/workflows/deno.yml/runs failed: error connecting to api"),
    "source unreachable",
  );
  assertEquals(friendlyError("error sending request for url"), "source unreachable");
  assertEquals(friendlyError("HTTP 404: Not Found"), "not found");
  assertEquals(friendlyError("HTTP 403: rate limit exceeded"), "rate limit hit");
  assertEquals(friendlyError("Bad credentials"), "auth failed");
  assertEquals(friendlyError("GitHub API x: set GH_TOKEN or GITHUB_TOKEN"), "set GH_TOKEN");
  assertEquals(friendlyError(STALE_RUNS_ERROR), "run list out of date");
  assertEquals(friendlyError("something weird"), "temporarily unavailable");
});

Deno.test("budgetStatus / readBudget: good ≤ budget, warn ≤ 1.25×, bad beyond; unset never alarms", () => {
  assertEquals(budgetStatus(50, 100), "good");
  assertEquals(budgetStatus(100, 100), "good");
  assertEquals(budgetStatus(125, 100), "warn");
  assertEquals(budgetStatus(126, 100), "bad");
  assertEquals(budgetStatus(9999, NaN), "good"); // unset budget never alarms
  assert(Number.isNaN(readBudget(undefined)));
  assert(Number.isNaN(readBudget("")));
  assert(Number.isNaN(readBudget("   ")));
  assertEquals(readBudget("100"), 100);
});

Deno.test("usd: whole dollars, or cents under a dollar", () => {
  assertEquals(usd(0), "$0");
  assertEquals(usd(0.45), "45¢");
  assertEquals(usd(0.05), "5¢");
  assertEquals(usd(0.004), "$0"); // rounds to 0¢ -> $0
  assertEquals(usd(0.99), "99¢");
  assertEquals(usd(0.999), "$1"); // 99.9¢ rounds up to a dollar
  assertEquals(usd(1), "$1");
  assertEquals(usd(1955.4), "$1955");
});

Deno.test("escapeHtml", () => {
  assertEquals(escapeHtml(`<a href="x">&`), "&lt;a href=&quot;x&quot;&gt;&amp;");
});

Deno.test("sparkline: highlight overdraws the trailing count on the same scale", () => {
  const vals = Array.from({ length: 50 }, (_, i) => i); // strictly increasing
  const svg = sparkline(vals, "#111", { count: 10, color: "#eee" });
  const lines = [...svg.matchAll(/<polyline points="([^"]*)" fill="none" stroke="([^"]*)"/g)];
  assertEquals(lines.length, 2); // base + highlight
  const base = lines[0][1].trim().split(" ");
  const tail = lines[1][1].trim().split(" ");
  assertEquals(lines[0][2], "#111");
  assertEquals(lines[1][2], "#eee");
  assertEquals(base.length, 50);
  assertEquals(tail.length, 10); // exactly the median window
  assertEquals(tail[tail.length - 1], base[base.length - 1]); // ends on the same point
  assertEquals(tail[0], base[base.length - 10]); // starts at the 10th-from-last point
});

Deno.test("sparkline: scale normalizes to the recent runs, clipping old spikes", () => {
  const y = (pt: string) => parseFloat(pt.split(",")[1]);
  const ysOf = (svg: string) => svg.match(/<polyline points="([^"]*)"/)![1].trim().split(" ").map(y);
  // One huge old run, then four modest recent runs.
  const spiky = ysOf(sparkline([100, 10, 11, 12, 13], "#111", { count: 4, color: "#eee" }));
  assert(spiky[0] < 0, `old spike should clip above the viewport, got y=${spiky[0]}`);
  const recent = spiky.slice(1);
  assert(maxOf(recent) - minOf(recent) > 12, "recent runs should span most of the height");
  // Without the spike, the same recent runs land on the same scale (spike-independent).
  const clean = ysOf(sparkline([12, 10, 11, 12, 13], "#111", { count: 4, color: "#eee" }));
  assertEquals(clean.slice(1), recent);
});

Deno.test("sparkline: a trimmed scale ignores ranked extremes without reordering points", () => {
  const values = [101, 10, 0, 25, 100, 11, 1, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
  const scale = { trim: 2, minValues: 20 };
  const svg = sparkline(values, "#111", undefined, undefined, undefined, scale);
  const ys = svg.match(/<polyline points="([^"]*)"/)![1].trim().split(" ")
    .map((point) => parseFloat(point.split(",")[1]));

  assertEquals(values, [101, 10, 0, 25, 100, 11, 1, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]); // sorting the scale does not mutate the line
  assert(ys[0] < 0 && ys[4] < 0, "the two highest values should clip above the chart");
  assert(ys[2] > 26 && ys[6] > 26, "the two lowest values should clip below the chart");
  assert(ys[1] >= 0 && ys[1] <= 26 && ys[3] >= 0 && ys[3] <= 26, "20 points should enable trimming");

  const short = Array.from({ length: 19 }, (_, value) => value);
  assertEquals(
    sparkline(short, "#111", undefined, undefined, undefined, scale),
    sparkline(short, "#111"),
  );
});

Deno.test("sparkline: highlight scaleAll keeps the whole series in view, still drawing the tail", () => {
  const y = (pt: string) => parseFloat(pt.split(",")[1]);
  const polys = (svg: string) => [...svg.matchAll(/<polyline points="([^"]*)"/g)].map((m) => m[1].trim().split(" ").map(y));
  // Same one-huge-old / modest-recent data, but scaleAll scales to every point.
  const lines = polys(sparkline([100, 10, 11, 12, 13], "#111", { count: 4, color: "#eee", scaleAll: true }));
  assertEquals(lines.length, 2); // base + highlighted tail
  const [base, tail] = lines;
  // The spike is now the series max, so it stays in view (not clipped past the top).
  assert(base[0] >= 0, `spike should stay in view with scaleAll, got y=${base[0]}`);
  assertEquals(base[0], minOf(base), "the spike is the highest point (smallest y)");
  assertEquals(tail.length, 4); // the tail still covers the trailing 4 points
});

Deno.test("durationTag renders an auto-formatted span; sparkline itself has no label", () => {
  const tag = durationTag(25 * 86_400_000);
  assert(tag.includes(">25 days</span>"), "the ms duration is auto-formatted to '25 days'");
  assert(/position:absolute[^"]*left:1px[^"]*bottom:0/.test(tag), "pinned to the bottom-left corner");
  assert(!/<text/.test(tag), "must be HTML, not an SVG <text> element");
  // sparkline no longer draws any label itself — it returns a bare <svg>.
  const svg = sparkline([10, 11, 12, 13], "#111", { count: 2, color: "#eee" });
  assert(svg.startsWith("<svg") && svg.endsWith("</svg>"), "bare svg, no wrapper or label");
  assert([...svg.matchAll(/<polyline/g)].length === 2, "the line + highlight are still drawn");
});

Deno.test("sparklines share one rendered height", () => {
  const single = sparkline([1, 2], "#111");
  const multi = multiSparkline([{ vals: [1, 2], color: "#111" }]);
  const labeled = multiSparkline([{
    vals: [1, 2],
    color: "#111",
    label: "2",
  }]);

  assert(single.includes('height="28"'));
  assert(multi.includes('height="28"'));
  assert(labeled.includes('height="28"'));
  assert(labeled.includes("height:28px"));
});

Deno.test("sparkline: fades to base color at the highlight edge", () => {
  const svg = sparkline(
    [30, 20, 10, 11, 12, 13],
    "#727882",
    { count: 3, color: "#c7ccd4" },
    true,
  );
  assert(
    svg.includes(
      'gradientUnits="userSpaceOnUse" x1="0" y1="0" ' +
        'x2="220" y2="0"',
    ),
    "gradient spans the chart axis",
  );
  assert(
    svg.includes(
      '<stop offset="0" stop-color="#727882" stop-opacity="0"/>',
    ),
    "far-left stop is the transparent line color",
  );
  assert(
    svg.includes('stop-color="#727882" stop-opacity="1"'),
    "the gradient resolves to the opaque base color",
  );
  const id = svg.match(/id="([^"]+)"/)![1];
  assert(svg.includes(`stroke="url(#${id})"`), "the base line strokes with the gradient");
  assert(svg.includes('stroke="#c7ccd4"'), "the highlight keeps its flat color");
  // transition reaches base color by the tile midpoint (0.5), before the
  // highlight edge at (6-3)/(6-1) = 0.6
  assert(svg.includes('offset="0.500"'), "gradient reaches base color by the midpoint");
  // No fade -> flat base stroke, no gradient.
  assert(
    !/<linearGradient/.test(
      sparkline([1, 2, 3], "#727882", { count: 2, color: "#eee" }),
    ),
    "no gradient without a fade",
  );
});

Deno.test("sparkline: fade handoff follows the shared x axis", () => {
  const partial = sparkline(
    [30, 20, 10, 11, 12, 13],
    "#727882",
    { count: 3, color: "#c7ccd4" },
    true,
    [0, 0.05, 0.1, 0.2, 0.4, 0.8],
  );
  assert(
    partial.includes(
      'offset="0.200" stop-color="#727882" stop-opacity="1"',
    ),
    "the fade reaches full opacity where the highlighted tail starts",
  );

  const onePoint = sparkline(
    [1, 2, 3, 4],
    "#727882",
    { count: 1, color: "#c7ccd4" },
    true,
    [0, 0.02, 0.05, 0.1],
  );
  assert(
    onePoint.includes(
      'offset="0.500" stop-color="#727882" stop-opacity="1"',
    ),
    "a one-point tail keeps the midpoint fade",
  );
});

Deno.test("multiSparkline: overlaid lines on one shared scale; < 2 points is empty", () => {
  const svg = multiSparkline([
    { vals: [1, 2, 3], color: "#0a0" },
    { vals: [4, 5, 6], color: "#00a" },
  ]);
  assertEquals([...svg.matchAll(/<polyline/g)].length, 2);
  assert(svg.includes('stroke="#0a0"'), "first series color present");
  assert(svg.includes('stroke="#00a"'), "second series color present");
  // Shared scale (min 1, max 6): the second series sits above the first.
  const yOf = (stroke: string) => {
    const pts = svg.match(new RegExp(`points="([^"]*)"[^>]*stroke="${stroke}"`))![1].split(" ");
    return parseFloat(pts[0].split(",")[1]);
  };
  assert(yOf("#00a") < yOf("#0a0"), "higher values render higher (smaller y) on the shared scale");
  assertEquals(multiSparkline([{ vals: [5], color: "#000" }]), ""); // < 2 points
  assertEquals(multiSparkline([]), "");

  // Per-series label: the last value, right-anchored, in the line's color.
  const labeled = multiSparkline([
    { vals: [1, 2, 3], color: "#0a0", label: "3" },
    { vals: [4, 5, 6], color: "#00a", label: "6" },
  ]);
  assert(/right:0[^"]*color:#0a0[^"]*">3<\/span>/.test(labeled), "team label at right, in the line color");
  assert(/right:0[^"]*color:#00a[^"]*">6<\/span>/.test(labeled), "visitor label at right, in the line color");
});

Deno.test("multiSparkline: a trimmed shared scale pools series and centers a flat interior", () => {
  const scale = { trim: 2, minValues: 20 };
  const lines = [
    { vals: [101, 10, 0, 25, 100, 11, 1, 12, 13, 14], color: "#0a0" },
    { vals: [15, 16, 17, 18, 19, 20, 21, 22, 23, 24], color: "#00a" },
  ];
  const svg = multiSparkline(lines, { scale });
  const ys = [...svg.matchAll(/<polyline points="([^"]*)"/g)]
    .flatMap((match) => match[1].trim().split(" "))
    .map((point) => parseFloat(point.split(",")[1]));

  assertEquals(ys.length, 20);
  assertEquals(ys.filter((y) => y > 34).length, 2);
  assertEquals(ys.filter((y) => y < 0).length, 2);
  assertEquals(ys.filter((y) => y >= 0 && y <= 34).length, 16);

  const short = [
    { vals: Array.from({ length: 9 }, (_, value) => value), color: "#0a0" },
    { vals: Array.from({ length: 10 }, (_, value) => value + 9), color: "#00a" },
  ];
  assertEquals(multiSparkline(short, { scale }), multiSparkline(short));

  const flat = multiSparkline([
    { vals: [0, 10, 10, 10, 10, 10, 10, 10, 10, 100], color: "#0a0" },
    { vals: [1, 10, 10, 10, 10, 10, 10, 10, 10, 101], color: "#00a" },
  ], { scale });
  const flatYs = [...flat.matchAll(/<polyline points="([^"]*)"/g)]
    .flatMap((match) => match[1].trim().split(" "))
    .map((point) => parseFloat(point.split(",")[1]));
  assertEquals(flatYs.filter((y) => y === 17).length, 16);
});

Deno.test("multiSparkline: fades each line from its transparent color", () => {
  const svg = multiSparkline(
    [
      { vals: [1, 2, 3], color: "#0a0", label: "3" },
      { vals: [4, 5, 6], color: "#00a", label: "6" },
    ],
    { fade: true },
  );
  assert(
    svg.includes(
      'stop-color="#0a0" stop-opacity="0"/><stop offset="0.5" ' +
        'stop-color="#0a0" stop-opacity="1"',
    ),
    "team line fades from transparent to opaque",
  );
  assert(
    svg.includes(
      'stop-color="#00a" stop-opacity="0"/><stop offset="0.5" ' +
        'stop-color="#00a" stop-opacity="1"',
    ),
    "visitor line fades from transparent to opaque",
  );
  assert(
    /stroke="url\(#mspk-[0-9a-fA-F]+-\d+\)"/.test(svg),
    "lines stroke via their gradient",
  );
  // No fade -> flat strokes, no gradient definitions.
  assert(
    !/<linearGradient/.test(multiSparkline([{ vals: [1, 2], color: "#0a0" }, { vals: [3, 4], color: "#00a" }])),
    "no gradient without a fade",
  );
});

Deno.test("multiSparkline: overlapping end-labels are spread apart, not stacked", () => {
  // Both lines end at the same value -> same natural label height -> must separate.
  const svg = multiSparkline([
    { vals: [5, 5, 0], color: "#0a0", label: "$100" },
    { vals: [1, 1, 0], color: "#00a", label: "$50" },
  ]);
  // Match only the label spans (top:...px;transform), not the container's margin-top.
  const tops = [...svg.matchAll(/top:([0-9.]+)px;transform/g)].map((m) => parseFloat(m[1]));
  assertEquals(tops.length, 2);
  assert(Math.abs(tops[0] - tops[1]) >= 11, `labels should stay ~12px apart, got ${tops}`);
  // And they stay within the 28px-tall label band.
  for (const t of tops) assert(t >= 0 && t <= 28, `label ${t} within band`);

  const crowded = multiSparkline([
    { vals: [5, 5, 0], color: "#0a0", label: "$100" },
    { vals: [3, 3, 0], color: "#00a", label: "$75" },
    { vals: [1, 1, 0], color: "#a00", label: "$50" },
  ]);
  const crowdedTops = [...crowded.matchAll(/top:([0-9.]+)px;transform/g)]
    .map((match) => parseFloat(match[1]));
  assertEquals(crowdedTops.length, 3);
  for (const top of crowdedTops) {
    assert(top >= 6 && top <= 22, `label ${top} inside the chart`);
  }
  assert(
    crowdedTops[1] - crowdedTops[0] >= 8 &&
      crowdedTops[2] - crowdedTops[1] >= 8,
    `crowded labels use the available height: ${crowdedTops}`,
  );
});

Deno.test("lighten: blends a color toward white; non-hex is left alone", () => {
  assertEquals(lighten("#000000", 0.5), "#808080"); // halfway to white
  assertEquals(lighten("#ffffff", 0.5), "#ffffff"); // already white
  assertEquals(lighten("#000", 0.5), "#808080"); // 3-digit shorthand expands
  assertEquals(lighten("url(#grad)"), "url(#grad)"); // not a hex color
  const lit = lighten("#10a37f");
  assert(/^#[0-9a-f]{6}$/.test(lit) && lit !== "#10a37f");
  assert(parseInt(lit.slice(1, 3), 16) > 0x10, "each channel moves toward white");
});

Deno.test("multiSparkline: highlight redraws the trailing slice in a lighter tint", () => {
  const svg = multiSparkline(
    [{ vals: [1, 2, 3, 4, 5], color: "#10a37f", label: "5" }],
    { highlight: { count: 2 }, fade: true },
  );
  // The base line plus the lighter trailing slice drawn over it.
  assertEquals([...svg.matchAll(/<polyline/g)].length, 2);
  assert(svg.includes(`stroke="${lighten("#10a37f")}"`), "the slice is a lighter tint of the line's own color");
  // The base still fades up to the line's own color by the midpoint.
  assert(svg.includes('stop offset="0.5" stop-color="#10a37f"'), "gradient handoff at the midpoint");
  assert(!svg.includes("stroke-opacity"), "a lighter tint, not a flat dim");
  // No highlight -> just the one line, no tint.
  const plain = multiSparkline(
    [{ vals: [1, 2, 3], color: "#10a37f", label: "3" }],
    { fade: true },
  );
  assertEquals([...plain.matchAll(/<polyline/g)].length, 1);
});

Deno.test("multiSparkline: a series can supply a theme-aware highlight", () => {
  const svg = multiSparkline(
    [{
      vals: [1, 2, 3],
      color: "light-dark(#07523f,#10a37f)",
      highlightColor: "light-dark(#063e30,#a0dcca)",
    }],
    { highlight: { count: 2 } },
  );
  assert(svg.includes('stroke="light-dark(#063e30,#a0dcca)"'));
});

Deno.test("a slice covering the whole series leaves the line in its own color", () => {
  // A window at least as long as the series marks nothing off, so drawing it would
  // repaint the whole line in the tint and lose the line's own color.
  const whole = multiSparkline(
    [{ vals: [1, 2, 3, 4], color: "#10a37f", label: "4" }],
    { highlight: { count: 4 }, fade: true },
  );
  assertEquals([...whole.matchAll(/<polyline/g)].length, 1, "base only, no tint over it");
  assert(!whole.includes(lighten("#10a37f")), "the line keeps its own color");
  assert(
    whole.includes(
      '<stop offset="0" stop-color="#10a37f" stop-opacity="0"/>' +
        '<stop offset="0.5" stop-color="#10a37f" stop-opacity="1"',
    ),
    "the whole window retains the shared fade",
  );
  // Same for a count past the end of the series.
  const over = multiSparkline(
    [{ vals: [1, 2, 3, 4], color: "#10a37f" }],
    { highlight: { count: 9 }, fade: true },
  );
  assertEquals([...over.matchAll(/<polyline/g)].length, 1);
  assert(
    over.includes('offset="0.5" stop-color="#10a37f" stop-opacity="1"'),
    "a past-the-end window retains the shared fade",
  );
  // The single-color sparkline behaves the same way.
  const one = sparkline(
    [1, 2, 3, 4],
    "#727882",
    { count: 4, color: "#c7ccd4" },
    true,
  );
  assertEquals([...one.matchAll(/<polyline/g)].length, 1, "base only");
  assert(!one.includes("#c7ccd4"), "the line keeps its own color");
  assert(
    one.includes('offset="0.500" stop-color="#727882" stop-opacity="1"'),
    "the whole window retains the shared fade",
  );
});

Deno.test("multiSparkline: every base is drawn before any tint", () => {
  // Interleaving base and tint per series lets a later line's base paint over an
  // earlier line's tint wherever the two cross inside the window.
  const svg = multiSparkline([
    { vals: [1, 5, 1, 5], color: "#10a37f" },
    { vals: [5, 1, 5, 1], color: "#d97757" },
  ], { highlight: { count: 2 } });
  const strokes = [...svg.matchAll(/<polyline[^>]*stroke="([^"]*)"/g)].map((m) => m[1]);
  assertEquals(strokes, ["#10a37f", "#d97757", lighten("#10a37f"), lighten("#d97757")]);
});

Deno.test("multiSparkline: shared axes and per-line highlights", () => {
  const svg = multiSparkline([
    {
      vals: [1, 2, 3],
      color: "#10a37f",
      xs: [0, 0.2, 0.4],
      highlightCount: 2,
    },
    {
      vals: [4, 5, 6],
      color: "#d97757",
      xs: [0.6, 0.8, 1],
      highlightCount: 0,
    },
  ], { fade: true });
  const lines = [
    ...svg.matchAll(
      /<polyline points="([^"]*)"[^>]*stroke="([^"]*)"/g,
    ),
  ].map((match) => ({
    points: match[1].split(" "),
    stroke: match[2],
  }));
  assertEquals(lines.length, 3);
  assertEquals(
    lines[0].points.map((point) => Number(point.split(",")[0])),
    [0, 44, 88],
  );
  assertEquals(
    lines[1].points.map((point) => Number(point.split(",")[0])),
    [132, 176, 220],
  );
  assertEquals(lines[2].stroke, lighten("#10a37f"));
  assertEquals(
    lines[2].points.map((point) => Number(point.split(",")[0])),
    [44, 88],
  );
  assert(!svg.includes("<mask"));
  assert(
    svg.includes(
      'gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="220" y2="0"',
    ),
    "partial lines fade over the shared chart axis",
  );
  assert(
    svg.includes(
      '<stop offset="0.2" stop-color="#10a37f" stop-opacity="1"',
    ),
  );
  assert(
    svg.includes(
      '<stop offset="0.5" stop-color="#d97757" stop-opacity="1"',
    ),
  );
});

Deno.test("multiSparkline: one-point markers are explicit", () => {
  const svg = multiSparkline([
    {
      vals: [5],
      color: "#d97757",
      xs: [0.75],
      showSinglePoint: true,
    },
  ]);
  assert(
    svg.includes(
      '<circle cx="165.0" cy="31.0" r="1.0" fill="#d97757"/>',
    ),
  );
  assertEquals([...svg.matchAll(/<polyline/g)].length, 0);
});

Deno.test("multiSparkline: large horizontal gaps split paths without losing points", () => {
  const svg = multiSparkline([{
    vals: [1, 2, 3, 4, 5],
    color: "#d97757",
    xs: [0, 0.2, 0.41, 0.5, 0.8],
    highlightCount: 4,
    maxXGap: 0.2,
    showSinglePoint: true,
  }]);
  const paths = [
    ...svg.matchAll(/<polyline points="([^"]+)"[^>]*stroke="([^"]+)"/g),
  ].map((match) => ({
    points: match[1].split(" "),
    stroke: match[2],
  }));
  assertEquals(paths, [
    {
      points: ["0.0,31.0", "44.0,24.0"],
      stroke: "#d97757",
    },
    {
      points: ["90.2,17.0", "110.0,10.0"],
      stroke: "#d97757",
    },
    {
      points: ["90.2,17.0", "110.0,10.0"],
      stroke: lighten("#d97757"),
    },
  ]);
  assert(
    svg.includes(
      `<circle cx="176.0" cy="3.0" r="1.0" fill="${
        lighten("#d97757")
      }"/>`,
    ),
  );

  const offsetBoundary = multiSparkline([{
    vals: [1, 2],
    color: "#d97757",
    xs: [0.6, 0.8],
    maxXGap: 0.2,
    showSinglePoint: true,
  }]);
  assertEquals([...offsetBoundary.matchAll(/<polyline/g)].length, 1);
  assertEquals([...offsetBoundary.matchAll(/<circle/g)].length, 0);
});

Deno.test("multiSparkline: disconnected paths share one chart-axis fade", () => {
  const svg = multiSparkline([{
    vals: [1, 2, 3, 4],
    color: "#d97757",
    xs: [0, 0.1, 0.7, 0.8],
    highlightCount: 4,
    maxXGap: 0.2,
  }], { fade: true });
  const strokes = [
    ...svg.matchAll(/<polyline[^>]*stroke="([^"]+)"/g),
  ].map((match) => match[1]);
  assertEquals(strokes.length, 2);
  assertEquals(new Set(strokes).size, 1);
  assertEquals([...svg.matchAll(/<linearGradient/g)].length, 1);
  assert(strokes[0].startsWith("url(#mspk-"));
  assert(
    svg.includes(
      'gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="220" y2="0"',
    ),
  );
  assert(
    svg.includes(
      '<stop offset="0.5" stop-color="#d97757" stop-opacity="1"',
    ),
  );
});

Deno.test("multiSparkline: isolated markers use the tint only inside the highlighted tail", () => {
  const color = "#d97757";
  const svg = multiSparkline([{
    vals: [1, 2, 3, 4, 5, 6],
    color,
    xs: [0, 0.25, 0.4, 0.5, 0.7, 0.95],
    highlightCount: 2,
    maxXGap: 0.2,
    showSinglePoint: true,
  }]);
  const fills = [
    ...svg.matchAll(/<circle[^>]*fill="([^"]+)"/g),
  ].map((match) => match[1]);
  assertEquals(fills, [color, lighten(color)]);
});

Deno.test("sparkline: xs place points on a shared axis", () => {
  const coords = (svg: string) => svg.match(/<polyline points="([^"]*)"/)![1].trim().split(" ");
  const x0 = (p: string[]) => parseFloat(p[0].split(",")[0]);
  const xLast = (p: string[]) => parseFloat(p[p.length - 1].split(",")[0]);
  // A late-starting series: on the right 40% of the axis (ends at the right edge).
  const late = coords(sparkline([1, 2, 3], "#111", undefined, undefined, [0.6, 0.8, 1.0]));
  assert(Math.abs(x0(late) - 0.6 * 220) < 0.5, "starts at 60% of the width");
  assert(Math.abs(xLast(late) - 220) < 0.5, "ends at the right edge");
  // A stale series: ends short of the right edge.
  const stale = coords(sparkline([1, 2, 3], "#111", undefined, undefined, [0, 0.35, 0.7]));
  assertEquals(x0(stale), 0);
  assert(Math.abs(xLast(stale) - 0.7 * 220) < 0.5, "ends short of the right edge");
  // No xs -> evenly spaced full width.
  assertEquals(x0(coords(sparkline([1, 2, 3], "#111"))), 0);
});

Deno.test("thin: caps length, keeps the first and last, evenly spaced", () => {
  assertEquals(thin([1, 2, 3], 5), [1, 2, 3]); // already within max -> unchanged
  const t = thin(Array.from({ length: 1000 }, (_, i) => i), 100);
  assertEquals(t.length, 100);
  assertEquals(t[0], 0);
  assertEquals(t[t.length - 1], 999);
  // strictly increasing (no repeats when downsampling a dense range)
  assert(t.every((v, i) => i === 0 || v > t[i - 1]), "evenly spaced, no repeats");
});

Deno.test("strip: each cell links to that run's CI results in a new tab", () => {
  const html = strip([
    { outcome: "green", href: "https://github.com/o/r/actions/runs/1" },
    { outcome: "red", href: "https://github.com/o/r/actions/runs/2" },
  ]);
  assertEquals([...html.matchAll(/<a class="cell"/g)].length, 2);
  assert(html.includes('href="https://github.com/o/r/actions/runs/1"'), "first run link");
  assert(html.includes('href="https://github.com/o/r/actions/runs/2"'), "second run link");
  assert(html.includes('target="_blank"'), "opens in a new tab");
  assertStringIncludes(
    strip([{ outcome: "green", href: "" }], true),
    'class="cells labeled"',
  );
  assertEquals(strip([]), ""); // empty -> nothing
});

Deno.test("sparkline: no highlight is a single line; a short series is empty", () => {
  assertEquals([...sparkline([1, 2, 3], "#111").matchAll(/<polyline/g)].length, 1);
  // A degenerate highlight (< 2 points) adds no second line.
  assertEquals([...sparkline([1, 2, 3], "#111", { count: 1, color: "#eee" }).matchAll(/<polyline/g)].length, 1);
  assertEquals(sparkline([5], "#111"), "");
});

Deno.test("median: an even count takes the mean of the two middle values", () => {
  // The ci-duration window is 20 runs, so even is the normal case. Taking the
  // upper middle alone reports a value no sample had, and always the higher of
  // the pair.
  assertEquals(median([2, 4, 6, 8]), 5);
  assertEquals(median([2, 4, 6, 10]), 5);
  assertEquals(median([1, 2, 3]), 2); // odd is the middle sample itself
  assertEquals(median([7]), 7);
  assertEquals(median([]), 0);
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
  assertEquals(median(twenty), 10.5); // not 11
});

Deno.test("median: sorts its input, and leaves the caller's array alone", () => {
  const values = [9, 1, 5];
  assertEquals(median(values), 5);
  assertEquals(values, [9, 1, 5]);
});

Deno.test("jsonFromZip: reads a stored json member, ignoring a text member beside it", async () => {
  const zip = makeZip([
    { name: "notes.txt", method: 0, data: bytes("not the report") },
    { name: "results.json", method: 0, data: bytes(`{"benches":[]}`) },
  ]);
  assertEquals(await jsonFromZip(zip), `{"benches":[]}`);
});

Deno.test("jsonFromZip: inflates a deflated json member", async () => {
  const json = `{"metrics":[{"name":"coverage-debt: tasks uncovered lines"}]}`;
  assertEquals(await jsonFromZip(await artifactZip("perf-metrics.json", json)), json);
});

Deno.test("jsonFromZip: a zip with no json member -> null", async () => {
  const zip = makeZip([{
    name: "notes.txt",
    method: 0,
    data: bytes("nothing"),
  }]);
  assertEquals(await jsonFromZip(zip), null);
});

Deno.test("jsonFromZip: bytes with no end-of-central-directory record -> null", async () => {
  assertEquals(await jsonFromZip(new Uint8Array(10)), null); // shorter than the record itself
  assertEquals(await jsonFromZip(new Uint8Array(200)), null);
});

Deno.test("jsonFromZip: a central directory shorter than its own count stops instead of reading past it", async () => {
  const zip = makeZip([{ name: "notes.txt", method: 0, data: bytes("x") }], 2);
  assertEquals(await jsonFromZip(zip), null);
});

Deno.test("jsonFromZip: a member whose local header the central directory does not point at -> null", async () => {
  const zip = makeZip([{
    name: "results.json",
    method: 0,
    data: bytes(`{"benches":[]}`),
  }]);
  new DataView(zip.buffer).setUint32(0, 0xdeadbeef, true); // clobber the local file header signature
  assertEquals(await jsonFromZip(zip), null);
});

Deno.test("jsonFromZip: a compression method we cannot read -> null, not garbage", async () => {
  const zip = makeZip([{
    name: "results.json",
    method: 99,
    data: bytes(`{"benches":[]}`),
  }]);
  assertEquals(await jsonFromZip(zip), null);
});
