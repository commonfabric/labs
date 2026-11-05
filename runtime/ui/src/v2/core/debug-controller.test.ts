import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { DebugController } from "./debug-controller.ts";

/** A host that records the controllers it is given and the animations run. */
const fakeHost = () => {
  const controllers: ReactiveController[] = [];
  const animations: Array<{ keyframes: unknown; duration: unknown }> = [];
  const host = {
    addController: (controller: ReactiveController) =>
      controllers.push(controller),
    animate: (keyframes: unknown, duration: unknown) => {
      animations.push({ keyframes, duration });
    },
  };
  return {
    host: host as unknown as ReactiveControllerHost & HTMLElement,
    controllers,
    animations,
  };
};

describe("debug-controller", () => {
  it("registers itself with its host", () => {
    const { host, controllers } = fakeHost();

    const controller = new DebugController(host);

    expect(controllers).toEqual([controller]);
  });

  it("flashes the host's outline after an update only while connected", () => {
    const { host, animations } = fakeHost();
    const controller = new DebugController(host);

    controller.hostUpdated();
    expect(animations).toHaveLength(0);

    controller.hostConnected();
    controller.hostUpdated();
    expect(animations).toHaveLength(1);
    expect(animations[0].duration).toBe(1500);
    expect(animations[0].keyframes).toEqual([
      { outline: "rgba(255, 0, 0, 1) 5px solid" },
      { outline: "rgba(255, 0, 0, 1) 5px solid", offset: 0.5 },
      { outline: "rgba(255, 0, 0, 0) 5px solid" },
    ]);

    controller.hostDisconnected();
    controller.hostUpdated();
    expect(animations).toHaveLength(1);
  });
});
