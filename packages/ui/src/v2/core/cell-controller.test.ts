import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import {
  CellHandle,
  type CellRef,
  isCellHandle,
} from "@commonfabric/runtime-client";
import type { ReactiveControllerHost } from "lit";

import {
  createMockCellHandle as createUnobservedMockCellHandle,
  pushUpdate,
} from "../test-utils/mock-cell-handle.ts";
import {
  ArrayCellController,
  BooleanCellController,
  CellController,
  createArrayCellController,
  createBooleanCellController,
  createCellController,
  createStringCellController,
  StringCellController,
} from "./cell-controller.ts";

/** Commit promises started through each mock handle. */
const mockWrites = new WeakMap<object, Promise<void>[]>();

/** Constructs a mock handle whose UI-write completions tests can await. */
function createMockCellHandle<T>(
  value?: T,
  ref?: Partial<CellRef>,
  source?: CellHandle<T>,
): CellHandle<T> {
  const cell = source
    ? new CellHandle<T>(source.runtime(), { ...source.ref(), ...ref }, value)
    : createUnobservedMockCellHandle(value, ref);
  const writes: Promise<void>[] = [];
  mockWrites.set(cell, writes);
  const setForUI = cell.setForUI.bind(cell);
  cell.setForUI = (value) => {
    const write = setForUI(value);
    writes.push(write);
    return write;
  };
  return cell;
}

/** Waits for writes already started on the supplied handles. */
async function settleWrites(
  ...cells: { sync(): Promise<unknown> }[]
): Promise<void> {
  await Promise.all(cells.flatMap((cell) => mockWrites.get(cell) ?? []));
  await Promise.all(cells.map((cell) => cell.sync()));
}

/** Minimal mock host satisfying Lit's ReactiveControllerHost interface. */
function createMockHost(): ReactiveControllerHost {
  return {
    addController: () => {},
    removeController: () => {},
    requestUpdate: () => {},
    updateComplete: Promise.resolve(true),
  } as unknown as ReactiveControllerHost;
}

//
// createMockCellHandle sanity checks
//

describe("createMockCellHandle", () => {
  it("passes isCellHandle()", () => {
    const h = createMockCellHandle("x");
    expect(isCellHandle(h)).toBe(true);
  });

  it("get() returns the initial value", () => {
    const h = createMockCellHandle("hello");
    expect(h.get()).toBe("hello");
  });

  it("set() updates get() and notifies subscribers", async () => {
    const h = createMockCellHandle("a");
    const values: (string | undefined)[] = [];
    h.subscribe((v) => {
      values.push(v);
    });
    await h.set("b");
    expect(h.get()).toBe("b");
    expect(values).toEqual(["a", "b"]); // initial + update
  });

  it("key() returns a child CellHandle", () => {
    const h = createMockCellHandle({ foo: 42 });
    const child = h.key("foo");
    expect(isCellHandle(child)).toBe(true);
    expect(child.get()).toBe(42);
  });

  it("subscribe() calls callback immediately with current value", () => {
    const h = createMockCellHandle("now");
    let received: string | undefined;
    h.subscribe((v) => {
      received = v;
    });
    expect(received).toBe("now");
  });

  it("child.set() propagates to parent value and fires parent subscribers", async () => {
    const parent = createMockCellHandle({ name: "Alice", age: 30 });
    const values: unknown[] = [];
    parent.subscribe((v) => {
      values.push(structuredClone(v));
    });

    const child = parent.key("name");
    await child.set("Bob");

    expect(parent.get()).toEqual({ name: "Bob", age: 30 });
    // values[0] = initial ({name:"Alice",age:30}), values[1] = after child.set
    expect(values.length).toBeGreaterThanOrEqual(2);
    expect(values[values.length - 1]).toEqual({ name: "Bob", age: 30 });
  });

  it("child.set() on array element propagates to parent", async () => {
    const parent = createMockCellHandle(["x", "y", "z"]);
    const item = parent.key(1 as keyof string[]);
    await item.set("Y" as any);
    expect(parent.get()).toEqual(["x", "Y", "z"]);
  });

  it("pushUpdate() simulates backend-pushed value change", () => {
    const cell = createMockCellHandle("original");
    const received: (string | undefined)[] = [];
    cell.subscribe((v) => {
      received.push(v);
    });
    received.length = 0; // clear initial

    pushUpdate(cell, "from-backend");
    expect(cell.get()).toBe("from-backend");
    expect(received).toEqual(["from-backend"]);
  });

  it("pushUpdate() suppresses callback when value is equal", () => {
    const cell = createMockCellHandle(42);
    let callCount = 0;
    cell.subscribe(() => {
      callCount++;
    });
    const afterSubscribe = callCount;

    pushUpdate(cell, 42); // same value
    expect(callCount).toBe(afterSubscribe);
  });
});

//
// CellController
//

describe("CellController", () => {
  it("binds a CellHandle and reads its value", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    const cell = createMockCellHandle("init");
    ctrl.bind(cell);
    expect(ctrl.getValue()).toBe("init");
    expect(ctrl.hasCell()).toBe(true);
    expect(ctrl.getCell()).toBe(cell);
  });

  it("binds a plain value", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    ctrl.bind("plain" as any);
    expect(ctrl.getValue()).toBe("plain");
    expect(ctrl.hasCell()).toBe(false);
    expect(ctrl.getCell()).toBeNull();
  });

  it("setValue updates the underlying CellHandle", async () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    const cell = createMockCellHandle("before");
    ctrl.bind(cell);
    ctrl.setValue("after");
    expect(ctrl.getValue()).toBe("after");
    await settleWrites(cell);
    expect(cell.get()).toBe("after");
  });

  it("calls onChange when setValue is invoked", () => {
    const host = createMockHost();
    const changes: Array<{ newVal: string; oldVal: string }> = [];
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
      onChange: (n, o) => changes.push({ newVal: n, oldVal: o }),
    });
    const cell = createMockCellHandle("a");
    ctrl.bind(cell);
    // bind() sets up subscription which fires onChange("a", undefined) initially.
    // Clear those so we can test setValue in isolation.
    changes.length = 0;

    ctrl.setValue("b");
    // setValue fires onChange directly, and then the cell subscription callback
    // also fires onChange when it sees the new value.
    const setValueChange = changes.find((c) => c.newVal === "b");
    expect(setValueChange).toBeDefined();
    expect(setValueChange!.oldVal).toBe("a");
  });

  it("announces a 0 -> -0 delivery as a change", async () => {
    // `0` and `-0` are distinct values under the system's equality
    // (`Object.is` semantics); the subscription gate must not swallow the
    // update.
    const host = createMockHost();
    const changes: Array<{ newVal: number; oldVal: number | undefined }> = [];
    const ctrl = new CellController<number>(host, {
      timing: { strategy: "immediate" },
      onChange: (n, o) => changes.push({ newVal: n, oldVal: o }),
    });
    const cell = createMockCellHandle(0);
    ctrl.bind(cell);
    changes.length = 0;

    await cell.set(-0);
    expect(changes.length).toBe(1);
    expect(Object.is(changes[0].newVal, -0)).toBe(true);
  });

  it("does not re-announce an unchanged NaN delivery", async () => {
    const host = createMockHost();
    const changes: Array<{ newVal: number; oldVal: number | undefined }> = [];
    const ctrl = new CellController<number>(host, {
      timing: { strategy: "immediate" },
      onChange: (n, o) => changes.push({ newVal: n, oldVal: o }),
    });
    const cell = createMockCellHandle(NaN);
    ctrl.bind(cell);
    changes.length = 0;

    await cell.set(NaN);
    expect(changes.length).toBe(0);
  });

  it("requestUpdate is called when cell subscription fires", async () => {
    let updateCount = 0;
    const host: ReactiveControllerHost = {
      addController: () => {},
      removeController: () => {},
      requestUpdate: () => {
        updateCount++;
      },
      updateComplete: Promise.resolve(true),
    } as unknown as ReactiveControllerHost;

    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    const cell = createMockCellHandle("x");
    ctrl.bind(cell);
    // bind sets up subscription which calls requestUpdate immediately
    const initialCount = updateCount;
    await cell.set("y");
    expect(updateCount).toBeGreaterThan(initialCount);
  });

  it("re-bind to a different cell cleans up old subscription", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    // Use distinct refs so CellHandle.equals() returns false
    const cell1 = createMockCellHandle("one", {
      id: "of:cell-1" as any,
    });
    const cell2 = createMockCellHandle("two", {
      id: "of:cell-2" as any,
    });
    ctrl.bind(cell1);
    ctrl.bind(cell2);
    expect(ctrl.getValue()).toBe("two");
    expect(ctrl.getCell()).toBe(cell2);
  });

  it("hostDisconnected cleans up subscription", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    const cell = createMockCellHandle("val");
    ctrl.bind(cell);
    ctrl.hostDisconnected();
    // After disconnect, the controller should still return the last known value
    // but shouldn't crash
    expect(ctrl.getValue()).toBe("val");
  });

  it("getValue returns undefined when nothing is bound", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    expect(ctrl.getValue()).toBeUndefined();
  });

  it("setValue is a no-op when nothing is bound", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    // Should not throw
    ctrl.setValue("ignored");
  });

  it("bind() with schema parameter creates schema-annotated handle when cell has no schema", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    // Create a handle WITHOUT a schema so bind() will apply one via asSchema
    const cell = createMockCellHandle("typed", {
      schema: undefined,
    });
    const schema = { type: "string" } as const;
    ctrl.bind(cell, schema);
    // bind(cell, schema) calls cell.asSchema(schema) — the controller should
    // hold a different handle than the original, with the schema on its ref.
    expect(ctrl.getValue()).toBe("typed");
    expect(ctrl.hasCell()).toBe(true);
    const bound = ctrl.getCell()!;
    expect(bound).not.toBe(cell); // asSchema creates a new handle
    expect(bound.ref().schema).toEqual(schema);
  });

  it("bind() preserves existing schema when cell already has one", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    // Create a handle WITH a schema (as pattern compiler would)
    const patternSchema = { type: "array", items: { type: "string" } } as const;
    const cell = createMockCellHandle("from-pattern", {
      schema: patternSchema,
    });
    const componentSchema = {
      type: "array",
      items: { type: "object" },
    } as const;
    ctrl.bind(cell, componentSchema);
    // bind() should NOT call asSchema — the controller should use the
    // original handle directly, preserving the pattern's schema.
    expect(ctrl.getValue()).toBe("from-pattern");
    expect(ctrl.hasCell()).toBe(true);
    const bound = ctrl.getCell()!;
    expect(bound).toBe(cell); // same handle, no asSchema
    expect(bound.ref().schema).toEqual(patternSchema); // pattern schema preserved
  });

  it("hostConnected() re-establishes subscription after disconnect", () => {
    let updateCount = 0;
    const host: ReactiveControllerHost = {
      addController: () => {},
      removeController: () => {},
      requestUpdate: () => {
        updateCount++;
      },
      updateComplete: Promise.resolve(true),
    } as unknown as ReactiveControllerHost;

    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    const cell = createMockCellHandle("a");
    ctrl.bind(cell);

    ctrl.hostDisconnected();
    updateCount = 0;
    pushUpdate(cell, "while-disconnected");
    expect(updateCount).toBe(0); // no updates while disconnected

    ctrl.hostConnected();
    updateCount = 0;
    pushUpdate(cell, "after-reconnect");
    expect(updateCount).toBeGreaterThan(0); // subscription restored
  });

  it("hostDisconnected stops requestUpdate on external cell changes", () => {
    let updateCount = 0;
    const host: ReactiveControllerHost = {
      addController: () => {},
      removeController: () => {},
      requestUpdate: () => {
        updateCount++;
      },
      updateComplete: Promise.resolve(true),
    } as unknown as ReactiveControllerHost;

    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
    });
    const cell = createMockCellHandle("a");
    ctrl.bind(cell);
    updateCount = 0;

    ctrl.hostDisconnected();
    pushUpdate(cell, "ignored");
    expect(updateCount).toBe(0);
  });

  it("onChange fires on backend-pushed value change (without setValue)", () => {
    const host = createMockHost();
    const changes: Array<{ newVal: string; oldVal: string }> = [];
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
      onChange: (n, o) => changes.push({ newVal: n, oldVal: o }),
    });
    const cell = createMockCellHandle("initial");
    ctrl.bind(cell);
    changes.length = 0; // clear bind-time onChange calls

    pushUpdate(cell, "external");
    const change = changes.find((c) => c.newVal === "external");
    expect(change).toBeDefined();
    expect(change!.oldVal).toBe("initial");
  });
});

//
// CellController.flush()
//

describe("CellController — flush", () => {
  it("runs a pending debounced write immediately", async () => {
    const cell = createMockCellHandle("initial");
    const ctrl = new CellController<string>(createMockHost(), {
      timing: { strategy: "debounce", delay: 300 },
    });
    ctrl.bind(cell);
    ctrl.setValue("updated");
    // Debounced: the write has not landed yet.
    expect(cell.get()).toBe("initial");
    ctrl.flush();
    expect(ctrl.getValue()).toBe("updated");
    await settleWrites(cell);
    expect(cell.get()).toBe("updated");
  });

  it("is a no-op when nothing is pending", () => {
    const cell = createMockCellHandle("x");
    const ctrl = new CellController<string>(createMockHost(), {
      timing: { strategy: "debounce", delay: 300 },
    });
    ctrl.bind(cell);
    ctrl.flush();
    expect(cell.get()).toBe("x");
  });
});

//
// StringCellController
//

describe("StringCellController", () => {
  it("defaults to empty string for undefined cell value", () => {
    const host = createMockHost();
    const ctrl = new StringCellController(host);
    const cell = createMockCellHandle<string>(undefined as any);
    ctrl.bind(cell);
    expect(ctrl.getValue()).toBe("");
  });

  it("returns the cell's string value", () => {
    const host = createMockHost();
    const ctrl = new StringCellController(host);
    const cell = createMockCellHandle("hello");
    ctrl.bind(cell);
    expect(ctrl.getValue()).toBe("hello");
  });

  it("returns plain string value", () => {
    const host = createMockHost();
    const ctrl = new StringCellController(host);
    ctrl.bind("world" as any);
    expect(ctrl.getValue()).toBe("world");
  });

  it("preserves empty string (not falsy coerced)", () => {
    const host = createMockHost();
    const ctrl = new StringCellController(host);
    ctrl.bind("" as any);
    expect(ctrl.getValue()).toBe("");
  });
});

//
// BooleanCellController
//

describe("BooleanCellController", () => {
  it("defaults to false for undefined cell value", () => {
    const host = createMockHost();
    const ctrl = new BooleanCellController(host);
    const cell = createMockCellHandle<boolean>(undefined as any);
    ctrl.bind(cell);
    expect(ctrl.getValue()).toBe(false);
  });

  it("reads boolean from cell", () => {
    const host = createMockHost();
    const ctrl = new BooleanCellController(host);
    const cell = createMockCellHandle(true);
    ctrl.bind(cell);
    expect(ctrl.getValue()).toBe(true);
  });

  it("toggle() flips the value", async () => {
    const host = createMockHost();
    const ctrl = new BooleanCellController(host);
    const cell = createMockCellHandle(false);
    ctrl.bind(cell);
    ctrl.toggle();
    expect(ctrl.getValue()).toBe(true);
    await settleWrites(cell);
    expect(cell.get()).toBe(true);
  });
});

//
// ArrayCellController
//

describe("ArrayCellController", () => {
  it("defaults to empty array for undefined cell value", () => {
    const host = createMockHost();
    const ctrl = new ArrayCellController<number>(host);
    const cell = createMockCellHandle<number[]>(undefined as any);
    ctrl.bind(cell);
    expect(ctrl.getValue()).toEqual([]);
  });

  it("reads array from cell", () => {
    const host = createMockHost();
    const ctrl = new ArrayCellController<number>(host);
    const cell = createMockCellHandle([1, 2, 3]);
    ctrl.bind(cell);
    expect(ctrl.getValue()).toEqual([1, 2, 3]);
  });

  it("addItem appends via cell.push()", () => {
    const host = createMockHost();
    const ctrl = new ArrayCellController<number>(host);
    const cell = createMockCellHandle([1, 2]);
    ctrl.bind(cell);
    ctrl.addItem(3);
    expect(cell.get()).toEqual([1, 2, 3]);
  });

  it("removeItem filters out the item", async () => {
    const host = createMockHost();
    const ctrl = new ArrayCellController<string>(host);
    const cell = createMockCellHandle(["a", "b", "c"]);
    ctrl.bind(cell);
    ctrl.removeItem("b");
    expect(ctrl.getValue()).toEqual(["a", "c"]);
    await settleWrites(cell);
    expect(cell.get()).toEqual(["a", "c"]);
  });

  it("removeItem removes a NaN element and keeps -0 distinct from 0", async () => {
    // `Object.is` matching: `NaN` is removable; removing `0` must not take a
    // stored `-0` with it.
    const host = createMockHost();
    const ctrl = new ArrayCellController<number>(host);
    const cell = createMockCellHandle([NaN, -0, 1]);
    ctrl.bind(cell);

    ctrl.removeItem(NaN);
    await settleWrites(cell);
    let result = cell.get() as number[];
    expect(result.length).toBe(2);
    expect(Object.is(result[0], -0)).toBe(true);

    ctrl.removeItem(0);
    await settleWrites(cell);
    result = cell.get() as number[];
    expect(result.length).toBe(2);
    expect(Object.is(result[0], -0)).toBe(true);
  });

  it("updateItem finds a NaN element", () => {
    const host = createMockHost();
    const ctrl = new ArrayCellController<number>(host);
    const cell = createMockCellHandle([1, NaN, 3]);
    ctrl.bind(cell);
    ctrl.updateItem(NaN, 2);
    expect(cell.get()).toEqual([1, 2, 3]);
  });

  it("updateItem replaces item via cell.key().set() and propagates to parent", () => {
    const host = createMockHost();
    const ctrl = new ArrayCellController<string>(host);
    const cell = createMockCellHandle(["x", "y", "z"]);
    ctrl.bind(cell);
    ctrl.updateItem("y", "Y");
    // With parent-child propagation, the child's set() updates the parent
    expect(cell.get()).toEqual(["x", "Y", "z"]);
  });
});

//
// Factory functions
//

describe("factory functions", () => {
  it("createCellController returns CellController", () => {
    const ctrl = createCellController<string>(createMockHost());
    expect(ctrl).toBeInstanceOf(CellController);
  });

  it("createStringCellController returns StringCellController", () => {
    const ctrl = createStringCellController(createMockHost());
    expect(ctrl).toBeInstanceOf(StringCellController);
  });

  it("createBooleanCellController returns BooleanCellController", () => {
    const ctrl = createBooleanCellController(createMockHost());
    expect(ctrl).toBeInstanceOf(BooleanCellController);
  });

  it("createArrayCellController returns ArrayCellController", () => {
    const ctrl = createArrayCellController<number>(createMockHost());
    expect(ctrl).toBeInstanceOf(ArrayCellController);
  });
});

//
// CellController — timing integration
//

describe("CellController — timing integration", () => {
  let time: FakeTime;

  beforeEach(() => {
    time = new FakeTime();
  });
  afterEach(() => {
    time.restore();
  });

  it("setValue with debounce delays the cell update", async () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "debounce", delay: 200 },
    });
    const cell = createMockCellHandle("old");
    ctrl.bind(cell);

    ctrl.setValue("new");
    // Debounce: cell should NOT be updated yet
    expect(cell.get()).toBe("old");

    time.tick(200);
    await settleWrites(cell);
    expect(cell.get()).toBe("new");
  });

  it("setValue with blur strategy only commits on onBlur()", async () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "blur" },
    });
    const cell = createMockCellHandle("before");
    ctrl.bind(cell);

    ctrl.setValue("pending");
    expect(cell.get()).toBe("before");

    ctrl.onBlur();
    await settleWrites(cell);
    expect(cell.get()).toBe("pending");
  });

  it("setValue with throttle fires immediately on leading edge", async () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "throttle", delay: 100 },
    });
    const cell = createMockCellHandle("start");
    ctrl.bind(cell);

    ctrl.setValue("first");
    expect(ctrl.getValue()).toBe("first");
    await settleWrites(cell);
    expect(cell.get()).toBe("first");
  });

  it("cancel() prevents pending debounced update from firing", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "debounce", delay: 100 },
    });
    const cell = createMockCellHandle("original");
    ctrl.bind(cell);

    ctrl.setValue("pending");
    ctrl.cancel();
    time.tick(200);
    expect(cell.get()).toBe("original");
  });

  it("updateTimingOptions changes strategy at runtime", async () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "debounce", delay: 100 },
    });
    const cell = createMockCellHandle("old");
    ctrl.bind(cell);

    ctrl.updateTimingOptions({ strategy: "immediate" });
    ctrl.setValue("instant");
    await settleWrites(cell);
    expect(cell.get()).toBe("instant");
  });
});

//
// CellController — pending local edits vs stale bound state
//
// Regression coverage for the cf-input early-boot wipe: a user types before
// the cell's initial echo/subscription has settled; the worker re-renders and
// the applicator hands the element a FRESH CellHandle for the same cell
// (cfcLabelView drift during CFC settling makes `equals()` false), whose value
// has not hydrated yet. The controller used to adopt that handle's stale/empty
// state, and the next repaint wiped the user's typed text until the backend
// echo restored it. The local edit must win until the echo confirms it or a
// genuinely newer remote value arrives.
//

/**
 * A cfcLabelView that differs from the (absent) label view on the default mock
 * ref. `CellHandle.equals()` compares cfcLabelView, so a rebind with this ref
 * replaces the bound handle — the production wipe vector (the applicator's
 * `setBinding` makes a fresh, value-less handle whenever the authored link's
 * label view drifts during early CFC settling).
 */
const DRIFTED_LABEL_VIEW: CellRef["cfcLabelView"] = {
  version: 1,
  entries: [{ path: [], label: { confidentiality: ["did:key:z-someone"] } }],
};

describe("CellController — pending local edits vs stale bound state", () => {
  it("keeps a settled local edit when a same-cell rebind delivers a not-yet-hydrated handle", async () => {
    // The confirmed lunch-poll trace: commit() resolved (write durable), THEN
    // the host re-render swapped in a fresh handle with no value yet.
    const ctrl = new StringCellController(createMockHost(), {
      timing: { strategy: "immediate" },
    });
    const initial = createMockCellHandle<string>("");
    ctrl.bind(initial);

    ctrl.setValue("Alice"); // user types; optimistic write
    await settleWrites(initial);

    const rebound = createMockCellHandle<string>(undefined, {
      cfcLabelView: DRIFTED_LABEL_VIEW,
    });
    ctrl.bind(rebound);
    // The typed value must survive the rebind — there is no newer remote
    // value, only a handle that has not hydrated yet.
    expect(ctrl.getValue()).toBe("Alice");

    // The durable echo hydrates the fresh handle.
    pushUpdate(rebound, "Alice");
    expect(ctrl.getValue()).toBe("Alice");

    // Once hydrated, remote updates (including a clear) apply normally.
    pushUpdate(rebound, "");
    expect(ctrl.getValue()).toBe("");
  });

  it("suppresses a stale rebound cache until a post-commit read confirms the edit", async () => {
    const changes: Array<string | undefined> = [];
    const ctrl = new StringCellController(createMockHost(), {
      timing: { strategy: "immediate" },
      onChange: (newValue) => changes.push(newValue),
    });
    const initial = createMockCellHandle<string>("");
    ctrl.bind(initial);

    ctrl.setValue("Alice");
    changes.length = 0;

    // A re-render-driven rebind hands over a handle still holding the
    // pre-write snapshot.
    const rebound = createMockCellHandle<string>("", {
      cfcLabelView: DRIFTED_LABEL_VIEW,
    }, initial);
    ctrl.bind(rebound);
    expect(ctrl.getValue()).toBe("Alice");
    // The stale "" must not be announced as a change either — the UI never
    // showed it.
    expect(changes).not.toContain("");
    await settleWrites(initial);
    expect(ctrl.getValue()).toBe("Alice");

    // The read confirms the edit; later remote deliveries apply normally.
    pushUpdate(rebound, "Alice");
    expect(ctrl.getValue()).toBe("Alice");
    pushUpdate(rebound, "Bob");
    expect(ctrl.getValue()).toBe("Bob");
  });

  it("keeps the latest keystroke when a partial echo of an earlier write arrives", () => {
    const ctrl = new StringCellController(createMockHost(), {
      timing: { strategy: "immediate" },
    });
    const cell = createMockCellHandle<string>("");
    ctrl.bind(cell);

    ctrl.setValue("Al");
    ctrl.setValue("Alice");
    // The echo of the first keystroke arrives after the second was typed.
    pushUpdate(cell, "Al");
    expect(ctrl.getValue()).toBe("Alice");

    pushUpdate(cell, "Alice");
    expect(ctrl.getValue()).toBe("Alice");
  });

  it("keeps the typed value when a late initial hydration arrives during a debounce window", async () => {
    const time = new FakeTime();
    try {
      const ctrl = new StringCellController(createMockHost(), {
        timing: { strategy: "debounce", delay: 300 },
      });
      // Early boot: the cell has not hydrated at bind time.
      const cell = createMockCellHandle<string>(undefined);
      ctrl.bind(cell);

      ctrl.setValue("Al"); // user typing; write still debounced
      pushUpdate(cell, ""); // late initial hydration (pre-write snapshot)
      expect(ctrl.getValue()).toBe("Al");

      time.tick(300); // debounced write lands
      await settleWrites(cell);
      expect(cell.get()).toBe("Al");
      expect(ctrl.getValue()).toBe("Al");
    } finally {
      time.restore();
    }
  });

  it("keeps an uncommitted edit over a remote update while using the blur strategy", async () => {
    const ctrl = new StringCellController(createMockHost(), {
      timing: { strategy: "blur" },
    });
    const cell = createMockCellHandle<string>("");
    ctrl.bind(cell);

    ctrl.setValue("Ali"); // typed, not yet committed (commits on blur)
    pushUpdate(cell, "remote-edit");
    // The in-progress local edit wins; the blur-time write will overwrite the
    // remote value anyway (last-write-wins set).
    expect(ctrl.getValue()).toBe("Ali");

    ctrl.onBlur(); // commits the edit
    await settleWrites(cell);
    expect(cell.get()).toBe("Ali");
  });

  it("accepts remote updates — including a clear back to the pre-edit value — once the write settled", async () => {
    const ctrl = new StringCellController(createMockHost(), {
      timing: { strategy: "immediate" },
    });
    const cell = createMockCellHandle<string>("");
    ctrl.bind(cell);

    ctrl.setValue("Alice");
    await settleWrites(cell);

    // A genuinely newer remote value must repaint...
    pushUpdate(cell, "Bob");
    expect(ctrl.getValue()).toBe("Bob");

    ctrl.setValue("Carol");
    await settleWrites(cell);

    // ...and so must a remote clear that matches the pre-edit baseline.
    pushUpdate(cell, "Bob");
    expect(ctrl.getValue()).toBe("Bob");
  });

  it("shows an authoritative remote clear-to-undefined instead of the last known value", () => {
    const ctrl = new StringCellController(createMockHost(), {
      timing: { strategy: "immediate" },
    });
    const cell = createMockCellHandle<string>("Alice");
    ctrl.bind(cell);
    expect(ctrl.getValue()).toBe("Alice");

    // The backend clears the cell. Unlike a fresh rebound handle's initial
    // no-delivery state, this undefined is authoritative and must repaint the
    // normal empty fallback.
    pushUpdate(cell, undefined as unknown as string);
    expect(ctrl.getValue()).toBe("");
  });

  it("does not resurrect the previous value on a same-cell rebind after a remote clear", () => {
    const ctrl = new StringCellController(createMockHost(), {
      timing: { strategy: "immediate" },
    });
    const cell = createMockCellHandle<string>("Alice");
    ctrl.bind(cell);
    pushUpdate(cell, undefined as unknown as string); // authoritative clear
    expect(ctrl.getValue()).toBe("");

    // A label-view drift rebind hands over a fresh unhydrated handle; the
    // cleared value must not come back.
    const rebound = createMockCellHandle<string>(undefined, {
      cfcLabelView: DRIFTED_LABEL_VIEW,
    });
    ctrl.bind(rebound);
    expect(ctrl.getValue()).toBe("");
  });

  it("accepts an authoritative clear after reconciling a rebound handle", async () => {
    const ctrl = new StringCellController(createMockHost(), {
      timing: { strategy: "immediate" },
    });
    const initial = createMockCellHandle<string>("");
    ctrl.bind(initial);

    ctrl.setValue("Alice");
    // The rebound cache predates the edit; the post-commit read refreshes it.
    const rebound = createMockCellHandle<string>("", {
      cfcLabelView: DRIFTED_LABEL_VIEW,
    }, initial);
    ctrl.bind(rebound);
    await settleWrites(initial);
    expect(ctrl.getValue()).toBe("Alice");

    // A later clear is authoritative even when its value is undefined.
    pushUpdate(rebound, undefined as unknown as string);
    expect(ctrl.getValue()).toBe("");
  });

  it("drops local-edit protection when rebinding to a different cell", () => {
    const ctrl = new StringCellController(createMockHost(), {
      timing: { strategy: "immediate" },
    });
    const cellA = createMockCellHandle<string>("a", { id: "of:cell-a" as any });
    ctrl.bind(cellA);
    ctrl.setValue("typed");

    const cellB = createMockCellHandle<string>("other", {
      id: "of:cell-b" as any,
    });
    ctrl.bind(cellB);
    expect(ctrl.getValue()).toBe("other");
  });

  it("accepts a remote edit after reconciling a rebound handle", async () => {
    const ctrl = new StringCellController(createMockHost(), {
      timing: { strategy: "immediate" },
    });
    const initial = createMockCellHandle<string>("");
    ctrl.bind(initial);

    ctrl.setValue("Alice");
    const rebound = createMockCellHandle<string>("", {
      cfcLabelView: DRIFTED_LABEL_VIEW,
    }, initial);
    ctrl.bind(rebound);
    await settleWrites(initial);

    // A remote edit after reconciliation repaints without another local echo.
    pushUpdate(rebound, "Zed");
    expect(ctrl.getValue()).toBe("Zed");
  });

  it("a write settling after a rebind to a different cell does not release its edit", async () => {
    const ctrl = new StringCellController(createMockHost(), {
      timing: { strategy: "immediate" },
    });
    const cellA = createMockCellHandle<string>("", { id: "of:cell-a" as any });
    ctrl.bind(cellA);
    ctrl.setValue("typed"); // write in flight against cell A

    const cellB = createMockCellHandle<string>("b-val", {
      id: "of:cell-b" as any,
    });
    ctrl.bind(cellB);
    ctrl.setValue("fresh-edit"); // pending edit on cell B

    // Cell A's write settles now; it must not touch cell B's pending edit.
    await settleWrites(cellA, cellB);
    expect(ctrl.getValue()).toBe("fresh-edit");
    pushUpdate(cellB, "fresh-edit"); // echo confirms on B
    expect(ctrl.getValue()).toBe("fresh-edit");
  });

  it("cancel() abandons the pending edit and bound state repaints", () => {
    const time = new FakeTime();
    try {
      const ctrl = new StringCellController(createMockHost(), {
        timing: { strategy: "debounce", delay: 300 },
      });
      const cell = createMockCellHandle<string>("orig");
      ctrl.bind(cell);

      ctrl.setValue("temp");
      expect(ctrl.getValue()).toBe("temp"); // pending edit shows
      ctrl.cancel();
      expect(ctrl.getValue()).toBe("orig"); // bound state authoritative again
      time.tick(300);
      expect(cell.get()).toBe("orig"); // and the write never landed
    } finally {
      time.restore();
    }
  });

  it("confirms an array edit structurally when the echo arrives on a rebound handle", async () => {
    const ctrl = new ArrayCellController<string | { k: string }>(
      createMockHost(),
    );
    const initial = createMockCellHandle<(string | { k: string })[]>([]);
    ctrl.bind(initial);

    ctrl.setValue(["x", { k: "v" }]);
    const rebound = createMockCellHandle<(string | { k: string })[]>(
      undefined,
      { cfcLabelView: DRIFTED_LABEL_VIEW },
    );
    ctrl.bind(rebound);
    expect(ctrl.getValue()).toEqual(["x", { k: "v" }]);
    await settleWrites(initial);

    // The echo is a fresh deserialized instance — equal by structure, not
    // identity — and must still confirm (and release) the edit.
    pushUpdate(rebound, ["x", { k: "v" }]);
    expect(ctrl.getValue()).toEqual(["x", { k: "v" }]);
    pushUpdate(rebound, ["x"]);
    expect(ctrl.getValue()).toEqual(["x"]);
  });

  it("drops local-edit protection when rebinding to a different scope of the same doc", () => {
    const ctrl = new StringCellController(createMockHost(), {
      timing: { strategy: "immediate" },
    });
    // Same id/space/path, user scope: a scoped cell is partitioned storage.
    const userScoped = createMockCellHandle<string>("", { scope: "user" });
    ctrl.bind(userScoped);
    ctrl.setValue("typed");

    // Rebind to the space-scoped cell at the same address (plus label-view
    // drift so equals() is false): a different cell — no edit carry-over.
    const spaceScoped = createMockCellHandle<string>("shared", {
      scope: "space",
      cfcLabelView: DRIFTED_LABEL_VIEW,
    });
    ctrl.bind(spaceScoped);
    expect(ctrl.getValue()).toBe("shared");
  });

  it("treats a delivery holding a different cell link as not confirming the edit", () => {
    const ctrl = new CellController<unknown>(createMockHost(), {
      timing: { strategy: "immediate" },
    });
    const cell = createMockCellHandle<unknown>("plain");
    ctrl.bind(cell);

    const linkA = createMockCellHandle("a", { id: "of:link-a" as any });
    const linkB = createMockCellHandle("b", { id: "of:link-b" as any });
    ctrl.setValue(linkA);
    // A stale delivery carrying a DIFFERENT link must not read as the echo of
    // our edit (links compare by identity, not structure).
    pushUpdate(cell, linkB);
    expect(ctrl.getValue()).toBe(linkA);
  });

  it("does not confirm on structurally different partial echoes (array and object)", () => {
    const arrCtrl = new ArrayCellController<string>(createMockHost());
    const arrCell = createMockCellHandle<string[]>([]);
    arrCtrl.bind(arrCell);
    arrCtrl.setValue(["a", "b"]);
    // Shorter partial echo of an earlier state must not confirm or repaint.
    pushUpdate(arrCell, ["a"]);
    expect(arrCtrl.getValue()).toEqual(["a", "b"]);

    const objCtrl = new CellController<{ k: string }>(createMockHost(), {
      timing: { strategy: "immediate" },
    });
    const objCell = createMockCellHandle<{ k: string }>({ k: "" });
    objCtrl.bind(objCell);
    objCtrl.setValue({ k: "v" });
    // Extra keys make it a different value — not our echo.
    pushUpdate(objCell, { k: "v", extra: 1 } as unknown as { k: string });
    expect(objCtrl.getValue()).toEqual({ k: "v" });
  });

  it("setValue on a plain (non-cell) binding leaves the value to the host property system", () => {
    const changes: Array<[string, string]> = [];
    const ctrl = new StringCellController(createMockHost(), {
      timing: { strategy: "immediate" },
      onChange: (n, o) => changes.push([n, o]),
    });
    ctrl.bind("plain" as unknown as CellHandle<string>);
    ctrl.setValue("next");
    // No cell to write; the controller only reports the change.
    expect(ctrl.getValue()).toBe("plain");
    expect(changes).toContainEqual(["next", "plain"]);
  });
});

//
// CellController — custom options
//

describe("CellController — custom options", () => {
  it("custom getValue transforms the cell value", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
      getValue: (value) => {
        if (isCellHandle(value)) {
          return ((value as CellHandle<string>).get() ?? "").toUpperCase();
        }
        return (value as string).toUpperCase();
      },
    });
    const cell = createMockCellHandle("hello");
    ctrl.bind(cell);
    expect(ctrl.getValue()).toBe("HELLO");
  });

  it("custom setValue intercepts the write", () => {
    const host = createMockHost();
    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
      setValue: (value, newValue, _oldValue) => {
        if (isCellHandle(value)) {
          (value as CellHandle<string>).set(newValue + "!");
        }
      },
    });
    const cell = createMockCellHandle("start");
    ctrl.bind(cell);
    ctrl.setValue("hi");
    expect(cell.get()).toBe("hi!");
  });

  it("triggerUpdate:false suppresses host.requestUpdate()", () => {
    let updateCount = 0;
    const host: ReactiveControllerHost = {
      addController: () => {},
      removeController: () => {},
      requestUpdate: () => {
        updateCount++;
      },
      updateComplete: Promise.resolve(true),
    } as unknown as ReactiveControllerHost;

    const ctrl = new CellController<string>(host, {
      timing: { strategy: "immediate" },
      triggerUpdate: false,
    });
    const cell = createMockCellHandle("a");
    ctrl.bind(cell);
    updateCount = 0;

    pushUpdate(cell, "b");
    expect(updateCount).toBe(0);
  });
});
