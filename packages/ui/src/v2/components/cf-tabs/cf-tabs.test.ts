/**
 * Unit tests for cf-tabs' cf-change emission contract (CT-1746 / CT-1745).
 *
 * The product bug: cf-tabs emitted `cf-change` on EVERY change to the bound
 * cell — including programmatic / cell-driven changes — so any `oncf-change`
 * handler that wrote the bound cell formed an unbreakable feedback loop
 * (reported by the scheduler as non-settling). The fix emits `cf-change` ONLY
 * for user gestures (click / keyboard), while cell-driven changes still sync
 * the selection.
 *
 * cf-tabs extends Lit's HTMLElement, which Deno's headless `deno test` runner
 * does not provide. We install a minimal DOM shim (the same "mock only the
 * surface the code under test touches" approach used by
 * packages/html/test/main-applicator.test.ts) so we can construct the real
 * component and drive its real handlers. The cell binding uses the shared
 * createMockCellHandle util, exactly like cell-controller.test.ts.
 */

// Minimal DOM shim — installed BEFORE importing the component so that Lit's
// ReactiveElement base class has an HTMLElement to extend.

interface ShadowStub {
  querySelector(): null;
  addEventListener(): void;
}

class FakeHTMLElement {
  attributes = new Map<string, string>();
  _listeners: Record<string, Array<(e: any) => void>> = {};
  shadowRoot: ShadowStub | null = null;

  addEventListener(type: string, handler: (e: any) => void): void {
    (this._listeners[type] ||= []).push(handler);
  }
  removeEventListener(type: string, handler: (e: any) => void): void {
    const arr = this._listeners[type];
    if (!arr) return;
    const i = arr.indexOf(handler);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatchEvent(event: { type: string }): boolean {
    (this._listeners[event.type] ?? []).forEach((h) => h(event));
    return true;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  querySelectorAll(): unknown[] {
    return [];
  }
  querySelector(): unknown {
    return null;
  }
  attachShadow(): ShadowStub {
    this.shadowRoot = { querySelector: () => null, addEventListener: () => {} };
    return this.shadowRoot;
  }
  getRootNode(): this {
    return this;
  }
  get isConnected(): boolean {
    return false;
  }
}

class FakeTab {
  value: string;
  disabled = false;
  selected = false;

  /**
   * The tag name a real `<cf-tab>` has as a custom element; `handleKeydown()`
   * gates on it and calls `focus()`/`click()` on the next tab.
   */
  tagName = "CF-TAB";

  /**
   * What `click()` dispatches: it must dispatch the bubbling `tab-click` the
   * real element emits, which `makeTabs()` wires per instance.
   */
  onClickDispatch: (() => void) | null = null;

  attributes = new Map<string, string>();
  constructor(value: string) {
    this.value = value;
  }
  focus(): void {}
  click(): void {
    this.onClickDispatch?.();
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
}

class FakeTabPanel {
  value: string;

  /**
   * Whether the panel is hidden, defaulting to `true` as the real `CFTabPanel`
   * constructor does. `cf-tab-panel` starts hidden and is revealed only when
   * `updateTabSelection()` matches it; a `false` default would make panels
   * look visible before any sync runs.
   */
  hidden = true;

  attributes = new Map<string, string>();
  constructor(value: string) {
    this.value = value;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
}

const g = globalThis as Record<string, unknown>;
g.HTMLElement = FakeHTMLElement;
g.customElements = { define: () => {}, get: () => undefined };
g.requestAnimationFrame = (_cb: () => void) => 0;
g.cancelAnimationFrame = () => {};

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { stringSchema } from "@commonfabric/runner/schemas";
import type { CellHandle } from "@commonfabric/runtime-client";

import {
  createMockCellHandle,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";
import { CFTabs } from "./index.ts";

/**
 * Build a CFTabs instance wired to fake tabs/panels and a mock cell, with its
 * cell controller bound (as firstUpdated would do). Returns helpers to drive
 * and observe it.
 */
function makeTabs(cell: CellHandle<string> | string, tabValues: string[]) {
  const tabs = new CFTabs();
  const fakeTabs = tabValues.map((v) => new FakeTab(v));
  const fakePanels = tabValues.map((v) => new FakeTabPanel(v));

  // Route querySelectorAll to our fake children.
  (tabs as unknown as {
    querySelectorAll: (sel: string) => unknown[];
  }).querySelectorAll = (sel: string) => {
    if (sel === "cf-tab") return fakeTabs;
    if (sel === "cf-tab-panel") return fakePanels;
    return [];
  };

  // Bind the cell the way firstUpdated() does, and seed initial selection.
  (tabs as unknown as { value: CellHandle<string> | string }).value = cell;
  const ctrl = (tabs as unknown as {
    _cellController: {
      bind: (v: CellHandle<string> | string, s: unknown) => void;
    };
  })._cellController;
  ctrl.bind(cell, stringSchema);
  (tabs as unknown as { updateTabSelection: () => void }).updateTabSelection();

  // cf-change events are emitted via dispatchEvent (BaseElement.emit).
  const changes: Array<{ value: string; oldValue: string }> = [];
  const orig = (tabs as unknown as { dispatchEvent: (e: any) => boolean })
    .dispatchEvent.bind(tabs);
  (tabs as unknown as { dispatchEvent: (e: any) => boolean }).dispatchEvent = (
    e: any,
  ) => {
    if (e?.type === "cf-change") changes.push(e.detail);
    return orig(e);
  };

  // Reach the component's real private handlers. handleKeydown does the arrow
  // math and calls nextTab.focus()/click(); a real <cf-tab>.click() emits a
  // tab-click the component listens for, so we route FakeTab.click() →
  // handleTabClick to mirror that hop. (The literal addEventListener wiring in
  // connectedCallback can't run under the headless DOM shim — Lit's base
  // EventTarget doesn't use FakeHTMLElement's listener store — so we invoke the
  // handlers directly; the keyboard ROUTE and its index math are still
  // exercised end to end.)
  const handleTabClick = (tabs as unknown as {
    handleTabClick: (e: { detail: { tab: unknown } }) => void;
  }).handleTabClick;
  const handleKeydown = (tabs as unknown as {
    handleKeydown: (e: unknown) => void;
  }).handleKeydown;
  fakeTabs.forEach((t) => {
    t.onClickDispatch = () => handleTabClick({ detail: { tab: t } });
  });

  const clickTab = (value: string) => {
    const tab = fakeTabs.find((t) => t.value === value);
    handleTabClick({ detail: { tab } });
  };

  // Keyboard: drive the real handleKeydown with the focused tab as target; it
  // computes the next tab and calls nextTab.click() → handleTabClick.
  const pressKey = (key: string, fromValue: string) => {
    const target = fakeTabs.find((t) => t.value === fromValue);
    handleKeydown({ key, target, preventDefault() {} });
  };

  const selectedTab = () => fakeTabs.find((t) => t.selected)?.value;
  const visiblePanel = () => fakePanels.find((p) => !p.hidden)?.value;

  return {
    tabs,
    fakeTabs,
    fakePanels,
    changes,
    clickTab,
    pressKey,
    selectedTab,
    visiblePanel,
  };
}

describe("CFTabs cf-change emission contract (CT-1746)", () => {
  it("emits exactly ONE cf-change on a user tab click", () => {
    const cell = createMockCellHandle<string>("active");
    const h = makeTabs(cell, ["active", "progress", "pending", "feed"]);
    h.changes.length = 0;

    h.clickTab("progress");

    expect(h.changes.length).toBe(1);
    expect(h.changes[0].value).toBe("progress");
    expect(h.changes[0].oldValue).toBe("active");
    // User click writes through to the bound cell (problem-2 propagation).
    expect(cell.get()).toBe("progress");
    expect(h.selectedTab()).toBe("progress");
  });

  it("does NOT emit cf-change for a programmatic / cell-driven change, but still syncs selection", () => {
    const cell = createMockCellHandle<string>("active");
    const h = makeTabs(cell, ["active", "progress", "pending", "feed"]);
    h.changes.length = 0;

    // Simulate a backend / programmatic update to the bound cell — the exact
    // path that previously echoed cf-change and closed the feedback loop.
    pushUpdate(cell, "pending");

    expect(h.changes.length).toBe(0);
    // Visual selection must still follow the cell.
    expect(h.selectedTab()).toBe("pending");
    expect(h.visiblePanel()).toBe("pending");
  });

  it("supports $value-only binding: a user click switches selection with NO cf-change listener", () => {
    // No cf-change consumer at all — selection must be driven purely by the
    // controller write-back to the bound cell. This is what lets consumers
    // drop the load-bearing-but-cyclic oncf-change handler.
    const cell = createMockCellHandle<string>("active");
    const h = makeTabs(cell, ["active", "progress", "pending", "feed"]);

    h.clickTab("feed");

    expect(cell.get()).toBe("feed");
    expect(h.selectedTab()).toBe("feed");
    expect(h.visiblePanel()).toBe("feed");
  });

  it("does not re-emit when clicking the already-selected tab", () => {
    const cell = createMockCellHandle<string>("active");
    const h = makeTabs(cell, ["active", "progress"]);
    h.changes.length = 0;

    h.clickTab("active"); // same as current value

    expect(h.changes.length).toBe(0);
    expect(cell.get()).toBe("active");
  });

  it("emits exactly ONE cf-change via the real keyboard route (keydown → nextTab.click() → tab-click → handleTabClick)", () => {
    // Guards the PR's keyboard-parity claim through the ACTUAL route — the
    // wired `keydown`/`tab-click` listeners — not a direct handler call, so a
    // future regression that stops keyboard nav routing through the click path
    // would fail here.
    const cell = createMockCellHandle<string>("active");
    const h = makeTabs(cell, ["active", "progress", "pending", "feed"]);
    h.changes.length = 0;

    h.pressKey("ArrowRight", "active"); // active → next enabled tab = progress

    expect(h.changes.length).toBe(1);
    expect(h.changes[0].value).toBe("progress");
    expect(h.changes[0].oldValue).toBe("active");
    expect(cell.get()).toBe("progress");
    expect(h.selectedTab()).toBe("progress");
  });

  it("keyboard nav wraps and still emits exactly one cf-change (ArrowLeft from first tab → last)", () => {
    const cell = createMockCellHandle<string>("active");
    const h = makeTabs(cell, ["active", "progress", "pending", "feed"]);
    h.changes.length = 0;

    h.pressKey("ArrowLeft", "active"); // wraps to last enabled tab = feed

    expect(h.changes.length).toBe(1);
    expect(h.changes[0].value).toBe("feed");
    expect(cell.get()).toBe("feed");
    expect(h.selectedTab()).toBe("feed");
  });

  it("ignores clicks on disabled tabs", () => {
    const cell = createMockCellHandle<string>("active");
    const h = makeTabs(cell, ["active", "progress"]);
    h.fakeTabs[1].disabled = true;
    h.changes.length = 0;

    h.clickTab("progress");

    expect(h.changes.length).toBe(0);
    expect(cell.get()).toBe("active");
  });
});

/**
 * Pure-on-mount contract (makes cf-tabs safe to instantiate inside a render
 * `computed()`).
 *
 * A component bound with `$value` is only safe to re-create inside a computed
 * that reads the same cell if it NEVER writes that cell as a side effect of
 * mount/selection-sync — only on a genuine user gesture. (cf-input already
 * honors this; it writes only on input/change events, never on bind.) If
 * cf-tabs writes the cell during `updateTabSelection()` — e.g. defaulting an
 * empty/unmatched cell to the first tab via `selectFirst()` → `setValue()` —
 * then each recompute re-mounts it, re-writes the cell, and re-triggers the
 * computed: a non-settling CPU-spin (the CT-1677 settle class).
 *
 * These tests pin the contract: mount and cell-driven sync produce ZERO cell
 * writes. The no-match fallback selects the first tab VISUALLY only for a
 * NON-empty stale value; an empty / unresolved value (the durable-$value
 * mount transient) holds the current selection rather than flashing the first
 * tab — see the mount-flicker regression test below.
 */
describe("CFTabs pure-on-mount contract (safe inside computed)", () => {
  // Count writes to the bound cell by wrapping `.set` before binding.
  function countingCell(initial: string) {
    const cell = createMockCellHandle<string>(initial);
    let writes = 0;
    for (const method of ["set", "setForUI"] as const) {
      const original = cell[method].bind(cell);
      cell[method] = (value) => {
        writes++;
        return original(value);
      };
    }
    return { cell, writes: () => writes };
  }

  it("does NOT write the bound cell on mount when the value is empty / unresolved", () => {
    // Empty cell — the durable-$value mount transient (value not delivered yet).
    const { cell, writes } = countingCell("");

    // makeTabs() binds the controller and runs updateTabSelection() — i.e. the
    // mount/selection-sync that must not write.
    const h = makeTabs(cell, ["active", "progress", "pending"]);

    expect(writes()).toBe(0); // FAILS pre-fix: selectFirst() writes "active"
    expect(cell.get()).toBe(""); // cell stays untouched until a real gesture
    // ...and NO tab is flashed: an empty/unresolved value holds the selection
    // rather than snapping to the first tab (which would flicker once the cell
    // resolves to a non-first value).
    expect(h.selectedTab()).toBe(undefined);
    expect(h.visiblePanel()).toBe(undefined);
  });

  it("a re-mount (recompute) over an empty cell stays write-free and idempotent", () => {
    const { cell, writes } = countingCell("");
    const h = makeTabs(cell, ["active", "progress", "pending"]);

    // Simulate the computed re-running: re-bind + re-sync several times.
    const reSync = (h.tabs as unknown as {
      updateTabSelection: () => void;
    }).updateTabSelection.bind(h.tabs);
    reSync();
    reSync();
    reSync();

    expect(writes()).toBe(0);
    expect(cell.get()).toBe("");
    expect(h.selectedTab()).toBe(undefined); // held — no first-tab flash
  });

  it("does not flash the first tab while the bound value is unresolved, then selects the resolved value (mount-flicker regression)", () => {
    // Reproduces the durable-$value mount race that produces "flickers between
    // two tabs": the synchronous mount sync sees an empty (not-yet-delivered)
    // value, then the cell resolves to a NON-first tab. The selection must go
    // straight to the resolved tab — never transiently snapping to the first.
    const { cell, writes } = countingCell(""); // unresolved at mount
    const h = makeTabs(cell, ["active", "progress", "pending", "feed"]);

    // While unresolved: nothing is flashed (NOT the first tab "active").
    expect(h.selectedTab()).toBe(undefined);
    expect(h.visiblePanel()).toBe(undefined);

    // Cell resolves to a non-first tab — selection jumps straight to it.
    pushUpdate(cell, "pending");
    expect(h.selectedTab()).toBe("pending");
    expect(h.visiblePanel()).toBe("pending");
    expect(writes()).toBe(0); // pure read throughout — no cell write
  });

  it("clears the selection when the bound value is explicitly set to empty", () => {
    // Empty is not only the mount transient — a consumer can clear the bound
    // cell ("" / unset) to mean "no tab active". The early-return form held the
    // prior selection (stale tab + panel stuck visible); selection-sync must
    // instead drop it. (Still write-free — clearing is a pure read.)
    const { cell, writes } = countingCell("progress");
    const h = makeTabs(cell, ["active", "progress", "pending"]);
    expect(h.selectedTab()).toBe("progress"); // initially selected
    expect(h.visiblePanel()).toBe("progress");

    pushUpdate(cell, ""); // explicit clear

    expect(h.selectedTab()).toBe(undefined); // selection dropped, not stale
    expect(h.visiblePanel()).toBe(undefined);
    expect(writes()).toBe(0);
  });

  it("a cell-driven change to an unmatched value does not write back", () => {
    const { cell, writes } = countingCell("active");
    const h = makeTabs(cell, ["active", "progress"]);
    // Programmatic/backend push to a value no tab matches.
    pushUpdate(cell, "archived");

    expect(writes()).toBe(0); // sync must not echo a write
    expect(cell.get()).toBe("archived");
    expect(h.selectedTab()).toBe("active"); // visual fallback to first tab
  });

  it("still writes the cell on a real user gesture (gesture path is unaffected)", () => {
    const { cell, writes } = countingCell("");
    const h = makeTabs(cell, ["active", "progress"]);
    expect(writes()).toBe(0); // mount wrote nothing

    h.clickTab("progress"); // genuine gesture

    expect(writes()).toBe(1); // exactly one write, from the gesture
    expect(cell.get()).toBe("progress");
  });

  it("all tabs disabled: no write and nothing selected (the firstEnabled-undefined branch)", () => {
    // Exercises the new fallback's `if (firstEnabled)` guard when there is no
    // enabled tab to fall back to: effectiveValue stays the (unmatched) cell
    // value, so no tab is selected — and crucially still no cell write.
    const { cell, writes } = countingCell("");
    const h = makeTabs(cell, ["active", "progress"]);
    h.fakeTabs.forEach((t) => (t.disabled = true));

    // Re-sync (as a recompute / prop update would) now that all are disabled.
    (h.tabs as unknown as { updateTabSelection: () => void })
      .updateTabSelection();

    expect(writes()).toBe(0);
    expect(h.selectedTab()).toBe(undefined); // no enabled tab to default to
  });
});

/**
 * Plain-string `value` contract (the "one-behind" highlight regression).
 *
 * A consumer whose selection truth is NOT a single string cell (e.g. Loom
 * mobile's PageViewer, which keys per-page selections in a map) binds a PLAIN
 * string value and listens to oncf-change:
 *
 *   <cf-tabs value={activeId} oncf-change={writeSelectionState}>
 *
 * — typically re-created inside a render computed, so each state write
 * re-renders cf-tabs with the string the click just produced. Two defects
 * stranded the highlight one state behind on every tap:
 *
 * 1. Click-time: emitUserChange → setValue has no backing store for a plain
 *    binding, so the onChange sync's getValue() re-read returned the STALE
 *    bound literal and the visual update no-oped. (Fixed: onChange syncs from
 *    the delivered value.)
 * 2. Re-render-time: the consumer's recompute re-creates the tab children
 *    (all unselected) and patches `value` to the clicked string — but
 *    updated()'s `currentValue !== _lastKnownValue` guard saw the value it
 *    had already recorded at click time and skipped the re-sync entirely.
 *    (Fixed: a changed `value` PROPERTY always re-syncs.)
 */
describe("CFTabs plain-string value contract (one-behind regression)", () => {
  // Simulate the consumer's recompute: replace every cf-tab child with a
  // fresh, unselected element (the VDOM re-creates them), patch the `value`
  // property, and drive the lit lifecycle the way a property change does.
  function reRender(
    h: ReturnType<typeof makeTabs>,
    newValue: string,
    oldValue: string,
  ) {
    const fresh = h.fakeTabs.map((t) => {
      const nt = new FakeTab(t.value);
      nt.onClickDispatch = t.onClickDispatch;
      return nt;
    });
    h.fakeTabs.splice(0, h.fakeTabs.length, ...fresh);
    (h.tabs as unknown as { value: string }).value = newValue;
    const changed = new Map<string | number | symbol, unknown>([[
      "value",
      oldValue,
    ]]);
    (h.tabs as unknown as {
      willUpdate: (c: Map<string | number | symbol, unknown>) => void;
    }).willUpdate(changed);
    (h.tabs as unknown as {
      updated: (c: Map<string | number | symbol, unknown>) => void;
    }).updated(changed);
  }

  it("a user click highlights the clicked tab immediately (no cell to write back through)", () => {
    const h = makeTabs("steps", ["steps", "notes", "log"]);
    expect(h.selectedTab()).toBe("steps");

    h.clickTab("notes");

    // One gesture event, and the highlight tracks the tap at click time —
    // pre-fix the onChange getValue() re-read left "steps" selected.
    expect(h.changes.length).toBe(1);
    expect(h.changes[0]).toEqual({ value: "notes", oldValue: "steps" });
    expect(h.selectedTab()).toBe("notes");
  });

  it("consumer re-render carrying the clicked value re-syncs freshly created tabs", () => {
    const h = makeTabs("steps", ["steps", "notes", "log"]);

    h.clickTab("notes");
    // The oncf-change consumer writes its state; its computed re-runs and
    // re-creates the tab row with value="notes" — the SAME string the click
    // produced. Pre-fix, updated() read this as no-change and left the fresh
    // (unselected) children unselected: the visible highlight was whatever
    // the PREVIOUS render carried — one behind, forever.
    reRender(h, "notes", "steps");
    expect(h.selectedTab()).toBe("notes");

    // And it stays correct across the next tap: the exact reported repro
    // (each render used to show the previous click's target).
    h.clickTab("log");
    reRender(h, "log", "notes");
    expect(h.selectedTab()).toBe("log");

    h.clickTab("steps");
    reRender(h, "steps", "log");
    expect(h.selectedTab()).toBe("steps");
  });

  it("re-render to a DIFFERENT value than the click (controlled rejection) wins", () => {
    // The consumer is authoritative: if its state write resolves to another
    // id (e.g. a guard/fallback), the re-rendered value must override the
    // click-time highlight.
    const h = makeTabs("steps", ["steps", "notes", "log"]);

    h.clickTab("log");
    reRender(h, "notes", "steps"); // consumer resolved the tap to "notes"
    expect(h.selectedTab()).toBe("notes");
  });
});

/**
 * Deferred-retry supersession + slot-listener lifetime.
 *
 * Review follow-ups on the one-behind fix (PR #4711): the deferred rAF retry
 * now CAPTURES its call's valueOverride, so a retry left armed across a newer
 * synchronous pass would replay the older delivery next frame; and the
 * cf-tab-list slotchange listener must survive the VDOM replacing the
 * tab-list element (previously a one-shot boolean pinned it to the first).
 */
describe("CFTabs deferred retry + slot listener lifetime", () => {
  it("a newer sync pass cancels a pending deferred retry (stale delivery must not replay)", () => {
    // Capturable rAF: the module-level shim swallows callbacks; these stubs
    // record them so the test can fire (or prove the cancellation of) the
    // deferred retry deterministically.
    const rafCbs = new Map<number, () => void>();
    let nextRafId = 1;
    const origRaf = g.requestAnimationFrame;
    const origCaf = g.cancelAnimationFrame;
    g.requestAnimationFrame = (cb: () => void) => {
      const id = nextRafId++;
      rafCbs.set(id, cb);
      return id;
    };
    g.cancelAnimationFrame = (id: number) => {
      rafCbs.delete(id);
    };
    try {
      const cell = createMockCellHandle<string>("");
      const h = makeTabs(cell, ["a", "b"]);
      // Simulate the VDOM timing gap: tab elements exist, properties not yet
      // assigned — the condition that arms the deferred retry.
      h.fakeTabs.forEach((t) => {
        (t as unknown as { value?: string }).value = undefined;
      });

      pushUpdate(cell, "a"); // delivery "a" can't apply → arms a retry carrying "a"
      expect(rafCbs.size).toBe(1);

      // Properties arrive, then a NEWER delivery applies synchronously.
      h.fakeTabs[0].value = "a";
      h.fakeTabs[1].value = "b";
      pushUpdate(cell, "b");
      expect(h.selectedTab()).toBe("b");

      // The stale "a" retry must be gone — pre-fix it survived here...
      expect(rafCbs.size).toBe(0);
      // ...and firing any survivor must not overwrite the latest selection
      // (pre-fix this replayed "a" over "b" on the next frame).
      for (const cb of [...rafCbs.values()]) cb();
      expect(h.selectedTab()).toBe("b");
    } finally {
      g.requestAnimationFrame = origRaf;
      g.cancelAnimationFrame = origCaf;
    }
  });

  it("re-attaches the slotchange listener when the cf-tab-list element is replaced, and its slotchange re-syncs", () => {
    // Fake cf-tab-list: just the surface setupTabListSlotListener touches — a
    // shadow root exposing a <slot> that records slotchange listeners.
    function makeFakeTabList() {
      const listeners: Array<() => void> = [];
      const slot = {
        addEventListener: (_type: string, cb: () => void) => {
          listeners.push(cb);
        },
        // Empty: skip the "tabs already present" immediate-sync branch so the
        // test exercises the LISTENER path explicitly via fireSlotChange.
        assignedElements: () => [] as unknown[],
      };
      return {
        el: {
          tagName: "CF-TAB-LIST",
          shadowRoot: {
            querySelector: (sel: string) => (sel === "slot" ? slot : null),
          },
        },
        listeners,
        fireSlotChange: () => listeners.forEach((cb) => cb()),
      };
    }

    const cell = createMockCellHandle<string>("a");
    const h = makeTabs(cell, ["a", "b"]);
    const listA = makeFakeTabList();
    const listB = makeFakeTabList();
    let currentTabList: unknown = listA.el;
    (h.tabs as unknown as {
      querySelector: (sel: string) => unknown;
    }).querySelector = (sel: string) =>
      sel === "cf-tab-list" ? currentTabList : null;
    const setup = (h.tabs as unknown as {
      setupTabListSlotListener: () => void;
    }).setupTabListSlotListener.bind(h.tabs);

    setup();
    expect(listA.listeners.length).toBe(1);
    setup(); // same element: idempotent, no duplicate listener
    expect(listA.listeners.length).toBe(1);

    // The VDOM re-renders the consumer's tab row, re-creating cf-tab-list.
    currentTabList = listB.el;
    setup();
    // Pre-fix the one-shot boolean left the replacement without a listener
    // (0 here) — cf-tabs went deaf to every subsequent tab change.
    expect(listB.listeners.length).toBe(1);

    // And the re-attached listener actually re-syncs: knock the selection out
    // from under the component (as freshly created, unselected children would
    // be), then fire B's slotchange.
    h.fakeTabs.forEach((t) => (t.selected = false));
    listB.fireSlotChange();
    expect(h.selectedTab()).toBe("a");
  });
});
