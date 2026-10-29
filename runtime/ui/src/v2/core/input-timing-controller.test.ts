import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import type { ReactiveControllerHost } from "lit";

import { InputTimingController } from "./input-timing-controller.ts";

function createMockHost(): ReactiveControllerHost {
  return {
    addController: () => {},
    removeController: () => {},
    requestUpdate: () => {},
    updateComplete: Promise.resolve(true),
  } as unknown as ReactiveControllerHost;
}

//
// Immediate strategy
//

describe("InputTimingController — immediate", () => {
  it("fires callback synchronously", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "immediate",
    });
    let fired = false;
    ctrl.schedule(() => {
      fired = true;
    });
    expect(fired).toBe(true);
  });
});

//
// Debounce strategy
//

describe("InputTimingController — debounce", () => {
  let time: FakeTime;

  beforeEach(() => {
    time = new FakeTime();
  });
  afterEach(() => {
    time.restore();
  });

  it("delays callback until after the delay period", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "debounce",
      delay: 200,
    });
    let fired = false;
    ctrl.schedule(() => {
      fired = true;
    });

    expect(fired).toBe(false);
    time.tick(199);
    expect(fired).toBe(false);
    time.tick(1);
    expect(fired).toBe(true);
  });

  it("resets the timer on repeated calls", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "debounce",
      delay: 100,
    });
    const calls: string[] = [];

    ctrl.schedule(() => calls.push("first"));
    time.tick(80);
    ctrl.schedule(() => calls.push("second"));
    time.tick(80);
    // 80ms after second schedule — first should have been cancelled
    expect(calls).toEqual([]);
    time.tick(20);
    // 100ms after second schedule
    expect(calls).toEqual(["second"]);
  });

  it("onBlur flushes pending debounced callback immediately", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "debounce",
      delay: 500,
    });
    let fired = false;
    ctrl.schedule(() => {
      fired = true;
    });

    expect(fired).toBe(false);
    ctrl.onBlur();
    expect(fired).toBe(true);
  });

  it("cancel() prevents pending callback from firing", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "debounce",
      delay: 100,
    });
    let fired = false;
    ctrl.schedule(() => {
      fired = true;
    });
    ctrl.cancel();
    time.tick(200);
    expect(fired).toBe(false);
  });
});

//
// Throttle strategy
//

describe("InputTimingController — throttle", () => {
  let time: FakeTime;

  beforeEach(() => {
    time = new FakeTime();
  });
  afterEach(() => {
    time.restore();
  });

  it("fires immediately on leading edge (default)", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "throttle",
      delay: 200,
    });
    let fired = false;
    ctrl.schedule(() => {
      fired = true;
    });
    expect(fired).toBe(true);
  });

  it("fires trailing edge after delay", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "throttle",
      delay: 100,
    });
    const calls: string[] = [];

    // First call fires immediately (leading edge)
    ctrl.schedule(() => calls.push("first"));
    expect(calls).toEqual(["first"]);

    // Second call within delay window — should queue for trailing edge
    ctrl.schedule(() => calls.push("second"));
    expect(calls).toEqual(["first"]);

    time.tick(100);
    expect(calls).toEqual(["first", "second"]);
  });

  it("leading:false suppresses leading edge", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "throttle",
      delay: 100,
      leading: false,
      trailing: true,
    });
    let fired = false;
    ctrl.schedule(() => {
      fired = true;
    });
    expect(fired).toBe(false);
    time.tick(100);
    expect(fired).toBe(true);
  });

  it("trailing:false suppresses trailing edge", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "throttle",
      delay: 100,
      leading: true,
      trailing: false,
    });
    const calls: string[] = [];

    ctrl.schedule(() => calls.push("first"));
    expect(calls).toEqual(["first"]);

    // Second call within window — trailing is disabled, so it's dropped
    ctrl.schedule(() => calls.push("second"));
    time.tick(200);
    expect(calls).toEqual(["first"]);
  });
});

//
// Blur strategy
//

describe("InputTimingController — blur", () => {
  it("does not fire until onBlur()", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "blur",
    });
    let fired = false;
    ctrl.schedule(() => {
      fired = true;
    });
    expect(fired).toBe(false);
  });

  it("fires pending callback on onBlur()", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "blur",
    });
    let fired = false;
    ctrl.schedule(() => {
      fired = true;
    });
    ctrl.onBlur();
    expect(fired).toBe(true);
  });

  it("only fires the latest scheduled callback", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "blur",
    });
    const calls: string[] = [];
    ctrl.schedule(() => calls.push("first"));
    ctrl.schedule(() => calls.push("second"));
    ctrl.onBlur();
    expect(calls).toEqual(["second"]);
  });

  it("cancel() prevents callback from firing on blur", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "blur",
    });
    let fired = false;
    ctrl.schedule(() => {
      fired = true;
    });
    ctrl.cancel();
    ctrl.onBlur();
    expect(fired).toBe(false);
  });
});

//
// flush()
//

describe("InputTimingController — flush", () => {
  let time: FakeTime;

  beforeEach(() => {
    time = new FakeTime();
  });
  afterEach(() => {
    time.restore();
  });

  it("runs a pending debounced callback immediately and cancels the timer", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "debounce",
      delay: 500,
    });
    const calls: string[] = [];
    ctrl.schedule(() => calls.push("v"));

    expect(calls).toEqual([]);
    ctrl.flush();
    expect(calls).toEqual(["v"]);

    // The scheduled timer must not fire again after a manual flush.
    time.tick(500);
    expect(calls).toEqual(["v"]);
  });

  it("flushes only the latest debounced callback", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "debounce",
      delay: 200,
    });
    const calls: string[] = [];
    ctrl.schedule(() => calls.push("first"));
    ctrl.schedule(() => calls.push("second"));
    ctrl.flush();
    expect(calls).toEqual(["second"]);
  });

  it("runs a pending throttle trailing edge instead of dropping it", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "throttle",
      delay: 100,
    });
    const calls: string[] = [];

    // Leading edge fires immediately.
    ctrl.schedule(() => calls.push("leading"));
    expect(calls).toEqual(["leading"]);

    // A second call within the window queues a trailing-edge write.
    ctrl.schedule(() => calls.push("trailing"));
    expect(calls).toEqual(["leading"]);

    // flush() must run the trailing write now, not cancel it.
    ctrl.flush();
    expect(calls).toEqual(["leading", "trailing"]);

    // And the scheduled trailing timer must not fire a second time.
    time.tick(100);
    expect(calls).toEqual(["leading", "trailing"]);
  });

  it("runs a pending blur-strategy callback immediately", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "blur",
    });
    let fired = false;
    ctrl.schedule(() => {
      fired = true;
    });
    ctrl.flush();
    expect(fired).toBe(true);
  });

  it("is a no-op when nothing is pending", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "debounce",
      delay: 100,
    });
    ctrl.flush();
    time.tick(100);
    // No callback was scheduled, so nothing fires and flush() does not throw.
    expect(true).toBe(true);
  });
});

//
// Lifecycle and configuration
//

describe("InputTimingController — lifecycle", () => {
  let time: FakeTime;

  beforeEach(() => {
    time = new FakeTime();
  });
  afterEach(() => {
    time.restore();
  });

  it("hostDisconnected cancels pending callbacks", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "debounce",
      delay: 100,
    });
    let fired = false;
    ctrl.schedule(() => {
      fired = true;
    });
    ctrl.hostDisconnected();
    time.tick(200);
    expect(fired).toBe(false);
  });

  it("updateOptions changes strategy at runtime", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "debounce",
      delay: 100,
    });

    // Switch to immediate
    ctrl.updateOptions({ strategy: "immediate" });

    let fired = false;
    ctrl.schedule(() => {
      fired = true;
    });
    expect(fired).toBe(true); // no delay
  });

  it("updateOptions cancels pending callbacks from old strategy", () => {
    const ctrl = new InputTimingController(createMockHost(), {
      strategy: "debounce",
      delay: 100,
    });
    let fired = false;
    ctrl.schedule(() => {
      fired = true;
    });
    ctrl.updateOptions({ strategy: "immediate" });
    time.tick(200);
    expect(fired).toBe(false); // old callback was cancelled
  });

  it("registers itself with the host", () => {
    let registered = false;
    const host = {
      addController: () => {
        registered = true;
      },
      removeController: () => {},
      requestUpdate: () => {},
      updateComplete: Promise.resolve(true),
    } as unknown as ReactiveControllerHost;

    new InputTimingController(host, { strategy: "immediate" });
    expect(registered).toBe(true);
  });
});
