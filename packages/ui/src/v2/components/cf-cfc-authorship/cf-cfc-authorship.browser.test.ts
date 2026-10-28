/**
 * Checks what a host page can see of the authorship badge from outside it:
 * the state it shows, as an attribute a stylesheet can select on, and the
 * theme's colors on the badge. Both need a live element in a document, so
 * these run in a browser.
 */

import { expect } from "@std/expect";

import { CFCFCAuthorship } from "./index.ts";

/** A label whose root says its value was written by `sender`. */
const authoredByLabel = (sender: string) => ({
  version: 1 as const,
  entries: [{
    path: [],
    label: { integrity: [{ kind: "authored-by", subject: sender }] },
  }],
});

/**
 * Lets the reads the element's observation started finish, and the update
 * they request render.
 */
async function settle(element: CFCFCAuthorship): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await element.updateComplete;
}

/** A badge for a value `alice` wrote, claimed by `claimed`, inside `parent`. */
async function mount(
  claimed: string,
  parent: HTMLElement = document.body,
): Promise<CFCFCAuthorship> {
  const element = new CFCFCAuthorship();
  element.author = claimed;
  element.value = {
    getCfcLabel: () => Promise.resolve(authoredByLabel("alice")),
  };
  parent.append(element);
  await settle(element);
  return element;
}

Deno.test("the badge's host carries the state it shows as data-state", async () => {
  const verified = await mount("alice");
  const unverified = await mount("mallory");
  try {
    expect(verified.dataset.state).toBe("verified");
    expect(unverified.dataset.state).toBe("unverified");
  } finally {
    verified.remove();
    unverified.remove();
  }
});

Deno.test("a badge reads `loading` on its host before its labels arrive", async () => {
  const element = new CFCFCAuthorship();
  element.author = "alice";
  element.value = { getCfcLabel: () => new Promise(() => {}) };
  document.body.append(element);
  try {
    await element.updateComplete;
    expect(element.dataset.state).toBe("loading");
  } finally {
    element.remove();
  }
});

for (
  const { state, claimed, token } of [
    { state: "verified", claimed: "alice", token: "--cf-theme-color-success" },
    {
      state: "unverified",
      claimed: "mallory",
      token: "--cf-theme-color-warning",
    },
  ]
) {
  Deno.test(`a ${state} badge draws its border in the theme's ${token}`, async () => {
    const host = document.createElement("div");
    host.style.setProperty(token, "rgb(1, 2, 3)");
    document.body.append(host);
    try {
      const element = await mount(claimed, host);
      const badge = element.shadowRoot?.querySelector(".badge");
      expect(badge).toBeInstanceOf(HTMLElement);
      expect(getComputedStyle(badge!).borderTopColor).toBe("rgb(1, 2, 3)");
    } finally {
      host.remove();
    }
  });
}
