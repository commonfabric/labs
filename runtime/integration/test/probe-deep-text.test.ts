import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Browser } from "../browser.ts";
import { waitForCondition } from "../utils.ts";

describe("ProbeApi.deepText", () => {
  it("reads each nested shadow element once", async () => {
    const browser = await Browser.launch();
    try {
      const page = await browser.newPage();
      try {
        for (const depth of [4, 8, 12]) {
          const result = await waitForCondition(
            page,
            (probe, depth: number) => {
              document.body.replaceChildren();
              let reads = 0;
              const root = document.createElement("div");
              document.body.append(root);
              let current = root;
              for (let index = 0; index < depth; index++) {
                const child = document.createElement("div");
                Object.defineProperty(child, "innerText", {
                  get() {
                    reads++;
                    return `marker-${index}`;
                  },
                });
                current.attachShadow({ mode: "open" }).append(child);
                current = child;
              }
              return { text: probe.deepText(root), reads };
            },
            { args: [depth] },
          );
          if (!result) {
            throw new Error("The probe did not return its observations");
          }
          expect(result.reads).toBe(depth);
          expect(result.text.trim().split(/\s+/)).toEqual(
            Array.from({ length: depth }, (_, index) => `marker-${index}`),
          );
        }
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  it("includes shadow and slotted text while excluding hidden root text", async () => {
    const browser = await Browser.launch();
    try {
      const page = await browser.newPage();
      try {
        const result = await waitForCondition(page, (probe) => {
          const root = document.createElement("div");
          document.body.append(root);
          const shadow = root.attachShadow({ mode: "open" });
          shadow.innerHTML = `
          <b>Shadow heading</b><slot></slot>
          <span hidden>Hidden marker</span>
          <span style="visibility:hidden">Invisible marker</span>
          <style>/* Style marker */</style>
          <script type="application/json">"Script marker"</script>
        `;
          const slotted = document.createElement("section");
          slotted.textContent = "Slotted label";
          const nested = document.createElement("div");
          nested.attachShadow({ mode: "open" }).innerHTML =
            "<span>Nested shadow label</span>";
          slotted.append(nested);
          root.append(slotted);
          return { text: probe.deepText(root) };
        });
        if (!result) {
          throw new Error("The probe did not return its observations");
        }
        for (
          const text of [
            "Shadow heading",
            "Slotted label",
            "Nested shadow label",
          ]
        ) {
          expect(result.text).toContain(text);
        }
        for (
          const text of [
            "Hidden marker",
            "Invisible marker",
            "Style marker",
            "Script marker",
          ]
        ) {
          expect(result.text).not.toContain(text);
        }
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });
});
