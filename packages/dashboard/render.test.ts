/**
 * Rendering tests: renderTile turns a TileView into markup, shell wraps the grid
 * in the page. Pure string work — no server, no network, no subprocess.
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import type { Status, TileView } from "./types.ts";
import {
  FAVICON_CRY_AFTER_MS,
  formatViewerTimes,
  renderTile,
  shell,
} from "./render.ts";
import { humanSpan, STATUS_DOT } from "./lib.ts";
import {
  STATUS_EDGE,
  STATUS_WASH,
  TEXTURE_ALPHA,
  TEXTURE_WIDTH,
} from "./palette.ts";
import { FAVICON_VERSION } from "./favicon.ts";
import { followUpdates, liveUpdateStream } from "./stream-client.ts";
import { reconcileTiles } from "./tiles-client.ts";
import { TILE_LABEL_RULE } from "./chart-layout.ts";

const TEST_VERSION = "1".repeat(40);

function view(over: Partial<TileView> = {}): TileView {
  return { status: "good", ...over };
}

Deno.test("renderTile: status drives the tile class, the dot color and the headline color", () => {
  const dots: Record<Status, string> = {
    good: "green",
    warn: "amber",
    bad: "red",
    unknown: "gray",
  };
  for (const [status, dot] of Object.entries(dots) as [Status, string][]) {
    const html = renderTile("labs ci", view({ status, value: "passing" }));
    assertStringIncludes(html, `class="tile ${status}"`);
    assertStringIncludes(html, `<span class="dot ${dot}"></span>`);
    assertStringIncludes(html, `<p class="big ${status}">passing</p>`);
  }
});

Deno.test("renderTile: no href -> a plain div, not a link", () => {
  const html = renderTile("labs ci", view());
  assert(html.startsWith(`<div class="tile good" data-tile-label="labs ci">`), html);
  assert(html.endsWith("</div>"));
  assert(!html.includes("<a "), "nothing to drill into, so no anchor");
  assert(!html.includes(" link"), "the link class is only for tiles that link");
});

Deno.test("renderTile: the label becomes the key an update matches the tile by", () => {
  assertStringIncludes(
    renderTile("labs ci", view()),
    `<div class="tile good" data-tile-label="labs ci">`,
  );
  assertStringIncludes(
    renderTile("labs ci duration", view({ href: "/ci" })),
    `<a class="tile good link" data-tile-label="labs ci duration" href="/ci">`,
  );
});

Deno.test("renderTile: an http href is an anchor that opens a new tab; a local one stays in place", () => {
  const external = renderTile("labs ci", view({ href: "https://github.com/o/r/actions" }));
  assertStringIncludes(
    external,
    `<a class="tile good link" data-tile-label="labs ci" href="https://github.com/o/r/actions" target="_blank" rel="noopener">`,
  );
  const local = renderTile("labs ci", view({ href: "/bench" }));
  assertStringIncludes(local, `<a class="tile good link" data-tile-label="labs ci" href="/bench">`);
  assert(
    !local.includes("target="),
    "a drill-down on this server replaces the page",
  );
});

Deno.test("renderTile: wide adds the class the shell lays out below the grid", () => {
  assertStringIncludes(
    renderTile("labs ci", view(), true),
    `class="tile good wide"`,
  );
  assertStringIncludes(
    renderTile("labs ci", view({ href: "/x" }), true),
    `class="tile good link wide"`,
  );
  assert(!renderTile("labs ci", view()).includes("wide"));
});

Deno.test("renderTile: an absent value/sub/hint/aside renders nothing rather than an empty element", () => {
  const html = renderTile("labs ci", view());
  assertEquals(
    html,
    `<div class="tile good" data-tile-label="labs ci"><div class="texture"></div><p class="lbl"><span class="dot green"></span> labs ci<span class="spacer"></span></p></div>`,
  );
});

Deno.test("renderTile: label and sub are escaped — a hostile label cannot inject markup", () => {
  const html = renderTile(
    `<img src=x onerror="alert(1)">`,
    view({ sub: `a & b "quoted" <script>` }),
  );
  assert(!html.includes("<img"), "the label's tag is defanged");
  assert(!html.includes("<script>"), "the sub line's tag is defanged");
  assertStringIncludes(html, "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assertStringIncludes(
    html,
    `data-tile-label="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"`,
  );
  assertStringIncludes(
    html,
    `<p class="sub" title="a &amp; b &quot;quoted&quot; &lt;script&gt;">a &amp; b &quot;quoted&quot; &lt;script&gt;</p>`,
  );
});

Deno.test("renderTile: value, extra and aside are trusted html; hint is escaped", () => {
  const html = renderTile("labs ci", view({
    href: "/commits",
    value: `<b>42</b>`,
    aside: `<span class="hfacet">$12</span>`,
    extra: `<svg viewBox="0 0 1 1"></svg>`,
    hint: `commits ↗ <not a "tag">`,
  }));
  // A tile builds these itself, escaping any data it puts in them.
  assertStringIncludes(html, `<p class="big good"><b>42</b></p>`);
  assert(!html.includes(`title="&lt;b&gt;42&lt;/b&gt;"`));
  assertStringIncludes(html, `<span class="hfacet">$12</span>`);
  assertStringIncludes(html, `<svg viewBox="0 0 1 1"></svg>`);
  // The hint is plain text from the tile, so the renderer escapes it.
  assertStringIncludes(
    html,
    `<span class="drill" title="commits ↗ &lt;not a &quot;tag&quot;&gt;" aria-hidden="true">↗</span>`,
  );
  assertStringIncludes(
    html,
    `<a class="tile good link" data-tile-label="labs ci" href="/commits" aria-description="commits ↗ &lt;not a &quot;tag&quot;&gt;" title="commits ↗ &lt;not a &quot;tag&quot;&gt;">`,
  );
});

Deno.test("renderTile: a plain headline label supplies truncated text", () => {
  const html = renderTile("labs ci", view({
    value: `<b>42</b>`,
    valueLabel: `42 "requests"`,
  }));
  assertStringIncludes(
    html,
    `<p class="big good" title="42 &quot;requests&quot;"><b>42</b></p>`,
  );
});

Deno.test("renderTile: the aside and hint sit after the label, separated by the spacer", () => {
  const html = renderTile("labs ci", view({ aside: "<i>mtd</i>", hint: "runs" }));
  assertStringIncludes(
    html,
    `<p class="lbl"><span class="dot green"></span> labs ci<span class="spacer"></span><i>mtd</i><span class="drill" title="runs" aria-hidden="true">↗</span></p>`,
  );
});

Deno.test("renderTile: a duration wraps the chart so the span can be pinned to its corner", () => {
  const html = renderTile(
    "labs ci",
    view({ extra: "<svg></svg>", duration: 25 * 86_400_000 }),
  );
  assertStringIncludes(
    html,
    `<div class="chart" style="position:relative"><svg></svg>`,
  );
  // The corner tag is the auto-formatted span, and it is inside the wrapper.
  assertStringIncludes(html, ">25 days</span></div>");
  assertStringIncludes(html, "position:absolute");
});

Deno.test("renderTile: no duration leaves extra unwrapped", () => {
  const html = renderTile("labs ci", view({ extra: "<svg></svg>" }));
  assertStringIncludes(html, "<svg></svg>");
  assert(
    !html.includes("position:relative"),
    "nothing to position, so no wrapper",
  );
});

Deno.test("renderTile: a duration with no chart draws nothing to label", () => {
  // The span labels the chart's corner. With no chart the wrapper has no height, so
  // the label would sit on top of the sub line. A tile whose series is too short to
  // plot still reports a span, so this happens: dau's first day, for one.
  const html = renderTile("labs ci", view({ sub: "things", duration: 90 * 60_000 }));
  assert(
    !html.includes("position:relative"),
    "nothing to position, so no wrapper",
  );
  assert(!html.includes(humanSpan(90 * 60_000)), "and no orphaned span label");
  assertStringIncludes(html, `<p class="sub" title="things">things</p>`); // the sub is left alone
});

Deno.test("renderTile: the body order is label, headline, sub, chart", () => {
  const html = renderTile(
    "labs ci",
    view({ value: "42", sub: "things", extra: "<svg></svg>" }),
  );
  const at = (needle: string) => html.indexOf(needle);
  assert(at(`class="lbl"`) < at(`class="big`), "label first");
  assert(at(`class="big`) < at(`class="sub"`), "headline above the sub line");
  assert(at(`class="sub"`) < at("<svg>"), "the chart is last");
});

Deno.test("shell: the grid and the wide tiles land in their own slots", () => {
  const html = shell(
    `<div class="tile good">g</div>`,
    `<div class="tile bad wide">w</div>`,
    3,
    30_000,
    TEST_VERSION,
    "bad",
  );
  assertStringIncludes(
    html,
    `<div class="grid" id="dashboard-grid"><div class="tile good">g</div></div>`,
  );
  assertStringIncludes(
    html,
    `<div id="dashboard-wide"><div class="tile bad wide">w</div></div>`,
  );
  // Wide tiles sit after the grid, not inside it.
  assert(html.indexOf(`class="grid"`) < html.indexOf(`tile bad wide`));
  assert(html.startsWith("<!doctype html>"), "a whole page, not a fragment");
  assertStringIncludes(html, "<title>Dashboard — LIVE</title>");
  assertStringIncludes(
    html,
    `href="/favicon.png?status=bad&v=${FAVICON_VERSION}"`,
  );
  assertStringIncludes(html, "</body></html>");
});

Deno.test("shell: labeled cell grids share the sparkline label baseline", () => {
  const html = shell("", "", 0, 30_000, TEST_VERSION, "good");
  assertStringIncludes(
    html,
    `.cells.labeled{margin-top:9px;height:28px;align-content:end;align-items:start;transform:translateY(-2px)}`,
  );
  assertStringIncludes(
    html,
    `.cells.labeled .cell{width:100%}`,
  );
  assertStringIncludes(
    html,
    `.cells{display:grid;grid-template-columns:repeat(40,min(7.5px,`,
  );
  assertStringIncludes(html, `.chart>span:last-child{bottom:2px!important}`);
  assertStringIncludes(html, `.cells.labeled+span{font-weight:700;text-shadow:`);
  assertStringIncludes(html, `.tile.bottom-chart{display:flex;flex-direction:column}`);
  assertStringIncludes(html, `.tile.bottom-chart .chart{margin-top:auto}`);
  assertStringIncludes(html, TILE_LABEL_RULE);
});

Deno.test("renderTile: a bottom-aligned chart can absorb a taller grid row", () => {
  const html = renderTile("labs ci", view({
    extra: "<svg></svg>",
    duration: 86_400_000,
    alignChartBottom: true,
  }));
  assertStringIncludes(html, `class="tile good bottom-chart"`);
  assertStringIncludes(html, `class="chart"`);
});

Deno.test("shell: the shared message is directly editable in the header center", () => {
  const html = shell(
    "",
    "",
    0,
    45_000,
    TEST_VERSION,
    "good",
    null,
    null,
    {
      text: `Ship <today> & "celebrate"`,
      updatedAt: 12_345,
      revision: 7,
    },
  );
  assertStringIncludes(html, `id="dashboard-message-form"`);
  assertStringIncludes(html, `id="dashboard-message"`);
  assert(!html.includes(`placeholder=`), "the empty editor has no hint text");
  assertStringIncludes(
    html,
    `value="Ship &lt;today&gt; &amp; &quot;celebrate&quot;"`,
  );
  assertStringIncludes(html, `let messageUpdatedAt = 12345;`);
  assertStringIncludes(html, `let messageRevision = 7;`);
  assertStringIncludes(html, `if (next.revision < messageRevision) return;`);
  assertStringIncludes(html, `const saveSequence = ++messageSaveSequence;`);
  assertStringIncludes(
    html,
    `if (!messageDirty && !messageSavePending) messageInput.value = next.text;`,
  );
  assertStringIncludes(html, `messageSavePending = true;`);
  assertStringIncludes(html, `messageSavePending = false;`);
  assertStringIncludes(
    html,
    `draftProtected: messageDirty || messageSavePending,`,
  );
  assert(
    !html.includes(`document.activeElement === messageInput`),
    "focus alone does not suspend message fading",
  );
  assertStringIncludes(
    html,
    `.message-form:focus-within{background:var(--surface);box-shadow:`,
  );
  assertStringIncludes(html, `.message-input:focus{outline:none}`);
  assertStringIncludes(
    html,
    `if (!messageDirty) messageInput.value = savedMessageText;`,
  );
  assertStringIncludes(
    html,
    `if (saveSequence !== messageSaveSequence) return;`,
  );
  assertStringIncludes(html, `fetch('/message'`);
  assertStringIncludes(html, `method: 'PUT'`);
  assertStringIncludes(html, `aria-describedby="dashboard-message-status"`);
  assertStringIncludes(html, `role="status" aria-live="polite"`);
  assertStringIncludes(html, `Message could not be saved.`);
  const brandAt = html.indexOf(`class="brand"`);
  const messageAt = html.indexOf(`id="dashboard-message-form"`);
  const freshnessAt = html.indexOf(`class="top-actions"`);
  assert(
    brandAt < messageAt && messageAt < freshnessAt,
    "the shared message sits between the left and right header content",
  );
  assertStringIncludes(
    html,
    `.top{display:grid;grid-template-columns:max-content minmax(0,1fr) max-content`,
  );
  assertStringIncludes(html, `.message-form{position:relative;width:min(100%,480px)`);
  assertStringIncludes(html, `text-align:center`);
  assertStringIncludes(
    html,
    `@media(max-width:560px){.top{grid-template-columns:minmax(0,1fr) max-content`,
  );
  assertStringIncludes(
    html,
    `.message-form{grid-column:1/-1;grid-row:2;width:100%}`,
  );
});

Deno.test("shell: the freshness age and the refresh interval reach both the text and the script", () => {
  const html = shell("", "", 7, 45_000, TEST_VERSION, "good");
  assertStringIncludes(html, `<span id="agotext">updated 7s ago</span>`);
  assertStringIncludes(html, "const REFRESH = 45000;");
  assertStringIncludes(
    html,
    `const SHELL_VERSION = ${JSON.stringify(TEST_VERSION)};`,
  );
  assertStringIncludes(html, "let base = 7;");
  assertStringIncludes(html, `new EventSource('/events')`);
  assertStringIncludes(
    html,
    `const updates = followUpdates(() => new EventSource('/events'), RED_AFTER, paint, {`,
  );
  assertStringIncludes(html, `update: (data) => {`);
  assertStringIncludes(
    html,
    `const followUpdates = ${followUpdates.toString()};`,
  );
  assertStringIncludes(html, `updateTiles(grid, update.gridHtml)`);
  assertStringIncludes(html, `updateTiles(wide, update.wideHtml)`);
  assertStringIncludes(
    html,
    `if (update.shellVersion !== SHELL_VERSION) { location.reload(); return; }`,
  );
  assertEquals(
    html.match(/location\.reload\(\)/g)?.length,
    1,
    "a version mismatch is the one thing that navigates the page",
  );
  assertStringIncludes(
    html,
    `const reconcileTiles = ${reconcileTiles.toString()};`,
  );
});

Deno.test("shell: the page watches its own stream and reopens one that stops delivering", () => {
  const html = shell("", "", 0, 45_000, TEST_VERSION, "good");
  // The silence the page reconnects on is the silence that turns the dot red.
  assertStringIncludes(html, "const RED_AFTER = REFRESH + 10000;");
  assertStringIncludes(html, `ago * 1000 <= RED_AFTER ? 'amber' : 'red'`);
  assertStringIncludes(html, `followUpdates(() => new EventSource('/events'), RED_AFTER, paint, {`);
  assertStringIncludes(
    html,
    `badge.textContent = updates.check(now) ? '● LIVE' : '● OFFLINE';`,
  );
  assertStringIncludes(html, `document.addEventListener('visibilitychange', paint);`);
  assertStringIncludes(html, `addEventListener('online', paint);`);
});

Deno.test("shell: the injected script is JavaScript, and each injected function stands alone", () => {
  // The functions the page runs are authored as TypeScript here and reach the
  // browser as the text of `Function.prototype.toString()`. That text has to be
  // JavaScript the browser accepts, and it has to stand alone: a reference to
  // anything outside the function is a name the page does not have. Neither
  // property is visible to a test that only looks for substrings.

  const scripts = [...shell("", "", 0, 45_000, TEST_VERSION, "good")
    .matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  // Parses every script without running it, which is where a leftover type
  // annotation or generic parameter would show up.
  for (const script of scripts) new Function(script);
  const script = scripts.at(-1)!;

  // Evaluated on its own, outside its module, so a reference to anything at
  // module scope throws instead of quietly resolving.
  const source = script.match(
    /const liveUpdateStream = ([\s\S]*?);\n {2}const followUpdates =/,
  )![1];
  const injected = new Function(`return (${source});`)() as typeof liveUpdateStream;

  const opened: { readyState: number; closed: boolean; close(): void }[] = [];
  const live = injected(55_000, () => {
    const stream = {
      readyState: 0,
      closed: false,
      close() {
        this.closed = true;
      },
    };
    opened.push(stream);
    return stream;
  });
  assert(live.check(0), "the page starts out hearing the server that served it");
  assertEquals(opened.length, 1);
  opened[0].readyState = 1;
  live.heard(0);
  assert(live.check(54_999));
  assertEquals(opened.length, 1, "a stream that is delivering is left alone");
  assertEquals(live.check(55_000), false, "and one that goes quiet is replaced");
  assertEquals(opened.length, 2);
  assert(opened[0].closed);

  // The only name it reaches outside itself is the one injected before it.
  const follow = new Function(
    "liveUpdateStream",
    `return (${script.match(/const followUpdates = ([\s\S]*?);\n {2}const badge =/)![1]});`,
  )(injected) as typeof followUpdates;
  const listeners = new Map<string, (event: { data: string }) => void>();
  let painted = 0;
  const followed = follow(() => ({
    readyState: 1,
    close() {},
    addEventListener: (type, listener) => listeners.set(type, listener),
  }), 55_000, () => painted++, {});
  followed.check(Date.now());
  listeners.get("ping")!({ data: "1" });
  assertEquals(painted, 1, "a heartbeat repaints the page");
});

Deno.test("shell: live data and runtime settings keep the compatibility version", () => {
  const first = shell(
    `<div class="tile good">first</div>`,
    "",
    0,
    30_000,
    TEST_VERSION,
    "good",
  );
  const second = shell(
    `<div class="tile bad">second</div>`,
    `<div class="tile warn wide">third</div>`,
    999,
    30_000,
    TEST_VERSION,
    "bad",
    123,
    456,
  );
  const differentRefresh = shell(
    "",
    "",
    0,
    60_000,
    TEST_VERSION,
    "good",
  );
  const embedded = (html: string): string =>
    html.match(/const SHELL_VERSION = "([^"]+)";/)?.[1] ?? "";
  assertEquals(embedded(first), TEST_VERSION);
  assertEquals(embedded(second), TEST_VERSION);
  assertEquals(embedded(differentRefresh), TEST_VERSION);
});

Deno.test("formatViewerTimes: the viewer's formatter replaces the UTC fallback", () => {
  const time = { dateTime: "2024-01-02T17:05:00Z", textContent: "17:05 UTC" };
  const viewerTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  formatViewerTimes([time], viewerTime);
  assertEquals(time.textContent, "09:05");
});

Deno.test("shell: the browser runs the viewer-time formatter", () => {
  const html = shell("", "", 0, 30_000, TEST_VERSION, "good");
  const source = formatViewerTimes.toString();
  assertStringIncludes(source, `time[data-viewer-time][datetime]`);
  assert(
    !source.includes("timeZone"),
    "the default formatter must use the viewer's timezone",
  );
  assertStringIncludes(html, source);
  assertStringIncludes(html, "formatViewerTimes();");
  const localizeUpdate = html.indexOf(
    `formatViewerTimes(template.content.querySelectorAll('time[data-viewer-time][datetime]'));`,
  );
  const compareMarkup = html.indexOf(
    "reconcileTiles(container, Array.from(template.content.children));",
  );
  assert(localizeUpdate >= 0, "live updates localize their timestamps");
  assert(
    localizeUpdate < compareMarkup,
    "live updates are localized before their markup is compared",
  );
});

Deno.test("shell: the texture fades out towards the bottom of its own tile", () => {
  const html = shell(renderTile("labs ci", view({ status: "bad" })), "", 0, 30_000, TEST_VERSION, "bad");
  assertStringIncludes(html, `<div class="texture"></div>`);
  // Measured against the tile: whole for its top seventh, gone seven tenths
  // of the way down.
  assertStringIncludes(
    html,
    ".texture{position:absolute;inset:0;z-index:-1;overflow:hidden;mask-image:linear-gradient(to bottom,#000 15%,transparent 70%)}",
  );
  // Measured against the turned frame the texture is drawn in.
  assertStringIncludes(
    html,
    ".texture::before{content:\"\";position:absolute;top:50%;left:50%;",
  );
  for (const status of ["unknown", "warn", "bad"]) {
    assertStringIncludes(html, `.tile.${status} .texture::before{`);
  }
  // The stroked textures are drawn at the width the palette sets, inside the
  // data URI that carries them.
  const strokes = [...html.matchAll(/stroke-width%3D%22([\d.]+)%22/g)];
  assertEquals(strokes.length, 2, "one stroked texture each for warn and bad");
  for (const stroke of strokes) assertEquals(Number(stroke[1]), TEXTURE_WIDTH);
  assertEquals(
    [...html.matchAll(/stroke%3D%22black%22/g)].length,
    2,
    "texture masks use opaque strokes and take their color from the page theme",
  );
  assertEquals(
    [...html.matchAll(/;mask-image:var\(--texture-mask\)/g)].length,
    2,
    "both textures apply their generated mask",
  );
  assertEquals(
    [...html.matchAll(/-webkit-mask-image:var\(--texture-mask\)/g)].length,
    2,
    "both textures apply their generated mask in WebKit",
  );
  for (const status of ["warn", "bad"]) {
    assertStringIncludes(
      html,
      `background-color:color-mix(in srgb,var(--status-${status}) ${
        TEXTURE_ALPHA * 100
      }%,transparent)`,
    );
  }
  assertStringIncludes(
    html,
    "radial-gradient(color-mix(in srgb,var(--status-unknown) 15%,transparent) 1px,transparent 1px)",
  );
  // A pattern repeats at the size of the artwork that draws it. The two are
  // written separately into the CSS, and a pattern drawn at one size and tiled
  // at another is stretched.
  const tiles = [
    ...html.matchAll(
      /width%3D%22(\d+)%22%20height%3D%22(\d+)%22[^;]*;mask-size:(\d+)px (\d+)px/g,
    ),
  ];
  assertEquals(tiles.length, 2, "both stroked textures set their own size");
  for (const [, width, height, sizeX, sizeY] of tiles) {
    assertEquals(sizeX, width, "the pattern tiles at the width it is drawn at");
    assertEquals(sizeY, height, "and at the height it is drawn at");
  }
});

Deno.test("shell: the turned texture layer still covers a tile far wider than it is tall", () => {
  const html = shell("", "", 0, 30_000, TEST_VERSION, "bad");
  const layer = /\.texture::before\{[^}]*width:(\d+)%[^}]*\}/.exec(html);
  assert(layer, "the texture layer sets its own size");
  assertStringIncludes(layer[0], "aspect-ratio:1");
  assertStringIncludes(layer[0], "top:50%;left:50%");
  assertStringIncludes(layer[0], "translate(-50%,-50%)");
  // Turning a square about its center sweeps its corners inward, so the layer
  // covers the tile only while half its side still reaches the tile's corner.
  // That reach is the tile's half-diagonal. The layer is measured off the
  // tile's width alone, so the shape that strains it is a tall narrow tile: the
  // tightest the dashboard's grid gets is a tile 0.94 as tall as it is wide,
  // and this asks for room well past that.
  const tallest = 1.5;
  const halfSide = Number(layer[1]) / 100 / 2;
  assert(
    halfSide >= Math.hypot(1, tallest) / 2,
    `a layer of ${layer[1]}% of the tile width leaves the corners of a tile ${
      tallest
    } times as tall as it is wide outside it once turned`,
  );
});

Deno.test("shell: the header dot takes a shape per status, not just a color", () => {
  const html = shell(renderTile("labs ci", view()), "", 0, 30_000, TEST_VERSION, "good");
  // The dot is empty and its shape is drawn by a layer inside it.
  assertStringIncludes(html, `.dot::before{content:"";position:absolute;inset:0}`);
  const shapes = (["good", "warn", "bad", "unknown"] as Status[]).map((status) => {
    const rule = new RegExp(`\\.dot\\.${STATUS_DOT[status]}::before\\{([^}]*)\\}`).exec(html);
    assert(rule, `${status} has a rule for its dot`);
    return rule[1];
  });
  assertEquals(
    new Set(shapes).size,
    shapes.length,
    "no two statuses draw the same dot, so the shape alone says which is which",
  );
  // A ring rather than a disc, for the one status that is an absence of news.
  assertStringIncludes(shapes[3], "border:2px solid");
  for (const shape of shapes.slice(0, 3)) assert(!shape.includes("border:"));
});

Deno.test("shell: a tile's wash and border grow with the seriousness of its status", () => {
  const html = shell("", "", 0, 30_000, TEST_VERSION, "good");
  const alphas = (["good", "warn", "bad"] as Status[]).map((status) => {
    const rule = new RegExp(
      `\\.tile\\.${status},\\.tile\\.wide\\.${status}\\{border-color:color-mix\\(in srgb,var\\(--status-${status}\\) ([\\d.]+)%,transparent\\);background:color-mix\\(in srgb,var\\(--status-${status}\\) ([\\d.]+)%,transparent\\)\\}`,
    ).exec(html);
    assert(rule, `${status} has a tile rule`);
    const edge = Number(rule[1]);
    const wash = Number(rule[2]);
    assertEquals(edge, Math.round(STATUS_EDGE[status] * 100));
    assertEquals(wash, Math.round(STATUS_WASH[status] * 100));
    return { edge, wash };
  });
  for (let i = 1; i < alphas.length; i++) {
    assert(alphas[i].edge > alphas[i - 1].edge, "each border is stronger than the last");
    assert(alphas[i].wash > alphas[i - 1].wash, "each wash is stronger than the last");
  }
  // A tile that cannot tell takes no color at all.
  assertStringIncludes(
    html,
    ".tile.unknown,.tile.wide.unknown{border-color:var(--border-strong)}",
  );
});

Deno.test("shell: server-measured red age changes the favicon after one hour", () => {
  const html = shell("", "", 0, 1000, TEST_VERSION, "good");
  assertStringIncludes(
    html,
    `const FAVICON_CRY_AFTER_MS = ${FAVICON_CRY_AFTER_MS}`,
  );
  assertStringIncludes(html, `let faviconServerRedSince = null`);
  assertStringIncludes(html, `let faviconServerRedAgeMs = null`);
  const serverRedHtml = shell(
    "",
    "",
    0,
    1000,
    TEST_VERSION,
    "bad",
    1_234,
    567,
  );
  assertStringIncludes(
    serverRedHtml,
    `let faviconServerRedSince = 1234`,
  );
  assertStringIncludes(
    serverRedHtml,
    `let faviconServerRedAgeMs = 567`,
  );
  assertStringIncludes(
    html,
    `const paintStatusFavicon = function paintStatusFavicon(`,
  );
  assertStringIncludes(html, `let faviconStartedAt = performance.now()`);
  assertStringIncludes(html, `root.querySelector(".tile.bad") ? "bad"`);
  assertStringIncludes(
    html,
    `face = redAge >= cryAfterMs ? "bad-crying" : "bad"`,
  );
  assertStringIncludes(
    html,
    `favicon.setAttribute("href", hrefs[face])`,
  );
  assertStringIncludes(
    html,
    `paintStatusFavicon(
      FAVICONS,
      FAVICON_CRY_AFTER_MS,
      faviconServerRedSince,
      faviconServerRedAgeMs,
      faviconStartedAt,
    )`,
  );
  assertStringIncludes(
    html,
    `faviconServerRedSince = update.faviconRedSince`,
  );
  assertStringIncludes(
    html,
    `faviconServerRedAgeMs = update.faviconRedAgeMs`,
  );
  assertStringIncludes(html, `faviconStartedAt = performance.now()`);
  assert(!html.includes("faviconSvg"));
});

Deno.test("shell: the header carries the shortcut and no name of its own", () => {
  const html = shell("", "", 0, 1000, TEST_VERSION, "good");
  const brand = html.match(/<div class="brand">(.*?)<\/div>/s);
  assertExists(brand, "the header's brand row");
  assertEquals(
    brand[1],
    `<span class="badge" id="livebadge">● LIVE</span>` +
      `<span class="shortcut">go/fabricwall</span>`,
    "the badge and the shortcut, and nothing naming the page",
  );
  // The shortcut is the only thing in the row that says which page this is, so
  // a narrow viewport keeps it rather than dropping it as a second label.
  assert(
    !/\.brand[^{]*\{[^}]*display:none/.test(html),
    "nothing in the brand row is hidden at any width",
  );
  assertStringIncludes(
    html,
    ".badge{font-size:11px;color:var(--status-good-text);border:1px solid color-mix(in srgb,var(--status-good) 40%,transparent)",
  );
  // `.shortcut` rather than `.brand span`, which would outrank `.badge` and
  // set the badge's size and color from the shortcut's rule.
  assertStringIncludes(
    html,
    ".shortcut{font-size:12px;color:var(--text-faint)}",
  );
});
