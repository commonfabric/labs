// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import {
  createMockCellHandle,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFLink, CFRouter } from "./index.ts";

/** A router holding a link to `to`, mounted, and whether any
 * `cf-route-change` got past the router. */
async function routerWithLinkTo(to: string) {
  const router = new CFRouter();
  const link = Object.assign(new CFLink(), { to });
  router.append(link);
  let escaped = false;
  document.body.addEventListener("cf-route-change", () => escaped = true);
  await mount(router);
  return { router, link, escaped: () => escaped };
}

describe("CFRouter", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-router`", () => {
    expect(customElements.get("cf-router")).toBe(CFRouter);
  });

  it("starts at the root path", () => {
    expect(new CFRouter().path).toBe("/");
  });

  it("renders its content through a slot", async () => {
    const { router } = await routerWithLinkTo("/a");
    expect(router.shadowRoot!.querySelector("slot")).not.toBe(null);
  });

  it("takes a plain path from a link's route change, which goes no further", async () => {
    const { router, link, escaped } = await routerWithLinkTo("/inbox");
    link.click();
    expect(router.path).toBe("/inbox");
    expect(escaped()).toBe(false);
  });

  it("writes a link's route change to a cell path, keeping the cell", async () => {
    const { router, link } = await routerWithLinkTo("/inbox");
    const path = createMockCellHandle("/");
    router.path = path;
    link.click();
    expect(router.path).toBe(path);
    expect(path.get()).toBe("/inbox");
    expect(writesSent(path).map(({ value }) => value)).toEqual(["/inbox"]);
  });

  it("ignores route changes once disconnected", async () => {
    const { router } = await routerWithLinkTo("/inbox");
    router.remove();
    router.dispatchEvent(
      new CustomEvent("cf-route-change", { detail: { to: "/inbox" } }),
    );
    expect(router.path).toBe("/");
  });
});
