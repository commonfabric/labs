import { expect } from "@std/expect";
import {
  LIVE_PAGE_UPDATE,
  reconcileMain,
  updateIcon,
  updateMain,
} from "./live-page-client.ts";

// The `<main>` of a page holding `html`.
function mainOf(html: string): Element {
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html")
    .querySelector("main")!;
}

Deno.test("a rendering changing one part of main replaces only that part", () => {
  const main = mainOf(
    "<main><div id=top>1h ago</div><table id=rows><tr><td>a</td></tr></table></main><p id=around>kept</p>",
  );
  const page = main.ownerDocument;
  const rows = page.getElementById("rows");
  const around = page.getElementById("around");
  expect(reconcileMain(
    main,
    mainOf(
      "<main><div id=top>2h ago</div><table id=rows><tr><td>a</td></tr></table></main>",
    ),
  )).toBe(true);
  expect(page.querySelector("main")).toBe(main);
  expect(page.getElementById("rows")).toBe(rows);
  expect(page.getElementById("around")).toBe(around);
  expect(page.getElementById("top")?.textContent).toBe("2h ago");
});

Deno.test("an unchanged rendering leaves main in place", () => {
  const main = mainOf("<main><b>same</b></main>");
  expect(reconcileMain(main, mainOf("<main><b>same</b></main>"))).toBe(false);
  expect(main.ownerDocument.querySelector("main")).toBe(main);
});

Deno.test("a rendering with other parts, or other text between them, replaces main whole", () => {
  for (
    const next of [
      "<main><p>one</p><p>two</p></main>",
      "<main>after<p>one</p></main>",
    ]
  ) {
    const main = mainOf("<main>before<p>one</p></main>");
    const page = main.ownerDocument;
    expect(reconcileMain(main, mainOf(next))).toBe(true);
    expect(page.querySelector("main")).not.toBe(main);
    expect(page.querySelector("main")?.outerHTML).toBe(next);
  }
});

Deno.test("the header's age changing leaves focus on the link beside it", () => {
  const main = document.createElement("main");
  main.innerHTML = `<div class="top"><a href="/">← dashboard</a><span>1h ago</span></div>`;
  document.body.append(main);
  try {
    const back = main.querySelector("a")!;
    back.focus();
    expect(reconcileMain(
      main,
      mainOf(
        `<main><div class="top"><a href="/">← dashboard</a><span>2h ago</span></div></main>`,
      ),
    )).toBe(true);
    expect(document.activeElement).toBe(back);
    expect(main.querySelector("span")?.textContent).toBe("2h ago");
  } finally {
    main.remove();
  }
});

Deno.test("an update is announced with the fresh rendering, which the page may arrange first", () => {
  const main = document.createElement("main");
  // The page shows its list in the reverse of the order it is served in.
  main.innerHTML = `<ol><li id="b">b</li><li id="a">1h</li></ol>`;
  document.body.append(main);
  const kept = main.querySelector("#b");
  const reverse = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const list = event.detail.querySelector("ol");
    list.append(...[...list.children].reverse());
  };
  document.addEventListener(LIVE_PAGE_UPDATE, reverse);
  try {
    expect(updateMain(
      main,
      mainOf(`<main><ol><li id="a">2h</li><li id="b">b</li></ol></main>`),
    )).toBe(true);
    expect([...main.querySelectorAll("li")].map((item) => item.id))
      .toEqual(["b", "a"]);
    expect(main.querySelector("#b")).toBe(kept);
    expect(main.querySelector("#a")?.textContent).toBe("2h");
  } finally {
    document.removeEventListener(LIVE_PAGE_UPDATE, reverse);
    main.remove();
  }
});

Deno.test("a rendering's favicon image replaces the page's", () => {
  const rendering = (href: string) =>
    new DOMParser().parseFromString(
      `<head><link rel="icon" href="${href}"></head><body><main></main></body>`,
      "text/html",
    );
  const page = rendering("data:,");
  const icon = page.querySelector('link[rel="icon"]');
  for (const href of ["/good.png", "/bad.png", "data:,"]) {
    updateIcon(page, rendering(href));
    expect(page.querySelector('link[rel="icon"]')).toBe(icon);
    expect(icon?.getAttribute("href")).toBe(href);
  }
  // A rendering with no favicon leaves the page's as it is.
  updateIcon(page, new DOMParser().parseFromString("<main></main>", "text/html"));
  expect(icon?.getAttribute("href")).toBe("data:,");
});
