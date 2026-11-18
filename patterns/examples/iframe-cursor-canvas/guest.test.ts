import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import {
  type GuestPage,
  MemoryCell,
  MemoryPresenceRoom,
  openGuestPage,
} from "../../tools/test-support/iframe-guest.ts";
import type { CanvasShape, ShapeBox } from "./contract.ts";

const GUEST = new URL("./guest.ts", import.meta.url);
const HTML = new URL("./guest.html", import.meta.url);

/** A shape as another session of the board stored it. */
function storedShape(id: string, box: ShapeBox): CanvasShape {
  return { id, kind: "rectangle", box, hue: 200, removed: false };
}

const BOX: ShapeBox = { position: { x: 100, y: 100 }, width: 200, height: 100 };

describe("iframe-cursor-canvas/guest", () => {
  let page: GuestPage | undefined;

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  /**
   * Opens the board, by default holding one stored shape `a` at {@link BOX},
   * and resolves once it has hydrated.
   */
  async function open(options: {
    input?: MemoryCell;
    state?: MemoryCell;
    output?: MemoryCell;
    cursors?: MemoryPresenceRoom;
  } = {}) {
    const input = options.input ??
      new MemoryCell({ title: "Team board" }, { readonly: true });
    const state = options.state ??
      new MemoryCell({ shapes: [storedShape("a", BOX)] });
    const output = options.output ??
      new MemoryCell({ displayName: "", hue: null });
    const cursors = options.cursors ?? new MemoryPresenceRoom();
    page = await openGuestPage({
      guest: GUEST,
      html: HTML,
      resources: {
        input: input.resource(),
        state: state.resource(),
        output: output.resource(),
        cursors: cursors.resource(),
      },
    });
    const opened = page;
    await opened.until(() => !byTestId("display-name").disabled);
    return { page: opened, input, state, output, cursors };
  }

  function byTestId<T extends HTMLElement = HTMLInputElement>(id: string): T {
    const element = document.querySelector<T>(`[data-testid="${id}"]`);
    if (!element) throw new Error(`No element has the test id \`${id}\`.`);
    return element;
  }

  function allByTestId(id: string): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  }

  function shapeElement(id: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-shape-id="${id}"]`);
  }

  function pointer(
    target: EventTarget,
    type: string,
    x: number,
    y: number,
    init: PointerEventInit = {},
  ): void {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: y,
        pointerId: 1,
        button: 0,
        ...init,
      }),
    );
  }

  describe("startup", () => {
    it("stores the default board on first use and enables its tools", async () => {
      const { state } = await open({ state: new MemoryCell() });

      expect(state.value).toEqual({ shapes: [] });
      expect(byTestId<HTMLButtonElement>("add-rectangle").disabled).toBe(false);
      expect(byTestId("board").querySelector<HTMLElement>(".hint")?.hidden)
        .toBe(false);
    });

    it("shows the title the piece was created with", async () => {
      await open();

      expect(document.querySelector("h1")?.textContent).toBe("Team board");
    });

    it("leaves a stored board as it is", async () => {
      const { page, state } = await open();
      await page.settled();

      expect(state.writes).toEqual([]);
      expect(shapeElement("a")?.style.transform).toBe(
        "translate(100px, 100px)",
      );
      expect(byTestId("board").querySelector<HTMLElement>(".hint")?.hidden)
        .toBe(true);
    });

    it("shows why it could not load the board, and keeps its tools off", async () => {
      const state = new MemoryCell();
      state.failReads(new Error("The board is unreadable."));
      page = await openGuestPage({
        guest: GUEST,
        html: HTML,
        resources: {
          input: new MemoryCell({ title: "x" }).resource(),
          state: state.resource(),
          output: new MemoryCell().resource(),
          cursors: new MemoryPresenceRoom().resource(),
        },
      });
      const alert = document.querySelector('[role="alert"]')!;
      await page.until(() => alert.textContent !== "");

      expect(alert.textContent).toContain("The board is unreadable.");
      expect(byTestId<HTMLButtonElement>("add-rectangle").disabled).toBe(true);
    });

    it("throws for a document with no #root element", async () => {
      await expect(openGuestPage({
        guest: GUEST,
        html: "<!doctype html><html><body></body></html>",
        resources: {},
      })).rejects.toThrow("Cursor Canvas needs a #root element.");
    });
  });

  describe("adding and removing shapes", () => {
    it("appends a rectangle and an ellipse, each selected once stored", async () => {
      const { page, state } = await open({ state: new MemoryCell() });

      byTestId<HTMLButtonElement>("add-rectangle").click();
      await page.until(() => allByTestId("shape").length === 1);
      byTestId<HTMLButtonElement>("add-ellipse").click();
      await page.until(() =>
        allByTestId("shape").length === 2 &&
        allByTestId("shape")[1].hasAttribute("data-selected")
      );

      expect(state.value).toMatchObject({
        shapes: [{ kind: "rectangle" }, { kind: "ellipse" }],
      });
      expect(allByTestId("shape")[0].hasAttribute("data-selected")).toBe(false);
      expect(byTestId<HTMLButtonElement>("delete-shape").disabled).toBe(false);
    });

    it("shows why a shape could not be added", async () => {
      const { page, state } = await open();
      state.failWrites(new Error("The board is read-only."));

      byTestId<HTMLButtonElement>("add-rectangle").click();
      const alert = document.querySelector('[role="alert"]')!;
      await page.until(() => alert.textContent !== "");

      expect(alert.textContent).toContain("The board is read-only.");
      await page.settled();
      expect(state.value).toEqual({ shapes: [storedShape("a", BOX)] });
    });

    it("marks the selected shape removed when Delete is clicked", async () => {
      const { page, state } = await open();
      pointer(shapeElement("a")!, "pointerdown", 150, 150);
      pointer(shapeElement("a")!, "pointerup", 150, 150);

      byTestId<HTMLButtonElement>("delete-shape").click();
      await page.until(() => shapeElement("a") === null);

      expect(state.value).toEqual({
        shapes: [{ ...storedShape("a", BOX), removed: true }],
      });
      expect(byTestId<HTMLButtonElement>("delete-shape").disabled).toBe(true);
    });

    it("marks the selected shape removed on the Backspace key", async () => {
      const { page, state } = await open();
      pointer(shapeElement("a")!, "pointerdown", 150, 150);
      pointer(shapeElement("a")!, "pointerup", 150, 150);

      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }),
      );
      await page.until(() => shapeElement("a") === null);

      expect(state.value).toEqual({
        shapes: [{ ...storedShape("a", BOX), removed: true }],
      });
    });

    it("removes nothing for a key typed into the name field", async () => {
      const { page, state } = await open();
      pointer(shapeElement("a")!, "pointerdown", 150, 150);
      pointer(shapeElement("a")!, "pointerup", 150, 150);

      byTestId("display-name").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
      await page.settled();

      expect(state.writes).toEqual([]);
      expect(shapeElement("a")).not.toBeNull();
    });

    it("removes nothing on the Delete key with no shape selected", async () => {
      const { page, state } = await open();

      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
      await page.settled();

      expect(state.writes).toEqual([]);
    });

    it("shows why a shape could not be removed", async () => {
      const { page, state } = await open();
      pointer(shapeElement("a")!, "pointerdown", 150, 150);
      pointer(shapeElement("a")!, "pointerup", 150, 150);
      state.failWrites(new Error("Removal refused."));

      byTestId<HTMLButtonElement>("delete-shape").click();
      const alert = document.querySelector('[role="alert"]')!;
      await page.until(() => alert.textContent !== "");

      expect(alert.textContent).toContain("Removal refused.");
    });

    it("clears the selection when the empty board is pressed", async () => {
      await open();
      pointer(shapeElement("a")!, "pointerdown", 150, 150);
      pointer(shapeElement("a")!, "pointerup", 150, 150);
      expect(shapeElement("a")?.hasAttribute("data-selected")).toBe(true);

      pointer(byTestId("board"), "pointerdown", 900, 900);

      expect(shapeElement("a")?.hasAttribute("data-selected")).toBe(false);
      expect(byTestId<HTMLButtonElement>("delete-shape").disabled).toBe(true);
    });

    it("drops a shape another session removed, with its selection", async () => {
      const { page, state } = await open();
      pointer(shapeElement("a")!, "pointerdown", 150, 150);
      pointer(shapeElement("a")!, "pointerup", 150, 150);

      state.value = { shapes: [{ ...storedShape("a", BOX), removed: true }] };
      await page.until(() => shapeElement("a") === null);

      expect(byTestId<HTMLButtonElement>("delete-shape").disabled).toBe(true);
    });
  });

  describe("moving and resizing", () => {
    it("stores the box a shape is dragged to, and shows it there meanwhile", async () => {
      const { page, state, cursors } = await open();
      const shape = shapeElement("a")!;

      pointer(shape, "pointerdown", 150, 120);
      pointer(shape, "pointermove", 450, 320);
      expect(shape.style.transform).toBe("translate(400px, 300px)");
      expect(shape.hasAttribute("data-dragging")).toBe(true);
      await page.until(() => cursors.facets.has("drag"));
      expect(cursors.facets.get("drag")).toEqual({
        id: "a",
        position: { x: 400, y: 300 },
        width: 200,
        height: 100,
      });
      const write = state.nextWrite();
      pointer(shape, "pointerup", 450, 320);
      await write;
      await page.until(() => !cursors.facets.has("drag"));
      await page.settled();

      expect(state.value).toEqual({
        shapes: [
          storedShape("a", {
            position: { x: 400, y: 300 },
            width: 200,
            height: 100,
          }),
        ],
      });
      expect(state.writes.map((entry) => entry.path)).toEqual([
        ["shapes", 0, "box"],
      ]);
      expect(shape.style.transform).toBe("translate(400px, 300px)");
    });

    it("resizes a shape from the corner handle it is grabbed by", async () => {
      const { state } = await open();
      const handle = byTestId("resize-se");

      pointer(handle, "pointerdown", 300, 200);
      pointer(handle, "pointermove", 500, 260);
      const write = state.nextWrite();
      pointer(handle, "pointerup", 500, 260);
      await write;

      expect(state.value).toEqual({
        shapes: [
          storedShape("a", {
            position: { x: 100, y: 100 },
            width: 400,
            height: 160,
          }),
        ],
      });
    });

    it("puts the handles inside a shape on the sides that touch the board's edge", async () => {
      await open({
        state: new MemoryCell({
          shapes: [
            storedShape("a", {
              position: { x: 0, y: 0 },
              width: 50,
              height: 50,
            }),
            storedShape("b", {
              position: { x: 1500, y: 900 },
              width: 100,
              height: 100,
            }),
          ],
        }),
      });

      const corner = shapeElement("a")!;
      const far = shapeElement("b")!;
      expect(
        ["left", "top", "right", "bottom"].map((side) =>
          corner.hasAttribute(`data-at-${side}`)
        ),
      ).toEqual([true, true, false, false]);
      expect(
        ["left", "top", "right", "bottom"].map((side) =>
          far.hasAttribute(`data-at-${side}`)
        ),
      ).toEqual([false, false, true, true]);
    });

    it("stores nothing for a drag that is cancelled", async () => {
      const { page, state, cursors } = await open();
      const shape = shapeElement("a")!;

      pointer(shape, "pointerdown", 150, 120);
      pointer(shape, "pointermove", 450, 320);
      pointer(shape, "pointercancel", 450, 320);
      await page.settled();

      expect(state.writes).toEqual([]);
      expect(shape.style.transform).toBe("translate(100px, 100px)");
      expect(cursors.facets.has("drag")).toBe(false);
    });

    it("stores nothing for a press that does not move the shape", async () => {
      const { page, state } = await open();
      const shape = shapeElement("a")!;

      pointer(shape, "pointerdown", 150, 120);
      pointer(shape, "pointerup", 150, 120);
      await page.settled();

      expect(state.writes).toEqual([]);
      expect(shape.hasAttribute("data-selected")).toBe(true);
    });

    it("ignores a second pointer and a secondary button while a shape is held", async () => {
      const { page, state } = await open();
      const shape = shapeElement("a")!;

      pointer(shape, "pointerdown", 150, 120, { button: 2 });
      expect(shape.hasAttribute("data-selected")).toBe(false);
      pointer(shape, "pointerdown", 150, 120);
      pointer(shape, "pointerdown", 150, 120, { pointerId: 2 });
      pointer(shape, "pointermove", 450, 320, { pointerId: 2 });
      pointer(shape, "pointerup", 450, 320, { pointerId: 2 });
      await page.settled();

      expect(shape.style.transform).toBe("translate(100px, 100px)");
      expect(state.writes).toEqual([]);
    });

    it("lets go of a held shape another session removes", async () => {
      const { page, state, cursors } = await open();
      const shape = shapeElement("a")!;
      pointer(shape, "pointerdown", 150, 120);
      pointer(shape, "pointermove", 450, 320);
      await page.until(() => cursors.facets.has("drag"));

      state.value = { shapes: [{ ...storedShape("a", BOX), removed: true }] };
      await page.until(() =>
        shapeElement("a") === null && !cursors.facets.has("drag")
      );
      await page.settled();

      expect(state.writes).toEqual([]);
    });

    it("shows why a moved shape could not be stored, and returns it", async () => {
      const { page, state } = await open();
      const shape = shapeElement("a")!;
      state.failWrites(new Error("Move refused."));

      pointer(shape, "pointerdown", 150, 120);
      pointer(shape, "pointermove", 450, 320);
      pointer(shape, "pointerup", 450, 320);
      const alert = document.querySelector('[role="alert"]')!;
      await page.until(() => alert.textContent !== "");

      expect(alert.textContent).toContain("Move refused.");
      expect(shape.style.transform).toBe("translate(100px, 100px)");
    });
  });

  describe("presence", () => {
    it("publishes the visitor name it goes by, and says it is alone", async () => {
      const { page, cursors } = await open();
      const status = byTestId("presence-status");
      await page.until(() =>
        status.dataset.status === "live" && cursors.facets.has("user")
      );

      expect(cursors.name).toMatch(/^Visitor \d{3}$/);
      expect(byTestId("display-name").value).toBe(cursors.name);
      expect(cursors.facets.get("user")).toEqual({
        hue: expect.any(Number),
      });
      expect(status.textContent).toBe("Live · only you");
    });

    it("goes by the name and hue the user stored", async () => {
      const { page, cursors } = await open({
        output: new MemoryCell({ displayName: "Ada", hue: 40 }),
      });
      await page.until(() =>
        cursors.name === "Ada" && cursors.facets.has("user")
      );

      expect(cursors.facets.get("user")).toEqual({ hue: 40 });
      expect(byTestId("display-name").value).toBe("Ada");
    });

    it("stores a name the user types, with the hue the page goes by", async () => {
      const { page, output, cursors } = await open();
      await page.until(() => cursors.facets.has("user"));
      const hue = (cursors.facets.get("user") as { hue: number }).hue;
      const field = byTestId("display-name");

      field.value = "  Grace  ";
      const write = output.nextWrite();
      field.dispatchEvent(new Event("change"));
      await write;
      await page.until(() => cursors.name === "Grace");

      expect(output.value).toEqual({ displayName: "Grace", hue });
      expect(field.value).toBe("Grace");
    });

    it("stores nothing for a name that is unchanged or blank", async () => {
      const { page, output, cursors } = await open();
      await page.until(() => cursors.name !== undefined);
      const field = byTestId("display-name");
      const name = field.value;

      field.value = "   ";
      field.dispatchEvent(new Event("change"));
      await page.settled();

      expect(field.value).toBe(name);
      expect(output.writes).toEqual([]);
    });

    it("stores no name changed before the board loads", async () => {
      const state = new MemoryCell();
      state.failReads(new Error("The board is unreadable."));
      const output = new MemoryCell({ displayName: "", hue: null });
      page = await openGuestPage({
        guest: GUEST,
        html: HTML,
        resources: {
          input: new MemoryCell({ title: "x" }).resource(),
          state: state.resource(),
          output: output.resource(),
          cursors: new MemoryPresenceRoom().resource(),
        },
      });
      const alert = document.querySelector('[role="alert"]')!;
      await page.until(() => alert.textContent !== "");
      const field = byTestId("display-name");

      field.value = "Grace";
      field.dispatchEvent(new Event("change"));
      await page.settled();

      expect(output.writes).toEqual([]);
    });

    it("shows why a name could not be stored", async () => {
      const { page, output } = await open();
      output.failWrites(new Error("Name refused."));
      const field = byTestId("display-name");

      field.value = "Grace";
      field.dispatchEvent(new Event("change"));
      const alert = document.querySelector('[role="alert"]')!;
      await page.until(() => alert.textContent !== "");

      expect(alert.textContent).toContain("Name refused.");
    });

    it("commits the name field on Enter", async () => {
      const { page } = await open();
      const field = byTestId("display-name");
      field.focus();
      await page.until(() => document.activeElement === field);

      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

      expect(document.activeElement).not.toBe(field);
    });

    it("publishes where the pointer is on the board, and clears it on leaving", async () => {
      const { page, cursors } = await open();
      const board = byTestId("board");
      await page.until(() =>
        byTestId("presence-status").dataset.status === "live"
      );

      pointer(board, "pointermove", 2000, -5);
      await page.until(() => cursors.facets.has("pointer"));
      expect(cursors.facets.get("pointer")).toEqual({ x: 1600, y: 0 });

      board.dispatchEvent(new PointerEvent("pointerleave"));
      await page.until(() => !cursors.facets.has("pointer"));
    });

    it("shows each peer in the roster and draws the pointers of those on the board", async () => {
      const { page, cursors } = await open();
      await page.until(() =>
        byTestId("presence-status").dataset.status === "live"
      );

      cursors.upsert({
        participantId: "p1",
        name: "Grace",
        facets: { pointer: { x: 10, y: 20 }, user: { hue: 120 } },
      });
      cursors.upsert({ participantId: "p2", name: "Linus", facets: {} });
      await page.until(() => allByTestId("participant").length === 2);

      expect(allByTestId("participant").map((entry) => entry.textContent))
        .toEqual(["Grace", "Linus"]);
      const drawn = allByTestId("peer-cursor");
      expect(drawn.map((cursor) => cursor.dataset.name)).toEqual(["Grace"]);
      expect(drawn[0].style.transform).toBe("translate(10px, 20px)");
      expect(byTestId("presence-status").textContent).toBe("Live · 3 here");

      cursors.remove("p1");
      await page.until(() => allByTestId("participant").length === 1);
      expect(allByTestId("peer-cursor")).toEqual([]);
    });

    it("shows a shape where the peer holding it has it, marked with who", async () => {
      const { page, cursors } = await open();
      await page.until(() =>
        byTestId("presence-status").dataset.status === "live"
      );

      cursors.upsert({
        participantId: "p1",
        name: "Grace",
        facets: {
          drag: {
            id: "a",
            position: { x: 500, y: 400 },
            width: 80,
            height: 60,
          },
        },
      });
      const shape = shapeElement("a")!;
      await page.until(() => shape.dataset.heldBy === "Grace");
      expect(shape.style.transform).toBe("translate(500px, 400px)");
      expect(shape.style.width).toBe("80px");

      cursors.upsert({
        participantId: "p1",
        name: "Grace",
        facets: { drag: { id: "a", position: { x: 20, y: 30 } } },
      });
      await page.until(() => shape.style.transform === "translate(20px, 30px)");
      expect(shape.style.width).toBe("200px");

      cursors.upsert({ participantId: "p1", name: "Grace", facets: {} });
      await page.until(() => shape.dataset.heldBy === undefined);
      expect(shape.style.transform).toBe("translate(100px, 100px)");
    });

    it("reports a host that offers no live cursors, and stays unjoined", async () => {
      const cursors = new MemoryPresenceRoom({
        refusal: "presence-unsupported",
      });
      const { page } = await open({ cursors });
      const status = byTestId("presence-status");
      await page.until(() => status.dataset.status === "unsupported");

      expect(status.textContent).toBe("Live cursors unavailable");
      byTestId("board").dispatchEvent(new PointerEvent("pointerenter"));
      const shape = shapeElement("a")!;
      pointer(shape, "pointerdown", 150, 120);
      pointer(shape, "pointermove", 450, 320);
      pointer(shape, "pointercancel", 450, 320);
      await page.settled();
      expect(status.dataset.status).toBe("unsupported");
      expect(cursors.joins).toBe(1);
      expect(cursors.facets.size).toBe(0);
    });

    it("pauses live cursors when the room is lost, and rejoins on the user's return", async () => {
      const { page, cursors } = await open();
      const status = byTestId("presence-status");
      await page.until(() => status.dataset.status === "live");
      cursors.upsert({ participantId: "p1", name: "Grace", facets: {} });
      await page.until(() => allByTestId("participant").length === 1);

      cursors.fail("presence-disconnected");
      await page.until(() => status.dataset.status === "lost");
      expect(status.textContent).toBe("Live cursors paused");
      expect(allByTestId("participant")).toEqual([]);
      pointer(byTestId("board"), "pointermove", 10, 10);
      await page.settled();
      expect(cursors.facets.has("pointer")).toBe(false);

      byTestId("board").dispatchEvent(new PointerEvent("pointerenter"));
      await page.until(() => status.dataset.status === "live");
      expect(cursors.joins).toBe(2);
    });
  });
});
