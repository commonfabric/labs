import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { toFileUrl } from "@std/path";
import { Window } from "happy-dom";
import type { BridgeCell, BridgeMethod } from "@commonfabric/iframe-sandbox";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  ManualFrames,
  MemoryCell,
  MemorySqlite,
  openGuestPage,
  patchProperty,
  taskTurn,
} from "./iframe-guest.ts";

/** Returns the cell a resource grants, failing the test for one with none. */
function cellOf(cell: MemoryCell): BridgeCell {
  const granted = cell.resource().cell;
  if (!granted) throw new Error("The resource grants no cell.");
  return granted;
}

/** Writes a guest module whose source is `source`, and returns its address. */
async function guestModule(source: string): Promise<URL> {
  const file = await Deno.makeTempFile({ suffix: ".js" });
  guestFiles.push(file);
  await Deno.writeTextFile(file, source);
  return toFileUrl(file);
}

/** The guest modules the tests wrote, which go once each test is done. */
const guestFiles: string[] = [];

/** Resolves once the event loop has run `count` turns of tasks. */
async function taskTurns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn++) await taskTurn();
}

/** Returns the SQLite method `name` a database grants. */
function methodOf(database: MemorySqlite, name: string): BridgeMethod {
  const method = database.resource().methods?.[name];
  if (!method) throw new Error(`The resource grants no \`${name}\`.`);
  return method;
}

describe("iframe-guest", () => {
  afterEach(async () => {
    for (const file of guestFiles.splice(0)) await Deno.remove(file);
  });

  describe("MemoryCell", () => {
    it("throws for a value the data model cannot store", () => {
      expect(() => new MemoryCell({ callback: () => {} })).toThrow(
        "A cell holds only values the data model can store.",
      );
    });

    it("reads nothing past the end of its value", () => {
      const cell = cellOf(new MemoryCell({ count: 1 }));

      expect(cell.key?.("count").key?.("digits").get()).toBeUndefined();
      expect(cell.key?.("missing").get()).toBeUndefined();
    });

    it("refuses a write into a value that holds no fields", () => {
      const memory = new MemoryCell({ count: 1 });
      const cell = cellOf(memory);

      expect(() => cell.key?.("count").key?.("digits").set?.(2)).toThrow(
        "Cannot write `digits` into a non-container value.",
      );
      expect(memory.value).toEqual({ count: 1 });
      expect(memory.writes).toEqual([]);
    });

    it("refuses to append to a value that is not a list", () => {
      const memory = new MemoryCell({ count: 1 });

      expect(() => cellOf(memory).key?.("count").push?.([2])).toThrow(
        "push() requires an array value.",
      );
      expect(memory.writes).toEqual([]);
    });

    it("appends to a list inside its value, and records the write", () => {
      const memory = new MemoryCell({ items: [{ id: 1 }] });

      cellOf(memory).key?.("items").push?.([{ id: 2 }]);

      expect(memory.value).toEqual({ items: [{ id: 1 }, { id: 2 }] });
      expect(memory.writes).toEqual([{
        operation: "push",
        path: ["items"],
        value: [{ id: 2 }],
      }]);
    });
  });

  describe("MemorySqlite", () => {
    it("binds named parameters by name", async () => {
      const sqlite = new MemorySqlite();
      sqlite.database.exec("CREATE TABLE notes (id INTEGER, text TEXT)");
      const exec = methodOf(sqlite, "exec");
      const query = methodOf(sqlite, "query");

      await exec({
        sql: "INSERT INTO notes VALUES (:id, :text)",
        namedParams: [["id", 7], ["text", "seven"]],
      });

      expect(
        await query({
          sql: "SELECT text FROM notes WHERE id = ?",
          params: [7],
        }),
      ).toEqual({ rows: [[["text", "seven"]]] });
    });

    it("throws for an operation with no statement", () => {
      expect(() => methodOf(new MemorySqlite(), "query")({ params: [] }))
        .toThrow("A SQLite operation is an object with `sql` text.");
    });

    it("throws for a bind value SQLite cannot take", () => {
      expect(() =>
        methodOf(new MemorySqlite(), "query")({
          sql: "SELECT ?",
          params: [{ nested: true }],
        })
      ).toThrow("A SQLite bind value is a string, number, bigint");
    });

    it("throws for an operation carrying both kinds of parameter", () => {
      expect(() =>
        methodOf(new MemorySqlite(), "query")({
          sql: "SELECT ?",
          params: [1],
          namedParams: [["a", 2]],
        })
      ).toThrow("carries positional or named parameters, not both");
    });

    it("throws for a named parameter that is not a name and a value", () => {
      expect(() =>
        methodOf(new MemorySqlite(), "query")({
          sql: "SELECT :a",
          namedParams: [[1, 2]],
        })
      ).toThrow("A named SQLite parameter is a [name, value] pair.");
    });
  });

  describe("document events", () => {
    it("dispatches an event Deno constructs to the document's listeners", async () => {
      const window = new Window();
      const target = window.document.createElement("div");
      const heard: string[] = [];
      target.addEventListener("ping", (event) => heard.push(event.type));

      const dispatched = Reflect.apply(target.dispatchEvent, target, [
        new Event("ping"),
      ]);

      expect(dispatched).toBe(true);
      expect(heard).toEqual(["ping"]);
      await window.happyDOM.close();
    });

    it("throws for a dispatch of a Deno event class whose fields a copy would lose", async () => {
      const window = new Window();
      const target = window.document.createElement("div");

      expect(() =>
        Reflect.apply(target.dispatchEvent, target, [
          new ErrorEvent("error", { message: "lost" }),
        ])
      ).toThrow("A ErrorEvent cannot be dispatched on the document.");
      await window.happyDOM.close();
    });

    it("throws for a dispatch of something that is not an event", async () => {
      const window = new Window();
      const target = window.document.createElement("div");

      expect(() => Reflect.apply(target.dispatchEvent, target, [{}])).toThrow(
        "Only an event can be dispatched.",
      );
      await window.happyDOM.close();
    });
  });

  describe("MemoryCell reads", () => {
    it("holds a pulled read back until released", async () => {
      const memory = new MemoryCell({ count: 1 });
      const release = memory.holdReads();
      let read: unknown = "pending";

      const pulled = Promise.resolve(cellOf(memory).pull()).then((value) =>
        read = value
      );
      await taskTurns(3);
      expect(read).toBe("pending");
      release();
      await pulled;

      expect(read).toEqual({ count: 1 });
    });

    it("tells a sink only of writes that change its value", () => {
      const memory = new MemoryCell({ left: 1, right: 2 });
      const heard: unknown[] = [];
      cellOf(memory).key?.("left").sink?.(
        (value) => heard.push(value),
        () => {},
      );

      cellOf(memory).key?.("right").set?.(3);
      cellOf(memory).key?.("left").set?.(4);

      expect(heard).toEqual([1, 4]);
    });
  });

  describe("patchProperty()", () => {
    it("replaces a property until the page open then closes", async () => {
      const target: { label?: string } = { label: "original" };
      const page = await openGuestPage({
        guest: await guestModule(""),
        html: "<!doctype html><html><body></body></html>",
        resources: {},
      });

      patchProperty(target, "label", { value: "patched" });
      expect(target.label).toBe("patched");
      await page.close();

      expect(target.label).toBe("original");
    });

    it("removes a property it added once the page closes", async () => {
      const target: { label?: string } = {};
      const page = await openGuestPage({
        guest: await guestModule(""),
        html: "<!doctype html><html><body></body></html>",
        resources: {},
      });

      patchProperty(target, "label", { value: "added" });
      await page.close();

      expect(Object.hasOwn(target, "label")).toBe(false);
    });
  });

  describe("ManualFrames", () => {
    it("runs the frames asked for only when told, each later than the last", () => {
      const frames = new ManualFrames();
      const times: number[] = [];
      frames.request((time) => times.push(time));
      const cancelled = frames.request(() => times.push(-1));
      frames.cancel(cancelled);

      expect(frames.pending).toBe(true);
      frames.run();
      frames.request((time) => times.push(time));
      frames.run();

      expect(frames.pending).toBe(false);
      expect(times).toHaveLength(2);
      expect(times[1]).toBeGreaterThan(times[0]);
    });
  });

  describe("GuestPage", () => {
    it("rejects a wait whose condition throws", async () => {
      const page = await openGuestPage({
        guest: await guestModule(""),
        html: "<!doctype html><html><body></body></html>",
        resources: {},
      });

      await expect(page.until(() => {
        throw new Error("No such element.");
      })).rejects.toThrow("No such element.");
      await page.close();
    });

    it("rejects a wait still pending when the page closes", async () => {
      const page = await openGuestPage({
        guest: await guestModule(""),
        html: "<!doctype html><html><body></body></html>",
        resources: {},
      });

      const waiting = expect(page.until(() => false)).rejects.toThrow(
        "The page closed before the condition held.",
      );
      await page.close();

      await waiting;
    });

    it("settles only once the host has answered a held read", async () => {
      const cell = new MemoryCell({ count: 1 });
      const release = cell.holdReads();
      const page = await openGuestPage({
        guest: await guestModule(`
          import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
          const counter = connectFabric().cell("counter");
          void counter.pull().then((value) => {
            document.body.textContent = String(value.count);
          });
        `),
        html: "<!doctype html><html><body></body></html>",
        resources: { counter: cell.resource() },
      });
      let settled = false;

      const settling = page.settled().then(() => settled = true);
      await taskTurns(3);
      expect(settled).toBe(false);
      release();
      await settling;

      expect(document.body.textContent).toBe("1");
      await page.close();
    });

    it("rejects a wait begun after the page closed", async () => {
      const page = await openGuestPage({
        guest: await guestModule(""),
        html: "<!doctype html><html><body></body></html>",
        resources: {},
      });
      await page.close();

      await expect(page.until(() => false)).rejects.toThrow(
        "The page closed before the condition held.",
      );
    });

    it("settles once the page closes with a read still held", async () => {
      const cell = new MemoryCell({ count: 1 });
      cell.holdReads();
      const page = await openGuestPage({
        guest: await guestModule(`
          import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
          void connectFabric().cell("counter").pull().catch(() => {});
        `),
        html: "<!doctype html><html><body></body></html>",
        resources: { counter: cell.resource() },
      });

      const settling = page.settled();
      await page.close();

      await settling;
    });

    it("settles once a guest disconnects with a read still held", async () => {
      const cell = new MemoryCell({ count: 1 });
      cell.holdReads();
      const page = await openGuestPage({
        guest: await guestModule(`
          import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
          const fabric = connectFabric();
          void fabric.cell("counter").pull().catch(() => {});
          document.body.addEventListener("click", () => fabric.disconnect());
        `),
        html: "<!doctype html><html><body></body></html>",
        resources: { counter: cell.resource() },
      });
      await taskTurns(3);

      document.body.click();
      await page.settled();

      await page.close();
    });

    it("waits for a write the guest sends as soon as an answer arrives", async () => {
      const cell = new MemoryCell({ count: 1 });
      const page = await openGuestPage({
        guest: await guestModule(`
          import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
          const counter = connectFabric().cell("counter");
          document.body.addEventListener("click", () => {
            void counter.pull().then((value) =>
              counter.set({ count: value.count + 1 })
            );
          });
        `),
        html: "<!doctype html><html><body></body></html>",
        resources: { counter: cell.resource() },
      });
      await page.settled();

      document.body.click();
      await page.settled();

      expect(cell.value).toEqual({ count: 2 });
      await page.close();
    });

    it("carries bytes across the bridge in both directions", async () => {
      const cell = new MemoryCell({
        bytes: new FabricBytes(new Uint8Array([1, 2])),
      });
      const page = await openGuestPage({
        guest: await guestModule(`
          import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
          import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
          const counter = connectFabric().cell("counter");
          void counter.pull().then(async (value) => {
            const bytes = value.bytes.slice();
            await counter.set({ bytes: new FabricBytes(new Uint8Array([...bytes, 3])) });
            document.body.textContent = String(bytes.length);
          });
        `),
        html: "<!doctype html><html><body></body></html>",
        resources: { counter: cell.resource() },
      });

      await page.until(() => document.body.textContent === "2");
      await page.settled();

      expect(cell.value).toEqual({
        bytes: new FabricBytes(new Uint8Array([1, 2, 3])),
      });
      await page.close();
    });

    it("records the errors a guest reports to its frame", async () => {
      const page = await openGuestPage({
        guest: await guestModule(
          'parent.postMessage({ type: "error", data: { description: "Broke", source: "guest", lineno: 1, colno: 2, stacktrace: "" } }, "*");',
        ),
        html: "<!doctype html><html><body></body></html>",
        resources: {},
      });

      expect(page.alarms).toEqual([{
        description: "Broke",
        source: "guest",
        lineno: 1,
        colno: 2,
        stacktrace: "",
      }]);
      await page.close();
    });
  });
});
