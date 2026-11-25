import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance, type StreamHeld } from "../executor.ts";

/** The pattern `name` of `compare/fixtures/row-event-reference.tsx`. */
const artifact = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../compare/fixtures/row-event-reference.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === name)!;
};

const TITLES = ["a", "b", "c"];

/**
 * Three items, each a document of its own: an array of references. With
 * `queue`, the events that handlers send are queued for the caller to take.
 */
const referenced = async (name: string, queue = false) => {
  const documents = TITLES.map((title) => ({
    id: `item-${title}`,
    kind: "item",
    value: { title, done: false },
  }));
  return new Instance(
    await artifact(name),
    {
      items: documents.map(({ id }) => ({ $link: { doc: id, path: [] } })),
      pinned: [],
    },
    queue ? { documents, events: "queue" } : { documents },
  );
};

/** Three items in place in the argument: an array of plain values. */
const inPlace = async (name: string) =>
  new Instance(await artifact(name), {
    items: TITLES.map((title) => ({ title, done: false })),
    pinned: [],
  });

/** The position of each button of a row among the children of its view. */
const BUTTONS = { remove: 1, pin: 2, note: 3 } as const;

type Button = keyof typeof BUTTONS;

/** The stream of the button `button` of the row at `row`. */
const rowButton = (
  instance: Instance,
  row: number,
  button: Button,
): StreamHeld =>
  instance.streams().find(({ path }) =>
    path[0] === "rows" && path[1] === `${row}` &&
    path.join("/").endsWith(`$UI/children/${BUTTONS[button]}/props/onClick`)
  )!;

/** Clicks the button `button` of the row at `row`. */
const click = (instance: Instance, row: number, button: Button) => {
  const stream = rowButton(instance, row, button);
  return instance.send(stream.binding, {}, stream.elements);
};

/** The titles of the items the list holds now. */
const titles = (instance: Instance) =>
  (instance.result() as { items: { title: string }[] }).items.map((item) =>
    item.title
  );

/** The stream `name` of the list. */
const listStream = (instance: Instance, name: string): StreamHeld =>
  instance.streams().find(({ path }) => path.join("/") === name)!;

/** The title the list noted last. */
const noted = (instance: Instance) =>
  (instance.result() as { last: string }).last;

/** The titles of the items the list has pinned. */
const pinned = (instance: Instance) =>
  (instance.result() as { pinned: { title: string }[] }).pinned.map((item) =>
    item.title
  );

describe("an event that carries the reference to an element of a list", () => {
  it("is queued by a row's handler with the reference to the row's item as a link", async () => {
    const instance = await referenced("Filtered", true);
    const stream = rowButton(instance, 1, "remove");

    instance.handleEvent(
      { binding: stream.binding, keys: [...stream.keys] },
      {},
    );

    expect(instance.takeQueued().map(({ event }) => event)).toEqual([
      { item: { $link: { doc: "item-b", path: [] } } },
    ]);
  });

  it("removes the element that an event from outside names by a link", async () => {
    const instance = await referenced("Filtered");
    const outcome = instance.send(listStream(instance, "removeItem").binding, {
      item: { $link: { doc: "item-c", path: [] } },
    });

    expect(outcome.committed).toBe(true);
    expect(titles(instance)).toEqual(["a", "b"]);
  });

  it("hands a handler the value read through a link that an event from outside holds", async () => {
    const instance = await referenced("Filtered");

    const outcome = instance.send(listStream(instance, "noteItem").binding, {
      item: { $link: { doc: "item-b", path: [] } },
    });

    expect(outcome.committed).toBe(true);
    expect(noted(instance)).toBe("b");
  });

  for (const name of ["Filtered", "Direct"]) {
    it(`removes the item of a row whose button sends it, over an array of references (${name})`, async () => {
      const instance = await referenced(name);

      expect(click(instance, 1, "remove").committed).toBe(true);

      expect(titles(instance)).toEqual(["a", "c"]);
    });

    it(`pins the item of a row once however often its button sends it, over an array of references (${name})`, async () => {
      const instance = await referenced(name);

      click(instance, 2, "pin");
      click(instance, 2, "pin");
      click(instance, 0, "pin");

      expect(pinned(instance)).toEqual(["c", "a"]);
    });

    it(`hands the list the title of the item of a row whose button sends it, over an array of references (${name})`, async () => {
      const instance = await referenced(name);

      expect(click(instance, 2, "note").committed).toBe(true);

      expect(noted(instance)).toBe("c");
    });
  }

  it("removes the item of a row whose button sends it, over an array of plain values in place", async () => {
    const instance = await inPlace("Direct");

    expect(click(instance, 1, "remove").committed).toBe(true);

    expect(titles(instance)).toEqual(["a", "c"]);
  });

  it("pins the item of a row once however often its button sends it, over an array of plain values in place", async () => {
    const instance = await inPlace("Direct");

    click(instance, 2, "pin");
    click(instance, 2, "pin");
    click(instance, 0, "pin");

    expect(pinned(instance)).toEqual(["c", "a"]);
  });

  it("hands the list the title of the item of a row whose button sends it, over an array of plain values in place", async () => {
    const instance = await inPlace("Direct");

    expect(click(instance, 2, "note").committed).toBe(true);

    expect(noted(instance)).toBe("c");
  });
});
