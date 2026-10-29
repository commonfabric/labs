import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
} from "@std/assert";
import { renderTile } from "./tile-render.ts";
import {
  BOTTOM_CHART_RULES,
  DASHBOARD_GRID_RULE,
  TILE_BOX_RULE,
  tileContentRules,
} from "./chart-layout.ts";
import {
  TILE_LAYOUT_FIXTURES,
  type TileLayoutFixture,
} from "./tile-layout-fixtures.ts";
import { SPARKLINE_HEIGHT } from "./tile-render-values.ts";

const pixel = (value: number): number => Math.round(value * 1000) / 1000;
const assertPixelAligned = (
  actual: number,
  expected: number,
  message: string,
): void => {
  assert(
    Math.abs(actual - expected) <= 0.05,
    `${message}: ${pixel(actual)}px vs ${pixel(expected)}px`,
  );
};

function assertStandardTileLayout(
  root: HTMLElement,
  standard: readonly TileLayoutFixture[],
): void {
  const width = pixel(root.getBoundingClientRect().width);
  const tiles = new Map(
    [...root.querySelectorAll<HTMLElement>("[data-tile-label]")].map((tile) => [
      tile.dataset.tileLabel!,
      tile,
    ]),
  );
  assertEquals(tiles.size, standard.length);
  const benchmark = tiles.get("all benchmarks");
  assertExists(benchmark);
  const benchmarkHeadline = benchmark.querySelector<HTMLElement>(".big");
  const benchmarkSub = benchmark.querySelector<HTMLElement>(
    ".benchmark-count",
  );
  const benchmarkDuration = benchmark.querySelector<HTMLElement>(
    ".chart > span:last-child",
  );
  assertExists(benchmarkHeadline);
  assertExists(benchmarkSub);
  assertExists(benchmarkDuration);
  const benchmarkRect = benchmark.getBoundingClientRect();
  const headlineTop = pixel(
    benchmarkHeadline.getBoundingClientRect().top - benchmarkRect.top,
  );
  const subTop = pixel(
    benchmarkSub.getBoundingClientRect().top - benchmarkRect.top,
  );
  const durationTop = pixel(
    benchmarkDuration.getBoundingClientRect().top - benchmarkRect.top,
  );
  const durationLeft = pixel(
    benchmarkDuration.getBoundingClientRect().left - benchmarkRect.left,
  );

  for (const { label, subSelector, view } of standard) {
    const tile = tiles.get(label);
    assertExists(tile);
    const tileRect = tile.getBoundingClientRect();
    // A linked tile is its link, or, when its chart holds links of its own,
    // links its text alone.
    const link = tile instanceof HTMLAnchorElement
      ? tile
      : tile.querySelector<HTMLAnchorElement>(":scope > a.tile-head");
    if (view.href) {
      assertExists(link, `${label} must render a link`);
      assertEquals(
        getComputedStyle(link).display,
        "block",
        `${label} link must retain block layout`,
      );
      assertExists(link.querySelector(".lbl"), `${label} link holds its label`);
    }
    const headline = tile.querySelector<HTMLElement>(".big");
    assertExists(headline);
    if (view.valueLabel !== undefined) {
      assertEquals(
        headline.title,
        view.valueLabel,
        `${label} truncated headline must expose its full text at ${width}px`,
      );
    }
    const header = tile.querySelector<HTMLElement>(".lbl");
    assertExists(header);
    assert(
      header.scrollWidth <= header.clientWidth,
      `${label} header overflows at ${width}px`,
    );
    const facet = header.querySelector<HTMLElement>(".hfacet");
    if (facet) {
      assertEquals(
        facet.title,
        facet.textContent,
        `${label} truncated header facet must expose its full text at ${width}px`,
      );
    }
    assertEquals(
      pixel(headline.getBoundingClientRect().top - tileRect.top),
      headlineTop,
      `${label} headline must share the benchmark offset at ${width}px`,
    );
    const sub = tile.querySelector<HTMLElement>(subSelector ?? ".sub");
    if (view.sub !== undefined || subSelector !== undefined) {
      assertExists(sub, `${label} must render its subheading at ${width}px`);
      assertEquals(
        pixel(sub.getBoundingClientRect().top - tileRect.top),
        subTop,
        `${label} subheading must share the benchmark offset at ${width}px`,
      );
      if (sub.matches(".sub")) {
        assertEquals(
          sub.title,
          sub.textContent?.trim(),
          `${label} truncated subheading must expose its full text at ${width}px`,
        );
      }
    }
    const duration = tile.querySelector<HTMLElement>(
      ".chart > span:last-child",
    );
    if (view.duration !== undefined) {
      assertExists(duration, `${label} must render its duration at ${width}px`);
      assertEquals(
        pixel(duration.getBoundingClientRect().top - tileRect.top),
        durationTop,
        `${label} duration must share the benchmark offset at ${width}px`,
      );
      assertEquals(
        pixel(duration.getBoundingClientRect().left - tileRect.left),
        durationLeft,
        `${label} duration must share the benchmark left offset at ${width}px`,
      );
    }
    if (label.endsWith(" ci trust")) {
      const grid = tile.querySelector<HTMLElement>(".cells.labeled");
      const firstCell = grid?.querySelector<HTMLElement>(".cell");
      const lastCell = grid?.querySelector<HTMLElement>(".cell:last-child");
      const trustSub = tile.querySelector<HTMLElement>(".sub");
      assertExists(grid);
      assertExists(firstCell);
      assertExists(lastCell);
      assertExists(trustSub);
      assertExists(duration);
      const gridRect = grid.getBoundingClientRect();
      const firstCellRect = firstCell.getBoundingClientRect();
      const lastCellRect = lastCell.getBoundingClientRect();
      const durationRect = duration.getBoundingClientRect();
      assertPixelAligned(
        firstCellRect.width,
        firstCellRect.height,
        `${label} commit cells must be square at ${width}px`,
      );
      assertPixelAligned(
        lastCellRect.bottom,
        gridRect.bottom,
        `${label} commit grid must align to its bottom edge at ${width}px`,
      );
      assert(
        firstCellRect.top >= trustSub.getBoundingClientRect().bottom,
        `${label} commit grid must not overlap its subheading at ${width}px: ${
          pixel(firstCellRect.top)
        }px vs ${pixel(trustSub.getBoundingClientRect().bottom)}px`,
      );
      const leftInset = gridRect.left - tileRect.left;
      const rightInset = tileRect.right - gridRect.right;
      assertPixelAligned(
        rightInset,
        leftInset,
        `${label} commit grid must have equal side insets at ${width}px`,
      );
      assertPixelAligned(
        tileRect.bottom - gridRect.bottom,
        leftInset,
        `${label} commit grid bottom inset must match its sides at ${width}px`,
      );
      assert(
        durationRect.left >= gridRect.left &&
          durationRect.left < gridRect.right &&
          durationRect.right > gridRect.left &&
          durationRect.top < gridRect.bottom &&
          durationRect.bottom > gridRect.top,
        `${label} duration must overlap the grid's bottom-left corner at ${width}px`,
      );
      assertNotEquals(
        getComputedStyle(duration).textShadow,
        "none",
        `${label} duration must carry a readable grid outline at ${width}px`,
      );
      const cells = [...grid.querySelectorAll<HTMLElement>(".cell")];
      assertEquals(cells.length, 160);
      const fortiethRect = cells[39].getBoundingClientRect();
      const fortyFirstRect = cells[40].getBoundingClientRect();
      assertPixelAligned(
        firstCellRect.left,
        gridRect.left,
        `${label} first cell must reach the grid's left edge at ${width}px`,
      );
      assert(
        Math.abs(fortiethRect.right - gridRect.right) < 0.5,
        `${label} fortieth cell must reach the grid's right edge at ${width}px: ${
          pixel(fortiethRect.right)
        }px vs ${pixel(gridRect.right)}px`,
      );
      assertPixelAligned(
        fortiethRect.top,
        firstCellRect.top,
        `${label} first row must contain 40 cells at ${width}px`,
      );
      assert(
        fortyFirstRect.top > firstCellRect.top,
        `${label} forty-first cell must start the second row at ${width}px`,
      );
    }
    const list = tile.querySelector<HTMLElement>(".tile-detail-list");
    if (list) {
      // The room the two columns share, and for each column its width, the
      // width its widest text needs, and whether it cuts any text short.
      const room = list.clientWidth -
        parseFloat(getComputedStyle(list).columnGap);
      const columns = [0, 1].map(() => ({ width: 0, need: 0, cuts: false }));
      const cells = list.querySelectorAll<HTMLElement>(
        ":scope > span, :scope > a > span",
      );
      cells.forEach((cell, index) => {
        const text = [cell, ...cell.querySelectorAll<HTMLElement>("span")]
          .find((element) =>
            [...element.childNodes].some((node) =>
              node.nodeType === Node.TEXT_NODE && node.textContent !== ""
            )
          );
        assertExists(text, `${label} row cell has no text at ${width}px`);
        const column = columns[index % 2];
        column.width = cell.getBoundingClientRect().width;
        const range = document.createRange();
        range.selectNodeContents(text);
        column.need = Math.max(
          column.need,
          column.width - text.clientWidth + range.getBoundingClientRect().width,
        );
        if (text.scrollWidth <= text.clientWidth) return;
        column.cuts = true;
        const style = getComputedStyle(text);
        assert(
          style.display === "block" && style.textOverflow === "ellipsis",
          `${label} cuts "${cell.textContent}" without an ellipsis at ${width}px`,
        );
      });
      for (const [column, other] of [columns, [...columns].reverse()]) {
        if (!column.cuts) continue;
        assert(
          column.width >= room / 2 - 0.5,
          `${label} cuts a column to ${
            pixel(column.width)
          }px, under half of ${pixel(room)}px, at ${width}px`,
        );
        assert(
          other.cuts || other.width <= other.need + 1,
          `${label} cuts a column while the other is ${
            pixel(other.width)
          }px for text needing ${pixel(other.need)}px, at ${width}px`,
        );
      }
      for (const link of list.querySelectorAll<HTMLElement>(":scope > a")) {
        assertPixelAligned(
          link.getBoundingClientRect().width,
          list.clientWidth,
          `${label} linked row must span the list at ${width}px`,
        );
      }
    }
    assert(
      pixel(tileRect.height) <= pixel(benchmarkRect.height),
      `${label} is ${pixel(tileRect.height)}px tall at ${width}px; benchmarks is ${
        pixel(benchmarkRect.height)
      }px`,
    );
  }
}

Deno.test("every standard tile shares text baselines and fits under benchmarks", async () => {
  const standard = TILE_LAYOUT_FIXTURES.filter(({ wide }) => !wide);
  const tiles = standard.map(({ label, view }) => renderTile(label, view)).join("");
  const fixture = document.createElement("div");
  fixture.innerHTML = `<style>
    .layout-dashboard{width:1100px;--surface:#111;font-family:-apple-system,"Segoe UI",Roboto,sans-serif}
    .layout-intermediate{width:451px;--surface:#111;font-family:-apple-system,"Segoe UI",Roboto,sans-serif}
    .layout-minimum{width:220px;--surface:#111;font-family:-apple-system,"Segoe UI",Roboto,sans-serif}
    ${DASHBOARD_GRID_RULE}
    ${TILE_BOX_RULE}
    ${BOTTOM_CHART_RULES}
    ${tileContentRules(SPARKLINE_HEIGHT)}
    .cells.labeled .cell{display:block}
  </style><div class="grid layout-dashboard">${tiles}</div>
  <div class="grid layout-intermediate">${tiles}</div>
  <div class="grid layout-minimum">${tiles}</div>`;
  document.body.append(fixture);

  try {
    await new Promise(requestAnimationFrame);
    const dashboard = fixture.querySelector<HTMLElement>(".layout-dashboard");
    const intermediate = fixture.querySelector<HTMLElement>(
      ".layout-intermediate",
    );
    const minimum = fixture.querySelector<HTMLElement>(".layout-minimum");
    assertExists(dashboard);
    assertExists(intermediate);
    assertExists(minimum);
    assertStandardTileLayout(dashboard, standard);
    assertStandardTileLayout(intermediate, standard);
    assertStandardTileLayout(minimum, standard);
    for (const sub of dashboard.querySelectorAll<HTMLElement>(".sub")) {
      assert(
        sub.scrollWidth <= sub.clientWidth,
        `"${sub.textContent}" is cut short at full width: ${sub.scrollWidth}px in ${sub.clientWidth}px`,
      );
    }
  } finally {
    fixture.remove();
  }
});

Deno.test("a link tile whose chart holds links keeps them apart from its own", async () => {
  const trust = TILE_LAYOUT_FIXTURES.find(({ label }) => label === "labs ci trust");
  assertExists(trust?.view.href);
  const fixture = document.createElement("div");
  fixture.style.cssText = "position:fixed;top:0;left:0;width:300px";
  fixture.innerHTML = `<style>
    ${TILE_BOX_RULE}
    ${BOTTOM_CHART_RULES}
    ${tileContentRules(SPARKLINE_HEIGHT)}
    .cells.labeled .cell{display:block}
  </style>${renderTile(trust.label, trust.view)}`;
  document.body.append(fixture);

  try {
    await new Promise(requestAnimationFrame);
    const tiles = fixture.querySelectorAll<HTMLElement>(".tile");
    assertEquals(tiles.length, 1, "the parser does not split the tile");
    const [tile] = tiles;
    const head = tile.querySelector<HTMLAnchorElement>(":scope > a.tile-head");
    assertExists(head);
    assertEquals(head.getAttribute("href"), "/repos?name=labs");
    const cells = tile.querySelectorAll<HTMLAnchorElement>(".cells > a.cell");
    assertEquals(cells.length, 160);
    assert(!head.contains(cells[0]), "a cell is not inside the tile's link");
    const hitAt = (element: Element) => {
      const box = element.getBoundingClientRect();
      return document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
    };
    for (const cell of [cells[0], cells[cells.length - 1]]) {
      assertEquals(hitAt(cell), cell, "a cell opens its run");
    }
    // The text keeps its own tooltip, inside the tile's link.
    for (const part of [".lbl", ".big", ".sub"]) {
      const element = tile.querySelector(part);
      assertExists(element);
      const hit = hitAt(element);
      assert(
        hit !== null && element.contains(hit) && head.contains(hit),
        `the tile's ${part} opens its link`,
      );
    }
    // The chart sits at the bottom of the tile, as it does when the tile is
    // not a link.
    const chart = tile.querySelector<HTMLElement>(":scope > .chart");
    assertExists(chart);
    assertPixelAligned(
      chart.getBoundingClientRect().bottom,
      tile.getBoundingClientRect().bottom -
        parseFloat(getComputedStyle(tile).paddingBottom) -
        parseFloat(getComputedStyle(tile).borderBottomWidth),
      "the chart ends at the tile's content edge",
    );
  } finally {
    fixture.remove();
  }
});

Deno.test("a linked bottom-chart tile keeps its flex layout", async () => {
  const fixture = document.createElement("div");
  fixture.innerHTML = `<style>
    ${TILE_BOX_RULE}
    ${BOTTOM_CHART_RULES}
    ${tileContentRules(SPARKLINE_HEIGHT)}
  </style>${
    renderTile("linked history", {
      status: "good",
      value: "42",
      sub: "representative linked tile",
      extra: `<div style="height:${SPARKLINE_HEIGHT}px"></div>`,
      duration: 30 * 86_400_000,
      href: "/details",
      alignChartBottom: true,
    })
  }`;
  document.body.append(fixture);

  try {
    await new Promise(requestAnimationFrame);
    const tile = fixture.querySelector<HTMLElement>(".tile");
    assertExists(tile);
    assertEquals(getComputedStyle(tile).display, "flex");
  } finally {
    fixture.remove();
  }
});
