/**
 * Tests for the model-spend tile: three provider billing APIs, read through a
 * stubbed fetch. Nothing here touches the network. The day keys are built from the
 * real current UTC date, because the tile reads the clock to decide which days are
 * this month and how far back to ask.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Ctx } from "../types.ts";
import { themedChartSeries } from "../theme.ts";
import { modelSpend } from "./model-spend.ts";

const themedSwatch = (color: string) =>
  `<span class="swatch" style="background:${themedChartSeries(color).color}"></span>`;

function ctx(env: Record<string, string> = {}): Ctx {
  return {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: (k) => env[k],
  };
}

type Handler = (url: URL, init: RequestInit) => Response;

// A fetch stub routed by host. Each provider's handler gets the parsed URL, so a
// paged endpoint can answer on the `page` parameter. The real fetch is put back
// even when the body throws, since other test files share this process.
async function withFetch(handlers: Record<string, Handler>, body: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const h = handlers[url.hostname];
    if (!h) return Promise.reject(new Error(`unexpected fetch: ${url}`));
    return Promise.resolve(h(url, init ?? {}));
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const authOf = (init: RequestInit) => (init.headers ?? {}) as Record<string, string>;

const DAY = 86_400_000;
const NOW = new Date();
const YEAR = NOW.getUTCFullYear();
const MONTH0 = NOW.getUTCMonth();
const DOM = NOW.getUTCDate();
const TODAY = Date.UTC(YEAR, MONTH0, DOM);
// The trailing calendar days the tile asks each provider for, oldest first. 46 is
// one more than the ~45 days the chart covers, matching the tile's start time.
const WINDOW = Array.from({ length: 46 }, (_, i) => new Date(TODAY - (45 - i) * DAY).toISOString().slice(0, 10));

// One OpenAI cost bucket: dollars split across two results, one a number and one a
// string, which is how the costs endpoint spells amounts.
const oaBucket = (day: string, dollars: number) => ({
  start_time: Date.parse(`${day}T00:00:00Z`) / 1000,
  results: [{ amount: { value: dollars / 2 } }, { amount: { value: String(dollars / 2) } }],
});
// One Anthropic cost_report bucket. Its amounts are USD cents.
const anBucket = (day: string, cents: number) => ({
  starting_at: `${day}T00:00:00Z`,
  results: [{ amount: String(cents / 2) }, { amount: cents / 2 }],
});

// $1/day from OpenAI over the whole window, delivered in two pages, plus two
// buckets the reader has to drop: one with no day, one with no figures.
const openaiPaged: Handler = (url) => {
  if (url.searchParams.get("page") === "p2") {
    return json({ data: WINDOW.slice(26).map((d) => oaBucket(d, 1)), has_more: false, next_page: null });
  }
  return json({
    data: [
      ...WINDOW.slice(0, 26).map((d) => oaBucket(d, 1)),
      { results: [{ amount: { value: 999 } }] },
      { start_time: Date.parse(`${WINDOW[0]}T00:00:00Z`) / 1000 },
    ],
    has_more: true,
    next_page: "p2",
  });
};
// $2/day from Anthropic over the whole window, in two pages, plus a bucket whose
// day is not a string.
const anthropicPaged: Handler = (url) => {
  if (url.searchParams.get("page") === "a2") {
    return json({ data: WINDOW.slice(31).map((d) => anBucket(d, 200)), has_more: false, next_page: null });
  }
  return json({
    data: [...WINDOW.slice(0, 31).map((d) => anBucket(d, 200)), { starting_at: 12345, results: [{ amount: "99900" }] }],
    has_more: true,
    next_page: "a2",
  });
};
const openrouterFive: Handler = () => json({ data: { usage_monthly: 5 } });

const ALL_KEYS = { OPENAI_ADMIN_KEY: "oa", ANTHROPIC_ADMIN_KEY: "an", OPENROUTER_KEY: "or" };
const allThree = { "api.openai.com": openaiPaged, "api.anthropic.com": anthropicPaged, "openrouter.ai": openrouterFive };

Deno.test("model spend: all three providers read -> green, combined MTD, a line each, OpenRouter in the key", async () => {
  const heads: Record<string, Record<string, string>> = {};
  const record = (h: Handler): Handler => (url, init) => {
    heads[url.hostname] = authOf(init);
    return h(url, init);
  };
  await withFetch(
    {
      "api.openai.com": record(openaiPaged),
      "api.anthropic.com": record(anthropicPaged),
      "openrouter.ai": record(openrouterFive),
    },
    async () => {
      const v = await modelSpend.collect(ctx(ALL_KEYS));
      assertEquals(v.status, "good"); // every configured provider resolved, and no budget is set
      // $1/day from OpenAI and $2/day from Anthropic for each day of the month so
      // far, plus OpenRouter's running $5. The buckets with no day and no figures
      // are dropped rather than counted, and both pages of each provider land.
      assertEquals(v.valueLabel, v.value);
      assertEquals(v.aside, `<span class="hfacet" title="$${3 * DOM + 5} MTD">$${3 * DOM + 5} MTD</span>`);
      assert(v.value?.startsWith("~"), `a complete read is a projection, got ${v.value}`);
      assert(v.value?.endsWith("/mo"));
      // The key: a swatch each for the charted providers (their totals sit at the
      // line ends), OpenRouter's total inline since it has no line.
      assertStringIncludes(
        v.extra ?? "",
        `<p class="sub" title="OpenAI • Anthropic • OR $5">${themedSwatch("#10a37f")} OpenAI • ` +
          `${themedSwatch("#d97757")} Anthropic • OR $5</p>`,
      );
      // Each line is drawn in its provider's color and labeled with its own MTD.
      assertStringIncludes(v.extra ?? "", `pointer-events:none">$${DOM}</span>`);
      assertStringIncludes(v.extra ?? "", `pointer-events:none">$${2 * DOM}</span>`);
      assertStringIncludes(v.extra ?? "", "#10a37f");
      assertStringIncludes(v.extra ?? "", "#d97757");
      assertEquals(v.duration, 45 * DAY); // the chart spans the trailing 45 days, inclusive
      // Each key goes to its own provider, in that provider's auth scheme.
      assertEquals(heads["api.openai.com"].authorization, "Bearer oa");
      assertEquals(heads["api.anthropic.com"]["x-api-key"], "an");
      assertEquals(heads["api.anthropic.com"]["anthropic-version"], "2023-06-01");
      assertEquals(heads["openrouter.ai"].authorization, "Bearer or");
    },
  );
});

Deno.test("model spend: the projected total is judged against MODEL_MONTHLY_BUDGET", async () => {
  await withFetch(allThree, async () => {
    const over = await modelSpend.collect(ctx({ ...ALL_KEYS, MODEL_MONTHLY_BUDGET: "0" }));
    assertEquals(over.status, "bad"); // $3/day projected against a $0 budget
    const under = await modelSpend.collect(ctx({ ...ALL_KEYS, MODEL_MONTHLY_BUDGET: "100000" }));
    assertEquals(under.status, "good");
  });
});

Deno.test("model spend: a provider that errors -> $??? and gray, the rest still chart and total", async () => {
  await withFetch(
    { ...allThree, "api.anthropic.com": () => new Response("nope", { status: 500 }) },
    async () => {
      // The budget is blown by the providers that did answer, but Anthropic's spend
      // is unknown, so the tile grays out rather than claiming a verdict.
      const v = await modelSpend.collect(ctx({ ...ALL_KEYS, MODEL_MONTHLY_BUDGET: "0" }));
      assertEquals(v.status, "unknown");
      assertEquals(v.aside, `<span class="hfacet" title="$${DOM + 5} MTD">$${DOM + 5} MTD</span>`); // Anthropic adds nothing
      assert(v.value?.startsWith("≥"), `the total is a lower bound, got ${v.value}`);
      assertStringIncludes(
        v.extra ?? "",
        `<p class="sub" title="OpenAI • Anthropic $??? • OR $5">${themedSwatch("#10a37f")} OpenAI • Anthropic $??? • OR $5</p>`,
      );
      assertEquals(v.duration, 45 * DAY); // OpenAI's line is still drawn
      assertStringIncludes(v.extra ?? "", "#10a37f");
    },
  );
});

// OpenAI's cost report stops six days back: the days after it have no bucket,
// so the provider has written nothing about them.
const openaiStalled: Handler = () =>
  json({ data: WINDOW.slice(0, WINDOW.length - 6).map((d) => oaBucket(d, 1)), has_more: false, next_page: null });
// A bucket for a day the org spent nothing. The endpoint carries one for every
// day in the range it covers, so a day with no figures is a reported $0.
const oaEmptyBucket = (day: string) => ({ start_time: Date.parse(`${day}T00:00:00Z`) / 1000, results: [] });
// $1/day until the last ten days, which are reported and empty.
const openaiQuiet: Handler = () =>
  json({
    data: WINDOW.map((d, i) => i < WINDOW.length - 10 ? oaBucket(d, 1) : oaEmptyBucket(d)),
    has_more: false,
    next_page: null,
  });

Deno.test("model spend: a provider whose report stopped -> $??? and gray, never days of $0", async () => {
  await withFetch({ "api.openai.com": openaiStalled, "openrouter.ai": openrouterFive }, async () => {
    const v = await modelSpend.collect(ctx({ OPENAI_ADMIN_KEY: "oa", OPENROUTER_KEY: "or" }));
    assertEquals(v.status, "unknown"); // OpenAI's recent days are unknown, not quiet
    assert(v.value?.startsWith("≥"), `the total is a lower bound, got ${v.value}`);
    assertEquals(v.extra, `<p class="sub" title="OpenAI $??? • OR $5">OpenAI $??? • OR $5</p>`); // no line, no total
  });
});

Deno.test("model spend: a provider reporting empty days is quiet, and still reads", async () => {
  await withFetch({ "api.openai.com": openaiQuiet }, async () => {
    const v = await modelSpend.collect(ctx({ OPENAI_ADMIN_KEY: "oa" }));
    assertEquals(v.status, "good");
    assert(v.value?.startsWith("~"), `nothing configured is missing, got ${v.value}`);
    assertEquals((v.extra ?? "").includes("OpenAI $???"), false);
    assertStringIncludes(v.extra ?? "", `${themedSwatch("#10a37f")} OpenAI`);
  });
});

Deno.test("model spend: a provider with no bucket at all draws no line of $0", async () => {
  // OpenAI answers with an empty report. Anthropic's days supply the chart's
  // day axis, but they are Anthropic's days: OpenAI reported on none of them,
  // so its total is $0 and its line is absent rather than flat along the floor.
  await withFetch({ "api.openai.com": () => json({ data: [] }), "api.anthropic.com": anthropicPaged }, async () => {
    const v = await modelSpend.collect(ctx({ OPENAI_ADMIN_KEY: "oa", ANTHROPIC_ADMIN_KEY: "an" }));
    assertEquals(v.status, "good");
    assertEquals(v.aside, `<span class="hfacet" title="$${2 * DOM} MTD">$${2 * DOM} MTD</span>`); // Anthropic's $2/day alone
    // OpenAI's color survives in the key's swatch and nowhere in the chart.
    assertEquals((v.extra ?? "").match(/#10a37f/gi)?.length, 1);
    assertStringIncludes(v.extra ?? "", "#d97757");
  });
});

Deno.test("model spend: a one-key deployment still turns green (an unset key doesn't gate the budget)", async () => {
  await withFetch({ "openrouter.ai": openrouterFive }, async () => {
    const v = await modelSpend.collect(ctx({ OPENROUTER_KEY: "or" }));
    assertEquals(v.status, "good");
    assertEquals(v.aside, `<span class="hfacet" title="$5 MTD">$5 MTD</span>`);
    assert(v.value?.startsWith("~"), `nothing configured is missing, got ${v.value}`);
    // OpenRouter has no daily series, so there is no chart and nothing to span.
    assertEquals(v.extra, `<p class="sub" title="OR $5">OR $5</p>`);
    assertEquals(v.duration, 0);
  });
});

Deno.test("model spend: one day of data draws no chart, so the provider's total moves into the key", async () => {
  const today = new Date(TODAY).toISOString().slice(0, 10);
  await withFetch({ "api.openai.com": () => json({ data: [oaBucket(today, 12)] }) }, async () => {
    const v = await modelSpend.collect(ctx({ OPENAI_ADMIN_KEY: "oa" }));
    assertEquals(v.status, "good");
    assertEquals(v.extra, `<p class="sub" title="OpenAI $12">${themedSwatch("#10a37f")} OpenAI $12</p>`);
    assertEquals(v.aside, `<span class="hfacet" title="$12 MTD">$12 MTD</span>`);
    assertEquals(v.duration, 0);
  });
});

// A provider fails in two ways, and neither may read as a real $0: the request is
// refused, or it returns a 200 whose body carries no figures (a permission-filtered
// view, say). Each provider is put through both.
const REFUSED: Record<string, Handler> = {
  "api.openai.com": () => new Response("denied", { status: 403 }),
  "api.anthropic.com": () => new Response("denied", { status: 403 }),
  "openrouter.ai": () => new Response("denied", { status: 401 }),
};
const UNUSABLE: Record<string, Handler> = {
  "api.openai.com": () => json({ data: "not-a-report" }),
  "api.anthropic.com": () => json({ data: { note: "no buckets here" } }),
  "openrouter.ai": () => json({ data: {} }), // a key with no usage_monthly
};

for (const [how, handlers] of [["refused", REFUSED], ["answering without figures", UNUSABLE]] as const) {
  Deno.test(`model spend: every provider ${how} -> gray, never a $0 green`, async () => {
    await withFetch(handlers, async () => {
      const v = await modelSpend.collect(ctx(ALL_KEYS));
      assertEquals(v.status, "unknown");
      assertEquals(v.value, "—");
      assertEquals(v.sub, "model spend unavailable");
    });
  });
}

Deno.test("model spend: no keys at all -> gray, naming the keys to set", async () => {
  const v = await modelSpend.collect(ctx({}));
  assertEquals(v.status, "unknown");
  assertEquals(v.value, "—");
  assertEquals(v.sub, "set OPENAI_ADMIN_KEY / ANTHROPIC_ADMIN_KEY / OPENROUTER_KEY");
});
