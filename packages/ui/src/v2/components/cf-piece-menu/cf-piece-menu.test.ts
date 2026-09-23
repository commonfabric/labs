import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CellScope } from "@commonfabric/api";
import { $conn, CellHandle, RequestType } from "@commonfabric/runtime-client";
import type {
  CellRef,
  PieceSourceRevisionSourceView,
  PieceSourceView,
  RuntimeClient,
  SpaceAclView,
} from "@commonfabric/runtime-client";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  CFPieceMenu,
  formatPieceValue,
  isStreamHandle,
  openPieceMenu,
  pieceMenuEntries,
} from "./cf-piece-menu.ts";
import {
  describeFollowState,
  describeOrigin,
  describeSourceFailure,
  formatTimestamp,
  patternRefLabel,
} from "./origin-view.ts";
import {
  clearPieceBoundary,
  providePieceBoundary,
} from "../../../../../html/src/main/space-context.ts";

// The menu renders through Lit templates rather than into a real DOM here: the
// assertions read the template a render produced, which is enough to say what
// the menu shows and when. Its behavior against a live piece — the portalled
// overlay, positioning, the click path — is driven end to end by
// packages/shell/integration/piece-menu.test.ts.

/** The static text and interpolated values of a rendered Lit template. */
function textOf(node: unknown): string {
  // `nothing` — Lit's render-nothing sentinel — is a symbol, and contributes no
  // text, like the other empty values.
  if (
    node === null || node === undefined || typeof node === "boolean" ||
    typeof node === "symbol"
  ) {
    return "";
  }
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "object") {
    const template = node as {
      strings?: readonly string[];
      values?: unknown[];
    };
    if (template.strings && template.values) {
      return template.strings
        .map((part, index) => part + textOf(template.values![index]))
        .join("");
    }
    return "";
  }
  return String(node);
}

/** What the menu shows now. `render` is the component's own protected hook. */
function shows(menu: CFPieceMenu): string {
  return textOf((menu as unknown as { render(): unknown }).render());
}

function liveRegionText(menu: CFPieceMenu): string {
  const regions: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isObjectOrArray(node)) return;
    const template = node as {
      strings?: readonly string[];
      values?: unknown[];
    };
    if (!template.strings || !template.values) return;
    for (const child of template.values) visit(child);
    const liveRegionIndex = template.strings.findIndex((part) =>
      part.includes('aria-live="polite"')
    );
    if (liveRegionIndex >= 0) {
      regions.push(textOf(template.values[liveRegionIndex]));
    }
  };
  visit((menu as unknown as { render(): unknown }).render());
  regions.sort((left, right) => left.length - right.length);
  return regions[0] ?? "";
}

function withLocation<T>(href: string, run: () => T): T {
  const hadLocation = "location" in globalThis &&
    globalThis.location !== undefined;
  // deno-lint-ignore no-explicit-any
  const originalLocation = (globalThis as any).location;
  Object.defineProperty(globalThis, "location", {
    value: { href },
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    if (hadLocation) {
      Object.defineProperty(globalThis, "location", {
        value: originalLocation,
        configurable: true,
        writable: true,
      });
    } else {
      // deno-lint-ignore no-explicit-any
      delete (globalThis as any).location;
    }
  }
}

function templateForTestId(
  menu: CFPieceMenu,
  testId: string,
): { strings: readonly string[]; values: unknown[] } {
  const candidates: Array<{
    node: { strings: readonly string[]; values: unknown[] };
    text: string;
  }> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isObjectOrArray(node)) return;
    const template = node as {
      strings?: readonly string[];
      values?: unknown[];
    };
    if (!template.strings || !template.values) return;
    for (const child of template.values) visit(child);
    const text = textOf(template);
    if (
      text.includes(testId) &&
      template.values.some((value) => typeof value === "function")
    ) {
      candidates.push({
        node: template as {
          strings: readonly string[];
          values: unknown[];
        },
        text,
      });
    }
  };
  visit((menu as unknown as { render(): unknown }).render());
  candidates.sort((left, right) => left.text.length - right.text.length);
  const template = candidates[0]?.node;
  if (template === undefined) {
    throw new Error(`no rendered template found for ${testId}`);
  }
  return template;
}

function clickHandler(
  menu: CFPieceMenu,
  testId: string,
): (event: MouseEvent) => unknown {
  const handler = templateForTestId(menu, testId).values.find(
    (value) => typeof value === "function",
  );
  if (typeof handler !== "function") {
    throw new Error(`no click handler found for ${testId}`);
  }
  return handler as (event: MouseEvent) => unknown;
}

function testMouseEvent(): MouseEvent {
  return {
    preventDefault() {},
    stopPropagation() {},
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  } as unknown as MouseEvent;
}

function clickTestId(
  menu: CFPieceMenu,
  testId: string,
  event: MouseEvent = testMouseEvent(),
): unknown {
  return clickHandler(menu, testId)(event);
}

/** Find a rendered event handler on the element identified by `marker`. */
function eventHandler(
  menu: CFPieceMenu,
  marker: string,
  eventName: string,
): (event: Event) => unknown {
  let handler: ((event: Event) => unknown) | undefined;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isObjectOrArray(node)) return;
    const template = node as {
      strings?: readonly string[];
      values?: unknown[];
    };
    if (!template.strings || !template.values) return;
    const index = template.strings.findIndex((part) =>
      part.includes(`@${eventName}="`)
    );
    if (
      template.strings.join("").includes(marker) && index >= 0 &&
      typeof template.values[index] === "function"
    ) {
      handler = template.values[index] as (event: Event) => unknown;
    }
    for (const child of template.values) visit(child);
  };
  visit((menu as unknown as { render(): unknown }).render());
  if (!handler) {
    throw new Error(`no ${eventName} handler found for ${marker}`);
  }
  return handler;
}

/**
 * Let a source action run to completion.
 *
 * Every stub in this file resolves immediately, so an action settles once the
 * microtask queue drains. Draining it is what this waits for -- a count of
 * `await`s would have to be recounted whenever an action gains a step.
 */
async function settled(): Promise<void> {
  for (let drained = 0; drained < 16; drained++) await Promise.resolve();
}

const SPACE = "did:key:z6Mk-piece-menu" as const;
const OWNER = "did:key:z6Mk-piece-menu-owner" as const;
const VIEWER = "did:key:z6Mk-piece-menu-viewer" as const;

const OWNER_ACCESS: SpaceAclView = {
  space: SPACE,
  principal: OWNER,
  acl: { [OWNER]: "OWNER", "*": "WRITE" },
  canEdit: true,
};

const VIEWER_ACCESS: SpaceAclView = {
  ...OWNER_ACCESS,
  principal: VIEWER,
  canEdit: false,
};

const SOURCE: PieceSourceView = {
  space: SPACE,
  pieceId: "of:fid1:piece",
  name: "Recipe",
  pattern: { identity: "pattern-identity-value", symbol: "default" },
  origin: {
    url: "https://toolshed.test/api/patterns/recipe.tsx",
    kind: "system",
  },
  entry: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: "the main file" },
    { name: "/helper.tsx", contents: "the helper file" },
  ],
  history: [],
};

/**
 * A piece whose runtime answers one source read. `read` decides what that read
 * does, so a test can resolve it, reject it, or leave it pending.
 */
function pieceCell(
  read: (
    pieceId?: string,
    space?: typeof SPACE,
    scope?: CellScope,
  ) => Promise<PieceSourceView> = () => Promise.resolve(SOURCE),
  {
    aborted = false,
    scope = "space",
    readRevision = () =>
      Promise.resolve({ pattern: SOURCE.pattern!, files: SOURCE.files }),
    update = () => Promise.resolve({ source: SOURCE }),
    getAccess = () => Promise.resolve(OWNER_ACCESS),
    setAccess = () => Promise.resolve(OWNER_ACCESS),
    removeAccess = () => Promise.resolve(OWNER_ACCESS),
  }: {
    aborted?: boolean | (() => boolean);
    scope?: CellScope;
    readRevision?: (
      pieceId: string,
      space: typeof SPACE,
      revisionId: string,
      scope?: CellScope,
    ) => Promise<PieceSourceRevisionSourceView>;
    update?: (
      pieceId: string,
      space: typeof SPACE,
      action: unknown,
      options: unknown,
    ) => Promise<{
      source: PieceSourceView;
      compatibilityWarning?: string;
      confirmationToken?: string;
      executionWarning?: string;
    }>;
    getAccess?: () => Promise<SpaceAclView>;
    setAccess?: (
      space: typeof SPACE,
      user: string,
      capability: "READ" | "WRITE" | "OWNER",
    ) => Promise<SpaceAclView>;
    removeAccess?: (
      space: typeof SPACE,
      user: string,
    ) => Promise<SpaceAclView>;
  } = {},
): CellHandle {
  const runtime = {
    getPieceSource: read,
    getPieceSourceRevision: readRevision,
    updatePieceSource: update,
    getSpaceAcl: getAccess,
    setSpaceAclEntry: setAccess,
    removeSpaceAclEntry: removeAccess,
    signal: {
      get aborted() {
        return typeof aborted === "function" ? aborted() : aborted;
      },
    },
  };
  return {
    id: () => "of:fid1:piece",
    space: () => SPACE,
    ref: () => ({ id: "of:fid1:piece", space: SPACE, scope, path: [] }),
    runtime: () => runtime,
    equals(other: unknown) {
      return other === this;
    },
  } as unknown as CellHandle;
}

/**
 * A menu whose state changes do not schedule a Lit update: there is no DOM to
 * render into here, and every assertion renders explicitly.
 */
function newMenu(): CFPieceMenu {
  const menu = new CFPieceMenu();
  // Lit's own update pass wants a DOM to render into; every assertion here
  // renders explicitly instead.
  (menu as unknown as { performUpdate(): void }).performUpdate = () => {};
  return menu;
}

function openMenu(cell: CellHandle = pieceCell()): CFPieceMenu {
  const menu = newMenu();
  menu.open({ cell, x: 40, y: 60 });
  return menu;
}

/** The runtime a fake piece is reached through, on its own. */
function spaceRuntime(
  options: Parameters<typeof pieceCell>[1] = {},
): RuntimeClient {
  return (pieceCell(undefined, options) as unknown as {
    runtime(): RuntimeClient;
  }).runtime();
}

/** A menu opened over a space with no piece, as a failed load leaves one. */
function openSpaceMenu(
  options: Parameters<typeof pieceCell>[1] = {},
): CFPieceMenu {
  const menu = newMenu();
  menu.open({ space: SPACE, runtime: spaceRuntime(options), x: 40, y: 60 });
  return menu;
}

/**
 * The rendered entry carrying `testId`, as the template that holds it. Both
 * the id and the disabled state are interpolated values rather than literal
 * markup, so a caller reads them out of the template rather than out of text.
 */
function entryTemplate(
  menu: CFPieceMenu,
  testId: string,
): { strings: readonly string[]; values: unknown[]; at: number } {
  let found:
    | { strings: readonly string[]; values: unknown[]; at: number }
    | undefined;
  const visit = (node: unknown): void => {
    if (found) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isObjectOrArray(node)) return;
    const template = node as {
      strings?: readonly string[];
      values?: unknown[];
    };
    if (!template.strings || !template.values) return;
    const at = template.strings.findIndex((part, index) =>
      part.endsWith('test-id="') && template.values![index] === testId
    );
    if (at >= 0) {
      found = { strings: template.strings, values: template.values, at };
      return;
    }
    for (const child of template.values) visit(child);
  };
  visit((menu as unknown as { render(): unknown }).render());
  if (!found) throw new Error(`no rendered entry carries test-id ${testId}`);
  return found;
}

/** Whether the entry carrying `testId` renders as disabled. */
function isDisabled(menu: CFPieceMenu, testId: string): boolean {
  const { strings, values, at } = entryTemplate(menu, testId);
  for (let index = at + 1; index < values.length; index++) {
    if (strings[index].includes('?disabled="')) return Boolean(values[index]);
    if (strings[index].includes('@click="')) break;
  }
  return false;
}

/**
 * The subject line of the open panel, which names what the panel is about. It
 * is an interpolated value, so a caller reads it out of the template.
 */
function subjectOf(menu: CFPieceMenu): unknown {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = visit(child);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (!isObjectOrArray(node)) return undefined;
    const template = node as {
      strings?: readonly string[];
      values?: unknown[];
    };
    if (!template.strings || !template.values) return undefined;
    const at = template.strings.findIndex((part) =>
      part.endsWith('<span class="subject">')
    );
    if (at >= 0) return template.values[at];
    for (const child of template.values) {
      const found = visit(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const found = visit((menu as unknown as { render(): unknown }).render());
  if (found === undefined) throw new Error("no panel renders a subject line");
  return found;
}

/** An element stub that records the attributes the menu changes. */
function highlightProbe(): {
  element: Element;
  has: (name: string) => boolean;
} {
  const attributes = new Set<string>();
  return {
    element: {
      setAttribute: (name: string) => attributes.add(name),
      removeAttribute: (name: string) => attributes.delete(name),
    } as unknown as Element,
    has: (name: string) => attributes.has(name),
  };
}

function geometryProbe(
  rect: { left: number; top: number; right: number; bottom: number },
): Element {
  return Object.assign(new EventTarget(), {
    getBoundingClientRect: () => rect,
    setAttribute: () => {},
    removeAttribute: () => {},
  }) as unknown as Element;
}

describe("piece menu entries", () => {
  it("offers the panels and clone action in order", () => {
    expect(pieceMenuEntries().map((entry) => entry.label)).toEqual([
      "View source",
      "Origin and history",
      "Data",
      "Actions",
      "Clone fresh piece into new space",
      "Clone piece and copy data into new space",
    ]);
  });

  it("gives each entry a stable hook a host's tests can select", () => {
    expect(pieceMenuEntries().map((entry) => entry.testId)).toEqual([
      "piece-menu-source",
      "piece-menu-origin",
      "piece-menu-data",
      "piece-menu-actions",
      "piece-menu-clone-fresh",
      "piece-menu-clone-copy-data",
    ]);
  });

  it("adds an explicit detach action for a piece with an origin", () => {
    expect(pieceMenuEntries(true).map((entry) => entry.label)).toEqual([
      "View source",
      "Origin and history",
      "Data",
      "Actions",
      "Clone fresh piece into new space",
      "Clone piece and copy data into new space",
      "Stop following source",
    ]);
    expect(pieceMenuEntries(true).at(-1)?.testId).toBe(
      "piece-menu-detach-source",
    );
  });
});

describe("the menu a right-click opens", () => {
  it("names the piece and offers every entry", () => {
    const rendered = shows(openMenu());
    expect(rendered).toContain("of:fid1:piece");
    for (const entry of pieceMenuEntries()) {
      expect(rendered).toContain(entry.label);
      expect(rendered).toContain(entry.testId);
    }
    expect(rendered).toContain("menu-divider");
    expect(rendered).toContain("Space access rights...");
    expect(rendered).toContain("piece-menu-space-access");
  });

  it("places space access after the piece actions and divider", () => {
    const rendered = shows(openMenu());
    expect(rendered.indexOf("Actions")).toBeLessThan(
      rendered.indexOf("menu-divider"),
    );
    expect(rendered.indexOf("menu-divider")).toBeLessThan(
      rendered.indexOf("Space access rights..."),
    );
  });

  it("shows nothing until it is opened, or once closed", () => {
    const menu = newMenu();
    expect(shows(menu)).toBe("");
    menu.open({ cell: pieceCell(), x: 0, y: 0 });
    expect(shows(menu)).toContain("View source");
    menu.close();
    expect(shows(menu)).toBe("");
  });

  it("moves the highlight to the addressed piece and removes it on close", () => {
    const menu = newMenu();
    const first = highlightProbe();
    const second = highlightProbe();

    menu.open({
      cell: pieceCell(),
      x: 0,
      y: 0,
      highlightedPiece: first.element,
    });
    expect(first.has("data-cf-piece-menu-open")).toBe(true);

    menu.open({
      cell: pieceCell(),
      x: 0,
      y: 0,
      highlightedPiece: second.element,
    });
    expect(first.has("data-cf-piece-menu-open")).toBe(false);
    expect(second.has("data-cf-piece-menu-open")).toBe(true);

    menu.close();
    expect(second.has("data-cf-piece-menu-open")).toBe(false);
  });

  it("closes only for the render element it highlights", () => {
    const menu = newMenu();
    const piece = highlightProbe();
    const other = highlightProbe();
    menu.open({
      cell: pieceCell(),
      x: 0,
      y: 0,
      highlightedPiece: piece.element,
    });

    menu.closeFor(other.element);
    expect(shows(menu)).toContain("View source");
    expect(piece.has("data-cf-piece-menu-open")).toBe(true);

    menu.closeFor(piece.element);
    expect(shows(menu)).toBe("");
    expect(piece.has("data-cf-piece-menu-open")).toBe(false);
  });

  it("closes and removes the highlight when its overlay disconnects", () => {
    const menu = newMenu();
    const piece = highlightProbe();
    menu.open({
      cell: pieceCell(),
      x: 0,
      y: 0,
      highlightedPiece: piece.element,
    });

    menu.disconnectedCallback();

    expect(piece.has("data-cf-piece-menu-open")).toBe(false);
    expect(shows(menu)).toBe("");
  });

  it("drops an access read that resolves after disconnect", async () => {
    let resolveAccess!: (access: SpaceAclView) => void;
    const menu = openMenu(pieceCell(undefined, {
      getAccess: () =>
        new Promise((resolve) => {
          resolveAccess = resolve;
        }),
    }));
    const read = menu.showPanel("access");
    expect(shows(menu)).toContain("Reading access rights");

    menu.disconnectedCallback();
    resolveAccess(OWNER_ACCESS);
    await read;

    expect(shows(menu)).toBe("");
    expect(
      (menu as unknown as { spaceAccess: SpaceAclView | undefined })
        .spaceAccess,
    ).toBeUndefined();
  });

  it("drops an access read while preserving a clone across disconnect", async () => {
    let resolveAccess!: (access: SpaceAclView) => void;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cell = pieceCell(undefined, {
      getAccess: () =>
        new Promise((resolve) => {
          resolveAccess = resolve;
        }),
    });
    const runtime = cell.runtime() as unknown as {
      resolveSpaceName(name: string): Promise<typeof SPACE>;
      clonePiece(): Promise<{ id(): string }>;
    };
    runtime.resolveSpaceName = () => Promise.resolve(SPACE);
    runtime.clonePiece = async () => {
      entered.resolve();
      await release.promise;
      throw new Error("expected test failure");
    };
    const menu = openMenu(cell);
    const read = menu.showPanel("access");
    (menu as unknown as { panel: string | undefined }).panel = undefined;
    const cloning = menu.cloneIntoNewSpace({
      spaceName: "clone-with-pending-access",
    });
    await entered.promise;
    menu.disconnectedCallback();
    resolveAccess(OWNER_ACCESS);
    await read;

    expect(
      (menu as unknown as { spaceAccess: SpaceAclView | undefined })
        .spaceAccess,
    ).toBeUndefined();

    (menu as unknown as { spaceAccess: SpaceAclView | undefined })
      .spaceAccess = OWNER_ACCESS;
    menu.disconnectedCallback();
    expect(
      (menu as unknown as { spaceAccess: SpaceAclView | undefined })
        .spaceAccess,
    ).toBeUndefined();
    release.resolve();
    await cloning;
  });

  it("draws a clipped fixed highlight over a nested pattern root", () => {
    const menu = newMenu();
    const owner = geometryProbe({
      left: 10,
      top: 20,
      right: 210,
      bottom: 220,
    });
    const target = geometryProbe({
      left: 0,
      top: 40,
      right: 160,
      bottom: 260,
    });
    const cell = pieceCell();
    providePieceBoundary(target, cell);

    menu.open({
      cell,
      x: 0,
      y: 0,
      highlightedPiece: owner,
      highlightTarget: target,
    });

    const rendered = shows(menu);
    expect(rendered).toContain("nested-piece-highlight");
    expect(rendered).toContain(
      "left: 10px; top: 40px; width: 150px; height: 180px",
    );

    menu.closeFor(target);
    expect(shows(menu)).toContain("View source");
    menu.closeFor(owner);
    expect(shows(menu)).toBe("");
  });

  it("closes when the nested root stops representing the open piece", () => {
    const menu = newMenu();
    const cell = pieceCell();
    const owner = geometryProbe({
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
    });
    const target = geometryProbe({
      left: 10,
      top: 10,
      right: 100,
      bottom: 100,
    });
    providePieceBoundary(target, cell);
    menu.open({
      cell,
      x: 0,
      y: 0,
      highlightedPiece: owner,
      highlightTarget: target,
    });

    clearPieceBoundary(target);

    expect(shows(menu)).toBe("");
  });

  it("shows the detach action after reading a followed piece", async () => {
    const menu = openMenu();
    await menu.showPanel("origin");
    (menu as unknown as { panel: undefined }).panel = undefined;

    const rendered = shows(menu);
    expect(rendered).toContain("Stop following source");
    expect(rendered).toContain("piece-menu-detach-source");
  });

  it("clones into a named space and navigates to the new piece", async () => {
    const requests: unknown[] = [];
    const navigations: unknown[] = [];
    const onNavigate = (event: Event) => {
      navigations.push((event as CustomEvent).detail);
    };
    const cell = pieceCell();
    const runtime = cell.runtime() as unknown as {
      resolveSpaceName(name: string): Promise<typeof SPACE>;
      clonePiece(
        pieceId: string,
        sourceSpace: typeof SPACE,
        destinationSpace: typeof SPACE,
        options: { copyData?: boolean },
      ): Promise<{ id(): string }>;
    };
    runtime.resolveSpaceName = (name) => {
      requests.push({ kind: "resolve", name });
      return Promise.resolve(SPACE);
    };
    runtime.clonePiece = (pieceId, sourceSpace, destinationSpace, options) => {
      requests.push({
        kind: "clone",
        pieceId,
        sourceSpace,
        destinationSpace,
        options,
      });
      return Promise.resolve({ id: () => "fid1:clone" });
    };
    globalThis.addEventListener("cf-navigate", onNavigate);
    try {
      const menu = openMenu(cell);
      await menu.cloneIntoNewSpace({ spaceName: "copied-piece" });
    } finally {
      globalThis.removeEventListener("cf-navigate", onNavigate);
    }

    expect(requests).toEqual([
      { kind: "resolve", name: "copied-piece" },
      {
        kind: "clone",
        pieceId: "of:fid1:piece",
        sourceSpace: SPACE,
        destinationSpace: SPACE,
        options: { copyData: false, scope: "space" },
      },
    ]);
    expect(navigations).toEqual([{
      spaceName: "copied-piece",
      pieceId: "fid1:clone",
    }]);
  });

  it("keeps the clone dialog open until an in-flight clone completes", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const navigations: unknown[] = [];
    const onNavigate = (event: Event) => {
      navigations.push((event as CustomEvent).detail);
    };
    const cell = pieceCell();
    const runtime = cell.runtime() as unknown as {
      resolveSpaceName(name: string): Promise<typeof SPACE>;
      clonePiece(): Promise<{ id(): string }>;
    };
    runtime.resolveSpaceName = () => Promise.resolve(SPACE);
    runtime.clonePiece = async () => {
      entered.resolve();
      await release.promise;
      return { id: () => "fid1:clone" };
    };
    globalThis.addEventListener("cf-navigate", onNavigate);
    try {
      const menu = openMenu(cell);
      const cloning = menu.cloneIntoNewSpace({ spaceName: "copied-piece" });
      await entered.promise;
      expect(shows(menu)).toContain("Cloning piece into a new space…");

      // A pending clone cannot be dismissed: its result still needs somewhere
      // to report a failure, and a successful clone will navigate when done.
      menu.close();
      expect(shows(menu)).toContain("Cloning piece into a new space…");

      release.resolve();
      await cloning;
      expect(shows(menu)).toBe("");
    } finally {
      release.resolve();
      globalThis.removeEventListener("cf-navigate", onNavigate);
    }

    expect(navigations).toEqual([{
      spaceName: "copied-piece",
      pieceId: "fid1:clone",
    }]);
  });

  it("ignores new openings and duplicate clone requests while cloning", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let cloneCalls = 0;
    const cell = pieceCell();
    const runtime = cell.runtime() as unknown as {
      resolveSpaceName(name: string): Promise<typeof SPACE>;
      clonePiece(): Promise<{ id(): string }>;
    };
    runtime.resolveSpaceName = () => Promise.resolve(SPACE);
    runtime.clonePiece = async () => {
      cloneCalls++;
      entered.resolve();
      await release.promise;
      throw new Error("expected test failure");
    };
    const menu = openMenu(cell);
    const cloneHandler = clickHandler(menu, "piece-menu-clone-fresh");
    const startClone = () => cloneHandler(testMouseEvent());

    const cloning = startClone() as Promise<void>;
    await entered.promise;
    expect(shows(menu)).toContain("Cloning piece into a new space…");

    menu.open({
      cell: {
        ...pieceCell(),
        id: () => "of:fid1:other-piece",
      } as CellHandle,
      x: 10,
      y: 20,
    });
    expect(shows(menu)).toContain("Cloning piece into a new space…");

    await startClone();
    await menu.cloneIntoNewSpace({ spaceName: "duplicate-copy" });
    expect(cloneCalls).toBe(1);

    release.resolve();
    await cloning;
  });

  it("completes a clone that finishes after disconnection", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const navigations: unknown[] = [];
    const onNavigate = (event: Event) => {
      navigations.push((event as CustomEvent).detail);
    };
    const cell = pieceCell();
    const runtime = cell.runtime() as unknown as {
      resolveSpaceName(name: string): Promise<typeof SPACE>;
      clonePiece(): Promise<{ id(): string }>;
    };
    runtime.resolveSpaceName = () => Promise.resolve(SPACE);
    runtime.clonePiece = async () => {
      entered.resolve();
      await release.promise;
      return { id: () => "fid1:clone" };
    };
    const menu = openMenu(cell);
    globalThis.addEventListener("cf-navigate", onNavigate);
    try {
      const cloning = menu.cloneIntoNewSpace({ spaceName: "copied-piece" });
      await entered.promise;

      menu.disconnectedCallback();
      release.resolve();
      await cloning;

      expect(navigations).toEqual([{
        spaceName: "copied-piece",
        pieceId: "fid1:clone",
      }]);
    } finally {
      release.resolve();
      globalThis.removeEventListener("cf-navigate", onNavigate);
    }
  });

  it("retains a clone failure that arrives after disconnection", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cell = pieceCell();
    const runtime = cell.runtime() as unknown as {
      resolveSpaceName(name: string): Promise<typeof SPACE>;
      clonePiece(): Promise<{ id(): string }>;
    };
    runtime.resolveSpaceName = () => Promise.resolve(SPACE);
    runtime.clonePiece = async () => {
      entered.resolve();
      await release.promise;
      throw new Error("clone failed after disconnection");
    };
    const menu = openMenu(cell);
    const cloning = menu.cloneIntoNewSpace({ spaceName: "copied-piece" });
    await entered.promise;

    menu.disconnectedCallback();
    release.resolve();
    await cloning;

    expect(shows(menu)).toContain("clone failed after disconnection");
    expect(shows(menu)).toContain("piece-clone-dialog");
  });

  it("shows clone progress and failures in a dialog", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cell = pieceCell();
    const runtime = cell.runtime() as unknown as {
      resolveSpaceName(name: string): Promise<typeof SPACE>;
      clonePiece(): Promise<{ id(): string }>;
    };
    runtime.resolveSpaceName = () => Promise.resolve(SPACE);
    runtime.clonePiece = async () => {
      entered.resolve();
      await release.promise;
      throw new Error("source data could not be copied");
    };
    const menu = openMenu(cell);

    const cloning = menu.cloneIntoNewSpace({ copyData: true });
    await entered.promise;
    const pending = shows(menu);
    expect(pending).toContain("piece-clone-dialog");
    expect(pending).toContain("Cloning piece into a new space…");
    expect(pending).toContain("<progress");
    expect(pending).not.toContain("Clone fresh piece into new space");

    release.resolve();
    await cloning;
    const failed = shows(menu);
    expect(failed).toContain("piece-clone-dialog");
    expect(failed).toContain(
      "Could not clone this piece: source data could not be copied",
    );
    expect(failed).toContain("Try again");
    expect(failed).not.toContain("piece-menu-clone-copy-data");
  });

  it("requests a data snapshot from the copy-data action", async () => {
    const calls: unknown[] = [];
    const cell = pieceCell();
    const runtime = cell.runtime() as unknown as {
      resolveSpaceName(name: string): Promise<typeof SPACE>;
      clonePiece(
        pieceId: string,
        sourceSpace: typeof SPACE,
        destinationSpace: typeof SPACE,
        options: { copyData?: boolean },
      ): Promise<{ id(): string }>;
    };
    runtime.resolveSpaceName = () => Promise.resolve(SPACE);
    runtime.clonePiece = (
      _pieceId,
      _sourceSpace,
      _destinationSpace,
      options,
    ) => {
      calls.push(options);
      return Promise.reject(new Error("stop after request"));
    };
    const menu = openMenu(cell);

    await clickTestId(menu, "piece-menu-clone-copy-data");

    expect(calls).toEqual([{ copyData: true, scope: "space" }]);
    expect(shows(menu)).toContain("Clone piece and copy data");
    expect(shows(menu)).not.toContain("piece-menu-clone-copy-data");
  });

  it("reports a runtime cancellation in the clone dialog", async () => {
    const cell = pieceCell(undefined, { aborted: true });
    const runtime = cell.runtime() as unknown as {
      resolveSpaceName(name: string): Promise<typeof SPACE>;
    };
    runtime.resolveSpaceName = () => Promise.reject(new Error("disposed"));
    const menu = openMenu(cell);

    await menu.cloneIntoNewSpace();

    expect(shows(menu)).toContain("piece-clone-dialog");
    expect(shows(menu)).toContain(
      "The clone was canceled because the runtime stopped.",
    );
  });
});

describe("addressing a piece in a narrower scope", () => {
  // A piece reached through a link into a narrower scope is addressed by its
  // id and that scope together, and the id alone names a different document.
  // The menu holds both on the cell it was opened over, so every request it
  // makes about the piece carries both.

  /** A source view with one retained revision to open. */
  const SCOPED_SOURCE: PieceSourceView = {
    ...SOURCE,
    origin: undefined,
    currentRevisionId: "current",
    history: [
      {
        revisionId: "older",
        timestamp: 1,
        pattern: SOURCE.pattern!,
        origin: SOURCE.origin,
        operation: "baseline",
      },
      {
        revisionId: "current",
        timestamp: 2,
        pattern: SOURCE.pattern!,
        operation: "detach",
      },
    ],
  };

  it("reads the source in the scope the cell was reached through", async () => {
    const reads: unknown[] = [];
    const menu = openMenu(pieceCell(
      (pieceId, space, scope) => {
        reads.push({ pieceId, space, scope });
        return Promise.resolve(SOURCE);
      },
      { scope: "user" },
    ));

    await menu.showPanel("source");

    expect(reads).toEqual([{
      pieceId: "of:fid1:piece",
      space: SPACE,
      scope: "user",
    }]);
  });

  it("reads a retained revision in that scope", async () => {
    const reads: unknown[] = [];
    const menu = openMenu(pieceCell(
      () => Promise.resolve(SCOPED_SOURCE),
      {
        scope: "user",
        readRevision: (pieceId, space, revisionId, scope) => {
          reads.push({ pieceId, space, revisionId, scope });
          return Promise.resolve({
            pattern: SOURCE.pattern!,
            files: [{ name: "/main.tsx", contents: "the older source" }],
          });
        },
      },
    ));
    await menu.showPanel("origin");

    await clickTestId(menu, "piece-source-view-older");

    expect(reads).toEqual([{
      pieceId: "of:fid1:piece",
      space: SPACE,
      revisionId: "older",
      scope: "user",
    }]);
  });

  it("changes the source in that scope", async () => {
    const changes: unknown[] = [];
    const menu = openMenu(pieceCell(
      () => Promise.resolve(SCOPED_SOURCE),
      {
        scope: "user",
        update: (pieceId, space, action, options) => {
          changes.push({ pieceId, space, action, options });
          return Promise.resolve({ source: SCOPED_SOURCE });
        },
      },
    ));

    await menu.changeSource({ kind: "detach" });

    expect(changes).toEqual([{
      pieceId: "of:fid1:piece",
      space: SPACE,
      action: { kind: "detach" },
      options: { scope: "user" },
    }]);
  });

  it("re-reads the source in that scope after a change that failed", async () => {
    const reads: unknown[] = [];
    const menu = openMenu(pieceCell(
      (pieceId, space, scope) => {
        reads.push({ pieceId, space, scope });
        return Promise.resolve(SCOPED_SOURCE);
      },
      {
        scope: "user",
        update: () => Promise.reject(new Error("the change did not land")),
      },
    ));

    await menu.changeSource({ kind: "detach" });

    // Opening the menu reads eagerly, so the read this pins is the last one:
    // the one the failed change triggers. The count is what says it happened
    // at all.
    expect(reads.length).toBe(2);
    expect(reads.at(-1)).toEqual({
      pieceId: "of:fid1:piece",
      space: SPACE,
      scope: "user",
    });
  });

  it("clones from that scope", async () => {
    const clones: unknown[] = [];
    const cell = pieceCell(undefined, { scope: "user" });
    const runtime = cell.runtime() as unknown as {
      resolveSpaceName(name: string): Promise<typeof SPACE>;
      clonePiece(
        pieceId: string,
        sourceSpace: typeof SPACE,
        destinationSpace: typeof SPACE,
        options: { copyData?: boolean; scope?: CellScope },
      ): Promise<{ id(): string }>;
    };
    runtime.resolveSpaceName = () => Promise.resolve(SPACE);
    runtime.clonePiece = (pieceId, sourceSpace, destinationSpace, options) => {
      clones.push({ pieceId, sourceSpace, destinationSpace, options });
      return Promise.resolve({ id: () => "fid1:clone" });
    };
    const menu = openMenu(cell);

    await menu.cloneIntoNewSpace({ spaceName: "copied-piece" });

    expect(clones).toEqual([{
      pieceId: "of:fid1:piece",
      sourceSpace: SPACE,
      destinationSpace: SPACE,
      options: { copyData: false, scope: "user" },
    }]);
  });

  it("reads the piece's own state in that scope", async () => {
    const piece = statefulPiece({ scope: "user" });
    const menu = openMenu(piece.cell);

    await menu.showPanel("data");

    expect(piece.getPieceCalls).toEqual([[
      "of:fid1:piece",
      SPACE,
      true,
      "user",
    ]]);
  });
});

describe("the menu over a space with no piece", () => {
  it("names the space and says the piece is unavailable", () => {
    const rendered = shows(openSpaceMenu());
    expect(rendered).toContain("Piece unavailable");
    expect(rendered).toContain(`Space ${SPACE}`);
  });

  it("disables every entry that needs a piece", () => {
    const menu = openSpaceMenu();
    for (const entry of pieceMenuEntries()) {
      expect(isDisabled(menu, entry.testId)).toBe(true);
    }
  });

  it("leaves the space entry available", () => {
    expect(isDisabled(openSpaceMenu(), "piece-menu-space-access")).toBe(false);
  });

  it("reads the space ACL with no piece to read it through", async () => {
    const menu = openSpaceMenu();
    await menu.showPanel("access");
    const rendered = shows(menu);
    expect(rendered).toContain("Space access rights");
    expect(rendered).toContain(OWNER);
  });

  it("names the space in the access panel's subject line", async () => {
    const menu = openSpaceMenu();
    await menu.showPanel("access");
    expect(subjectOf(menu)).toBe(SPACE);
  });

  it("disables the space entry when no runtime came with the space", () => {
    const menu = newMenu();
    menu.open({ space: SPACE, x: 40, y: 60 });
    expect(isDisabled(menu, "piece-menu-space-access")).toBe(true);
  });

  it("reads no access rights it has no runtime to read them through", async () => {
    // The entry that opens this panel is disabled without a runtime, so a
    // caller reaching the panel anyway finds it still waiting rather than
    // reporting a failure it never attempted.
    const menu = newMenu();
    menu.open({ space: SPACE, x: 40, y: 60 });

    await menu.showPanel("access");

    expect(shows(menu)).toContain("Reading access rights…");
  });

  it("stays down when it is opened over neither a piece nor a space", () => {
    const menu = newMenu();
    menu.open({ x: 40, y: 60 });
    expect(shows(menu)).toBe("");
    // The host covers the viewport, so a menu showing nothing has to be
    // hidden rather than left over the page catching its clicks.
    expect(menu.hidden).toBe(true);
  });

  it("takes the highlight off the piece a previous opening marked", () => {
    const menu = newMenu();
    const piece = highlightProbe();

    menu.open({
      cell: pieceCell(),
      x: 0,
      y: 0,
      highlightedPiece: piece.element,
    });
    expect(piece.has("data-cf-piece-menu-open")).toBe(true);

    menu.open({ space: SPACE, runtime: spaceRuntime(), x: 40, y: 60 });
    expect(piece.has("data-cf-piece-menu-open")).toBe(false);
  });
});

describe("placing the menu", () => {
  /**
   * Where `#placeMenu` puts a menu whose box is `width` by `height`, opened at
   * (`x`, `y`) in a viewport of `viewport`. The element standing in for the
   * rendered menu reports that box however it is positioned, which is what the
   * corner measurement buys: the size does not change under the clamp.
   */
  function placement(
    { x, y, width, height, viewport }: {
      x: number;
      y: number;
      width: number;
      height: number;
      viewport: { width: number; height: number };
    },
  ): { left: string; top: string } {
    const style = { left: "", top: "" };
    const element = {
      style,
      getBoundingClientRect: () => ({ width, height }),
    };
    const menu = newMenu();
    menu.open({ space: SPACE, runtime: spaceRuntime(), x, y });
    Object.defineProperty(menu, "shadowRoot", {
      configurable: true,
      value: {
        querySelector: (selector: string) =>
          selector === ".menu" ? element : null,
      },
    });
    const globals = globalThis as unknown as Record<string, unknown>;
    const priorWidth = globals.innerWidth;
    const priorHeight = globals.innerHeight;
    globals.innerWidth = viewport.width;
    globals.innerHeight = viewport.height;
    try {
      (menu as unknown as { updated(changed: Map<string, unknown>): void })
        .updated(new Map());
    } finally {
      globals.innerWidth = priorWidth;
      globals.innerHeight = priorHeight;
    }
    return style;
  }

  const VIEWPORT = { width: 1000, height: 800 };

  it("leaves the menu at the click when it fits there", () => {
    expect(
      placement({ x: 40, y: 60, width: 240, height: 300, viewport: VIEWPORT }),
    ).toEqual({ left: "40px", top: "60px" });
  });

  it("pulls a menu clicked near the far corner back inside the viewport", () => {
    expect(
      placement({
        x: 990,
        y: 790,
        width: 240,
        height: 300,
        viewport: VIEWPORT,
      }),
    ).toEqual({ left: "756px", top: "496px" });
  });

  it("holds a menu too big for the viewport against the near edges", () => {
    expect(
      placement({
        x: 500,
        y: 500,
        width: 1200,
        height: 900,
        viewport: VIEWPORT,
      }),
    ).toEqual({ left: "4px", top: "4px" });
  });

  it("places nothing while a panel is open in the menu's place", () => {
    const menu = newMenu();
    menu.open({ space: SPACE, runtime: spaceRuntime(), x: 40, y: 60 });
    Object.defineProperty(menu, "shadowRoot", {
      configurable: true,
      value: { querySelector: () => null },
    });
    expect(() =>
      (menu as unknown as { updated(changed: Map<string, unknown>): void })
        .updated(new Map())
    ).not.toThrow();
  });
});

describe("the menu over a piece", () => {
  it("names the space the piece belongs to", () => {
    expect(shows(openMenu())).toContain(`Space ${SPACE}`);
  });

  it("names the space in the access panel's subject line", async () => {
    const menu = openMenu();
    await menu.showPanel("access");
    expect(subjectOf(menu)).toBe(SPACE);
  });

  it("keeps every piece entry live", () => {
    const menu = openMenu();
    for (const entry of pieceMenuEntries()) {
      expect(isDisabled(menu, entry.testId)).toBe(false);
    }
  });
});

describe("the space access panel", () => {
  it("shows the ACL without editing controls to a non-owner", async () => {
    const menu = openMenu(pieceCell(undefined, {
      getAccess: () => Promise.resolve(VIEWER_ACCESS),
    }));

    await menu.showPanel("access");

    const rendered = shows(menu);
    expect(rendered).toContain("Space access rights");
    expect(rendered).toContain(OWNER);
    expect(rendered).toContain("Anyone (*)");
    expect(rendered).toContain("Only a space owner can change them");
    expect(rendered).not.toContain("space-access-add-form");
    expect(rendered).not.toContain("space-access-remove");
  });

  it("shows ACL editing controls to an owner", async () => {
    const menu = openMenu();

    await menu.showPanel("access");

    const rendered = shows(menu);
    expect(rendered).toContain("you have OWNER access");
    expect(rendered).toContain("space-access-add-form");
    expect(rendered).toContain("space-access-remove");
    expect(rendered).toContain(`${OWNER} (you)`);
  });

  it("updates the rendered ACL after setting and removing entries", async () => {
    const reader = "did:key:z6Mk-piece-menu-reader";
    const mutations: unknown[] = [];
    const withReader: SpaceAclView = {
      ...OWNER_ACCESS,
      acl: { ...OWNER_ACCESS.acl, [reader]: "READ" },
    };
    const menu = openMenu(pieceCell(undefined, {
      setAccess: (space, user, capability) => {
        mutations.push({ kind: "set", space, user, capability });
        return Promise.resolve(withReader);
      },
      removeAccess: (space, user) => {
        mutations.push({ kind: "remove", space, user });
        return Promise.resolve(OWNER_ACCESS);
      },
    }));
    await menu.showPanel("access");

    await menu.setSpaceAccessEntry(reader, "READ");
    expect(shows(menu)).toContain(reader);
    await menu.removeSpaceAccessEntry(reader);
    expect(shows(menu)).not.toContain(reader);
    expect(mutations).toEqual([
      { kind: "set", space: SPACE, user: reader, capability: "READ" },
      { kind: "remove", space: SPACE, user: reader },
    ]);
  });

  it("submits a new ACL entry from the rendered form", async () => {
    const reader = "did:key:z6Mk-piece-menu-form-reader";
    const mutations: unknown[] = [];
    const menu = openMenu(pieceCell(undefined, {
      setAccess: (space, user, capability) => {
        mutations.push({ space, user, capability });
        return Promise.resolve({
          ...OWNER_ACCESS,
          acl: { ...OWNER_ACCESS.acl, [user]: capability },
        });
      },
    }));
    await menu.showPanel("access");

    eventHandler(menu, "Identity DID or wildcard", "input")({
      currentTarget: { value: ` ${reader} ` },
    } as unknown as Event);
    eventHandler(menu, "Access level for new entry", "change")({
      currentTarget: { value: "WRITE" },
    } as unknown as Event);
    let prevented = false;
    eventHandler(menu, 'test-id="space-access-add-form"', "submit")({
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as Event);
    await Promise.resolve();

    expect(prevented).toBe(true);
    expect(mutations).toEqual([
      { space: SPACE, user: reader, capability: "WRITE" },
    ]);
    expect(shows(menu)).toContain(reader);
    expect(
      (menu as unknown as { newAccessUser: string }).newAccessUser,
    ).toBe("");
  });

  it("reports access reads and mutations that fail", async () => {
    const readFailure = openMenu(pieceCell(undefined, {
      getAccess: () => Promise.reject(new Error("ACL read denied")),
    }));
    await readFailure.showPanel("access");
    expect(shows(readFailure)).toContain("ACL read denied");

    const mutationFailure = openMenu(pieceCell(undefined, {
      setAccess: () => Promise.reject(new Error("ACL write denied")),
      removeAccess: () => Promise.reject("ACL removal denied"),
    }));
    await mutationFailure.showPanel("access");
    await mutationFailure.setSpaceAccessEntry("did:key:reader", "READ");
    expect(shows(mutationFailure)).toContain("ACL write denied");
    await mutationFailure.removeSpaceAccessEntry("did:key:reader");
    expect(shows(mutationFailure)).toContain("ACL removal denied");
  });

  it("ignores cancelled ACL reads and mutations", async () => {
    const menu = openMenu(pieceCell(undefined, {
      aborted: true,
      getAccess: () => Promise.reject(new Error("cancelled read")),
      setAccess: () => Promise.reject(new Error("cancelled set")),
      removeAccess: () => Promise.reject(new Error("cancelled removal")),
    }));

    await menu.showPanel("access");
    await menu.setSpaceAccessEntry("did:key:reader", "READ");
    await menu.removeSpaceAccessEntry("did:key:reader");

    expect(shows(menu)).not.toContain("cancelled");
  });

  it("drops ACL mutation results after another piece opens", async () => {
    let resolveSet!: (access: SpaceAclView) => void;
    let resolveRemoval!: (access: SpaceAclView) => void;
    const menu = openMenu(pieceCell(undefined, {
      setAccess: () =>
        new Promise((resolve) => {
          resolveSet = resolve;
        }),
    }));
    await menu.showPanel("access");

    const staleSet = menu.setSpaceAccessEntry("did:key:stale", "READ");
    menu.open({ cell: pieceCell(), x: 0, y: 0 });
    resolveSet({
      ...OWNER_ACCESS,
      acl: { ...OWNER_ACCESS.acl, "did:key:stale": "READ" },
    });
    await staleSet;
    expect(
      (menu as unknown as { spaceAccess: SpaceAclView | undefined })
        .spaceAccess,
    ).toBeUndefined();

    const removalMenu = openMenu(pieceCell(undefined, {
      removeAccess: () =>
        new Promise((resolve) => {
          resolveRemoval = resolve;
        }),
    }));
    await removalMenu.showPanel("access");
    const staleRemoval = removalMenu.removeSpaceAccessEntry(OWNER);
    removalMenu.open({ cell: pieceCell(), x: 0, y: 0 });
    resolveRemoval({ ...OWNER_ACCESS, acl: {} });
    await staleRemoval;
    expect(
      (removalMenu as unknown as {
        spaceAccess: SpaceAclView | undefined;
      }).spaceAccess,
    ).toBeUndefined();
  });

  it("does not overlap ACL mutations or accept an empty identity", async () => {
    let resolveSet!: (access: SpaceAclView) => void;
    let sets = 0;
    let removals = 0;
    const menu = openMenu(pieceCell(undefined, {
      setAccess: () => {
        sets++;
        return new Promise((resolve) => {
          resolveSet = resolve;
        });
      },
      removeAccess: () => {
        removals++;
        return Promise.resolve(OWNER_ACCESS);
      },
    }));
    await menu.showPanel("access");

    await menu.setSpaceAccessEntry("   ", "READ");
    const pending = menu.setSpaceAccessEntry("did:key:first", "READ");
    await menu.setSpaceAccessEntry("did:key:second", "WRITE");
    await menu.removeSpaceAccessEntry(OWNER);
    expect(sets).toBe(1);
    expect(removals).toBe(0);

    resolveSet(OWNER_ACCESS);
    await pending;
    await menu.removeSpaceAccessEntry(OWNER);
    expect(removals).toBe(1);

    menu.close();
    await menu.setSpaceAccessEntry("did:key:no-piece", "READ");
    await menu.removeSpaceAccessEntry(OWNER);
    expect(sets).toBe(1);
    expect(removals).toBe(1);
  });

  it("shows an empty ACL and consistently orders the wildcard", async () => {
    const empty = openMenu(pieceCell(undefined, {
      getAccess: () => Promise.resolve({ ...OWNER_ACCESS, acl: {} }),
    }));
    await empty.showPanel("access");
    expect(shows(empty)).toContain("No ACL entries");

    const wildcardFirst = openMenu(pieceCell(undefined, {
      getAccess: () =>
        Promise.resolve({
          ...OWNER_ACCESS,
          acl: { [OWNER]: "OWNER", "*": "WRITE" },
        }),
    }));
    await wildcardFirst.showPanel("access");
    const rendered = shows(wildcardFirst);
    expect(rendered).toContain("Anyone (*)");
    expect(rendered).toContain(OWNER);
    expect(rendered.indexOf("Anyone (*)")).toBeLessThan(
      rendered.indexOf(OWNER),
    );
  });
});

describe("the source panel", () => {
  it("shows the entry file, with a tab per file", async () => {
    const menu = openMenu();
    await menu.showPanel("source");

    const rendered = shows(menu);
    expect(rendered).toContain("Source");
    expect(rendered).toContain("Recipe");
    expect(rendered).toContain("the main file");
    expect(rendered).toContain("/helper.tsx");
  });

  it("switches to the file a tab selects", async () => {
    const menu = openMenu();
    await menu.showPanel("source");
    expect(shows(menu)).toContain("the main file");

    menu.selectFile(1);
    expect(shows(menu)).toContain("the helper file");
  });

  it("reads the piece once for both panels", async () => {
    let reads = 0;
    const menu = openMenu(pieceCell(() => {
      reads++;
      return Promise.resolve(SOURCE);
    }));

    await menu.showPanel("source");
    await menu.showPanel("origin");
    await menu.showPanel("source");

    expect(reads).toBe(1);
  });

  it("says so when the piece's source is not in its space", async () => {
    const menu = openMenu(
      pieceCell(() =>
        Promise.resolve({ ...SOURCE, entry: undefined, files: [] })
      ),
    );
    await menu.showPanel("source");

    const rendered = shows(menu);
    expect(rendered).toContain("not available in its space");
    expect(rendered).toContain("pattern-identity-value");
  });

  it("reports a read that failed", async () => {
    const menu = openMenu(
      pieceCell(() => Promise.reject(new Error("no read"))),
    );
    await menu.showPanel("source");

    expect(shows(menu)).toContain("no read");
    await menu.showPanel("origin");
    expect(shows(menu)).toContain("no read");
  });

  it("closes after a completed source read failure disconnects", async () => {
    const menu = openMenu(
      pieceCell(() => Promise.reject(new Error("no read"))),
    );
    await menu.showPanel("source");
    expect(shows(menu)).toContain("no read");

    menu.disconnectedCallback();

    expect(shows(menu)).toBe("");
  });

  it("stays quiet when the runtime was disposed mid-read", async () => {
    // A disposal race is cancellation, not a failure to report.
    const menu = openMenu(
      pieceCell(() => Promise.reject(new Error("gone")), { aborted: true }),
    );
    await menu.showPanel("source");

    expect(shows(menu)).not.toContain("gone");
  });

  it("drops a failed read that a later opening replaced", async () => {
    let failRead!: (error: Error) => void;
    const menu = openMenu(
      pieceCell(() =>
        new Promise<PieceSourceView>((_resolve, reject) => {
          failRead = reject;
        })
      ),
    );
    const pending = menu.showPanel("source");

    menu.open({ cell: pieceCell(), x: 0, y: 0 });
    failRead(new Error("failed after reopening"));
    await pending;

    // The failure belongs to the piece the menu no longer shows.
    expect(shows(menu)).not.toContain("failed after reopening");
  });

  it("drops a read that a later opening replaced", async () => {
    let resolveRead!: (source: PieceSourceView) => void;
    const menu = openMenu(
      pieceCell(() =>
        new Promise<PieceSourceView>((resolve) => {
          resolveRead = resolve;
        })
      ),
    );
    const pending = menu.showPanel("source");

    // Reopening for another piece invalidates the read in flight.
    menu.open({ cell: pieceCell(), x: 0, y: 0 });
    resolveRead({ ...SOURCE, name: "Stale" });
    await pending;

    expect(shows(menu)).not.toContain("Stale");
  });

  it("drops a source read that resolves after disconnection", async () => {
    let resolveRead!: (source: PieceSourceView) => void;
    let reads = 0;
    const menu = openMenu(
      pieceCell(() => {
        reads++;
        return reads === 1
          ? new Promise<PieceSourceView>((resolve) => {
            resolveRead = resolve;
          })
          : Promise.resolve(SOURCE);
      }),
    );
    const pending = menu.showPanel("source");

    menu.disconnectedCallback();
    resolveRead({ ...SOURCE, name: "Disconnected source" });
    await pending;

    expect(shows(menu)).toContain("Reading source…");
    expect(shows(menu)).not.toContain("Disconnected source");

    menu.connectedCallback();
    await menu.showPanel("source");

    expect(reads).toBe(2);
    expect(shows(menu)).toContain("the main file");
  });
});

describe("the origin and history panel", () => {
  it("names the origin and the facts behind it", async () => {
    const menu = openMenu();
    await menu.showPanel("origin");

    const rendered = shows(menu);
    expect(rendered).toContain("Deployment pattern");
    expect(rendered).toContain(
      "https://toolshed.test/api/patterns/recipe.tsx",
    );
    expect(rendered).toContain(
      patternRefLabel({
        identity: "pattern-identity-value",
        symbol: "default",
      }),
    );
    expect(rendered).toContain("/main.tsx");
    expect(rendered).toContain("of:fid1:piece");
    expect(rendered).toContain(SPACE);
    expect(rendered).toContain("No source changes have been recorded yet");
  });

  it("links the space to its default piece", async () => {
    const menu = openMenu();
    await menu.showPanel("origin");
    let target: unknown;
    const onNavigate = (event: Event) => {
      target = (event as CustomEvent).detail;
    };
    globalThis.addEventListener("cf-navigate", onNavigate);
    try {
      clickTestId(menu, "piece-source-space");
    } finally {
      globalThis.removeEventListener("cf-navigate", onNavigate);
    }

    expect(target).toEqual({ spaceDid: SPACE });
    expect(shows(menu)).toBe("");
  });

  it("keeps the dialog open when the space opens in a new tab", async () => {
    const menu = openMenu();
    await menu.showPanel("origin");
    let target: unknown;
    const onOpen = (event: Event) => {
      event.preventDefault();
      target = (event as CustomEvent).detail;
    };
    globalThis.addEventListener("cf-open-external", onOpen);
    try {
      clickTestId(menu, "piece-source-space", {
        preventDefault() {},
        stopPropagation() {},
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      } as unknown as MouseEvent);
    } finally {
      globalThis.removeEventListener("cf-open-external", onOpen);
    }

    expect(target).toEqual({ spaceDid: SPACE });
    expect(shows(menu)).toContain("Origin and history");
  });

  it("keeps embedded mode in the space link's native target", async () => {
    const menu = openMenu();
    await menu.showPanel("origin");

    const rendered = withLocation(
      `https://example.test/.embed/${SPACE}/of:fid1:piece`,
      () => shows(menu),
    );

    expect(rendered).toContain(`/.embed/${SPACE}`);
  });

  it("links a current Fabric piece origin to its own space", async () => {
    const originSpace = "did:key:z6Mk-origin-space" as const;
    const hash = "b".repeat(43);
    const menu = openMenu(pieceCell(() =>
      Promise.resolve({
        ...SOURCE,
        origin: {
          url: `cf:/${originSpace}/of:fid1:${hash}`,
          kind: "fabric-piece",
        },
      })
    ));
    await menu.showPanel("origin");
    expect(shows(menu)).toContain("piece-source-origin-current");
    let target: unknown;
    const onNavigate = (event: Event) => {
      target = (event as CustomEvent).detail;
    };
    globalThis.addEventListener("cf-navigate", onNavigate);
    try {
      clickTestId(menu, "piece-source-origin-current");
    } finally {
      globalThis.removeEventListener("cf-navigate", onNavigate);
    }

    expect(target).toEqual({
      spaceDid: originSpace,
      pieceId: `of:fid1:${hash}`,
    });
    expect(shows(menu)).toBe("");
  });

  it("leaves modified current-origin navigation to the native link", async () => {
    const hash = "b".repeat(43);
    const menu = openMenu(pieceCell(() =>
      Promise.resolve({
        ...SOURCE,
        origin: {
          url: `cf:/${SPACE}/of:fid1:${hash}`,
          kind: "fabric-piece",
        },
      })
    ));
    await menu.showPanel("origin");
    const link = withLocation(
      `https://example.test/.embed/${SPACE}/of:fid1:piece`,
      () => templateForTestId(menu, "piece-source-origin-current"),
    );
    const hrefIndex = link.strings.findIndex((part) => part.includes('href="'));
    expect(link.strings.join("")).toContain("<a");
    expect(link.values[hrefIndex]).toBe(
      `/.embed/${SPACE}/of:fid1:${hash}`,
    );
    let prevented = false;

    clickTestId(menu, "piece-source-origin-current", {
      ...testMouseEvent(),
      shiftKey: true,
      preventDefault: () => {
        prevented = true;
      },
    } as MouseEvent);

    expect(prevented).toBe(false);
    expect(shows(menu)).toContain("Origin and history");
  });

  it("links current Fabric slugs in named and current spaces", async () => {
    const cases = [
      {
        url: "cf:/common-knowledge/demo",
        target: { spaceName: "common-knowledge", pieceSlug: "demo" },
      },
      {
        url: "cf:demo",
        target: { spaceDid: SPACE, pieceSlug: "demo" },
      },
    ];
    for (const { url, target: expected } of cases) {
      const menu = openMenu(pieceCell(() =>
        Promise.resolve({
          ...SOURCE,
          origin: { url, kind: "fabric-piece" },
        })
      ));
      await menu.showPanel("origin");
      let target: unknown;
      const onNavigate = (event: Event) => {
        target = (event as CustomEvent).detail;
      };
      globalThis.addEventListener("cf-navigate", onNavigate);
      try {
        clickTestId(menu, "piece-source-origin-current");
      } finally {
        globalThis.removeEventListener("cf-navigate", onNavigate);
      }
      expect(target).toEqual(expected);
    }
  });

  it("leaves non-navigable current Fabric origins as text", async () => {
    const hash = "c".repeat(43);
    const urls = [
      "cf:/not a Fabric ref",
      `cf://source.example/${SPACE}/of:fid1:${hash}`,
      `cf:/${SPACE}/of:fid1:${hash}@${hash}`,
      `cf:/${SPACE}/of:fid1:${hash}/source.ts`,
      `cf:pattern:${hash}`,
    ];
    for (const url of urls) {
      const menu = openMenu(pieceCell(() =>
        Promise.resolve({
          ...SOURCE,
          origin: { url, kind: "fabric-piece" },
        })
      ));
      await menu.showPanel("origin");
      expect(shows(menu)).toContain(url);
      expect(shows(menu)).not.toContain("piece-source-origin-current");
    }

    const pattern = openMenu(pieceCell(() =>
      Promise.resolve({
        ...SOURCE,
        origin: {
          url: `cf:pattern:${hash}`,
          kind: "fabric-pattern",
        },
      })
    ));
    await pattern.showPanel("origin");
    expect(shows(pattern)).not.toContain("piece-source-origin-current");
  });

  it("names what following the origin last did on the panel", async () => {
    const at = Date.UTC(2026, 7, 3, 10, 30, 0);
    const menu = openMenu(
      pieceCell(() =>
        Promise.resolve({
          ...SOURCE,
          reconciliation: {
            outcome: "refused" as const,
            at,
            origin: SOURCE.origin!.url,
            reason: "incompatible-schema" as const,
            offered: { identity: "offered-identity", symbol: "default" },
          },
        })
      ),
    );
    await menu.showPanel("origin");

    const rendered = shows(menu);
    expect(rendered).toContain("New source refused");
    expect(rendered).toContain(formatTimestamp(at));
    expect(rendered).toContain("Reason:");
    expect(rendered).toContain("inputs or outputs do not match");
    expect(rendered).toContain(
      patternRefLabel({ identity: "offered-identity", symbol: "default" }),
    );
    expect(rendered).toContain("Update from the origin now");
    expect(rendered).toContain("Update, ignoring the compatibility check");
  });

  it("says nothing is known about an origin nothing has looked at", async () => {
    const menu = openMenu();
    await menu.showPanel("origin");

    const rendered = shows(menu);
    expect(rendered).toContain("Source updates");
    expect(rendered).toContain("Unknown");
    expect(rendered).toContain(
      "Nothing has looked for new source at this origin.",
    );
  });

  it("says nothing beyond the facts about a piece that is up to date", async () => {
    const menu = openMenu(
      pieceCell(() =>
        Promise.resolve({
          ...SOURCE,
          reconciliation: {
            outcome: "followed" as const,
            at: Date.UTC(2026, 7, 3, 10, 30, 0),
            origin: SOURCE.origin!.url,
            offered: SOURCE.pattern,
          },
        })
      ),
    );
    await menu.showPanel("origin");

    // Nothing is wrong with this piece, and a box with a button in it reads
    // as a problem to fix.
    const rendered = shows(menu);
    expect(rendered).toContain("Up to date");
    expect(rendered).not.toContain("piece-origin-follow-detail");
    expect(rendered).not.toContain("piece-origin-update-now");
    expect(rendered).not.toContain("piece-origin-force-update");
  });

  it("does not offer to override a refusal the piece cannot overrule", async () => {
    const menu = openMenu(
      pieceCell(() =>
        Promise.resolve({
          ...SOURCE,
          reconciliation: {
            outcome: "refused" as const,
            at: Date.UTC(2026, 7, 3, 10, 30, 0),
            origin: SOURCE.origin!.url,
            reason: "identity-mismatch" as const,
          },
        })
      ),
    );
    await menu.showPanel("origin");

    const rendered = shows(menu);
    expect(rendered).toContain("piece-origin-follow-detail");
    expect(rendered).not.toContain("piece-origin-force-update");
  });

  it("asks the origin for an update on request", async () => {
    const actions: unknown[] = [];
    const menu = openMenu(pieceCell(
      () =>
        Promise.resolve({
          ...SOURCE,
          reconciliation: {
            outcome: "refused" as const,
            at: 1,
            origin: SOURCE.origin!.url,
            reason: "incompatible-schema" as const,
          },
        }),
      {
        update: (_pieceId, _space, action) => {
          actions.push(action);
          return Promise.resolve({ source: SOURCE });
        },
      },
    ));
    await menu.showPanel("origin");

    clickTestId(menu, "piece-origin-update-now");
    await settled();

    expect(actions).toEqual([{ kind: "adopt" }]);
  });

  it("confirms the incompatibility itself when told to ignore it", async () => {
    const calls: unknown[] = [];
    const menu = openMenu(pieceCell(
      () =>
        Promise.resolve({
          ...SOURCE,
          reconciliation: {
            outcome: "refused" as const,
            at: 1,
            origin: SOURCE.origin!.url,
            reason: "incompatible-schema" as const,
          },
        }),
      {
        update: (_pieceId, _space, action, options) => {
          calls.push({ action, options });
          // The first attempt is refused; the second carries the token back.
          return Promise.resolve(
            calls.length === 1
              ? {
                source: SOURCE,
                compatibilityWarning: "the input schema changed",
                confirmationToken: "token-1",
              }
              : { source: SOURCE },
          );
        },
      },
    ));
    await menu.showPanel("origin");

    clickTestId(menu, "piece-origin-force-update");
    await settled();

    expect(calls).toEqual([
      { action: { kind: "adopt" }, options: { scope: "space" } },
      {
        action: { kind: "adopt" },
        options: { confirmationToken: "token-1", scope: "space" },
      },
    ]);
    // The warning is spent rather than left on the panel to answer again.
    expect(shows(menu)).not.toContain("piece-source-warning");
  });

  it("puts away a warning the panel raised when it is declined", async () => {
    const calls: unknown[] = [];
    const menu = openMenu(pieceCell(
      () =>
        Promise.resolve({
          ...SOURCE,
          reconciliation: {
            outcome: "refused" as const,
            at: 1,
            origin: SOURCE.origin!.url,
            reason: "incompatible-schema" as const,
          },
        }),
      {
        update: (_pieceId, _space, action, options) => {
          calls.push({ action, options });
          return Promise.resolve({
            source: SOURCE,
            compatibilityWarning: "the input schema changed",
            confirmationToken: "token-1",
          });
        },
      },
    ));
    await menu.showPanel("origin");

    clickTestId(menu, "piece-origin-update-now");
    await settled();
    expect(shows(menu)).toContain("piece-source-warning");

    clickTestId(menu, "piece-source-warning-cancel");

    // Declining leaves the piece as it was, and asks nothing further of the
    // runtime: the one attempt that raised the warning is all there was.
    const rendered = shows(menu);
    expect(rendered).not.toContain("piece-source-warning");
    expect(rendered).toContain("piece-panel-origin");
    expect(calls).toEqual([
      { action: { kind: "adopt" }, options: { scope: "space" } },
    ]);
  });

  it("does not offer to ignore a check that is not what refused it", async () => {
    const menu = openMenu(
      pieceCell(() =>
        Promise.resolve({
          ...SOURCE,
          reconciliation: {
            outcome: "refused" as const,
            at: 1,
            origin: SOURCE.origin!.url,
            reason: "source-invalid" as const,
          },
        })
      ),
    );
    await menu.showPanel("origin");

    const rendered = shows(menu);
    expect(rendered).toContain("piece-origin-update-now");
    expect(rendered).not.toContain("piece-origin-force-update");
  });

  it("shows what a failed update concluded about the origin", async () => {
    // A failed attempt still records a state of the piece, so the panel reads
    // the piece again rather than going on showing what it knew before.
    let reads = 0;
    const menu = openMenu(pieceCell(
      () => {
        reads++;
        return Promise.resolve(
          reads === 1 ? SOURCE : {
            ...SOURCE,
            reconciliation: {
              outcome: "unreachable" as const,
              at: 1,
              origin: SOURCE.origin!.url,
              detail: "the origin answered 503",
            },
          },
        );
      },
      { update: () => Promise.reject(new Error("nothing answers there")) },
    ));
    await menu.showPanel("origin");
    expect(shows(menu)).toContain("Unknown");

    clickTestId(menu, "piece-origin-update-now");
    await settled();

    const rendered = shows(menu);
    expect(rendered).toContain("Could not reach the origin");
    expect(rendered).toContain("the origin answered 503");
    expect(rendered).toContain("nothing answers there");
  });

  it("says a piece carrying an unfollowable origin is not detached", async () => {
    const menu = openMenu(
      pieceCell(() =>
        Promise.resolve({
          ...SOURCE,
          origin: undefined,
          unusableOrigin: {
            recorded: "../recipes/main.tsx",
            reason: "../recipes/main.tsx is not an absolute URL",
          },
        })
      ),
    );
    await menu.showPanel("origin");

    const rendered = shows(menu);
    expect(rendered).toContain("Origin cannot be followed");
    expect(rendered).toContain("../recipes/main.tsx");
    // Detaching is the repair, so the action stays available.
    expect(rendered).toContain("piece-origin-detach-source");
  });

  it("asks for an origin in a dialog over the panel", async () => {
    const actions: unknown[] = [];
    const menu = openMenu(pieceCell(undefined, {
      update: (_pieceId, _space, action) => {
        actions.push(action);
        return Promise.resolve({ source: SOURCE });
      },
    }));
    await menu.showPanel("origin");
    expect(shows(menu)).not.toContain("piece-origin-entry");

    clickTestId(menu, "piece-origin-enter-source");
    const opened = shows(menu);
    // A dialog of its own, over the panel, which stays rendered behind it.
    expect(opened).toContain("piece-origin-entry");
    expect(opened).toContain("Follow another source");
    expect(opened).toContain("piece-panel-origin");
    // The panel's own content keeps its place rather than being pushed down.
    expect(opened).toContain("Source history");

    eventHandler(menu, 'test-id="piece-origin-url"', "input")({
      currentTarget: { value: "  https://example.test/other.tsx  " },
    } as unknown as Event);
    let prevented = false;
    eventHandler(menu, 'test-id="piece-origin-entry"', "submit")({
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as Event);
    await settled();

    expect(prevented).toBe(true);
    expect(actions).toEqual([
      { kind: "repoint", url: "https://example.test/other.tsx" },
    ]);
    expect(shows(menu)).not.toContain("piece-origin-entry");
  });

  it("keeps a typed origin in the dialog when following it fails", async () => {
    const menu = openMenu(pieceCell(undefined, {
      update: () => Promise.reject(new Error("nothing answers there")),
    }));
    await menu.showPanel("origin");
    clickTestId(menu, "piece-origin-enter-source");
    eventHandler(menu, 'test-id="piece-origin-url"', "input")({
      currentTarget: { value: "https://example.test/missing.tsx" },
    } as unknown as Event);
    eventHandler(menu, 'test-id="piece-origin-entry"', "submit")({
      preventDefault: () => {},
    } as unknown as Event);
    await settled();

    const rendered = shows(menu);
    expect(rendered).toContain("Could not follow that source");
    expect(rendered).toContain("nothing answers there");
    expect(rendered).toContain("piece-origin-entry");
    expect(rendered).toContain("https://example.test/missing.tsx");
    // The failure is the dialog's to report; the panel does not repeat it.
    expect(rendered).not.toContain("Could not change this piece's source");
  });

  it("dismisses the origin dialog without touching the panel", async () => {
    const menu = openMenu();
    await menu.showPanel("origin");
    clickTestId(menu, "piece-origin-enter-source");
    eventHandler(menu, 'test-id="piece-origin-url"', "input")({
      currentTarget: { value: "https://example.test/other.tsx" },
    } as unknown as Event);

    clickTestId(menu, "piece-origin-entry-cancel");

    const rendered = shows(menu);
    expect(rendered).not.toContain("piece-origin-entry");
    expect(rendered).toContain("piece-panel-origin");
    // Reopening starts from an empty field rather than the abandoned one.
    clickTestId(menu, "piece-origin-enter-source");
    expect(shows(menu)).not.toContain("https://example.test/other.tsx");
  });

  it("offers to follow an incompatible typed origin anyway", async () => {
    const calls: unknown[] = [];
    const menu = openMenu(pieceCell(undefined, {
      update: (_pieceId, _space, action, options) => {
        calls.push({ action, options });
        return Promise.resolve(
          calls.length === 1
            ? {
              source: SOURCE,
              compatibilityWarning: "the input schema changed",
              confirmationToken: "token-1",
            }
            : { source: SOURCE },
        );
      },
    }));
    await menu.showPanel("origin");
    clickTestId(menu, "piece-origin-enter-source");
    eventHandler(menu, 'test-id="piece-origin-url"', "input")({
      currentTarget: { value: "https://example.test/other.tsx" },
    } as unknown as Event);
    const submit = () =>
      eventHandler(menu, 'test-id="piece-origin-entry"', "submit")({
        preventDefault: () => {},
      } as unknown as Event);
    submit();
    await settled();

    // The question was asked here, so it is answered here: the dialog stays
    // up, states the objection, and its submit becomes the override.
    const warned = shows(menu);
    expect(warned).toContain("piece-origin-entry");
    expect(warned).toContain("piece-origin-entry-warning");
    expect(warned).toContain("the input schema changed");
    expect(warned).toContain("Follow this source anyway");
    expect(warned).not.toContain("piece-source-warning");

    submit();
    await settled();

    expect(calls).toEqual([
      {
        action: { kind: "repoint", url: "https://example.test/other.tsx" },
        options: { scope: "space" },
      },
      {
        action: { kind: "repoint", url: "https://example.test/other.tsx" },
        options: { confirmationToken: "token-1", scope: "space" },
      },
    ]);
    expect(shows(menu)).not.toContain("piece-origin-entry");
  });

  it("does nothing when the origin dialog is submitted empty", async () => {
    const actions: unknown[] = [];
    const menu = openMenu(pieceCell(undefined, {
      update: (_pieceId, _space, action) => {
        actions.push(action);
        return Promise.resolve({ source: SOURCE });
      },
    }));
    await menu.showPanel("origin");
    clickTestId(menu, "piece-origin-enter-source");

    // The submit button is disabled while the field is empty, but Enter in
    // the field submits the form regardless.
    eventHandler(menu, 'test-id="piece-origin-entry"', "submit")({
      preventDefault: () => {},
    } as unknown as Event);
    await settled();

    expect(actions).toEqual([]);
    expect(shows(menu)).toContain("piece-origin-entry");
  });

  it("dismisses the origin dialog when its backdrop is clicked", async () => {
    const menu = openMenu();
    await menu.showPanel("origin");
    clickTestId(menu, "piece-origin-enter-source");
    expect(shows(menu)).toContain("piece-origin-entry");

    eventHandler(menu, 'class="backdrop dimmed stacked"', "click")(
      {} as unknown as Event,
    );

    const rendered = shows(menu);
    expect(rendered).not.toContain("piece-origin-entry");
    expect(rendered).toContain("piece-panel-origin");
  });

  it("takes a forced update that turns out to need no override", async () => {
    const calls: unknown[] = [];
    const menu = openMenu(pieceCell(
      () =>
        Promise.resolve({
          ...SOURCE,
          reconciliation: {
            outcome: "refused" as const,
            at: 1,
            origin: SOURCE.origin!.url,
            reason: "incompatible-schema" as const,
          },
        }),
      {
        update: (_pieceId, _space, action, options) => {
          calls.push({ action, options });
          return Promise.resolve({ source: SOURCE });
        },
      },
    ));
    await menu.showPanel("origin");

    clickTestId(menu, "piece-origin-force-update");
    await settled();

    // The origin was resolved again and what it offers now is compatible, so
    // there is no warning to confirm and the one attempt is the whole of it.
    expect(calls).toEqual([
      { action: { kind: "adopt" }, options: { scope: "space" } },
    ]);
  });

  it("abandons a failed attempt rather than passing it to the panel", async () => {
    const menu = openMenu(pieceCell(undefined, {
      update: () => Promise.reject(new Error("nothing answers there")),
    }));
    await menu.showPanel("origin");
    clickTestId(menu, "piece-origin-enter-source");
    eventHandler(menu, 'test-id="piece-origin-url"', "input")({
      currentTarget: { value: "https://example.test/missing.tsx" },
    } as unknown as Event);
    eventHandler(menu, 'test-id="piece-origin-entry"', "submit")({
      preventDefault: () => {},
    } as unknown as Event);
    await settled();
    expect(shows(menu)).toContain("nothing answers there");

    clickTestId(menu, "piece-origin-entry-cancel");

    // The question it answered is gone, so the answer goes with it.
    const rendered = shows(menu);
    expect(rendered).not.toContain("nothing answers there");
    expect(rendered).not.toContain("Could not change this piece's source");
    expect(rendered).toContain("piece-panel-origin");
  });

  it("drops the answer to a URL that has since been edited", async () => {
    const menu = openMenu(pieceCell(undefined, {
      update: () => Promise.reject(new Error("nothing answers there")),
    }));
    await menu.showPanel("origin");
    clickTestId(menu, "piece-origin-enter-source");
    const type = (value: string) =>
      eventHandler(menu, 'test-id="piece-origin-url"', "input")({
        currentTarget: { value },
      } as unknown as Event);
    type("https://example.test/missing.tsx");
    eventHandler(menu, 'test-id="piece-origin-entry"', "submit")({
      preventDefault: () => {},
    } as unknown as Event);
    await settled();

    type("https://example.test/another.tsx");

    // The failure was about the URL that was there before.
    expect(shows(menu)).not.toContain("nothing answers there");
  });

  it("offers the origin field to a detached piece", async () => {
    const menu = openMenu(
      pieceCell(() => Promise.resolve({ ...SOURCE, origin: undefined })),
    );
    await menu.showPanel("origin");

    const rendered = shows(menu);
    expect(rendered).toContain("piece-origin-enter-source");
    expect(rendered).not.toContain("piece-origin-detach-source");
  });

  it("says a piece with no origin is detached", async () => {
    const menu = openMenu(
      pieceCell(() => Promise.resolve({ ...SOURCE, origin: undefined })),
    );
    await menu.showPanel("origin");

    expect(shows(menu)).toContain("Detached");
  });

  it("shows the recorded form of an origin that was normalized", async () => {
    const menu = openMenu(
      pieceCell(() =>
        Promise.resolve({
          ...SOURCE,
          origin: {
            url: "https://toolshed.test/api/patterns/system/home.tsx",
            kind: "system",
            recorded: "/api/patterns/system/home.tsx",
          },
        })
      ),
    );
    await menu.showPanel("origin");

    const rendered = shows(menu);
    expect(rendered).toContain("Recorded as");
    expect(rendered).toContain("/api/patterns/system/home.tsx");
  });

  it("shows a setup identity only when it differs from the running one", async () => {
    const same = openMenu(
      pieceCell(() =>
        Promise.resolve({ ...SOURCE, setupPattern: SOURCE.pattern })
      ),
    );
    await same.showPanel("origin");
    expect(shows(same)).not.toContain("Setup applied for");

    const differs = openMenu(
      pieceCell(() =>
        Promise.resolve({
          ...SOURCE,
          setupPattern: { identity: "older-identity", symbol: "default" },
        })
      ),
    );
    await differs.showPanel("origin");
    expect(shows(differs)).toContain("Setup applied for");
  });

  it("shows a displaced pattern with the time it was replaced", async () => {
    const displacedAt = Date.UTC(2026, 6, 24, 12, 0, 0);
    const menu = openMenu(
      pieceCell(() =>
        Promise.resolve({
          ...SOURCE,
          displacedPattern: {
            identity: "displaced-identity",
            symbol: "default",
            displacedAt,
          },
          repository: "https://github.com/example/recipes",
        })
      ),
    );
    await menu.showPanel("origin");

    const rendered = shows(menu);
    expect(rendered).toContain("Previously ran");
    expect(rendered).toContain(formatTimestamp(displacedAt));
    expect(rendered).toContain("Repository");
    expect(rendered).toContain("https://github.com/example/recipes");
  });

  it("offers an exact version and its former origin on historical entries", async () => {
    const detachedAt = Date.UTC(2026, 6, 27, 12, 0, 0);
    const historical = {
      ...SOURCE,
      origin: undefined,
      currentRevisionId: "detached",
      history: [
        {
          revisionId: "followed",
          timestamp: detachedAt - 1_000,
          pattern: SOURCE.pattern!,
          origin: SOURCE.origin,
          operation: "baseline" as const,
        },
        {
          revisionId: "detached",
          timestamp: detachedAt,
          pattern: SOURCE.pattern!,
          operation: "detach" as const,
        },
      ],
    };
    const menu = openMenu(pieceCell(() => Promise.resolve(historical)));
    await menu.showPanel("origin");

    const rendered = shows(menu);
    expect(rendered).toContain("Stopped following source · Current");
    expect(rendered).toContain("Use this version");
    expect(rendered).toContain("Follow this source again");
    expect(rendered).toContain("piece-source-restore");
    expect(rendered).toContain("piece-source-follow");
  });

  it("describes restoring an immutable origin as using a pin", async () => {
    const historical = {
      ...SOURCE,
      origin: undefined,
      currentRevisionId: "detached",
      history: [
        {
          revisionId: "pinned",
          timestamp: Date.UTC(2026, 6, 27, 11, 0, 0),
          pattern: SOURCE.pattern!,
          origin: {
            url: "cf:pattern:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            kind: "fabric-pattern" as const,
          },
          operation: "baseline" as const,
        },
        {
          revisionId: "detached",
          timestamp: Date.UTC(2026, 6, 27, 12, 0, 0),
          pattern: SOURCE.pattern!,
          operation: "detach" as const,
        },
      ],
    };
    const menu = openMenu(pieceCell(() => Promise.resolve(historical)));
    await menu.showPanel("origin");

    expect(shows(menu)).toContain("Use this pinned source again");
  });

  it("stops following through the piece runtime and refreshes the panel", async () => {
    const requests: unknown[] = [];
    const detached: PieceSourceView = {
      ...SOURCE,
      origin: undefined,
      currentRevisionId: "detached",
      history: [{
        revisionId: "detached",
        timestamp: Date.UTC(2026, 6, 27, 12, 0, 0),
        pattern: SOURCE.pattern!,
        operation: "detach",
      }],
    };
    const menu = openMenu(pieceCell(
      () => Promise.resolve(SOURCE),
      {
        update: (pieceId, space, action, options) => {
          requests.push({ pieceId, space, action, options });
          return Promise.resolve({ source: detached });
        },
      },
    ));
    await menu.showPanel("origin");
    await menu.changeSource({ kind: "detach" });

    expect(requests).toEqual([{
      pieceId: "of:fid1:piece",
      space: SPACE,
      action: { kind: "detach" },
      options: { scope: "space" },
    }]);
    expect(shows(menu)).toContain("Detached");
    expect(shows(menu)).toContain("Stopped following source · Current");
  });

  it("re-enables source actions after a disconnected action settles", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sourceRead = Promise.withResolvers<PieceSourceView>();
    let updates = 0;
    let reads = 0;
    const updated = { ...SOURCE, name: "Updated after reconnect" };
    const menu = openMenu(pieceCell(
      () => {
        reads++;
        return sourceRead.promise;
      },
      {
        update: async () => {
          updates++;
          if (updates === 1) {
            entered.resolve();
            await release.promise;
          }
          return { source: updates === 1 ? updated : SOURCE };
        },
      },
    ));
    const staleRead = menu.showPanel("origin");

    const first = menu.changeSource({ kind: "detach" });
    await entered.promise;
    menu.disconnectedCallback();
    menu.connectedCallback();
    release.resolve();
    await first;
    expect(shows(menu)).toContain("Updated after reconnect");
    sourceRead.resolve(SOURCE);
    await staleRead;
    expect(shows(menu)).toContain("Updated after reconnect");
    expect(reads).toBe(1);
    await menu.changeSource({ kind: "detach" });

    expect(updates).toBe(2);
  });

  it("runs detach from both menu affordances", async () => {
    const requests: unknown[] = [];
    const detached = { ...SOURCE, origin: undefined };
    const menu = openMenu(pieceCell(
      () => Promise.resolve(SOURCE),
      {
        update: (_pieceId, _space, action) => {
          requests.push(action);
          return Promise.resolve({ source: detached });
        },
      },
    ));
    await menu.showPanel("origin");
    (menu as unknown as { panel?: undefined }).panel = undefined;
    await clickTestId(menu, "piece-menu-detach-source");

    menu.open({
      cell: pieceCell(
        () => Promise.resolve(SOURCE),
        {
          update: (_pieceId, _space, action) => {
            requests.push(action);
            return Promise.resolve({ source: detached });
          },
        },
      ),
      x: 0,
      y: 0,
    });
    await menu.showPanel("origin");
    await clickTestId(menu, "piece-origin-detach-source");

    expect(requests).toEqual([{ kind: "detach" }, { kind: "detach" }]);
  });

  it("distinguishes a saved change from a later refresh failure", async () => {
    const menu = openMenu(pieceCell(
      () => Promise.resolve(SOURCE),
      {
        update: () =>
          Promise.resolve({
            source: { ...SOURCE, origin: undefined },
            executionWarning: "result pull failed",
          }),
      },
    ));
    await menu.showPanel("origin");
    await menu.changeSource({ kind: "detach" });

    expect(shows(menu)).toContain("The source change was saved");
    expect(shows(menu)).toContain("result pull failed");
    expect(shows(menu)).not.toContain("Could not change this piece's source");
  });

  it("requires a second explicit action for an incompatible source", async () => {
    const calls: unknown[] = [];
    const action = { kind: "restore", revisionId: "older" } as const;
    const menu = openMenu(pieceCell(
      () => Promise.resolve(SOURCE),
      {
        update: (_pieceId, _space, requested, options) => {
          calls.push({ requested, options });
          return Promise.resolve(
            (options as { confirmationToken?: string }).confirmationToken
              ? { source: { ...SOURCE, origin: undefined } }
              : {
                source: SOURCE,
                compatibilityWarning: "result schema narrowed",
                confirmationToken: "confirm-older",
              },
          );
        },
      },
    ));
    await menu.showPanel("origin");
    await menu.changeSource(action);

    expect(shows(menu)).toContain("result schema narrowed");
    expect(shows(menu)).toContain("Use it anyway");

    await menu.changeSource(action, "confirm-older");
    expect(calls).toEqual([
      { requested: action, options: { scope: "space" } },
      {
        requested: action,
        options: { confirmationToken: "confirm-older", scope: "space" },
      },
    ]);
    expect(shows(menu)).not.toContain("result schema narrowed");
  });

  it("reports a runtime warning that omitted its confirmation token", async () => {
    const menu = openMenu(pieceCell(
      () => Promise.resolve(SOURCE),
      {
        update: () =>
          Promise.resolve({
            source: SOURCE,
            compatibilityWarning: "result schema narrowed",
          }),
      },
    ));
    await menu.showPanel("origin");
    await menu.changeSource({ kind: "restore", revisionId: "older" });

    expect(shows(menu)).toContain(
      "the runtime did not provide a compatibility confirmation",
    );
    expect(shows(menu)).not.toContain("Use it anyway");
  });

  it("cancels an incompatibility warning from its visible action", async () => {
    const menu = openMenu(pieceCell(
      () => Promise.resolve(SOURCE),
      {
        update: () =>
          Promise.resolve({
            source: SOURCE,
            compatibilityWarning: "result schema narrowed",
            confirmationToken: "confirm-older",
          }),
      },
    ));
    await menu.showPanel("origin");
    await menu.changeSource({ kind: "restore", revisionId: "older" });
    expect(shows(menu)).toContain("Use it anyway");

    clickTestId(menu, "piece-source-warning-cancel");

    expect(shows(menu)).not.toContain("Use it anyway");
    expect(shows(menu)).not.toContain("result schema narrowed");
  });

  it("discards a consumed confirmation after the confirmed change fails", async () => {
    const action = { kind: "restore", revisionId: "older" } as const;
    let nextConfirmation = 1;
    const menu = openMenu(pieceCell(
      () => Promise.resolve(SOURCE),
      {
        update: (_pieceId, _space, _requested, options) => {
          const confirmation = (options as { confirmationToken?: string })
            .confirmationToken;
          if (confirmation !== undefined) {
            return Promise.reject(
              new Error(
                "the piece source changed after compatibility was checked",
              ),
            );
          }
          return Promise.resolve({
            source: SOURCE,
            compatibilityWarning: "result schema narrowed",
            confirmationToken: `confirm-${nextConfirmation++}`,
          });
        },
      },
    ));
    await menu.showPanel("origin");
    await menu.changeSource(action);
    expect(shows(menu)).toContain("Use it anyway");

    await menu.changeSource(action, "confirm-1");

    expect(shows(menu)).toContain(
      "the piece source changed after compatibility was checked",
    );
    expect(shows(menu)).not.toContain("Use it anyway");
    expect(shows(menu)).not.toContain("result schema narrowed");

    await menu.changeSource(action);
    expect(shows(menu)).toContain("Use it anyway");
    expect(shows(menu)).toContain("result schema narrowed");
  });

  it("discards the previous confirmation when a new action fails", async () => {
    const firstAction = { kind: "restore", revisionId: "older" } as const;
    const secondAction = { kind: "detach" } as const;
    let call = 0;
    const menu = openMenu(pieceCell(
      () => Promise.resolve(SOURCE),
      {
        update: () => {
          if (call++ === 0) {
            return Promise.resolve({
              source: SOURCE,
              compatibilityWarning: "result schema narrowed",
              confirmationToken: "confirm-older",
            });
          }
          return Promise.reject(new Error("source change failed"));
        },
      },
    ));
    await menu.showPanel("origin");
    await menu.changeSource(firstAction);
    expect(shows(menu)).toContain("Use it anyway");

    await menu.changeSource(secondAction);

    expect(shows(menu)).toContain("source change failed");
    expect(shows(menu)).not.toContain("Use it anyway");
    expect(shows(menu)).not.toContain("result schema narrowed");
  });

  it("discards a confirmation before an aborted confirmed request", async () => {
    const action = { kind: "restore", revisionId: "older" } as const;
    let aborted = false;
    let call = 0;
    const menu = openMenu(pieceCell(
      () => Promise.resolve(SOURCE),
      {
        aborted: () => aborted,
        update: () => {
          if (call++ === 0) {
            return Promise.resolve({
              source: SOURCE,
              compatibilityWarning: "result schema narrowed",
              confirmationToken: "confirm-older",
            });
          }
          aborted = true;
          return Promise.reject(new DOMException("aborted", "AbortError"));
        },
      },
    ));
    await menu.showPanel("origin");
    await menu.changeSource(action);
    expect(shows(menu)).toContain("Use it anyway");

    await menu.changeSource(action, "confirm-older");

    expect(shows(menu)).not.toContain("Use it anyway");
    expect(shows(menu)).not.toContain("result schema narrowed");
    expect(shows(menu)).not.toContain("Could not change this piece's source");
  });

  it("ignores an action without a piece and while another action is pending", async () => {
    const unopened = newMenu();
    await unopened.changeSource({ kind: "detach" });

    let finish!: (value: { source: PieceSourceView }) => void;
    let updates = 0;
    const menu = openMenu(pieceCell(
      () => Promise.resolve(SOURCE),
      {
        update: () => {
          updates++;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    ));
    await menu.showPanel("origin");
    const first = menu.changeSource({ kind: "detach" });
    await Promise.resolve();
    await menu.changeSource({ kind: "detach" });
    expect(updates).toBe(1);
    finish({ source: { ...SOURCE, origin: undefined } });
    await first;
  });

  it("drops a source action response after the menu is reopened", async () => {
    let finish!: (value: { source: PieceSourceView }) => void;
    const menu = openMenu(pieceCell(
      () => Promise.resolve(SOURCE),
      {
        update: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    ));
    await menu.showPanel("origin");
    const action = menu.changeSource({ kind: "detach" });
    await Promise.resolve();

    menu.open({
      cell: pieceCell(() =>
        Promise.resolve({ ...SOURCE, name: "Replacement" })
      ),
      x: 0,
      y: 0,
    });
    finish({ source: { ...SOURCE, name: "Stale" } });
    await action;
    await menu.showPanel("origin");

    expect(shows(menu)).toContain("Replacement");
    expect(shows(menu)).not.toContain("Stale");
  });
});

describe("source history actions", () => {
  const historySource: PieceSourceView = {
    ...SOURCE,
    origin: undefined,
    currentRevisionId: "current",
    history: [
      {
        revisionId: "older",
        timestamp: 1,
        pattern: SOURCE.pattern!,
        origin: SOURCE.origin,
        operation: "baseline",
      },
      {
        revisionId: "current",
        timestamp: 2,
        pattern: SOURCE.pattern!,
        operation: "detach",
      },
    ],
  };

  it("runs restore and follow from their history buttons", async () => {
    const actions: unknown[] = [];
    const menu = openMenu(pieceCell(
      () => Promise.resolve(historySource),
      {
        update: (_pieceId, _space, action) => {
          actions.push(action);
          return Promise.resolve({ source: historySource });
        },
      },
    ));
    await menu.showPanel("origin");

    await clickTestId(menu, "piece-source-restore");
    await clickTestId(menu, "piece-source-follow");

    expect(actions).toEqual([
      { kind: "restore", revisionId: "older" },
      { kind: "follow", revisionId: "older" },
    ]);
  });

  it("labels every source-history operation", async () => {
    const operations = [
      ["create", "Created from source"],
      ["edit", "Direct source edit"],
      ["origin-update", "Source update"],
      ["revert", "Restored source version"],
      ["follow", "Followed source"],
      ["repoint", "Followed earlier source"],
    ] as const;
    const menu = openMenu(pieceCell(() =>
      Promise.resolve({
        ...historySource,
        history: operations.map(([operation], index) => ({
          revisionId: `revision-${index}`,
          timestamp: index,
          pattern: SOURCE.pattern!,
          operation,
        })),
      })
    ));
    await menu.showPanel("origin");

    const rendered = shows(menu);
    for (const [, label] of operations) expect(rendered).toContain(label);
  });

  it("links a Fabric piece origin to that piece in its space", async () => {
    const hash = "a".repeat(43);
    const menu = openMenu(pieceCell(() =>
      Promise.resolve({
        ...historySource,
        history: [{
          revisionId: "fabric-piece",
          timestamp: 1,
          pattern: SOURCE.pattern!,
          origin: {
            url: `cf:/${SPACE}/of:fid1:${hash}`,
            kind: "fabric-piece",
          },
          operation: "baseline",
        }],
      })
    ));
    await menu.showPanel("origin");
    let target: unknown;
    const onNavigate = (event: Event) => {
      target = (event as CustomEvent).detail;
    };
    globalThis.addEventListener("cf-navigate", onNavigate);
    try {
      clickTestId(menu, "piece-source-origin-fabric-piece");
    } finally {
      globalThis.removeEventListener("cf-navigate", onNavigate);
    }

    expect(target).toEqual({
      spaceDid: SPACE,
      pieceId: `of:fid1:${hash}`,
    });
    expect(shows(menu)).toBe("");
  });

  it("keeps a history origin as recorded and links to where it resolves", async () => {
    const menu = openMenu(pieceCell(() =>
      Promise.resolve({
        ...historySource,
        history: [{
          revisionId: "system",
          timestamp: 1,
          pattern: SOURCE.pattern!,
          origin: {
            url: "https://toolshed.test/api/patterns/system/home.tsx",
            kind: "system",
            recorded: "system:system/home.tsx",
          },
          operation: "baseline",
        }],
      })
    ));
    await menu.showPanel("origin");

    const rendered = shows(menu);
    expect(rendered).toContain("<code>system:system/home.tsx</code>");
    expect(rendered).toContain(
      'href="https://toolshed.test/api/patterns/system/home.tsx"',
    );
    expect(rendered).toContain(">open</a>");
  });

  it("offers the route only where it is not already the string on show", async () => {
    const menu = openMenu(pieceCell(() =>
      Promise.resolve({
        ...historySource,
        history: [
          {
            revisionId: "recorded",
            timestamp: 1,
            pattern: SOURCE.pattern!,
            origin: {
              url: "https://toolshed.test/api/patterns/system/home.tsx",
              kind: "system" as const,
              recorded: "system:system/home.tsx",
            },
            operation: "baseline" as const,
          },
          {
            revisionId: "canonical",
            timestamp: 2,
            pattern: SOURCE.pattern!,
            origin: SOURCE.origin,
            operation: "repoint" as const,
          },
        ],
      })
    ));
    await menu.showPanel("origin");

    // Both entries name their origin; only the one whose recorded form differs
    // from the route it resolves to carries a link to that route.
    const rendered = shows(menu);
    expect(rendered).toContain("<code>system:system/home.tsx</code>");
    expect(rendered).toContain(
      "<code>https://toolshed.test/api/patterns/recipe.tsx</code>",
    );
    expect(rendered.split(">open</a>").length - 1).toBe(1);
  });

  it("offers no route for an origin resolving to a fabric reference", async () => {
    const menu = openMenu(pieceCell(() =>
      Promise.resolve({
        ...historySource,
        history: [{
          revisionId: "pinned",
          timestamp: 1,
          pattern: SOURCE.pattern!,
          origin: {
            url: `cf:pattern:${"A".repeat(43)}`,
            kind: "fabric-pattern" as const,
            recorded: "cf:pattern:an-earlier-spelling",
          },
          operation: "baseline" as const,
        }],
      })
    ));
    await menu.showPanel("origin");

    // Nothing a browser can open resolves from a fabric reference, so the
    // entry names what the piece recorded and stops there.
    const rendered = shows(menu);
    expect(rendered).toContain("<code>cf:pattern:an-earlier-spelling</code>");
    expect(rendered).not.toContain(">open</a>");
  });

  it("shows the exact retained source for a history entry", async () => {
    const requests: unknown[] = [];
    const menu = openMenu(pieceCell(
      () =>
        Promise.resolve({
          ...historySource,
          history: [{
            revisionId: "older",
            timestamp: 1,
            pattern: SOURCE.pattern!,
            operation: "baseline",
          }],
        }),
      {
        readRevision: (pieceId, space, revisionId) => {
          requests.push({ pieceId, space, revisionId });
          return Promise.resolve({
            pattern: SOURCE.pattern!,
            files: [{ name: "/main.tsx", contents: "the older source" }],
          });
        },
      },
    ));
    await menu.showPanel("origin");

    expect(shows(menu)).toContain("view source");
    await clickTestId(menu, "piece-source-view-older");

    expect(requests).toEqual([{
      pieceId: "of:fid1:piece",
      space: SPACE,
      revisionId: "older",
    }]);
    expect(shows(menu)).toContain("the older source");
    expect(shows(menu)).not.toContain("the main file");
  });

  it("names the revision's pattern whole in the panel subject", async () => {
    const menu = openMenu(pieceCell(
      () =>
        Promise.resolve({
          ...historySource,
          history: [{
            revisionId: "older",
            timestamp: 1,
            pattern: SOURCE.pattern!,
            operation: "baseline",
          }],
        }),
      {
        readRevision: () =>
          Promise.resolve({
            pattern: SOURCE.pattern!,
            files: [{ name: "/main.tsx", contents: "the older source" }],
          }),
      },
    ));
    await menu.showPanel("origin");
    await clickTestId(menu, "piece-source-view-older");

    expect(shows(menu)).toContain(
      'Pattern pattern-identity-value (export symbol "default")',
    );
  });

  it("starts one revision read for rapid repeated activations", async () => {
    let finish!: (source: PieceSourceRevisionSourceView) => void;
    let reads = 0;
    const menu = openMenu(pieceCell(
      () => Promise.resolve(historySource),
      {
        readRevision: () => {
          reads++;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    ));
    await menu.showPanel("origin");
    const viewSource = clickHandler(menu, "piece-source-view-older");

    const first = viewSource(testMouseEvent()) as Promise<void>;
    const second = viewSource(testMouseEvent()) as Promise<void>;

    expect(reads).toBe(1);
    expect(liveRegionText(menu)).toContain("Reading source revision");
    finish({
      pattern: SOURCE.pattern!,
      files: [{ name: "/main.tsx", contents: "one retained read" }],
    });
    await Promise.all([first, second]);

    expect(shows(menu)).toContain("one retained read");
    expect(liveRegionText(menu)).toContain(
      "Source revision loaded with 1 file",
    );
  });

  it("does not let an older revision read affect a newer one", async () => {
    const finishes: Array<
      (source: PieceSourceRevisionSourceView) => void
    > = [];
    let reads = 0;
    const menu = openMenu(pieceCell(
      () => Promise.resolve(historySource),
      {
        readRevision: () => {
          reads++;
          return new Promise((resolve) => finishes.push(resolve));
        },
      },
    ));
    await menu.showPanel("origin");
    const first = clickHandler(menu, "piece-source-view-older")(
      testMouseEvent(),
    ) as Promise<void>;

    await menu.showPanel("origin");
    const secondHandler = clickHandler(menu, "piece-source-view-older");
    const second = secondHandler(testMouseEvent()) as Promise<void>;
    finishes[0]({
      pattern: SOURCE.pattern!,
      files: [{ name: "/main.tsx", contents: "stale revision" }],
    });
    await first;

    expect(shows(menu)).not.toContain("stale revision");
    expect(liveRegionText(menu)).toContain("Reading source revision");
    await secondHandler(testMouseEvent());
    expect(reads).toBe(2);

    finishes[1]({
      pattern: SOURCE.pattern!,
      files: [{ name: "/main.tsx", contents: "new revision" }],
    });
    await second;

    expect(shows(menu)).toContain("new revision");
  });

  it("moves focus into the source panel and announces revision reads", async () => {
    let focusCalls = 0;
    const menu = openMenu(pieceCell(() => Promise.resolve(historySource)));
    Object.defineProperty(menu, "updateComplete", {
      value: Promise.resolve(true),
      configurable: true,
    });
    Object.defineProperty(menu, "shadowRoot", {
      value: {
        querySelector: () => ({ focus: () => focusCalls++ }),
      },
      configurable: true,
    });
    await menu.showPanel("origin");
    expect(liveRegionText(menu).trim()).toBe("");
    await clickTestId(menu, "piece-source-view-older");

    expect(focusCalls).toBe(1);
    expect(liveRegionText(menu)).toContain(
      "Source revision loaded with 2 files",
    );
    expect(liveRegionText(menu)).not.toContain("the main file");
  });

  it("does not substitute current source for an unavailable revision", async () => {
    const menu = openMenu(pieceCell(
      () => Promise.resolve(historySource),
      {
        readRevision: () =>
          Promise.resolve({ pattern: SOURCE.pattern!, files: [] }),
      },
    ));
    await menu.showPanel("origin");
    await clickTestId(menu, "piece-source-view-older");

    expect(shows(menu)).toContain("revision's source is not available");
    expect(liveRegionText(menu)).toContain("Source revision is not available");
    expect(shows(menu)).not.toContain("the main file");
  });

  it("reports a historical source read failure without hiding history", async () => {
    const menu = openMenu(pieceCell(
      () => Promise.resolve(historySource),
      {
        readRevision: () => Promise.reject(new Error("old source failed")),
      },
    ));
    await menu.showPanel("origin");
    await clickTestId(menu, "piece-source-view-older");

    expect(shows(menu)).toContain("old source failed");
    await menu.showPanel("origin");
    expect(shows(menu)).toContain("Source history");
    expect(shows(menu)).not.toContain("old source failed");
  });

  it("does not report a historical read cancelled by runtime disposal", async () => {
    let reads = 0;
    const menu = openMenu(pieceCell(
      () => Promise.resolve(historySource),
      {
        aborted: true,
        readRevision: () => {
          reads++;
          return Promise.reject(new Error("disposed runtime"));
        },
      },
    ));
    await menu.showPanel("origin");
    await clickTestId(menu, "piece-source-view-older");

    expect(reads).toBe(1);
    expect(shows(menu)).not.toContain("disposed runtime");
    expect(shows(menu)).toContain("Source revision read was cancelled");
    expect(liveRegionText(menu)).toContain(
      "Source revision read was cancelled",
    );
    expect(shows(menu)).not.toContain("Reading source revision");
  });
});

/**
 * A live-ish piece for the data and actions panels: a real `CellHandle` (the
 * panels detect streams with `instanceof`) over a fake connection that
 * records every request it is asked to make.
 */
function statefulPiece(
  {
    result = {},
    argument: initialArgument = {} as unknown,
    argumentRef,
    getPieceFails = false,
    deferGetPiece = false,
    sendFails = false,
    scope = "space",
    pieceSchema = { type: "object" } as Record<string, unknown>,
  }: {
    result?: Record<string, unknown>;
    argument?: unknown;

    /** The scope the piece's own cell was reached through. */
    scope?: CellScope;

    /** When set, the argument read also returns this schema-bearing ref. */
    argumentRef?: CellRef;

    getPieceFails?: boolean;

    /** When true, getPiece stays pending until `resolveGetPiece()` is called. */
    deferGetPiece?: boolean;

    sendFails?: boolean;
    pieceSchema?: Record<string, unknown>;
  } = {},
) {
  const requests: Array<Record<string, unknown>> = [];
  const counters = { subscribes: 0, unsubscribes: 0 };
  const argument = initialArgument;
  const conn = {
    subscribe: () => {
      counters.subscribes++;
    },
    unsubscribe: () => {
      counters.unsubscribes++;
      return Promise.resolve();
    },
    request: (request: Record<string, unknown>) => {
      requests.push(request);
      if (request.type === RequestType.CellGet) {
        return Promise.resolve(
          request.includeRef && argumentRef
            ? { value: argument, cell: argumentRef }
            : { value: argument },
        );
      }
      if (request.type === RequestType.CellSet) {
        return Promise.resolve({});
      }
      if (request.type === RequestType.CellSend) {
        return sendFails
          ? Promise.reject(new Error("handler refused the event"))
          : Promise.resolve({});
      }
      return Promise.reject(new Error(`unexpected request: ${request.type}`));
    },
    signal: { aborted: false },
  };
  const pendingPieces: Array<() => void> = [];
  const getPieceCalls: unknown[][] = [];
  const rt = {
    [$conn]: () => conn,
    signal: { aborted: false },
    getPieceSource: () => Promise.resolve(SOURCE),
    getPiece: (...args: unknown[]) => {
      getPieceCalls.push(args);
      if (getPieceFails) {
        return Promise.reject(new Error("no piece handle for this piece"));
      }
      if (deferGetPiece) {
        return new Promise((resolve) => {
          pendingPieces.push(() => resolve(pieceHandle));
        });
      }
      return Promise.resolve(pieceHandle);
    },
  } as unknown as RuntimeClient;

  const pieceRef: CellRef = {
    id: "of:fid1:piece",
    space: SPACE,
    scope,
    path: [],
    schema: pieceSchema,
  } as unknown as CellRef;
  const cell = new CellHandle(rt, pieceRef, result);
  const pieceHandle = { cell: () => cell };

  /** Resolve the oldest still-pending deferred getPiece call. */
  const resolveGetPiece = () => pendingPieces.shift()?.();

  /** A nested handler stream whose own ref schema carries the stream tag. */
  const streamHandle = (name: string): CellHandle =>
    new CellHandle(rt, {
      id: "of:fid1:piece",
      space: SPACE,
      path: [name],
      schema: { asCell: ["stream"] },
    } as unknown as CellRef);

  /**
   * A handler as a schema'd piece read actually delivers one: a handle to the
   * stream's own doc carrying the handler's EVENT schema, with the stream
   * declaration living on the piece schema's property instead.
   */
  const handlerHandle = (name: string, eventSchema: unknown): CellHandle =>
    new CellHandle(rt, {
      id: `of:fid1:handler-${name}`,
      space: SPACE,
      path: [],
      schema: eventSchema,
    } as unknown as CellRef);

  return {
    cell,
    requests,
    counters,
    getPieceCalls,
    streamHandle,
    handlerHandle,
    resolveGetPiece,
    rt,
  };
}

describe("the data panel", () => {
  it("shows the argument and the result", async () => {
    const piece = statefulPiece({
      argument: { title: "hello input" },
      result: {},
    });
    // The result carries a plain field, a linked cell, and a stream.
    await piece.cell.set({
      count: 3,
      addItem: piece.streamHandle("addItem"),
    });
    const menu = openMenu(piece.cell);
    await menu.showPanel("data");

    const rendered = shows(menu);
    expect(rendered).toContain("Argument");
    expect(rendered).toContain("hello input");
    expect(rendered).toContain("Result");
    expect(rendered).toContain('"count": 3');
    expect(rendered).toContain("[stream]");
  });

  it("omits the view keys, which hold VDOM rather than data", async () => {
    const piece = statefulPiece();
    await piece.cell.set({ real: "data", $UI: { huge: "vdom" } });
    const menu = openMenu(piece.cell);
    await menu.showPanel("data");

    const rendered = shows(menu);
    expect(rendered).toContain("real");
    expect(rendered).not.toContain("vdom");
  });

  it("reads the piece state once for data and actions", async () => {
    const piece = statefulPiece({ argument: { a: 1 } });
    const menu = openMenu(piece.cell);
    await menu.showPanel("data");
    await menu.showPanel("actions");
    await menu.showPanel("data");

    const argumentReads = piece.requests.filter(
      (request) => request.type === RequestType.CellGet,
    );
    expect(argumentReads.length).toBe(1);
  });

  it("reports a data read that failed", async () => {
    const piece = statefulPiece({ getPieceFails: true });
    const menu = openMenu(piece.cell);
    await menu.showPanel("data");

    expect(shows(menu)).toContain("no piece handle for this piece");
  });
});

describe("the actions panel", () => {
  it("lists the piece's handler streams", async () => {
    const piece = statefulPiece({ argument: { plain: "value" } });
    await piece.cell.set({
      addItem: piece.streamHandle("addItem"),
      clear: piece.streamHandle("clear"),
      count: 3,
    });
    const menu = openMenu(piece.cell);
    await menu.showPanel("actions");

    const rendered = shows(menu);
    expect(rendered).toContain("addItem");
    expect(rendered).toContain("clear");
    expect(rendered).toContain("piece-action-addItem");
    // Plain fields are data, not actions.
    expect(rendered).not.toContain("piece-action-count");
  });

  it("finds handlers the piece schema declares, and hints their payload", async () => {
    // The live shape: the handle carries the event schema, the stream
    // declaration lives on the piece schema's property.
    const piece = statefulPiece({
      pieceSchema: {
        type: "object",
        properties: {
          addSpace: { asCell: ["stream"], type: "object" },
          spaces: { type: "array" },
        },
      },
    });
    await piece.cell.set({
      addSpace: piece.handlerHandle("addSpace", {
        type: "object",
        properties: { name: { type: "string" } },
      }),
      spaces: [],
    });
    const menu = openMenu(piece.cell);
    await menu.showPanel("actions");

    const rendered = shows(menu);
    expect(rendered).toContain("piece-action-addSpace");
    expect(rendered).toContain("{ name }");

    // The Data panel shows the same key as a stream, not a bare cell link.
    await menu.showPanel("data");
    expect(shows(menu)).toContain('"addSpace": "[stream]"');
  });

  it("does not offer a cell that merely contains a stream", async () => {
    // asCell ["cell", "stream"] is a CELL wrapping a stream: sending to the
    // outer cell would overwrite data, so it must not be dispatchable.
    const piece = statefulPiece({
      pieceSchema: {
        type: "object",
        properties: {
          wrapped: { asCell: ["cell", "stream"], type: "object" },
        },
      },
    });
    await piece.cell.set({
      wrapped: piece.handlerHandle("wrapped", { type: "object" }),
    });
    const menu = openMenu(piece.cell);
    await menu.showPanel("actions");

    expect(shows(menu)).toContain("no handler streams");
  });

  it("finds handlers the argument schema declares", async () => {
    // The argument arrives in wire form: sigil links that deserialize back
    // into handles carrying the handler's event schema, while the stream
    // declaration lives on the argument schema's property.
    const piece = statefulPiece({
      argument: {
        ping: {
          "/": {
            "link@1": {
              id: "of:fid1:handler-ping",
              space: SPACE,
              path: [],
              schema: { type: "object" },
            },
          },
        },
      },
      argumentRef: {
        id: "of:fid1:argument",
        space: SPACE,
        path: [],
        schema: {
          type: "object",
          properties: { ping: { asCell: ["stream"] } },
        },
      } as unknown as CellRef,
    });
    const menu = openMenu(piece.cell);
    await menu.showPanel("actions");

    const rendered = shows(menu);
    expect(rendered).toContain("piece-action-ping");
    expect(rendered).toContain("argument");
  });

  it("offers a declared stream even when its value is not a handle", async () => {
    // A schema-less read leaves whatever the document holds in place of a
    // handle, and a stream's document holds nothing; the parent declaration
    // is the trusted signal, so the action derives its address from the
    // parent cell instead.
    const piece = statefulPiece({
      pieceSchema: {
        type: "object",
        properties: { go: { asCell: ["stream"] } },
      },
    });
    await piece.cell.set({ go: {} });
    const menu = openMenu(piece.cell);
    await menu.showPanel("actions");

    expect(shows(menu)).toContain("piece-action-go");

    const [action] = menu.collectActions();
    await menu.dispatchAction(action);
    const sends = piece.requests.filter(
      (request) => request.type === RequestType.CellSend,
    );
    expect(sends.length).toBe(1);
    expect((sends[0].cell as CellRef).path).toEqual(["go"]);
  });

  it("never offers the retired stream sentinel at an undeclared key", async () => {
    const piece = statefulPiece();
    await piece.cell.set({ mystery: { $stream: true } });
    const menu = openMenu(piece.cell);
    await menu.showPanel("actions");

    expect(shows(menu)).toContain("no handler streams");
  });

  it("says so when the piece exposes no handlers", async () => {
    const piece = statefulPiece({ argument: { a: 1 } });
    await piece.cell.set({ count: 3 });
    const menu = openMenu(piece.cell);
    await menu.showPanel("actions");

    expect(shows(menu)).toContain("no handler streams");
  });

  it("dispatches an event with the JSON payload entered", async () => {
    const piece = statefulPiece();
    await piece.cell.set({ addItem: piece.streamHandle("addItem") });
    const menu = openMenu(piece.cell);
    await menu.showPanel("actions");

    (menu as unknown as { payloadText: string }).payloadText =
      '{ "title": "new item" }';
    const [action] = menu.collectActions();
    await menu.dispatchAction(action);

    const sends = piece.requests.filter(
      (request) => request.type === RequestType.CellSend,
    );
    expect(sends.length).toBe(1);
    expect(sends[0].event).toEqual({ title: "new item" });
    expect((sends[0].cell as CellRef).path).toEqual(["addItem"]);
    // "Accepted", not "sent": the worker commits asynchronously after
    // acknowledging, so the panel only claims what the request proves.
    expect(shows(menu)).toContain("Event accepted for addItem");
  });

  it("rejects an unparsable payload without dispatching", async () => {
    const piece = statefulPiece();
    await piece.cell.set({ addItem: piece.streamHandle("addItem") });
    const menu = openMenu(piece.cell);
    await menu.showPanel("actions");

    (menu as unknown as { payloadText: string }).payloadText = "{not json";
    const [action] = menu.collectActions();
    await menu.dispatchAction(action);

    expect(shows(menu)).toContain("not valid JSON");
    expect(
      piece.requests.filter((r) => r.type === RequestType.CellSend).length,
    ).toBe(0);
  });

  it("reports a dispatch the runtime refused", async () => {
    const piece = statefulPiece({ sendFails: true });
    await piece.cell.set({ addItem: piece.streamHandle("addItem") });
    const menu = openMenu(piece.cell);
    await menu.showPanel("actions");

    const [action] = menu.collectActions();
    await menu.dispatchAction(action);

    expect(shows(menu)).toContain("handler refused the event");
  });

  it("sends once for a rapid double-click", async () => {
    const piece = statefulPiece();
    await piece.cell.set({ addItem: piece.streamHandle("addItem") });
    const menu = openMenu(piece.cell);
    await menu.showPanel("actions");

    const [action] = menu.collectActions();
    // Both clicks land before the first request settles.
    await Promise.all([
      menu.dispatchAction(action),
      menu.dispatchAction(action),
    ]);

    expect(
      piece.requests.filter((r) => r.type === RequestType.CellSend).length,
    ).toBe(1);
  });
});

describe("piece-state read lifecycle", () => {
  it("a refresh during a pending read drops the older read entirely", async () => {
    const piece = statefulPiece({ deferGetPiece: true });
    await piece.cell.set({ value: "current" });
    const menu = openMenu(piece.cell);

    const first = menu.showPanel("data");
    menu.refreshData();
    // The OLDER read resolves after the refresh started a newer one; it must
    // not install a second subscription or overwrite anything.
    piece.resolveGetPiece();
    await first;
    piece.resolveGetPiece();
    await Promise.resolve();

    expect(piece.counters.subscribes).toBe(1);
    menu.close();
    expect(piece.counters.unsubscribes).toBe(piece.counters.subscribes);
  });

  it("a read resolving after disconnect installs nothing", async () => {
    const piece = statefulPiece({ deferGetPiece: true });
    const menu = openMenu(piece.cell);

    const pending = menu.showPanel("data");
    menu.disconnectedCallback();
    piece.resolveGetPiece();
    await pending;

    expect(piece.counters.subscribes).toBe(0);
  });

  it("balances subscriptions when the menu closes", async () => {
    const piece = statefulPiece({
      argumentRef: {
        id: "of:fid1:argument",
        space: SPACE,
        path: [],
        schema: { type: "object" },
      } as unknown as CellRef,
    });
    await piece.cell.set({ value: 1 });
    const menu = openMenu(piece.cell);
    await menu.showPanel("data");

    // One subscription per side: result and argument.
    expect(piece.counters.subscribes).toBe(2);
    menu.close();
    expect(piece.counters.unsubscribes).toBe(piece.counters.subscribes);
  });
});

describe("formatPieceValue", () => {
  it("formats undefined and values JSON cannot render", () => {
    expect(formatPieceValue(undefined)).toBe("undefined");
    const unrenderable = formatPieceValue(1n);
    expect(unrenderable.startsWith("<unrenderable: ")).toBe(true);
    expect(unrenderable.endsWith(">")).toBe(true);
  });

  it("stubs a linked cell instead of printing its sigil form", () => {
    const piece = statefulPiece();
    const linked = new CellHandle(piece.rt, {
      id: "of:fid1:other",
      space: SPACE,
      path: ["items", "0"],
      schema: { type: "object" },
    } as unknown as CellRef);

    const formatted = formatPieceValue({ item: linked });
    expect(formatted).toContain('"@cell": "of:fid1:other"');
    expect(formatted).toContain("items/0");
  });

  it("caps the depth of a deep value", () => {
    type Deep = { deeper?: Deep; leaf?: string };
    let value: Deep = { leaf: "bottom" };
    for (let i = 0; i < 12; i++) value = { deeper: value };

    const formatted = formatPieceValue(value);
    expect(formatted).toContain("…");
    expect(formatted).not.toContain("bottom");
  });
});

describe("isStreamHandle", () => {
  it("recognizes only handles whose schema declares a stream", () => {
    const piece = statefulPiece();
    expect(isStreamHandle(piece.streamHandle("go"))).toBe(true);
    expect(isStreamHandle(piece.cell)).toBe(false);
    expect(isStreamHandle({ $stream: true })).toBe(false);
    expect(isStreamHandle("addItem")).toBe(false);
  });
});

describe("dismissing the menu", () => {
  /** Send a keydown the way the browser would, since the menu listens globally. */
  function pressKey(key: string): void {
    const event = new Event("keydown", { cancelable: true });
    (event as unknown as { key: string }).key = key;
    globalThis.dispatchEvent(event);
  }

  it("steps back from a panel to the menu, then closes", async () => {
    const menu = openMenu();
    menu.connectedCallback();
    try {
      await menu.showPanel("origin");
      expect(shows(menu)).toContain("Origin and history");

      pressKey("Escape");
      expect(shows(menu)).toContain("View source");

      pressKey("Escape");
      expect(shows(menu)).toBe("");
    } finally {
      menu.disconnectedCallback();
    }
  });

  it("dismisses the origin dialog before the panel behind it", async () => {
    const menu = openMenu();
    menu.connectedCallback();
    try {
      await menu.showPanel("origin");
      clickTestId(menu, "piece-origin-enter-source");
      expect(shows(menu)).toContain("piece-origin-entry");

      pressKey("Escape");
      const rendered = shows(menu);
      expect(rendered).not.toContain("piece-origin-entry");
      expect(rendered).toContain("Origin and history");

      pressKey("Escape");
      expect(shows(menu)).toContain("View source");
    } finally {
      menu.disconnectedCallback();
    }
  });

  it("dismisses on a right-click on the backdrop", () => {
    const menu = openMenu();
    let prevented = false;
    (menu as unknown as { _onBackdropContextMenu(e: Event): void })
      ._onBackdropContextMenu(
        { preventDefault: () => (prevented = true) } as unknown as Event,
      );

    // The platform menu does not open over the dismissed piece menu.
    expect(prevented).toBe(true);
    expect(shows(menu)).toBe("");
  });

  it("ignores keys that are not Escape", () => {
    const menu = openMenu();
    menu.connectedCallback();
    try {
      pressKey("Enter");
      expect(shows(menu)).toContain("View source");
    } finally {
      menu.disconnectedCallback();
    }
  });
});

describe("openPieceMenu", () => {
  /** A document stub: the menu mounts on `document.body`, outside any piece. */
  function installDocument(): { restore: () => void; appended: unknown[] } {
    const appended: unknown[] = [];
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalComputed = Object.getOwnPropertyDescriptor(
      globalThis,
      "getComputedStyle",
    );
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: {
        createElement: () => {
          const element = newMenu();
          // The shim element has no style object of its own.
          (element as unknown as { style: unknown }).style = {
            setProperty: () => {},
            removeProperty: () => {},
          };
          return element;
        },
        body: {
          appendChild: (element: unknown) => {
            appended.push(element);
            (element as { isConnected?: boolean }).isConnected = true;
            return element;
          },
        },
      },
    });
    Object.defineProperty(globalThis, "getComputedStyle", {
      configurable: true,
      writable: true,
      value: () => ({
        getPropertyValue: (name: string) =>
          name === "--cf-theme-color-surface" ? "#101010" : "",
      }),
    });
    return {
      appended,
      restore: () => {
        if (original) Object.defineProperty(globalThis, "document", original);
        else Reflect.deleteProperty(globalThis, "document");
        if (originalComputed) {
          Object.defineProperty(
            globalThis,
            "getComputedStyle",
            originalComputed,
          );
        } else Reflect.deleteProperty(globalThis, "getComputedStyle");
      },
    };
  }

  it("mounts one menu and reuses it for the next right-click", () => {
    const { appended, restore } = installDocument();
    try {
      const first = openPieceMenu({ cell: pieceCell(), x: 10, y: 20 });
      const second = openPieceMenu({ cell: pieceCell(), x: 30, y: 40 });

      // One overlay, reopened — a second right-click replaces the menu rather
      // than stacking another on top of it.
      expect(second).toBe(first);
      expect(appended.length).toBe(1);
      expect(shows(second)).toContain("View source");
    } finally {
      restore();
    }
  });

  it("adopts the theme of the element the click came from", () => {
    const { restore } = installDocument();
    const applied: Array<[string, string]> = [];
    try {
      const themeFrom = {} as unknown as Element;
      const menu = openPieceMenu({
        cell: pieceCell(),
        x: 0,
        y: 0,
        themeFrom,
      });
      (menu as unknown as { style: unknown }).style = {
        setProperty: (name: string, value: string) =>
          applied.push([name, value]),
        removeProperty: () => {},
      };
      // Reopening with the same host re-copies onto the recorded style stub.
      openPieceMenu({ cell: pieceCell(), x: 0, y: 0, themeFrom });

      expect(applied).toContainEqual(["--cf-theme-color-surface", "#101010"]);
    } finally {
      restore();
    }
  });
});

describe("describeOrigin", () => {
  it("names the detached case without inventing an origin", () => {
    const description = describeOrigin(undefined);
    expect(description.label).toBe("Detached");
    expect(description.detail).toContain("no origin");
  });

  it("distinguishes a mutable piece origin from an exact pattern", () => {
    expect(
      describeOrigin({
        url: "cf:/did:key:z6Mk/of:fid1:x",
        kind: "fabric-piece",
      }).label,
    ).toBe("Fabric piece");
    expect(
      describeOrigin({ url: "cf:pattern:x", kind: "fabric-pattern" }).label,
    ).toBe("Exact pattern");
    expect(
      describeOrigin({
        url: "https://t.test/api/patterns/p.tsx",
        kind: "system",
      })
        .label,
    ).toBe("Deployment pattern");
  });

  it("says what each kind of origin can do", () => {
    expect(
      describeOrigin({
        url: "https://t.test/api/patterns/p.tsx",
        kind: "system",
      })
        .detail,
    ).toContain("a new release of the deployment can replace it");
    expect(
      describeOrigin({ url: "cf:pattern:x", kind: "fabric-pattern" }).detail,
    ).toContain("always resolves to");
  });
});

describe("patternRefLabel", () => {
  it("names the export as an identifier rather than as prose", () => {
    expect(patternRefLabel({ identity: "short", symbol: "default" })).toBe(
      'short (export symbol "default")',
    );
  });

  it("abbreviates the identity unless the whole value is asked for", () => {
    const ref = { identity: "abcdefghijklmnopqrstuvwxyz", symbol: "main" };
    expect(patternRefLabel(ref)).toBe('abcdefghijkl… (export symbol "main")');
    expect(patternRefLabel(ref, { whole: true })).toBe(
      'abcdefghijklmnopqrstuvwxyz (export symbol "main")',
    );
  });
});

describe("formatTimestamp", () => {
  it("renders a recorded timestamp as local time", () => {
    const stamped = formatTimestamp(Date.UTC(2026, 6, 24, 12, 0, 0));
    expect(stamped).toContain("2026");
    expect(stamped.length).toBeGreaterThan(0);
  });
});

describe("describeFollowState", () => {
  it("does not report a piece nothing has looked at as up to date", () => {
    const description = describeFollowState(SOURCE);
    expect(description.state).toBe("unknown");
    // The row's heading supplies the subject for the terse label; the box has
    // no heading over it, so it opens with a sentence that carries its own.
    expect(description.label).toBe("Unknown");
    expect(description.summary).toBe(
      "Nothing has looked for new source at this origin.",
    );
    expect(description.at).toBeUndefined();
    // Asking is what this state wants. Nothing has failed a check, so there
    // is no check to offer to ignore.
    expect(description.canUpdate).toBe(true);
    expect(description.canForce).toBe(false);
  });

  it("separates an origin it could not reach from one it refused", () => {
    const at = Date.UTC(2026, 7, 1, 9, 0, 0);
    const unreachable = describeFollowState({
      ...SOURCE,
      reconciliation: {
        outcome: "unreachable",
        at,
        origin: SOURCE.origin!.url,
        detail: "the origin answered 503",
      },
    });
    expect(unreachable.state).toBe("unreachable");
    expect(unreachable.summary).toBe("This piece could not reach its origin.");
    expect(unreachable.reason).toBe("the origin answered 503");
    expect(unreachable.detail).toContain("may right itself");
    expect(unreachable.canUpdate).toBe(true);
    expect(unreachable.canForce).toBe(false);

    const refused = describeFollowState({
      ...SOURCE,
      reconciliation: {
        outcome: "refused",
        at,
        origin: SOURCE.origin!.url,
        reason: "incompatible-schema",
        offered: { identity: "candidate-identity", symbol: "default" },
      },
    });
    expect(refused.state).toBe("refused");
    expect(refused.summary).toContain("did not take it");
    expect(refused.detail).toContain("will happen again");
    // A compiler's report can run to many lines, so what the attempt said
    // stays out of the sentence and gets a line of its own.
    expect(refused.reason).toContain("inputs or outputs do not match");
    expect(refused.offered).toEqual({
      identity: "candidate-identity",
      symbol: "default",
    });
    expect(refused.at).toBe(at);
  });

  it("has words for every reason a refusal can carry", () => {
    // The reason a check recorded is shown when there is one; these are what
    // the panel says when a refusal arrives carrying only its kind.
    const reasons = [
      ["incompatible-schema", "inputs or outputs do not match"],
      ["argument-mismatch", "data this piece holds does not fit"],
      ["source-invalid", "could not be used"],
      ["identity-mismatch", "did not match the version"],
      ["apply-failed", "could not be applied to this piece"],
    ] as const;
    for (const [reason, expected] of reasons) {
      const described = describeFollowState({
        ...SOURCE,
        reconciliation: {
          outcome: "refused",
          at: 1,
          origin: SOURCE.origin!.url,
          reason,
        },
      });
      expect(described.reason).toContain(expected);
    }

    // A refusal that names no reason at all still says something.
    const bare = describeFollowState({
      ...SOURCE,
      reconciliation: { outcome: "refused", at: 1, origin: SOURCE.origin!.url },
    });
    expect(bare.reason).toContain("did not take what the origin offered");
  });

  it("says a refusal nothing can overrule is one, and why", () => {
    const description = describeFollowState({
      ...SOURCE,
      reconciliation: {
        outcome: "refused",
        at: 1,
        origin: SOURCE.origin!.url,
        reason: "argument-mismatch",
        detail: "missing required property profiles",
      },
    });
    expect(description.canForce).toBe(false);
    // A box with no override needs to say why, or it reads as one whose
    // button someone forgot.
    expect(description.detail).toContain("nothing to overrule");
    expect(description.detail).toContain("data would have to change");
    expect(description.reason).toBe("missing required property profiles");
  });

  it("offers to override only what an override could fix", () => {
    const refusal = (
      reason: "incompatible-schema" | "source-invalid" | "argument-mismatch",
    ) =>
      describeFollowState({
        ...SOURCE,
        reconciliation: {
          outcome: "refused",
          at: 1,
          origin: SOURCE.origin!.url,
          reason,
        },
      });
    // Asking again is always on offer; ignoring the check is not, when the
    // refusal named something ignoring it cannot fix.
    expect(refusal("incompatible-schema").canUpdate).toBe(true);
    expect(refusal("incompatible-schema").canForce).toBe(true);
    expect(refusal("source-invalid").canUpdate).toBe(true);
    expect(refusal("source-invalid").canForce).toBe(false);
    expect(refusal("argument-mismatch").canUpdate).toBe(true);
    expect(refusal("argument-mismatch").canForce).toBe(false);
  });

  it("reports a piece nothing has looked at as unknown", () => {
    expect(describeFollowState(SOURCE).state).toBe("unknown");
  });

  it("tells a piece carrying an unfollowable string from a detached one", () => {
    const unusable = describeFollowState({
      ...SOURCE,
      origin: undefined,
      unusableOrigin: {
        recorded: "../recipes/main.tsx",
        reason: "../recipes/main.tsx is not an absolute URL",
      },
    });
    expect(unusable.state).toBe("unusable");
    expect(unusable.summary).toContain("Nothing can follow");
    expect(unusable.detail).toContain("has not been detached");
    expect(unusable.reason).toBe("../recipes/main.tsx is not an absolute URL");

    expect(
      describeFollowState({ ...SOURCE, origin: undefined }).state,
    ).toBe("detached");
  });
});

describe("what the source-updates box offers", () => {
  /** The states that get a box, and the buttons each one earns. */
  const CASES: Array<
    [string, PieceSourceView, { box: boolean; update: boolean; force: boolean }]
  > = [
    ["up to date", {
      ...SOURCE,
      reconciliation: {
        outcome: "followed",
        at: 1,
        origin: SOURCE.origin!.url,
      },
    }, { box: false, update: false, force: false }],
    ["unknown", SOURCE, { box: true, update: true, force: false }],
    ["unreachable", {
      ...SOURCE,
      reconciliation: {
        outcome: "unreachable",
        at: 1,
        origin: SOURCE.origin!.url,
      },
    }, { box: true, update: true, force: false }],
    ["refused over a contract", {
      ...SOURCE,
      reconciliation: {
        outcome: "refused",
        at: 1,
        origin: SOURCE.origin!.url,
        reason: "incompatible-schema",
      },
    }, { box: true, update: true, force: true }],
    ["refused over data that does not fit", {
      ...SOURCE,
      reconciliation: {
        outcome: "refused",
        at: 1,
        origin: SOURCE.origin!.url,
        reason: "argument-mismatch",
      },
    }, { box: true, update: true, force: false }],
    ["refused over unusable source", {
      ...SOURCE,
      reconciliation: {
        outcome: "refused",
        at: 1,
        origin: SOURCE.origin!.url,
        reason: "source-invalid",
      },
    }, { box: true, update: true, force: false }],
    ["detached", { ...SOURCE, origin: undefined }, {
      box: false,
      update: false,
      force: false,
    }],
    ["an origin nothing can follow", {
      ...SOURCE,
      origin: undefined,
      unusableOrigin: { recorded: "x", reason: "x is not an absolute URL" },
    }, { box: true, update: false, force: false }],
  ];

  for (const [name, source, expected] of CASES) {
    it(`offers what ${name} earns`, async () => {
      const menu = openMenu(pieceCell(() => Promise.resolve(source)));
      await menu.showPanel("origin");
      const rendered = shows(menu);
      expect(rendered.includes("piece-origin-follow-detail")).toBe(
        expected.box,
      );
      expect(rendered.includes("piece-origin-update-now")).toBe(
        expected.update,
      );
      expect(rendered.includes("piece-origin-force-update")).toBe(
        expected.force,
      );
    });
  }
});

describe("describeSourceFailure", () => {
  it("keeps an ordinary failure as it came", () => {
    const failure = describeSourceFailure("nothing answers there");
    expect(failure.summary).toBe("Could not follow that source.");
    expect(failure.reason).toBe("nothing answers there");
  });

  it("says a source the piece's data cannot run is not one to insist on", () => {
    const failure = describeSourceFailure(
      "updated arguments do not match the candidate schema: " +
        "missing required property profiles",
    );
    // Left as it came it reads as something that might work next time, beside
    // a dialog offering no way to insist.
    expect(failure.summary).toContain("cannot run on the data this piece");
    expect(failure.summary).toContain("data would have to change first");
    expect(failure.reason).toBe("missing required property profiles");
  });
});
