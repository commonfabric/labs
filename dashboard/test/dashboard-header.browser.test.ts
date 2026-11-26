import { assert, assertExists } from "@std/assert";
import {
  DASHBOARD_HEADER_RULES,
  dashboardHeader,
} from "../dashboard-header.ts";
import { test } from "@commonfabric/test-support/test";

function assertNear(actual: number, expected: number, message: string): void {
  assert(
    Math.abs(actual - expected) <= 0.05,
    `${message}: ${actual.toFixed(3)}px vs ${expected.toFixed(3)}px`,
  );
}

// The header is laid out in a frame of its own, so its width is the viewport
// width that the header's media rules respond to.
async function withHeader(
  width: number,
  check: (top: HTMLElement) => void,
): Promise<void> {
  const frame = document.createElement("iframe");
  frame.style.cssText = `width:${width}px;height:200px;border:0`;
  frame.srcdoc = `<!doctype html><style>
    body{margin:0;font-family:-apple-system,"Segoe UI",Roboto,sans-serif}
    ${DASHBOARD_HEADER_RULES}
  </style>${dashboardHeader("Topics is back", 500, 7)}`;
  const loaded = new Promise((resolve) =>
    frame.addEventListener("load", resolve, { once: true })
  );
  document.body.append(frame);
  try {
    await loaded;
    const top = frame.contentDocument?.querySelector<HTMLElement>(".top");
    assertExists(top);
    check(top);
  } finally {
    frame.remove();
  }
}

function part(top: HTMLElement, selector: string): HTMLElement {
  const element = top.querySelector<HTMLElement>(selector);
  assertExists(element, selector);
  return element;
}

test("the dashboard message keeps its place while the freshness age counts up", async () => {
  await withHeader(1100, (top) => {
    const form = part(top, ".message-form");
    const age = part(top, "#agotext");
    const { left, right } = form.getBoundingClientRect();
    for (const seconds of [0, 1, 59, 888, 1234, 9999]) {
      age.textContent = `updated ${seconds}s ago`;
      const moved = form.getBoundingClientRect();
      assertNear(moved.left, left, `left edge at ${seconds}s`);
      assertNear(moved.right, right, `right edge at ${seconds}s`);
    }

    // An age with more digits than the room holds is shown whole, and the
    // message gives way to it.
    age.textContent = "updated 123456s ago";
    const ageRect = age.getBoundingClientRect();
    assert(
      ageRect.right <= top.getBoundingClientRect().right + 0.05,
      `the age runs past the header to ${ageRect.right.toFixed(3)}px`,
    );
    assert(
      form.getBoundingClientRect().right < right - 1,
      "the message did not give way to a longer age",
    );
  });
});

test("the dashboard message keeps its place while the badge goes offline and back", async () => {
  await withHeader(1100, (top) => {
    const form = part(top, ".message-form");
    const badge = part(top, "#livetext");
    const { left, right } = form.getBoundingClientRect();
    for (const text of ["● OFFLINE", "● LIVE"]) {
      badge.textContent = text;
      const moved = form.getBoundingClientRect();
      assertNear(moved.left, left, `left edge reading ${text}`);
      assertNear(moved.right, right, `right edge reading ${text}`);
    }
  });
});

test("the dashboard message fills the space between the identity and the freshness indicator", async () => {
  await withHeader(1100, (top) => {
    const view = top.ownerDocument.defaultView;
    assertExists(view);
    const gap = parseFloat(view.getComputedStyle(top).columnGap);
    const brand = part(top, ".brand").getBoundingClientRect();
    const form = part(top, ".message-form").getBoundingClientRect();
    const freshness = part(top, ".top-actions").getBoundingClientRect();
    assertNear(form.left, brand.right + gap, "left edge");
    assertNear(form.right, freshness.left - gap, "right edge");
  });
});

test("the dashboard message takes a row of its own on a phone-width screen", async () => {
  await withHeader(400, (top) => {
    const header = top.getBoundingClientRect();
    const brand = part(top, ".brand").getBoundingClientRect();
    const form = part(top, ".message-form").getBoundingClientRect();
    const freshness = part(top, ".top-actions").getBoundingClientRect();
    assert(
      freshness.left > brand.right && freshness.top < form.top,
      "the identity and the freshness indicator share the first row",
    );
    assert(
      form.top >= brand.bottom && form.top >= freshness.bottom,
      "the message sits below the identity and the freshness indicator",
    );
    assertNear(form.left, header.left, "left edge");
    assertNear(form.right, header.right, "right edge");
  });
});
