import { assertEquals } from "@std/assert";
import { paintStatusFavicon } from "./favicon-client.ts";

const HREFS = {
  good: "/favicon.png?status=good",
  warn: "/favicon.png?status=warn",
  bad: "/favicon.png?status=bad",
  "bad-crying": "/favicon.png?status=bad-crying",
};
const HOUR = 60 * 60 * 1000;

interface Fixture {
  root: Pick<Document, "querySelector">;
  href(): string;
  writes(): number;
}

function fixture(
  statuses: { bad?: boolean; warn?: boolean },
  initialHref = HREFS.good,
  includeFavicon = true,
): Fixture {
  let href = initialHref;
  let writes = 0;
  const favicon = {
    getAttribute(name: string): string | null {
      return name === "href" ? href : null;
    },
    setAttribute(name: string, value: string): void {
      if (name === "href") {
        href = value;
        writes++;
      }
    },
  };
  const root = {
    querySelector(selector: string): Element | null {
      if (selector === ".tile.bad") {
        return statuses.bad ? ({} as Element) : null;
      }
      if (selector === ".tile.warn") {
        return statuses.warn ? ({} as Element) : null;
      }
      return includeFavicon ? (favicon as unknown as Element) : null;
    },
  } as unknown as Pick<Document, "querySelector">;
  return {
    root,
    href: () => href,
    writes: () => writes,
  };
}

Deno.test("favicon client follows the worst tile and avoids redundant writes", () => {
  const healthy = fixture({});
  paintStatusFavicon(HREFS, HOUR, null, null, 0, undefined, healthy.root);
  assertEquals(healthy.href(), HREFS.good);
  assertEquals(healthy.writes(), 0);

  const warning = fixture({ warn: true });
  paintStatusFavicon(HREFS, HOUR, null, null, 0, 0, warning.root);
  assertEquals(warning.href(), HREFS.warn);
  assertEquals(warning.writes(), 1);

  const bad = fixture({ bad: true, warn: true });
  paintStatusFavicon(HREFS, HOUR, null, null, 0, 0, bad.root);
  assertEquals(bad.href(), HREFS.bad);

  const missing = fixture({ warn: true }, HREFS.good, false);
  paintStatusFavicon(HREFS, HOUR, null, null, 0, 0, missing.root);
  assertEquals(missing.href(), HREFS.good);
  assertEquals(missing.writes(), 0);
});

Deno.test("favicon client combines server red age with elapsed browser time", () => {
  const favicon = fixture({ bad: true });
  paintStatusFavicon(HREFS, HOUR, 1, HOUR - 10, 100, 109, favicon.root);
  assertEquals(favicon.href(), HREFS.bad);

  paintStatusFavicon(HREFS, HOUR, 1, HOUR - 10, 100, 110, favicon.root);
  assertEquals(favicon.href(), HREFS["bad-crying"]);

  const invalidServerAge = fixture({ bad: true });
  paintStatusFavicon(
    HREFS,
    HOUR,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    5_000,
    5_000 + HOUR,
    invalidServerAge.root,
  );
  assertEquals(invalidServerAge.href(), HREFS["bad-crying"]);

  const clockMovedBack = fixture({ bad: true });
  paintStatusFavicon(HREFS, HOUR, null, null, 5_000, 4_000, clockMovedBack.root);
  assertEquals(clockMovedBack.href(), HREFS.bad);
});
