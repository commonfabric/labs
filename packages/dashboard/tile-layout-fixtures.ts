import type { TileView } from "./types.ts";
import { SPARKLINE_HEIGHT } from "./tile-render-values.ts";

export interface TileLayoutFixture {
  label: string;
  view: TileView;
  wide?: boolean;
  subSelector?: string;
}

const DAY = 86_400_000;
const history = () =>
  `<svg viewBox="0 0 220 26" width="100%" height="${SPARKLINE_HEIGHT}" preserveAspectRatio="none" style="display:block;margin-top:9px"><polyline points="0,20 55,12 110,16 165,4 220,8" fill="none" stroke="var(--chart-line)" stroke-width="2"></polyline></svg>`;
const twoLines = () =>
  `<div style="position:relative;margin-top:9px;height:${SPARKLINE_HEIGHT}px"><svg viewBox="0 0 220 34" width="calc(100% - 24px)" height="${SPARKLINE_HEIGHT}" preserveAspectRatio="none" style="display:block"><polyline points="0,20 55,12 110,16 165,4 220,8" fill="none" stroke="#7aa2ff" stroke-width="2"></polyline><polyline points="0,24 55,20 110,16 165,20 220,12" fill="none" stroke="#be95ff" stroke-width="2"></polyline></svg></div>`;
const trustStrip = (prefix: string, badEvery: number) =>
  `<div class="cells labeled">${
    Array.from(
      { length: 160 },
      (_, index) =>
        `<a class="cell" href="https://example.com/${prefix}/${index}" style="background:var(--status-${
          index % badEvery === 0 ? "bad" : "good"
        })"></a>`,
    ).join("")
  }</div>`;
const spendSub = (text: string) =>
  `<p class="sub" title="${text}"><span class="swatch" style="background:#7aa2ff"></span> ${text}</p>`;

// These are maximum-content loaded states expressed through the renderer's
// public TileView contract. The registry test keeps the list complete and in
// dashboard order. The browser test supplies these views to renderTile().
const TILE_LAYOUT_FIXTURE_INPUTS: readonly TileLayoutFixture[] = [
  {
    label: "labs ci",
    view: {
      status: "good",
      value: "passing",
      valueLabel: "passing",
      sub: "green for 3h",
      hint: "commits ↗",
      href: "https://example.com/labs/commits",
      extra:
        `<span class="running"><span class="rdot"></span>next build running</span>`,
    },
  },
  {
    label: "labs ci trust",
    view: {
      status: "good",
      value: "90.4%",
      sub: "first-try green · 156 of last 160 runs",
      extra: trustStrip("runs", 10),
      duration: 30 * DAY,
      alignChartBottom: true,
    },
  },
  {
    label: "labs ci duration",
    view: {
      status: "good",
      value: "17m",
      sub: "median · 31 passing runs in the last 6h",
      extra: history(),
      duration: 30 * DAY,
      hint: "jobs ↗",
      href: "/bench?repo=labs",
    },
  },
  {
    label: "all benchmarks",
    subSelector: ".benchmark-count",
    view: {
      status: "warn",
      value: "▲6%",
      extra:
        `<div class="benchmark-count" style="font-size:13px;color:var(--text-muted);margin:5px 0 0">544 benchmarks · last 10 days</div>${twoLines()}`,
      duration: 30 * DAY,
      hint: "details ↗",
      href: "/bench",
    },
  },
  {
    label: "loom ci",
    view: {
      status: "good",
      value: "passing",
      valueLabel: "passing",
      sub: "green for 5h",
      hint: "commits ↗",
      href: "https://example.com/loom/commits",
      extra:
        `<span class="running"><span class="rdot"></span>next build running</span>`,
    },
  },
  {
    label: "loom ci trust",
    view: {
      status: "warn",
      value: "73.8%",
      sub: "first-try green · last 160 runs",
      extra: trustStrip("loom-runs", 4),
      duration: 30 * DAY,
      alignChartBottom: true,
    },
  },
  {
    label: "loom ci duration",
    view: {
      status: "good",
      value: "6m",
      sub: "median · last 20 passing runs",
      extra: history(),
      duration: 30 * DAY,
      hint: "jobs ↗",
      href: "/bench?repo=loom",
    },
  },
  {
    label: "key benchmarks",
    subSelector: ".benchmark-count",
    view: {
      status: "warn",
      value: "▲6%",
      extra:
        `<div class="benchmark-count" style="font-size:13px;color:var(--text-muted);margin:5px 0 0">2 benchmarks · last 10 days</div>${twoLines()}`,
      duration: 30 * DAY,
      hint: "metrics ↗",
      href: "/bench?view=runtime&repo=labs",
    },
  },
  {
    label: "flaky tests",
    view: {
      status: "warn",
      value: "25 flaky tests",
      valueLabel: "25 flaky tests",
      sub: "60 days of runs · 3h old",
      extra: history(),
      duration: 18 * DAY,
      aside: `<span class="running"><span class="rdot"></span>running</span>`,
      hint: "flakes ↗",
      href: "/test-selection#flaky",
    },
  },
  {
    label: "test selection",
    view: {
      status: "good",
      value: "64%",
      sub: "16,614 of 19,544 tests",
      extra: history(),
      duration: 18 * DAY,
      aside: `<span class="running"><span class="rdot"></span>running</span><span class="hfacet" title="12h old">12h old</span>`,
      hint: "lanes ↗",
      href: "/test-selection",
    },
  },
  {
    label: "coverage debt",
    view: {
      status: "warn",
      value: "78,101 lines",
      valueLabel: "78,101 lines",
      sub: "+214 per day (median) · last 21 days",
      extra: history(),
      duration: 56 * DAY,
    },
  },
  {
    label: "prod errors",
    view: {
      status: "good",
      value: "0.24%",
      sub: "12 err / 5000 spans · last 12h",
      extra: history(),
      duration: 30 * DAY,
      hint: "traces ↗",
      href: "https://example.com/traces",
    },
  },
  {
    label: "dau",
    view: {
      status: "good",
      value: "244",
      sub: "active identities · toolshed-production",
      extra: history(),
      duration: 30 * DAY,
      hint: "traces ↗",
      href: "https://example.com/identities",
    },
  },
  {
    label: "discord online",
    subSelector: ".sub",
    view: {
      status: "good",
      value: "37",
      extra: spendSub("team + visitors") + twoLines(),
      duration: 30 * DAY,
    },
  },
  {
    label: "github users",
    subSelector: ".sub",
    view: {
      status: "good",
      value: "14",
      extra: spendSub("members · collaborators") + twoLines(),
      duration: 30 * DAY,
      hint: "people ↗",
      href: "https://example.com/people",
    },
  },
  {
    label: "production",
    view: {
      status: "bad",
      value: "commonfabric.com down",
      valueLabel: "commonfabric.com down",
      extra:
        `<div class="tile-detail-list" tabindex="0" role="region" data-focus-key="targets" aria-label="Production target details; scroll for more" title="Scroll for more details" style="display:grid;grid-template-columns:auto 1fr;gap:7px 10px;margin-top:11px;font-size:12px;line-height:1.35">${
          [
            "commonfabric.com",
            "estuary",
            "rapids",
            "bastion",
            "prod shell",
            "stage shell",
            "LLM",
            "sandbox",
          ].map((name) =>
            `<span style="display:inline-flex;align-items:center;gap:6px;font-weight:600"><span class="dot red"></span>${name}</span><span style="color:var(--text-muted);font-variant-numeric:tabular-nums">connection refused</span>`
          ).join("")
        }</div>`,
    },
  },
  {
    label: "cubic spend",
    view: {
      status: "good",
      value: "—",
      sub: "api does not expose value",
    },
  },
  {
    label: "github spend",
    subSelector: ".sub",
    view: {
      status: "good",
      value: "~$3059/mo",
      valueLabel: "~$3059/mo",
      aside: `<span class="hfacet" title="$1644 MTD">$1644 MTD</span>`,
      extra: spendSub("GitHub · Budget $3100") + history(),
      duration: 30 * DAY,
      hint: "billing ↗",
      href: "https://example.com/billing",
    },
  },
  {
    label: "model spend",
    subSelector: ".sub",
    view: {
      status: "good",
      value: "~$820/mo",
      valueLabel: "~$820/mo",
      aside: `<span class="hfacet" title="$440 MTD">$440 MTD</span>`,
      extra: spendSub("OpenAI • Anthropic • OR $0") + twoLines(),
      duration: 30 * DAY,
    },
  },
  {
    label: "cloud spend",
    view: {
      status: "good",
      value: "~$410/mo",
      valueLabel: "~$410/mo",
      aside: `<span class="hfacet" title="$220 MTD">$220 MTD</span>`,
      sub: "billing account spend",
      extra: history(),
      duration: 30 * DAY,
    },
  },
  {
    label: "recent main runs",
    wide: true,
    view: { status: "good" },
  },
] as const;

export const TILE_LAYOUT_FIXTURES: readonly TileLayoutFixture[] =
  TILE_LAYOUT_FIXTURE_INPUTS;
