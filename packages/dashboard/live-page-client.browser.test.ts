import { expect } from "@std/expect";
import { reconcileMain } from "./live-page-client.ts";

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
