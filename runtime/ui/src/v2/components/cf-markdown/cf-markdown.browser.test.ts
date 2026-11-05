/**
 * Tests for the DOM cf-markdown builds from a markdown document.
 *
 * These need a browser, and run under deno-web-test rather than `deno test`.
 * The harness registers tests through `Deno.test` and calls each one with no
 * arguments, so the BDD functions the rest of the repository uses are not
 * available here.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { CFMarkdown } from "./index.ts";

interface Rendered {
  content: HTMLElement;
  element: CFMarkdown;
  done(): void;
}

async function render(markdown: string): Promise<Rendered> {
  const element = new CFMarkdown();
  element.content = markdown;
  document.body.appendChild(element);
  await element.updateComplete;
  const content = element.shadowRoot?.querySelector(
    ".markdown-content",
  ) as HTMLElement;
  assert(content, "the component renders a .markdown-content wrapper");
  return { content, element, done: () => element.remove() };
}

/** Every element the component put in the document, the wrapper aside. */
function elementsOf(content: HTMLElement): Element[] {
  return Array.from(content.querySelectorAll("*"));
}

/**
 * A document collecting the ways markdown can carry markup, a URL that runs
 * script, or an event handler.
 */
const HOSTILE = [
  "<script>globalThis.__markdownXss = true;</script>",
  '<img src="x" onerror="globalThis.__markdownXss = true;">',
  '<div onmouseover="globalThis.__markdownXss = true;">hover me</div>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">an anchor</a>',
  '<svg><animate attributeName="href" to="javascript:alert(1)"></svg>',
  "[a link](javascript:alert(1))",
  "[a link](JaVaScRiPt:alert(1))",
  "![an image](javascript:alert(1))",
  "[a link](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[a link](vbscript:msgbox(1))",
  "<style>@import url(https://example.invalid/x.css);</style>",
].join("\n\n");

Deno.test("cf-markdown renders no element that can run script", async () => {
  const { content, done } = await render(HOSTILE);
  try {
    for (const forbidden of ["script", "iframe", "img", "svg", "style"]) {
      assertEquals(
        content.querySelectorAll(forbidden).length,
        0,
        `renders no <${forbidden}>`,
      );
    }
  } finally {
    done();
  }
});

Deno.test("cf-markdown renders no event-handler attribute", async () => {
  const { content, done } = await render(HOSTILE);
  try {
    for (const element of elementsOf(content)) {
      for (const attribute of Array.from(element.attributes)) {
        assert(
          !attribute.name.toLowerCase().startsWith("on"),
          `<${element.localName}> carries ${attribute.name}`,
        );
      }
    }
  } finally {
    done();
  }
});

Deno.test("cf-markdown renders no URL that runs script", async () => {
  const { content, done } = await render(HOSTILE);
  try {
    for (const element of elementsOf(content)) {
      for (const attribute of Array.from(element.attributes)) {
        const value = attribute.value.replace(/[\s]/g, "").toLowerCase();
        assert(
          !value.startsWith("javascript:") && !value.startsWith("vbscript:") &&
            !value.startsWith("data:text/html"),
          `<${element.localName}> carries ${attribute.name}="${attribute.value}"`,
        );
      }
    }
  } finally {
    done();
  }
});

Deno.test("cf-markdown renders a hostile document's text as text", async () => {
  const { content, done } = await render("A <b>bold</b> word and <script>");
  try {
    assertEquals(content.querySelectorAll("b").length, 0);
    assertStringIncludes(content.textContent ?? "", "A bold word and");
  } finally {
    done();
  }
});

Deno.test("cf-markdown drops a block of raw HTML along with its text", async () => {
  const { content, done } = await render(
    "<div>text inside the block</div>\n\nA paragraph after it.",
  );
  try {
    // marked reads a block of HTML as one token holding its content, so the
    // text inside goes when the block does. Inline HTML is one token per tag,
    // and the text between a pair of tags survives on its own — the test
    // above pins that half.
    assertEquals(content.textContent?.includes("text inside the block"), false);
    assertStringIncludes(content.textContent ?? "", "A paragraph after it.");
  } finally {
    done();
  }
});

Deno.test("cf-markdown keeps a link whose target it cannot follow as text", async () => {
  const { content, done } = await render("[the label](javascript:alert(1))");
  try {
    assertEquals(content.querySelectorAll("a").length, 0);
    assertStringIncludes(content.textContent ?? "", "the label");
  } finally {
    done();
  }
});

Deno.test("cf-markdown renders emphasis, strong text and a code span", async () => {
  const { content, done } = await render(
    "Hello **world**, *now* with `code`",
  );
  try {
    assertEquals(content.querySelector("strong")?.textContent, "world");
    assertEquals(content.querySelector("em")?.textContent, "now");
    assertEquals(content.querySelector("code")?.textContent, "code");
  } finally {
    done();
  }
});

Deno.test("cf-markdown renders an ordinary link", async () => {
  const { content, done } = await render(
    '[example](https://example.com/a "the title")',
  );
  try {
    const anchor = content.querySelector("a");
    assertEquals(anchor?.getAttribute("href"), "https://example.com/a");
    assertEquals(anchor?.getAttribute("title"), "the title");
    assertEquals(anchor?.textContent, "example");
  } finally {
    done();
  }
});

Deno.test("cf-markdown renders an image with an allowed source", async () => {
  const { content, done } = await render(
    "![the alt](https://example.com/a.png)",
  );
  try {
    const image = content.querySelector("img");
    assertEquals(image?.getAttribute("src"), "https://example.com/a.png");
    assertEquals(image?.getAttribute("alt"), "the alt");
  } finally {
    done();
  }
});

Deno.test("cf-markdown renders a code block with a copy button holding the code", async () => {
  const { content, done } = await render(
    "```js\nconst a = 1 < 2 && 3 > 2;\n```",
  );
  try {
    const code = content.querySelector(".code-block-container pre code");
    assertEquals(code?.getAttribute("class"), "language-js");
    assertEquals(code?.textContent, "const a = 1 < 2 && 3 > 2;\n");
    const copy = content.querySelector("cf-copy-button") as
      | (Element & { text: string })
      | null;
    assertEquals(copy?.text, "const a = 1 < 2 && 3 > 2;\n");
  } finally {
    done();
  }
});

Deno.test("cf-markdown wraps each table in its own scroll container", async () => {
  const { content, done } = await render([
    "| A | B |",
    "| --- | ---: |",
    "| 1 | 2 |",
    "",
    "Prose between the tables.",
    "",
    "| C | D |",
    "| --- | --- |",
    "| 3 | 4 |",
  ].join("\n"));
  try {
    const wrappers = content.querySelectorAll(".table-scroll");
    assertEquals(wrappers.length, 2);
    for (const wrapper of Array.from(wrappers)) {
      assertEquals(wrapper.querySelectorAll("table").length, 1);
    }
    // The prose between the tables is outside both wrappers.
    assertEquals(
      content.querySelector(".table-scroll")?.textContent?.includes("Prose"),
      false,
    );
    assertEquals(
      content.querySelectorAll("td")[1]?.getAttribute("align"),
      "right",
    );
  } finally {
    done();
  }
});

Deno.test("cf-markdown renders a cell link as a cf-cell-link", async () => {
  const { content, done } = await render("Check this [Link](/of:bafyabc/path)");
  try {
    const link = content.querySelector("cf-cell-link") as
      | (Element & { link: string; label: string })
      | null;
    assertEquals(link?.link, "/of:bafyabc/path");
    assertEquals(link?.label, "Link");
  } finally {
    done();
  }
});

Deno.test("cf-markdown gives a fragment link a heading to land on", async () => {
  const { content, done } = await render(
    "# Section One\n\n[Jump](#section-one)",
  );
  try {
    assertEquals(content.querySelector("h1")?.id, "section-one");
    assertEquals(
      content.querySelector("a")?.getAttribute("href"),
      "#section-one",
    );
  } finally {
    done();
  }
});

Deno.test("cf-markdown reports which task-list checkbox was toggled", async () => {
  const { content, element, done } = await render(
    "- [ ] first\n- [ ] second\n- [x] third",
  );
  try {
    const boxes = content.querySelectorAll('input[type="checkbox"]');
    assertEquals(boxes.length, 3);
    assertEquals((boxes[2] as HTMLInputElement).checked, true);
    assertEquals((boxes[1] as HTMLInputElement).disabled, false);

    const reported: unknown[] = [];
    element.addEventListener("cf-checkbox-change", (event) => {
      reported.push((event as CustomEvent).detail);
    });
    (boxes[1] as HTMLInputElement).click();

    assertEquals(reported, [{ index: 1, checked: true }]);
  } finally {
    done();
  }
});

Deno.test("cf-markdown puts a toggled checkbox back to what the document says", async () => {
  const { content, element, done } = await render("- [ ] first");
  try {
    const box = content.querySelector("input") as HTMLInputElement;
    box.click();
    assertEquals(box.checked, true);

    // Any re-render. The document still says the task is not done, and a
    // consumer that did not record the toggle should see that again.
    element.variant = "inverse";
    await element.updateComplete;

    assertEquals(
      (content.querySelector("input") as HTMLInputElement).checked,
      false,
    );
  } finally {
    done();
  }
});

Deno.test("cf-markdown resolves character references in text", async () => {
  const { content, done } = await render("Tips &amp; tricks &copy; AT&T");
  try {
    assertEquals(
      content.querySelector("p")?.textContent,
      "Tips & tricks © AT&T",
    );
  } finally {
    done();
  }
});

Deno.test("cf-markdown leaves character references in a code span as written", async () => {
  const { content, done } = await render("Write `&amp;` for an ampersand");
  try {
    assertEquals(content.querySelector("code")?.textContent, "&amp;");
  } finally {
    done();
  }
});
