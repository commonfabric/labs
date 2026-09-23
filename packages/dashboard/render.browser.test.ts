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
    if (view.href) {
      assert(tile instanceof HTMLAnchorElement, `${label} must render as a link`);
      assertEquals(
        getComputedStyle(tile).display,
        "block",
        `${label} linked tile must retain block layout`,
      );
    }
    const tileRect = tile.getBoundingClientRect();
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
    if (label === "labs ci trust" || label === "loom ci trust") {
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
