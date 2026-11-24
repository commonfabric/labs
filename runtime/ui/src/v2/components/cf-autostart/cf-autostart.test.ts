// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { CFAutostart } from "./index.ts";

describe("CFAutostart", () => {
  afterEach(() => document.body.replaceChildren());

  it("registers the cf-autostart element", () => {
    expect(customElements.get("cf-autostart")).toBe(CFAutostart);
  });

  it("emits start once on its first connection and not on later ones", async () => {
    const element = new CFAutostart();
    const starts: Event[] = [];
    document.body.addEventListener("start", (event) => starts.push(event));
    expect(starts).toHaveLength(0);

    await mount(element);
    expect(starts).toHaveLength(1);
    expect(starts[0].target).toBe(element);

    element.remove();
    document.body.append(element);
    expect(starts).toHaveLength(1);
  });
});
