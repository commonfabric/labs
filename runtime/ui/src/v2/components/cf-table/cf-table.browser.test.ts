/**
 * Checks the row styles of `cf-table` against a browser's own `@scope`: they
 * reach the rows and cells beneath a table through the spans a renderer wraps
 * lists in, and stop at the content of a cell, where a `cf-table` takes only
 * its own. happy-dom scopes such rules to the outermost table alone, so these
 * run in a browser. deno-web-test registers tests through `Deno.test`, so the
 * functions from `@std/testing/bdd` are not available here.
 */

import { expect } from "@std/expect";

import { CFTable } from "./index.ts";

/**
 * A `display: contents` span holding `children`, as the renderer wraps the
 * elements of a list it renders.
 */
function listWrapper(...children: Element[]): HTMLSpanElement {
  const span = document.createElement("span");
  span.setAttribute("style", "display:contents");
  span.append(...children);
  return span;
}

/**
 * A table whose body holds one-cell rows, each list wrapped in a span, as the
 * renderer builds one whose pattern maps its rows and their cells.
 */
function tableWithRows(...names: string[]): CFTable {
  const element = new CFTable();
  const body = element.appendChild(document.createElement("tbody"));
  body.append(listWrapper(...names.map((name) => {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.textContent = name;
    row.append(listWrapper(cell));
    return row;
  })));
  return element;
}

const cells = (element: CFTable) => [...element.querySelectorAll("td")];

Deno.test("cf-table pads the cells and shades the even rows a renderer wraps in spans", async () => {
  const element = document.body.appendChild(
    Object.assign(tableWithRows("Ada", "Grace"), { striped: true }),
  );
  try {
    await element.updateComplete;
    expect(cells(element).map((cell) => getComputedStyle(cell).padding))
      .toEqual(["8px 12px", "8px 12px"]);
    expect(
      [...element.querySelectorAll("tr")].map((row) =>
        getComputedStyle(row).backgroundColor
      ),
    ).toEqual(["rgba(0, 0, 0, 0)", "rgb(248, 250, 252)"]);
  } finally {
    element.remove();
  }
});

Deno.test("cf-table styles a `cf-table` inside a cell by its own variants", async () => {
  const element = document.body.appendChild(
    Object.assign(tableWithRows("Ada"), { size: "sm", bordered: true }),
  );
  try {
    const inner = Object.assign(tableWithRows("1", "2"), { size: "lg" });
    element.querySelector("td")!.append(inner);
    await element.updateComplete;
    await inner.updateComplete;
    const style = getComputedStyle(cells(inner)[0]);
    expect({ padding: style.padding, border: style.borderTopStyle }).toEqual({
      padding: "12px 16px",
      border: "none",
    });
    expect(getComputedStyle(cells(element)[0]).padding).toBe("4px 8px");
  } finally {
    element.remove();
  }
});
