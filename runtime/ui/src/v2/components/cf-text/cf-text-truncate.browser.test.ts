import { assert, assertEquals } from "@std/assert";
import "./index.ts";
import "../cf-hstack/index.ts";

type UpdatingElement = HTMLElement & {
  updateComplete: Promise<unknown>;
};

async function settleLayout(root: ParentNode): Promise<void> {
  const elements = Array.from(
    root.querySelectorAll("cf-hstack, cf-text"),
  ) as UpdatingElement[];

  await Promise.all(elements.map((element) => element.updateComplete));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.all(elements.map((element) => element.updateComplete));
}

const LONG_TEXT =
  "A very long single line of text that should be clipped to an ellipsis " +
  "instead of overflowing or wrapping onto additional lines in the row.";

Deno.test("cf-text truncate applies single-line ellipsis styles", async () => {
  const text = document.createElement("cf-text");
  text.setAttribute("truncate", "");
  text.textContent = LONG_TEXT;
  document.body.append(text);

  try {
    await settleLayout(document.body);

    const style = getComputedStyle(text);
    assertEquals(style.overflow, "hidden");
    assertEquals(style.textOverflow, "ellipsis");
    assertEquals(style.whiteSpace, "nowrap");
    assertEquals(style.display, "block");
  } finally {
    text.remove();
  }
});

Deno.test("cf-text truncate shrinks and clips inside a cf-hstack", async () => {
  const fixture = document.createElement("div");
  fixture.style.cssText = "width: 240px;";
  fixture.innerHTML = `
    <cf-hstack gap="2">
      <cf-text truncate id="truncated"></cf-text>
      <button>Action</button>
    </cf-hstack>
  `;
  const truncated = fixture.querySelector("#truncated") as HTMLElement;
  truncated.textContent = LONG_TEXT;
  document.body.append(fixture);

  try {
    await settleLayout(fixture);

    // The text element must shrink to fit the 240px row (minus the button)
    // rather than forcing the row wider than its container.
    assert(
      truncated.clientWidth <= 240,
      `expected clientWidth <= 240, got ${truncated.clientWidth}`,
    );
    // And its content must overflow (be clipped) inside that width.
    assert(
      truncated.scrollWidth > truncated.clientWidth,
      `expected scrollWidth (${truncated.scrollWidth}) > ` +
        `clientWidth (${truncated.clientWidth})`,
    );
    // Single line: the slotted text must occupy exactly one line.
    // (The element box itself may be stretched by the flex row, so measure
    // the text content directly via a Range. Chrome may report both the
    // unclipped and the ellipsized rect for the same line, so count
    // distinct line tops rather than rects.)
    const range = document.createRange();
    range.selectNodeContents(truncated);
    const lineTops = new Set(
      Array.from(range.getClientRects()).map((rect) => Math.round(rect.top)),
    );
    assertEquals(
      lineTops.size,
      1,
      `expected text on 1 line, got ${lineTops.size} distinct line tops`,
    );
  } finally {
    fixture.remove();
  }
});
