import { expect } from "@std/expect";
import { renderTile } from "./tile-render.ts";
import { reconcileTiles } from "./tiles-client.ts";
import type { TileView } from "./types.ts";

function rendering(...tiles: [string, TileView][]): HTMLElement[] {
  const template = document.createElement("template");
  template.innerHTML = tiles.map(([label, view]) => renderTile(label, view))
    .join("");
  return [...template.content.children] as HTMLElement[];
}

// Runs `test` against a page holding the tiles, and removes them afterwards.
function withBoard(
  tiles: [string, TileView][],
  test: (container: HTMLElement) => void,
): void {
  const container = document.createElement("div");
  container.append(...rendering(...tiles));
  document.body.append(container);
  try {
    test(container);
  } finally {
    container.remove();
  }
}

// Each row has a title link and an arrow link with the same href, as the
// recent-runs tile renders them.
function runRows(titles: string[]): string {
  return `<div class="evscroll" data-focus-key="runs" style="height:40px;overflow:auto">${
    titles.map((title) =>
      `<div class="ev" style="height:30px"><a class="evtxt" data-focus-key="pr-title-${title}" href="https://example.com/${title}">${title}</a><a class="evarrow" data-focus-key="pr-arrow-${title}" href="https://example.com/${title}">↗</a></div>`
    ).join("")
  }</div>`;
}

Deno.test("an update keeps an unchanged tile's element and replaces a changed tile where it stands", () => {
  withBoard([
    ["labs ci", { status: "good", value: "passing" }],
    ["loom ci", { status: "good", value: "passing" }],
    ["dau", { status: "good", value: "12" }],
  ], (container) => {
    const [labs, loom, dau] = [...container.children];
    reconcileTiles(
      container,
      rendering(
        ["labs ci", { status: "good", value: "passing" }],
        ["loom ci", { status: "bad", value: "failure" }],
        ["dau", { status: "good", value: "12" }],
      ),
    );
    const [nextLabs, nextLoom, nextDau] = [...container.children];
    expect(container.children).toHaveLength(3);
    expect(nextLabs).toBe(labs);
    expect(nextLoom).not.toBe(loom);
    expect(nextLoom.className).toBe("tile bad");
    expect(nextLoom.querySelector(".big")?.textContent).toBe("failure");
    expect(nextDau).toBe(dau);
  });
});

Deno.test("an update adds, removes and reorders tiles by label, keeping the elements of tiles it keeps", () => {
  withBoard([
    ["labs ci", { status: "good" }],
    ["loom ci", { status: "good" }],
    ["dau", { status: "good" }],
  ], (container) => {
    const [labs, , dau] = [...container.children];
    reconcileTiles(
      container,
      rendering(
        ["dau", { status: "good" }],
        ["labs ci", { status: "good" }],
        ["model spend", { status: "warn" }],
      ),
    );
    const [first, second, third] = [...container.children];
    expect(container.children).toHaveLength(3);
    expect(first).toBe(dau);
    expect(second).toBe(labs);
    expect(third.getAttribute("data-tile-label")).toBe("model spend");
  });
});

Deno.test("an update keeps focus and scroll position in a tile when a tile before it leaves the page", () => {
  withBoard([
    ["scheduled workflows", { status: "bad", value: "1 failing" }],
    ["recent main runs", { status: "good", extra: runRows(["c", "b", "a"]) }],
  ], (container) => {
    container.querySelector<HTMLElement>('[data-focus-key="pr-arrow-a"]')
      ?.focus({ preventScroll: true });
    container.querySelector(".evscroll")!.scrollTop = 25;
    reconcileTiles(
      container,
      rendering([
        "recent main runs",
        { status: "warn", extra: runRows(["d", "c", "b", "a"]) },
      ]),
    );
    expect(container.children).toHaveLength(1);
    expect(container.children[0].className).toBe("tile warn");
    expect(container.querySelector(".evscroll")?.scrollTop).toBe(25);
    expect(document.activeElement).toBe(
      container.querySelector('[data-focus-key="pr-arrow-a"]'),
    );
  });
});

Deno.test("an update moves focus from a replaced linked tile to its replacement", () => {
  withBoard([[
    "labs ci",
    { status: "good", value: "passing", href: "https://example.com/ci" },
  ]], (container) => {
    (container.children[0] as HTMLElement).focus();
    reconcileTiles(
      container,
      rendering([
        "labs ci",
        { status: "bad", value: "failure", href: "https://example.com/ci" },
      ]),
    );
    expect(container.children[0].className).toBe("tile bad link");
    expect(document.activeElement).toBe(container.children[0]);
  });
});

Deno.test("an update moves focus inside a replaced tile to the link with the same focus key", () => {
  withBoard([[
    "recent main runs",
    { status: "good", extra: runRows(["b", "a"]) },
  ]], (container) => {
    container.querySelector<HTMLElement>('[data-focus-key="pr-arrow-a"]')
      ?.focus();
    reconcileTiles(
      container,
      rendering([
        "recent main runs",
        { status: "good", extra: runRows(["c", "b", "a"]) },
      ]),
    );
    const arrow = container.querySelector('[data-focus-key="pr-arrow-a"]');
    expect(arrow).not.toBeNull();
    expect(document.activeElement).toBe(arrow);
  });
});

Deno.test("an update moves focus inside a replaced tile to the element that is not a link with the same focus key", () => {
  const targets = (host: string) =>
    `<div class="tile-detail-list" role="region" tabindex="0" data-focus-key="targets">${host}</div>`;
  withBoard([[
    "production",
    { status: "good", extra: targets("rapids") },
  ]], (container) => {
    container.querySelector<HTMLElement>(".tile-detail-list")?.focus();
    reconcileTiles(
      container,
      rendering(["production", { status: "bad", extra: targets("estuary") }]),
    );
    const region = container.querySelector(".tile-detail-list");
    expect(region?.textContent).toBe("estuary");
    expect(document.activeElement).toBe(region);
  });
});

Deno.test("an update moves focus inside a replaced tile to the link with the same href when the link has no focus key", () => {
  const links = (hrefs: string[]) =>
    hrefs.map((href) => `<a href="https://example.com/${href}">${href}</a>`)
      .join("");
  withBoard([[
    "flaky tests",
    { status: "good", extra: links(["b", "a"]) },
  ]], (container) => {
    container.querySelector<HTMLElement>('a[href$="/a"]')?.focus();
    reconcileTiles(
      container,
      rendering([
        "flaky tests",
        { status: "warn", extra: links(["c", "b", "a"]) },
      ]),
    );
    const replacement = container.querySelector('a[href$="/a"]');
    expect(replacement?.textContent).toBe("a");
    expect(document.activeElement).toBe(replacement);
  });
});

Deno.test("an update keeps the scroll position of a replaced tile's list", () => {
  withBoard([[
    "recent main runs",
    { status: "good", extra: runRows(["c", "b", "a"]) },
  ]], (container) => {
    container.querySelector(".evscroll")!.scrollTop = 25;
    reconcileTiles(
      container,
      rendering([
        "recent main runs",
        { status: "warn", extra: runRows(["d", "c", "b", "a"]) },
      ]),
    );
    expect(container.children[0].className).toBe("tile warn");
    expect(container.querySelector(".evscroll")?.scrollTop).toBe(25);
  });
});
