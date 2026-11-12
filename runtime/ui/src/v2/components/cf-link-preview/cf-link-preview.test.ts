// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { CFLinkPreview } from "./index.ts";

/** A request the component made, which the test answers. */
type Request = {
  url: string;
  signal: AbortSignal;
  /** What the component's `fetch()` returned. */
  response: Promise<Response>;
  respond(response: Response): void;
};

/** A preview for `url`, mounted. */
function preview(url: string): Promise<CFLinkPreview> {
  return mount(Object.assign(new CFLinkPreview(), { url }));
}

/** A JSON response carrying `body`. */
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Resolves with the first element matching `selector` in `element`'s shadow
 * root, once one is there.
 */
function rendered(element: CFLinkPreview, selector: string): Promise<Element> {
  const root = element.shadowRoot!;
  const { promise, resolve } = Promise.withResolvers<Element>();
  const check = () => {
    const match = root.querySelector(selector);
    if (!match) return;
    observer.disconnect();
    resolve(match);
  };
  const observer = new MutationObserver(check);
  observer.observe(root, { childList: true, subtree: true, attributes: true });
  check();
  return promise;
}

describe("CFLinkPreview", () => {
  const originalFetch = globalThis.fetch;
  let requests: Request[];

  // Each request waits for the test to answer it, and rejects once aborted,
  // as the browser's `fetch()` does.
  beforeEach(() => {
    requests = [];
    globalThis.fetch = (input, init) => {
      const { promise, resolve, reject } = Promise.withResolvers<Response>();
      const signal = init!.signal!;
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
      );
      requests.push({
        url: String(input),
        signal,
        response: promise,
        respond: resolve,
      });
      return promise;
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    document.body.replaceChildren();
  });

  it("renders nothing, and fetches nothing, without a URL", async () => {
    const element = await preview("");

    expect(element.shadowRoot!.querySelector("*")).toBeNull();
    expect(requests).toEqual([]);
  });

  it("fetches the preview of its URL from the link-preview endpoint, and shows a placeholder meanwhile", async () => {
    const element = await preview("https://example.com/a?b=c");

    expect(requests.map((request) => request.url)).toEqual([
      "/api/link-preview/https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc",
    ]);
    expect(element.shadowRoot!.querySelector(".preview-card.loading"))
      .not.toBeNull();
    expect(element.shadowRoot!.querySelector("a")).toBeNull();
  });

  it("renders a card linking to the URL with the fetched title, description, and image", async () => {
    const element = await preview("https://example.com/page");

    requests[0].respond(json({
      title: "Example",
      description: "An example page",
      image: "https://example.com/image.png",
    }));
    const card = await rendered(element, "a.preview-card:not(.fallback)");

    expect(card.getAttribute("href")).toBe("https://example.com/page");
    expect(card.getAttribute("target")).toBe("_blank");
    expect(card.querySelector(".preview-title")!.textContent).toBe("Example");
    expect(card.querySelector(".preview-description")!.textContent).toBe(
      "An example page",
    );
    expect(card.querySelector("img")!.getAttribute("src")).toBe(
      "https://example.com/image.png",
    );
    expect(card.querySelector(".preview-domain")!.textContent).toBe(
      "example.com",
    );
  });

  it("titles an image with no title by its domain, and renders no description it was not given", async () => {
    const element = await preview("https://example.com/page");

    requests[0].respond(json({ image: "https://example.com/image.png" }));
    const card = await rendered(element, "a.preview-card:not(.fallback)");

    expect(card.querySelector(".preview-title")!.textContent).toBe(
      "example.com",
    );
    expect(card.querySelector(".preview-description")).toBeNull();
  });

  it("renders no image it was not given", async () => {
    const element = await preview("https://example.com/page");

    requests[0].respond(json({ title: "Example" }));
    const card = await rendered(element, "a.preview-card:not(.fallback)");

    expect(card.querySelector(".preview-title")!.textContent).toBe("Example");
    expect(card.querySelector("img")).toBeNull();
  });

  it("renders a link showing the domain when the preview has neither title nor image", async () => {
    const element = await preview("https://example.com/page");

    requests[0].respond(json({ description: "Only a description" }));
    const card = await rendered(element, "a.preview-card.fallback");

    expect(card.getAttribute("href")).toBe("https://example.com/page");
    expect(card.textContent!.trim()).toBe("example.com");
  });

  it("renders a link showing the domain when the endpoint fails", async () => {
    const element = await preview("https://example.com/page");

    requests[0].respond(new Response("Bad gateway", { status: 502 }));
    const card = await rendered(element, "a.preview-card.fallback");

    expect(card.textContent!.trim()).toBe("example.com");
  });

  it("links to `#` for a URL that is not http or https, or does not parse", async () => {
    for (
      const [url, shown] of [
        ["javascript:alert(1)", ""],
        ["not a url", "not a url"],
      ]
    ) {
      const element = await preview(url);

      requests.at(-1)!.respond(json({ title: "Trap" }));
      const card = await rendered(element, "a.preview-card:not(.fallback)");

      expect(card.getAttribute("href")).toBe("#");
      expect(card.querySelector(".preview-domain")!.textContent).toBe(shown);
      element.remove();
    }
  });

  it("aborts the fetch for a URL it is no longer showing, and shows the new URL's preview", async () => {
    const element = await preview("https://first.example/");

    element.url = "https://second.example/";
    await element.updateComplete;
    expect(requests.map((request) => request.signal.aborted)).toEqual([
      true,
      false,
    ]);
    // The component awaits the aborted fetch before the test does, so it has
    // handled the abort by now, and is still waiting on the second fetch.
    await requests[0].response.catch(() => {});
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector(".preview-card.loading"))
      .not.toBeNull();
    requests[1].respond(json({ title: "Second" }));
    const card = await rendered(element, "a.preview-card:not(.fallback)");

    expect(card.querySelector(".preview-title")!.textContent).toBe("Second");
  });

  it("aborts its fetch once removed from the document", async () => {
    const element = await preview("https://example.com/page");

    element.remove();

    expect(requests[0].signal.aborted).toBe(true);
  });
});
