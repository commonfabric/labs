// First, so that the document it installs is there when Lit loads.
import { mount } from "../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { ReactiveElement } from "lit";

import { DebugController } from "./debug-controller.ts";

/** A host carrying a {@link DebugController}, which records its animations. */
class Host extends ReactiveElement {
  readonly animations: { keyframes: unknown; duration: unknown }[] = [];

  constructor() {
    super();
    new DebugController(this);
  }

  override animate(
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    duration?: number | KeyframeAnimationOptions,
  ): Animation {
    this.animations.push({ keyframes, duration });
    return super.animate(keyframes, duration);
  }
}
customElements.define("debug-controller-host", Host);

describe("DebugController", () => {
  afterEach(() => document.body.replaceChildren());

  it("flashes a red outline on the host each time it updates", async () => {
    const host = await mount(new Host());
    expect(host.animations).toHaveLength(1);
    expect(host.animations[0].duration).toBe(1500);
    expect(host.animations[0].keyframes).toEqual([
      { outline: "rgba(255, 0, 0, 1) 5px solid" },
      { outline: "rgba(255, 0, 0, 1) 5px solid", offset: 0.5 },
      { outline: "rgba(255, 0, 0, 0) 5px solid" },
    ]);

    host.requestUpdate();
    await host.updateComplete;
    expect(host.animations).toHaveLength(2);
  });

  it("flashes nothing on a host updated while out of the document", async () => {
    const host = await mount(new Host());
    host.remove();
    host.requestUpdate();
    await host.updateComplete;
    expect(host.animations).toHaveLength(1);
  });
});
