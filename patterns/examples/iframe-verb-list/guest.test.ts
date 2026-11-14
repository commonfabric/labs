import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { isFabricPlainObject } from "@commonfabric/data-model";
import type { BridgeResource } from "@commonfabric/iframe-sandbox";

import {
  type GuestPage,
  MemoryCell,
  openGuestPage,
} from "../../tools/test-support/iframe-guest.ts";
import type { AddItemEvent, ListItem } from "./contract.ts";

const GUEST = new URL("./guest.ts", import.meta.url);
const HTML = new URL("./guest.html", import.meta.url);

/**
 * The pattern's `addItem` verb as the guest reaches it: each event it is sent
 * is recorded, and answered by `answer`, which by default adds the item to
 * `items` the way the pattern does.
 */
class AddItemVerb {
  readonly #events: AddItemEvent[] = [];
  #answer: (event: AddItemEvent) => Promise<void> | void;

  constructor(items: MemoryCell) {
    this.#answer = ({ id, text }) => {
      const list = Array.isArray(items.value) ? items.value : [];
      items.value = [...list, { id, text }];
    };
  }

  /** The events the guest sent, in order. */
  get events(): readonly AddItemEvent[] {
    return this.#events;
  }

  /** Replaces what the verb does with each later event. */
  set answer(answer: (event: AddItemEvent) => Promise<void> | void) {
    this.#answer = answer;
  }

  resource(): BridgeResource {
    return {
      kind: "stream",
      methods: {
        send: async (input) => {
          if (
            !isFabricPlainObject(input) || typeof input.id !== "string" ||
            typeof input.text !== "string"
          ) {
            throw new TypeError("addItem takes an id and a text.");
          }
          const event = { id: input.id, text: input.text };
          this.#events.push(event);
          await this.#answer(event);
          return undefined;
        },
      },
    };
  }
}

const MILK: ListItem = { id: "milk", text: "Milk" };
const EGGS: ListItem = { id: "eggs", text: "Eggs" };

describe("iframe-verb-list/guest", () => {
  let page: GuestPage | undefined;

  afterEach(async () => {
    await page?.close();
    page = undefined;
  });

  /** Opens the list, by default empty, and resolves once it has hydrated. */
  async function open(options: {
    items?: MemoryCell;
    checked?: MemoryCell;
    output?: MemoryCell;
  } = {}) {
    const items = options.items ?? new MemoryCell([], { readonly: true });
    const checked = options.checked ?? new MemoryCell({});
    const output = options.output ?? new MemoryCell({ hideChecked: false });
    const addItem = new AddItemVerb(items);
    page = await openGuestPage({
      guest: GUEST,
      html: HTML,
      resources: {
        items: items.resource(),
        checked: checked.resource(),
        output: output.resource(),
        addItem: addItem.resource(),
      },
    });
    const opened = page;
    await opened.until(() => !field().disabled);
    return { page: opened, items, checked, output, addItem };
  }

  function byId<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = document.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`No element has the id \`${id}\`.`);
    return element;
  }

  const field = () => byId<HTMLInputElement>("new-item");
  const addButton = () => byId<HTMLButtonElement>("add");
  const hideBox = () => byId<HTMLInputElement>("hide-checked");
  const statusText = () => byId("status").textContent;
  const errorText = () => byId("error").textContent;

  function rows(): HTMLLIElement[] {
    return [...byId("items").querySelectorAll("li")];
  }

  function rowTexts(): string[] {
    return rows().map((row) => {
      const label = row.querySelector("span");
      if (!label) throw new Error("A row of the list has no label.");
      return label.textContent ?? "";
    });
  }

  function boxFor(id: string): HTMLInputElement {
    const box = document.querySelector<HTMLInputElement>(
      `li[data-item-id="${id}"] input`,
    );
    if (!box) throw new Error(`No row shows the item \`${id}\`.`);
    return box;
  }

  /** Types `text` into the new item field, as a person would. */
  function type(text: string): void {
    field().value = text;
    field().dispatchEvent(new Event("input"));
  }

  /** Whether no `addItem` event is on its way. */
  function idle(): boolean {
    return byId("add-row").getAttribute("aria-busy") === "false";
  }

  function toggle(box: HTMLInputElement): void {
    box.checked = !box.checked;
    box.dispatchEvent(new Event("change"));
  }

  describe("startup", () => {
    it("says the list is empty, and offers no Add for an empty field", async () => {
      await open();

      expect(statusText()).toBe("Nothing on the list yet.");
      expect(rows()).toEqual([]);
      expect(addButton().disabled).toBe(true);
      expect(hideBox().disabled).toBe(false);
    });

    it("shows the stored items with their check marks and counts them", async () => {
      await open({
        items: new MemoryCell([MILK, EGGS], { readonly: true }),
        checked: new MemoryCell({ eggs: true }),
      });

      expect(rowTexts()).toEqual(["Milk", "Eggs"]);
      expect(boxFor("milk").checked).toBe(false);
      expect(boxFor("eggs").checked).toBe(true);
      expect(boxFor("eggs").disabled).toBe(false);
      expect(rows()[1].hasAttribute("data-checked")).toBe(true);
      expect(rows()[0].hasAttribute("data-checked")).toBe(false);
      expect(statusText()).toBe("2 items, 1 checked off.");
    });

    it("counts a single item in the singular", async () => {
      await open({ items: new MemoryCell([MILK], { readonly: true }) });

      expect(statusText()).toBe("1 item, 0 checked off.");
    });

    it("reads resources that hold nothing as an empty list", async () => {
      const { page, checked, output } = await open({
        items: new MemoryCell(undefined, { readonly: true }),
        checked: new MemoryCell(),
        output: new MemoryCell(),
      });
      await page.settled();

      expect(statusText()).toBe("Nothing on the list yet.");
      expect(hideBox().checked).toBe(false);
      expect(checked.writes).toEqual([]);
      expect(output.writes).toEqual([]);
    });

    it("shows Loading and keeps its controls off until every resource answers", async () => {
      const items = new MemoryCell([MILK], { readonly: true });
      const release = items.holdReads();
      page = await openGuestPage({
        guest: GUEST,
        html: HTML,
        resources: {
          items: items.resource(),
          checked: new MemoryCell({}).resource(),
          output: new MemoryCell({ hideChecked: false }).resource(),
          addItem: new AddItemVerb(items).resource(),
        },
      });
      const opened = page;
      await opened.until(() => rows().length === 1);

      expect(statusText()).toBe("Loading…");
      expect(field().disabled).toBe(true);
      expect(hideBox().disabled).toBe(true);
      expect(boxFor("milk").disabled).toBe(true);

      release();
      await opened.until(() => !field().disabled);
      expect(statusText()).toBe("1 item, 0 checked off.");
      expect(boxFor("milk").disabled).toBe(false);
    });

    it("shows why it could not load the list, and keeps its controls off", async () => {
      const items = new MemoryCell([], { readonly: true });
      items.failReads(new Error("The list is unreadable."));
      page = await openGuestPage({
        guest: GUEST,
        html: HTML,
        resources: {
          items: items.resource(),
          checked: new MemoryCell({}).resource(),
          output: new MemoryCell({ hideChecked: false }).resource(),
          addItem: new AddItemVerb(items).resource(),
        },
      });
      await page.until(() => errorText() !== "");

      expect(errorText()).toContain("The list is unreadable.");
      expect(statusText()).toBe("Loading…");
      expect(field().disabled).toBe(true);
    });
  });

  describe("adding items", () => {
    it("sends the trimmed text with a fresh id, clears the field, and shows the item the pattern adds", async () => {
      const { page, addItem } = await open();

      type("  Milk  ");
      expect(addButton().disabled).toBe(false);
      addButton().click();
      expect(idle()).toBe(false);
      await page.until(() => rows().length === 1 && idle());

      expect(field().value).toBe("");
      expect(addItem.events).toHaveLength(1);
      expect(addItem.events[0].text).toBe("Milk");
      expect(addItem.events[0].id).toMatch(/^[0-9a-f-]{36}$/);
      expect(rowTexts()).toEqual(["Milk"]);
      expect(rows()[0].dataset.itemId).toBe(addItem.events[0].id);
      expect(statusText()).toBe("1 item, 0 checked off.");
      expect(addButton().disabled).toBe(true);
      expect(document.activeElement).toBe(field());
    });

    it("gives the same text a different id each time it is added", async () => {
      const { page, addItem } = await open();

      type("Milk");
      addButton().click();
      await page.until(() => rows().length === 1 && idle());
      type("Milk");
      addButton().click();
      await page.until(() => rows().length === 2 && idle());

      expect(rowTexts()).toEqual(["Milk", "Milk"]);
      expect(addItem.events[0].id).not.toBe(addItem.events[1].id);
    });

    it("adds the item on the Enter key, and on no other", async () => {
      const { page, addItem } = await open();
      type("Eggs");

      field().dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      await page.settled();
      expect(addItem.events).toEqual([]);

      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await page.until(() => rows().length === 1 && idle());
      expect(addItem.events.map((event) => event.text)).toEqual(["Eggs"]);
    });

    it("sends nothing for a field holding only whitespace", async () => {
      const { page, addItem } = await open();
      type("   ");

      expect(addButton().disabled).toBe(true);
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await page.settled();

      expect(addItem.events).toEqual([]);
      expect(errorText()).toBe("");
    });

    it("marks the row busy and sends once while an item is on its way, and keeps a draft typed meanwhile", async () => {
      const { page, addItem, items } = await open();
      const answered = Promise.withResolvers<void>();
      addItem.answer = async (event) => {
        await answered.promise;
        items.value = [event];
      };

      type("Milk");
      addButton().click();
      expect(idle()).toBe(false);
      expect(addButton().disabled).toBe(true);
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      type("Eggs");
      expect(addButton().disabled).toBe(true);

      answered.resolve();
      await page.until(idle);
      expect(addItem.events.map((event) => event.text)).toEqual(["Milk"]);
      expect(rowTexts()).toEqual(["Milk"]);
      expect(field().value).toBe("Eggs");
      expect(addButton().disabled).toBe(false);
    });

    it("shows why an item could not be added, keeps the text, and clears the message on the next try", async () => {
      const { page, addItem } = await open();
      addItem.answer = () => {
        throw new Error("The list refused the item.");
      };

      type("Milk");
      addButton().click();
      await page.until(() => errorText() !== "" && idle());

      expect(errorText()).toContain("The list refused the item.");
      expect(field().value).toBe("Milk");
      expect(rows()).toEqual([]);

      addItem.answer = () => {};
      addButton().click();
      expect(errorText()).toBe("");
      await page.until(idle);
      expect(addItem.events).toHaveLength(2);
    });
  });

  describe("checking items off", () => {
    it("stores a check mark by item id, storing the empty record first when there is none", async () => {
      const checked = new MemoryCell();
      const { page } = await open({
        items: new MemoryCell([MILK, EGGS], { readonly: true }),
        checked,
      });

      toggle(boxFor("eggs"));
      await page.until(() => rows()[1].hasAttribute("data-checked"));
      await page.settled();

      expect(checked.value).toEqual({ eggs: true });
      expect(checked.writes.map(({ operation, path }) => [operation, path]))
        .toEqual([["initialize", []], ["set", ["eggs"]]]);
      expect(statusText()).toBe("2 items, 1 checked off.");
    });

    it("clears a check mark", async () => {
      const checked = new MemoryCell({ milk: true });
      const { page } = await open({
        items: new MemoryCell([MILK], { readonly: true }),
        checked,
      });

      toggle(boxFor("milk"));
      await page.until(() => !rows()[0].hasAttribute("data-checked"));
      await page.settled();

      expect(checked.value).toEqual({ milk: false });
      expect(statusText()).toBe("1 item, 0 checked off.");
    });

    it("shows why a check mark could not be stored, and shows the item as it is stored", async () => {
      const checked = new MemoryCell({});
      const { page } = await open({
        items: new MemoryCell([MILK], { readonly: true }),
        checked,
      });
      checked.failWrites(new Error("Check marks are read-only."));

      toggle(boxFor("milk"));
      await page.until(() => errorText() !== "");

      expect(errorText()).toContain("Check marks are read-only.");
      expect(boxFor("milk").checked).toBe(false);
      expect(checked.value).toEqual({});
    });
  });

  describe("hiding checked items", () => {
    it("stores the choice and hides only the checked items", async () => {
      const output = new MemoryCell();
      const { page } = await open({
        items: new MemoryCell([MILK, EGGS], { readonly: true }),
        checked: new MemoryCell({ eggs: true }),
        output,
      });
      expect(rows().map((row) => row.hidden)).toEqual([false, false]);

      toggle(hideBox());
      await page.until(() => rows()[1].hidden === true);
      await page.settled();

      expect(output.value).toEqual({ hideChecked: true });
      expect(output.writes.map(({ operation, path }) => [operation, path]))
        .toEqual([["initialize", []], ["set", ["hideChecked"]]]);
      expect(rows()[0].hidden).toBe(false);
      expect(hideBox().checked).toBe(true);
    });

    it("follows the choice another viewer stores", async () => {
      const output = new MemoryCell({ hideChecked: false });
      const { page } = await open({
        items: new MemoryCell([MILK], { readonly: true }),
        checked: new MemoryCell({ milk: true }),
        output,
      });

      output.value = { hideChecked: true };
      await page.until(() => rows()[0].hidden === true);

      expect(hideBox().checked).toBe(true);
    });

    it("shows why the choice could not be stored, and keeps the box as stored", async () => {
      const output = new MemoryCell({ hideChecked: false });
      const { page } = await open({ output });
      output.failWrites(new Error("The choice is read-only."));

      toggle(hideBox());
      await page.until(() => errorText() !== "");

      expect(errorText()).toContain("The choice is read-only.");
      expect(hideBox().checked).toBe(false);
    });
  });

  describe("changes from other sessions", () => {
    it("drops a removed item's row and keeps the rest in the stored order", async () => {
      const items = new MemoryCell([MILK, EGGS], { readonly: true });
      const { page } = await open({ items });
      const eggsRow = rows()[1];

      const bread = { id: "bread", text: "Bread" };
      items.value = [bread, EGGS];
      await page.until(() => rowTexts().join() === "Bread,Eggs");

      expect(rows()[1]).toBe(eggsRow);
      expect(document.querySelector('li[data-item-id="milk"]')).toBeNull();
      expect(statusText()).toBe("2 items, 0 checked off.");
    });

    it("shows an item's edited text", async () => {
      const items = new MemoryCell([MILK], { readonly: true });
      const { page } = await open({ items });

      items.value = [{ id: "milk", text: "Oat milk" }];
      await page.until(() => rowTexts()[0] === "Oat milk");

      expect(rows()).toHaveLength(1);
    });
  });

  it("stops following the list once the page is hidden", async () => {
    const items = new MemoryCell([MILK], { readonly: true });
    const { page } = await open({ items });

    dispatchEvent(new Event("pagehide"));
    items.value = [MILK, EGGS];
    await page.settled();

    expect(rowTexts()).toEqual(["Milk"]);
  });
});
