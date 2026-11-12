import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import type { BridgeCell, BridgeResource } from "@commonfabric/iframe-sandbox";
import {
  type GuestPage,
  MemoryCell,
  openGuestPage,
  patchProperty,
} from "../../tools/test-support/iframe-guest.ts";
import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeStateData,
  type MachineEdge,
  machineEdgeId,
} from "./contract.ts";
import { machineNodePresentation } from "./model.ts";

const GUEST = new URL("./guest.tsx", import.meta.url);
const HTML = new URL("./guest.html", import.meta.url);

const INPUT = {
  title: "Rube's workshop",
  subtitle: "Every wire is a bad idea.",
};

const MOONLIGHT_TO_PARADOX = machineEdgeId("sensor-moonlight", "gate-paradox");

/** Wires appended concurrently with the routes they would loop back into. */
const OPTIMISM_LOOP: MachineEdge = {
  id: machineEdgeId("transformer-optimism", "gate-paradox"),
  source: "transformer-optimism",
  target: "gate-paradox",
};
const TOMORROW_LOOP: MachineEdge = {
  id: machineEdgeId("delay-tomorrow", "gate-paradox"),
  source: "delay-tomorrow",
  target: "gate-paradox",
};

/** The default machine with its moonlight sensor switched off. */
const DORMANT_STATE: IframeStateData = {
  ...DEFAULT_STATE,
  nodes: DEFAULT_STATE.nodes.map((node) =>
    node.id === "sensor-moonlight"
      ? { ...node, parameters: { ...node.parameters, active: false } }
      : node
  ),
};

//
// Layout doubles
//

/** The size the simulated layout gives an element, in CSS pixels. */
function sizeOf(element: Element): { width: number; height: number } {
  if (element.classList.contains("react-flow__handle")) {
    return { width: 10, height: 10 };
  }
  if (element.classList.contains("react-flow__node")) {
    return { width: 220, height: 140 };
  }
  return { width: 1200, height: 800 };
}

/** What a resize observer reports about one element. */
interface ResizeEntry {
  target: Element;
  contentRect: DOMRect;
}

/**
 * Reports each element it is asked to observe once, as a browser reports an
 * element's first size after it starts observing it.
 */
class FirstSizeObserver {
  readonly #callback: (entries: ResizeEntry[]) => void;

  constructor(callback: (entries: ResizeEntry[]) => void) {
    this.#callback = callback;
  }

  observe(target: Element): void {
    queueMicrotask(() =>
      this.#callback([{ target, contentRect: target.getBoundingClientRect() }])
    );
  }

  unobserve(): void {}
  disconnect(): void {}
}

//
// Fabric double
//

type Path = readonly (string | number)[];

/**
 * Stands between the guest and a cell as the rest of the fabric does, so that
 * a test can act as another writer at the moment the guest reads one path:
 * after the guest's earlier reads of other paths have answered, and before
 * this one does. A {@link MemoryCell} can hold back every read, but not tell
 * one path's read from another's.
 */
class Link {
  readonly #cell: MemoryCell;
  readonly #reads = new Map<string, () => void>();

  constructor(cell: MemoryCell) {
    this.#cell = cell;
  }

  /** Runs `action` as the guest next reads `path`, before the read answers. */
  beforeRead(path: Path, action: () => void): void {
    this.#reads.set(path.join("/"), action);
  }

  /** The bridge resource that grants the guest the cell through this link. */
  resource(): BridgeResource {
    const resource = this.#cell.resource();
    return resource.cell
      ? { ...resource, cell: this.#wrap(resource.cell, []) }
      : resource;
  }

  #wrap(cell: BridgeCell, path: Path): BridgeCell {
    const { key } = cell;
    const id = path.join("/");
    return {
      ...cell,
      pull: () => {
        const action = this.#reads.get(id);
        this.#reads.delete(id);
        action?.();
        return cell.pull();
      },
      ...(key && {
        key: (name: string | number) => this.#wrap(key(name), [...path, name]),
      }),
    };
  }
}

//
// Tests
//

describe("iframe-impossible-machine/guest", () => {
  let page: GuestPage | undefined;

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  /**
   * Loads the guest with the stored machine and view, or with `cells`, and
   * resolves once `loaded` holds: by default, once the canvas has measured
   * every module.
   */
  async function open(cells: {
    input?: MemoryCell;
    state?: MemoryCell;
    output?: MemoryCell;
    html?: string;
    loaded?: () => boolean;
  } = {}) {
    const input = cells.input ?? new MemoryCell(INPUT, { readonly: true });
    const state = cells.state ?? new MemoryCell(DEFAULT_STATE);
    const output = cells.output ?? new MemoryCell(DEFAULT_OUTPUT);
    const stateLink = new Link(state);
    page = await openGuestPage({
      guest: GUEST,
      html: cells.html ?? HTML,
      resources: {
        input: input.resource(),
        state: stateLink.resource(),
        output: output.resource(),
      },
      globals: { ResizeObserver: FirstSizeObserver },
      setup: () => {
        patchProperty(HTMLElement.prototype, "offsetWidth", {
          get(this: HTMLElement) {
            return sizeOf(this).width;
          },
        });
        patchProperty(HTMLElement.prototype, "offsetHeight", {
          get(this: HTMLElement) {
            return sizeOf(this).height;
          },
        });
        patchProperty(Element.prototype, "getBoundingClientRect", {
          value(this: Element) {
            const { width, height } = sizeOf(this);
            return new DOMRect(0, 0, width, height);
          },
        });
      },
    });
    await page.until(cells.loaded ?? measured);
    return { page, input, state, output, stateLink };
  }

  /** Whether the machine is shown with every module measured. */
  function measured(): boolean {
    const nodes = [
      ...document.querySelectorAll<HTMLElement>(".react-flow__node"),
    ];
    return nodes.length > 0 &&
      nodes.every((node) => node.style.visibility === "visible");
  }

  function find<T extends Element = HTMLElement>(
    selector: string,
    within: ParentNode = document,
  ): T {
    const element = within.querySelector<T>(selector);
    if (!element) throw new Error(`Nothing matches \`${selector}\`.`);
    return element;
  }

  function text(selector: string): string {
    return document.querySelector(selector)?.textContent ?? "";
  }

  function texts(selector: string): string[] {
    return [...document.querySelectorAll(selector)].map((element) =>
      element.textContent ?? ""
    );
  }

  function alertText(): string {
    return text('[role="alert"]');
  }

  function telemetry(): string[] {
    return texts(".telemetry > *");
  }

  function button(selector: string): HTMLButtonElement {
    return find<HTMLButtonElement>(selector);
  }

  /** The canvas's element for the module `id`. */
  function node(id: string): HTMLElement {
    return find(`.react-flow__node[data-id="${id}"]`);
  }

  function signal(id: string): string {
    return find("output", node(id)).textContent ?? "";
  }

  function parameter<T extends Element = HTMLInputElement>(
    id: string,
    name: string,
  ): T {
    return find<T>(`[data-param="${name}"]`, node(id));
  }

  /** Where the canvas draws the module `id`, in canvas coordinates. */
  function drawnAt(id: string): { x: number; y: number } {
    const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(
      node(id).style.transform,
    );
    if (!match) throw new Error(`Module ${id} is not placed.`);
    return { x: Number(match[1]), y: Number(match[2]) };
  }

  /** The canvas's zoom, which scales a pointer's movement into the canvas. */
  function zoom(): number {
    const match = /scale\(([-\d.]+)\)/.exec(
      find(".react-flow__viewport").style.transform,
    );
    if (!match) throw new Error("The canvas has no zoom.");
    return Number(match[1]);
  }

  /** Types `value` into `input` as a person would, leaving it focused. */
  function type(input: HTMLInputElement, value: string): void {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
      ?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function choose(select: HTMLSelectElement, value: string): void {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function wire(source: string, target: string): void {
    choose(find<HTMLSelectElement>('[data-wire="source"]'), source);
    choose(find<HTMLSelectElement>('[data-wire="target"]'), target);
    button('[data-action="connect-modules"]').click();
  }

  /**
   * Drags the module `id` by `dx` and `dy` screen pixels. The canvas picks a
   * module up at the pointer's first movement past its threshold, so the
   * pointer nudges it first and then moves it by the full distance.
   */
  function drag(id: string, dx: number, dy: number): void {
    const init = { bubbles: true, cancelable: true, view: window };
    const at = (clientX: number, clientY: number) => ({
      ...init,
      clientX,
      clientY,
    });
    node(id).dispatchEvent(new MouseEvent("mousedown", at(300, 300)));
    dispatchEvent(new MouseEvent("mousemove", at(305, 300)));
    dispatchEvent(new MouseEvent("mousemove", at(305 + dx, 300 + dy)));
    dispatchEvent(new MouseEvent("mouseup", at(305 + dx, 300 + dy)));
  }

  describe("hydration", () => {
    it("initializes an empty machine and view with the defaults", async () => {
      const { page, state, output } = await open({
        state: new MemoryCell(),
        output: new MemoryCell(),
      });
      await page.settled();

      expect(state.writes).toEqual([
        { operation: "initialize", path: [], value: DEFAULT_STATE },
      ]);
      expect(output.writes).toEqual([
        { operation: "initialize", path: [], value: DEFAULT_OUTPUT },
      ]);
      expect(texts(".react-flow__node strong")).toEqual(
        DEFAULT_STATE.nodes.map((node) => node.label),
      );
    });

    it("writes nothing when the machine and view are stored", async () => {
      const { page, state, output } = await open();
      await page.settled();

      expect(state.writes).toEqual([]);
      expect(output.writes).toEqual([]);
    });

    it("shows the input's title and subtitle", async () => {
      await open();

      expect(text(".app-header h1")).toBe(INPUT.title);
      expect(text(".app-header p:not(.eyebrow)")).toBe(INPUT.subtitle);
    });

    it("shows the loading view, titled from the input, while the machine is unreadable", async () => {
      const { page, state } = await open();

      state.value = undefined;
      await page.until(() => document.querySelector(".loading-view") !== null);

      expect(text(".loading-view h1")).toBe(INPUT.title);
      expect(button(".loading-view button").disabled).toBe(true);
      expect(document.querySelector(".machine-app")).toBeNull();
    });

    it("titles the loading view with the default title while the input is unreadable", async () => {
      const { page, input } = await open();

      input.value = undefined;
      await page.until(() => document.querySelector(".loading-view") !== null);

      expect(text(".loading-view h1")).toBe(DEFAULT_INPUT.title);
    });

    it("shows why a cell could not be read", async () => {
      const state = new MemoryCell(DEFAULT_STATE);
      state.failReads(new Error("The machine is sealed."));
      await open({ state, loaded: () => alertText() !== "" });

      expect(alertText()).toContain("The machine is sealed.");
      expect(document.querySelector(".machine-app")).toBeNull();
    });

    it("shows that hydration failed when the input holds nothing", async () => {
      await open({
        input: new MemoryCell(undefined, { readonly: true }),
        loaded: () => alertText() !== "",
      });

      expect(alertText()).toBe(
        "Fabric resources were not readable after hydration.",
      );
      expect(document.querySelector(".machine-app")).toBeNull();
    });

    it("throws when the document has no root element", async () => {
      await expect(
        open({ html: "<!doctype html><html><body></body></html>" }),
      ).rejects.toThrow("Impossible Machine root element is missing.");
    });
  });

  describe("machine", () => {
    it("draws each stored module with its kind and signal", async () => {
      await open();

      expect(
        [...document.querySelectorAll(".machine-node")].map((element) => [
          element.getAttribute("data-node-id"),
          element.getAttribute("data-node-kind"),
          element.querySelector("output")?.textContent,
        ]),
      ).toEqual([
        ["sensor-moonlight", "sensor", "85%"],
        ["sensor-contradiction", "sensor", "0%"],
        ["gate-paradox", "gate", "100%"],
        ["delay-tomorrow", "delay", "100%"],
        ["transformer-optimism", "transformer", "100%"],
        ["actuator-teacup", "actuator", "100%"],
      ]);
      expect(node("sensor-moonlight").querySelector(".is-active")).not
        .toBeNull();
      expect(node("sensor-contradiction").querySelector(".is-active"))
        .toBeNull();
    });

    it("draws each wire, glowing while its source is high", async () => {
      await open();

      const edges = [...document.querySelectorAll(".react-flow__edge")];
      expect(edges.map((edge) => edge.getAttribute("data-id"))).toEqual(
        DEFAULT_STATE.edges.map((edge) => edge.id),
      );
      const glowing = edges.filter((edge) =>
        edge.classList.contains("animated")
      )
        .map((edge) => edge.getAttribute("data-id"));
      expect(glowing).toContain(MOONLIGHT_TO_PARADOX);
      expect(glowing).not.toContain(
        machineEdgeId("sensor-contradiction", "gate-paradox"),
      );
    });

    it("counts the modules, the wires and the actuators firing", async () => {
      await open();

      expect(telemetry()).toEqual(["6 modules", "6 wires", "1 firing"]);
      expect(text(".actuator-state")).toBe("Launched!");
    });

    it("shows an actuator standing by while its signal is below its trigger", async () => {
      await open({ state: new MemoryCell(DORMANT_STATE) });

      expect(telemetry()).toEqual(["6 modules", "6 wires", "0 firing"]);
      expect(text(".actuator-state")).toBe("Standing by");
    });

    it("leaves out the wires that have been removed", async () => {
      await open({
        state: new MemoryCell({
          ...DEFAULT_STATE,
          disabledEdges: { [MOONLIGHT_TO_PARADOX]: true },
        }),
      });

      expect(telemetry()).toContain("5 wires");
      expect(
        document.querySelector(
          `.react-flow__edge[data-id="${MOONLIGHT_TO_PARADOX}"]`,
        ),
      ).toBeNull();
    });

    it("follows changes another writer makes to the machine", async () => {
      const { page, state } = await open();

      state.value = DORMANT_STATE;
      await page.until(() => signal("sensor-moonlight") === "0%");

      expect(text(".actuator-state")).toBe("Standing by");
    });
  });

  describe("adding modules", () => {
    it("appends a module of the chosen kind with that kind's defaults", async () => {
      const { page, state } = await open();

      const write = state.nextWrite();
      button('[data-add-kind="gate"]').click();
      expect(await write).toMatchObject({
        operation: "push",
        path: ["nodes"],
        value: [{
          kind: "gate",
          parameters: {
            active: false,
            strength: 1,
            operator: "and",
            delaySteps: 1,
            gain: 1,
            offset: 0,
            threshold: 0.6,
          },
        }],
      });
      await page.until(() =>
        document.querySelectorAll(".machine-node").length === 7
      );

      const added = [...document.querySelectorAll(".machine-node")].at(-1);
      const id = added?.getAttribute("data-node-id") ?? "";
      expect(added?.getAttribute("data-node-kind")).toBe("gate");
      expect(added?.querySelector("strong")?.textContent).toBe(
        `Gate · ${machineNodePresentation(id).code}`,
      );
      expect(telemetry()).toContain("7 modules");
    });

    it("appends a sensor that is already emitting", async () => {
      const { page } = await open();

      button('[data-add-kind="sensor"]').click();
      await page.until(() =>
        document.querySelectorAll(".machine-node").length === 7
      );

      const added = [...document.querySelectorAll(".machine-node")].at(-1);
      expect(added?.querySelector('[data-param="active"]')?.textContent).toBe(
        "Emitting",
      );
    });

    it("disables the controls while a write is in flight", async () => {
      const { page, output } = await open();

      const release = output.holdReads();
      button('[data-action="next-tick"]').click();
      await page.until(() =>
        text("#machine-status") === "Committing to Fabric…"
      );
      expect(button('[data-add-kind="gate"]').disabled).toBe(true);
      expect(button('[data-action="toggle-signals"]').disabled).toBe(true);

      release();
      await page.until(() =>
        text("#machine-status") === "All controls are live"
      );
      expect(button('[data-add-kind="gate"]').disabled).toBe(false);
      expect(text('[data-testid="simulation-tick"]')).toBe("Tick 4");
    });
  });

  describe("simulation", () => {
    it("stores the next tick and evaluates the machine at it", async () => {
      const { page, output } = await open({
        output: new MemoryCell({ ...DEFAULT_OUTPUT, simulationTick: 1 }),
      });
      expect(signal("delay-tomorrow")).toBe("0%");

      const write = output.nextWrite();
      button('[data-action="next-tick"]').click();
      expect(await write).toEqual({
        operation: "set",
        path: ["simulationTick"],
        value: 2,
      });
      await page.until(() => signal("delay-tomorrow") === "100%");

      expect(text('[data-testid="simulation-tick"]')).toBe("Tick 2");
    });

    it("stores the previous tick", async () => {
      const { page, output } = await open();

      const write = output.nextWrite();
      button('[data-action="previous-tick"]').click();
      expect(await write).toEqual({
        operation: "set",
        path: ["simulationTick"],
        value: 2,
      });
      await page.until(() =>
        text('[data-testid="simulation-tick"]') === "Tick 2"
      );
    });

    it("disables the previous tick at the first tick only", async () => {
      const { page, output } = await open({
        output: new MemoryCell({ ...DEFAULT_OUTPUT, simulationTick: 0 }),
      });
      expect(button('[data-action="previous-tick"]').disabled).toBe(true);

      output.value = { ...DEFAULT_OUTPUT, simulationTick: 1 };
      await page.until(() => !button('[data-action="previous-tick"]').disabled);
    });

    it("hides the signals once the signal glow is switched off", async () => {
      const { page, output } = await open();
      expect(document.querySelectorAll(".react-flow__edge-text").length)
        .toBeGreaterThan(0);

      const write = output.nextWrite();
      button('[data-action="toggle-signals"]').click();
      expect(await write).toEqual({
        operation: "set",
        path: ["showSignals"],
        value: false,
      });
      await page.until(() => signal("sensor-moonlight") === "Hidden");

      expect(
        button('[data-action="toggle-signals"]').getAttribute("aria-pressed"),
      ).toBe("false");
      expect(document.querySelectorAll(".machine-node.is-active").length)
        .toBe(0);
      expect(document.querySelectorAll(".react-flow__edge-text").length)
        .toBe(0);
      // The machine still fires; only its display is hidden.
      expect(text(".actuator-state")).toBe("Launched!");
    });

    it("shows why a view change failed", async () => {
      const { page, output } = await open();
      output.failWrites(new Error("The view is frozen."));

      button('[data-action="next-tick"]').click();
      await page.until(() => alertText() !== "");

      expect(alertText()).toContain("The view is frozen.");
      expect(text('[data-testid="simulation-tick"]')).toBe("Tick 3");
    });
  });

  describe("module controls", () => {
    it("stores a sensor switched off", async () => {
      const { page, state } = await open();

      const write = state.nextWrite();
      parameter<HTMLButtonElement>("sensor-moonlight", "active").click();
      expect(await write).toEqual({
        operation: "set",
        path: ["nodes", 0, "parameters", "active"],
        value: false,
      });
      await page.until(() =>
        parameter("sensor-moonlight", "active").textContent === "Dormant"
      );

      expect(signal("sensor-moonlight")).toBe("0%");
    });

    it("stores a gate's chosen logic", async () => {
      const { page, state } = await open();

      const write = state.nextWrite();
      choose(parameter<HTMLSelectElement>("gate-paradox", "operator"), "and");
      expect(await write).toEqual({
        operation: "set",
        path: ["nodes", 2, "parameters", "operator"],
        value: "and",
      });
      await page.until(() => signal("gate-paradox") === "0%");
    });

    it("stores a typed value, clamped into the parameter's range, once the field loses focus", async () => {
      const { page, state } = await open();
      const strength = parameter("sensor-moonlight", "strength");

      type(strength, "1.5");
      await page.settled();
      expect(state.writes).toEqual([]);
      const write = state.nextWrite();
      strength.blur();
      expect(await write).toEqual({
        operation: "set",
        path: ["nodes", 0, "parameters", "strength"],
        value: 1,
      });
      await page.until(() => signal("sensor-moonlight") === "100%");

      expect(parameter("sensor-moonlight", "strength").value).toBe("1");
    });

    it("stores a typed value when Enter is pressed", async () => {
      const { state } = await open();
      const gain = parameter("transformer-optimism", "gain");

      type(gain, "-0.5");
      const write = state.nextWrite();
      gain.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );

      expect(await write).toEqual({
        operation: "set",
        path: ["nodes", 4, "parameters", "gain"],
        value: -0.5,
      });
    });

    it("stores nothing for a key other than Enter", async () => {
      const { page, state } = await open();
      const gain = parameter("transformer-optimism", "gain");

      type(gain, "2");
      gain.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
      await page.settled();

      expect(state.writes).toEqual([]);
      expect(gain.value).toBe("2");
    });

    it("stores nothing when the typed value is the stored one", async () => {
      const { page, state } = await open();
      const offset = parameter("transformer-optimism", "offset");

      type(offset, "0.05");
      offset.blur();
      await page.settled();

      expect(state.writes).toEqual([]);
    });

    it("keeps a field's typed draft while another writer changes its value", async () => {
      const { page, state } = await open();
      const threshold = parameter("actuator-teacup", "threshold");

      type(threshold, "0.3");
      state.value = {
        ...DORMANT_STATE,
        nodes: DORMANT_STATE.nodes.map((node) =>
          node.id === "actuator-teacup"
            ? { ...node, parameters: { ...node.parameters, threshold: 0.9 } }
            : node
        ),
      };
      await page.until(() => text(".actuator-state") === "Standing by");

      expect(threshold.value).toBe("0.3");
    });

    it("shows another writer's value in a field that is not being edited", async () => {
      const { page, state } = await open();

      state.value = {
        ...DEFAULT_STATE,
        nodes: DEFAULT_STATE.nodes.map((node) =>
          node.id === "delay-tomorrow"
            ? { ...node, parameters: { ...node.parameters, delaySteps: 5 } }
            : node
        ),
      };

      await page.until(() =>
        parameter("delay-tomorrow", "delaySteps").value === "5"
      );
    });

    it("disables only the edited module's controls while its write is in flight", async () => {
      const { page, state } = await open();

      const release = state.holdReads();
      parameter<HTMLButtonElement>("sensor-moonlight", "active").click();
      await page.until(() =>
        parameter<HTMLButtonElement>("sensor-moonlight", "active").disabled
      );
      expect(parameter("sensor-moonlight", "strength").disabled).toBe(true);
      expect(
        parameter<HTMLButtonElement>("sensor-contradiction", "active").disabled,
      ).toBe(false);
      expect(button('[data-add-kind="gate"]').disabled).toBe(false);

      release();
      await page.until(() =>
        !parameter<HTMLButtonElement>("sensor-moonlight", "active").disabled
      );
      expect(parameter("sensor-moonlight", "active").textContent).toBe(
        "Dormant",
      );
    });

    it("reports a module that was removed before its edit landed", async () => {
      const { page, state, stateLink } = await open();

      stateLink.beforeRead(["nodes"], () => {
        state.value = {
          ...DEFAULT_STATE,
          nodes: DEFAULT_STATE.nodes.filter((node) =>
            node.id !== "sensor-moonlight"
          ),
          edges: DEFAULT_STATE.edges.filter((edge) =>
            edge.source !== "sensor-moonlight"
          ),
        };
      });
      parameter<HTMLButtonElement>("sensor-moonlight", "active").click();
      await page.until(() => alertText() !== "");

      expect(alertText()).toBe("Module sensor-moonlight no longer exists.");
      await page.settled();
      expect(state.writes).toEqual([]);
    });

    it("reports a module that moved before its edit landed", async () => {
      const { page, state, stateLink } = await open();

      stateLink.beforeRead(["nodes", 0], () => {
        state.value = {
          ...DEFAULT_STATE,
          nodes: DEFAULT_STATE.nodes.toReversed(),
        };
      });
      parameter<HTMLButtonElement>("sensor-moonlight", "active").click();
      await page.until(() => alertText() !== "");

      expect(alertText()).toBe(
        "Module sensor-moonlight moved while it was being edited.",
      );
      await page.settled();
      expect(state.writes).toEqual([]);
    });

    it("leaves the selection alone when a module's control is clicked", async () => {
      const { page, output } = await open();

      parameter<HTMLButtonElement>("sensor-moonlight", "active").click();
      await page.settled();

      expect(output.writes).toEqual([]);
    });
  });

  describe("wire builder", () => {
    it("offers every module but the actuators as a source and every module but the sensors as a target", async () => {
      await open();

      expect(texts('[data-wire="source"] option')).toEqual([
        "Choose module",
        "Moonlight sensor",
        "Contradiction detector",
        "Paradox gate",
        "Tomorrow loop",
        "Optimism amplifier",
      ]);
      expect(texts('[data-wire="target"] option')).toEqual([
        "Choose module",
        "Paradox gate",
        "Tomorrow loop",
        "Optimism amplifier",
        "Teacup launcher",
      ]);
    });

    it("enables connecting once both ends are chosen", async () => {
      const { page } = await open();
      const connect = button('[data-action="connect-modules"]');
      const source = find<HTMLSelectElement>('[data-wire="source"]');
      expect(connect.disabled).toBe(true);

      choose(source, "sensor-moonlight");
      await page.until(() => source.value === "sensor-moonlight");
      expect(connect.disabled).toBe(true);

      choose(
        find<HTMLSelectElement>('[data-wire="target"]'),
        "actuator-teacup",
      );
      await page.until(() => !connect.disabled);
    });

    it("appends a wire between the chosen modules", async () => {
      const { page, state } = await open();

      const write = state.nextWrite();
      wire("sensor-contradiction", "actuator-teacup");
      const id = machineEdgeId("sensor-contradiction", "actuator-teacup");
      expect(await write).toEqual({
        operation: "push",
        path: ["edges"],
        value: [{
          id,
          source: "sensor-contradiction",
          target: "actuator-teacup",
        }],
      });
      await page.until(() => telemetry().includes("7 wires"));

      expect(document.querySelector(`.react-flow__edge[data-id="${id}"]`)).not
        .toBeNull();
    });

    it("restores a removed wire rather than appending it again", async () => {
      const { page, state } = await open({
        state: new MemoryCell({
          ...DEFAULT_STATE,
          disabledEdges: { [MOONLIGHT_TO_PARADOX]: true },
        }),
      });

      const write = state.nextWrite();
      wire("sensor-moonlight", "gate-paradox");
      expect(await write).toEqual({
        operation: "set",
        path: ["disabledEdges", MOONLIGHT_TO_PARADOX],
        value: false,
      });
      await page.until(() => telemetry().includes("6 wires"));
      await page.settled();

      expect(state.writes.length).toBe(1);
    });

    it("refuses to connect a module to itself", async () => {
      const { page, state } = await open();

      wire("gate-paradox", "gate-paradox");
      await page.until(() => alertText() !== "");

      expect(alertText()).toBe("Choose two different modules to connect.");
      await page.settled();
      expect(state.writes).toEqual([]);
    });

    it("refuses a wire that already exists", async () => {
      const { page, state } = await open();

      wire("sensor-moonlight", "gate-paradox");
      await page.until(() => alertText() !== "");

      expect(alertText()).toBe("Those modules are already connected.");
      await page.settled();
      expect(state.writes).toEqual([]);
    });

    it("refuses a wire that would close a feedback loop", async () => {
      const { page, state } = await open();

      wire("transformer-optimism", "gate-paradox");
      await page.until(() => alertText() !== "");

      expect(alertText()).toBe(
        "Feedback loops are not supported. Choose a downstream module.",
      );
      await page.settled();
      expect(state.writes).toEqual([]);
    });
  });

  describe("feedback conflicts", () => {
    it("shows a wire that loops back as a conflict to remove", async () => {
      await open({
        state: new MemoryCell({
          ...DEFAULT_STATE,
          edges: [...DEFAULT_STATE.edges, OPTIMISM_LOOP],
        }),
      });

      expect(texts("[data-remove-wire]")).toEqual([
        "Remove transformer-optimism → gate-paradox",
      ]);
      expect(text('footer [role="status"]')).toBe(
        "1 concurrent feedback wire is awaiting conflict resolution",
      );
      expect(telemetry()).toContain("6 wires");
      expect(
        find(`.react-flow__edge[data-id="${OPTIMISM_LOOP.id}"]`).textContent,
      ).toBe("Feedback conflict");
    });

    it("counts several conflicting wires", async () => {
      await open({
        state: new MemoryCell({
          ...DEFAULT_STATE,
          edges: [...DEFAULT_STATE.edges, OPTIMISM_LOOP, TOMORROW_LOOP],
        }),
      });

      expect(text('footer [role="status"]')).toBe(
        "2 concurrent feedback wires are awaiting conflict resolution",
      );
    });

    it("shows no conflicts for a machine without loops", async () => {
      await open();

      expect(document.querySelector(".wire-conflicts")).toBeNull();
      expect(document.querySelector('footer [role="status"]')).toBeNull();
    });

    it("stores a conflicting wire as removed", async () => {
      const { page, state } = await open({
        state: new MemoryCell({
          ...DEFAULT_STATE,
          edges: [...DEFAULT_STATE.edges, OPTIMISM_LOOP],
        }),
      });

      const write = state.nextWrite();
      button("[data-remove-wire]").click();
      expect(await write).toEqual({
        operation: "set",
        path: ["disabledEdges", OPTIMISM_LOOP.id],
        value: true,
      });
      await page.until(() =>
        document.querySelector(".wire-conflicts") === null
      );

      expect(
        document.querySelector(
          `.react-flow__edge[data-id="${OPTIMISM_LOOP.id}"]`,
        ),
      ).toBeNull();
    });
  });

  describe("canvas", () => {
    it("stores the module clicked as the selection", async () => {
      const { page, output } = await open();
      expect(text(".inspector h2")).toBe("Select a module");

      const write = output.nextWrite();
      node("gate-paradox").click();
      expect(await write).toEqual({
        operation: "set",
        path: ["selectedNodeId"],
        value: "gate-paradox",
      });
      await page.until(() => text(".inspector h2") === "Paradox gate");
      await page.settled();

      expect(text(".inspector h2 + p")).toBe("Gate · 100% signal");
      expect(node("gate-paradox").classList.contains("selected")).toBe(true);
    });

    it("stores nothing when the selected module is clicked again", async () => {
      const { page, output } = await open({
        output: new MemoryCell({
          ...DEFAULT_OUTPUT,
          selectedNodeId: "gate-paradox",
        }),
      });

      node("gate-paradox").click();
      await page.settled();

      expect(output.writes).toEqual([]);
      expect(node("gate-paradox").classList.contains("selected")).toBe(true);
    });

    it("puts the selection back when it cannot be stored", async () => {
      const { page, output } = await open({
        output: new MemoryCell({
          ...DEFAULT_OUTPUT,
          selectedNodeId: "gate-paradox",
        }),
      });
      output.failWrites(new Error("The view is frozen."));

      node("delay-tomorrow").click();
      await page.until(() => alertText() !== "");
      await page.until(() =>
        node("gate-paradox").classList.contains("selected")
      );

      expect(node("delay-tomorrow").classList.contains("selected")).toBe(false);
      expect(text(".inspector h2")).toBe("Paradox gate");
    });

    it("follows the selection another of the user's views stores", async () => {
      const { page, output } = await open();

      output.value = { ...DEFAULT_OUTPUT, selectedNodeId: "actuator-teacup" };
      await page.until(() =>
        node("actuator-teacup").classList.contains("selected")
      );

      expect(text(".inspector h2")).toBe("Teacup launcher");
    });

    it("stores the position a module is dragged to", async () => {
      const { page, state } = await open();
      const position = { x: 70 + 40 / zoom(), y: 70 + 20 / zoom() };

      const write = state.nextWrite();
      drag("sensor-moonlight", 40, 20);
      expect(await write).toEqual({
        operation: "set",
        path: ["nodes", 0, "position"],
        value: position,
      });
      await page.until(() =>
        drawnAt("sensor-moonlight").x === position.x &&
        drawnAt("sensor-moonlight").y === position.y
      );
    });

    it("stores the position of a module dropped where it was picked up", async () => {
      const { page, state } = await open();

      const write = state.nextWrite();
      drag("sensor-moonlight", 0, 0);
      expect(await write).toEqual({
        operation: "set",
        path: ["nodes", 0, "position"],
        value: { x: 70, y: 70 },
      });
      await page.settled();

      expect(drawnAt("sensor-moonlight")).toEqual({ x: 70, y: 70 });
    });

    it("puts a dragged module back when its position cannot be stored", async () => {
      const { page, state } = await open();
      state.failWrites(new Error("The machine is sealed."));

      drag("sensor-moonlight", 40, 20);
      await page.until(() => alertText() !== "");
      await page.until(() =>
        drawnAt("sensor-moonlight").x === 70 &&
        drawnAt("sensor-moonlight").y === 70
      );

      expect(alertText()).toContain("The machine is sealed.");
    });

    it("appends a wire drawn from one module's output to another's input", async () => {
      const { state } = await open();

      const write = state.nextWrite();
      find(".react-flow__handle.source", node("sensor-contradiction")).click();
      find(".react-flow__handle.target", node("actuator-teacup")).click();

      expect(await write).toEqual({
        operation: "push",
        path: ["edges"],
        value: [{
          id: machineEdgeId("sensor-contradiction", "actuator-teacup"),
          source: "sensor-contradiction",
          target: "actuator-teacup",
        }],
      });
    });
  });
});
