// First, so that the document it installs is there when Lit loads.
import { mount, settle, window } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import {
  createMockCellHandle,
  pushUpdate,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { defaultTheme, themeProperties } from "../theme-context.ts";
import { type AutocompleteItem, CFAutocomplete } from "./index.ts";

describe("CFAutocomplete", () => {
  let time: FakeTime;

  beforeEach(() => {
    time = new FakeTime();
  });
  afterEach(() => {
    time.restore();
    document.body.replaceChildren();
  });

  const fruit: AutocompleteItem[] = [
    { value: "apple-pie", label: "Apple Pie", group: "Dessert" },
    { value: "banana", searchAliases: ["yellow fruit"] },
    { value: "carrot", label: "Carrot", group: "Vegetable" },
  ];

  /** An autocomplete with `properties`, mounted in the document. */
  const autocomplete = (properties: Partial<CFAutocomplete>) =>
    mount(Object.assign(new CFAutocomplete(), properties));

  const inputOf = (element: CFAutocomplete) =>
    element.shadowRoot!.querySelector("input")!;

  const dropdownOf = (element: CFAutocomplete) =>
    element.shadowRoot!.querySelector<HTMLElement>("#dropdown")!;

  const optionsOf = (element: CFAutocomplete) => [
    ...element.shadowRoot!.querySelectorAll<HTMLElement>("[role=option]"),
  ];

  /** The text of each option the dropdown lists. */
  const listed = (element: CFAutocomplete) =>
    optionsOf(element).map((option) =>
      option.textContent!.replace(/\s+/g, " ").trim()
    );

  const isOpen = (element: CFAutocomplete) =>
    !dropdownOf(element).classList.contains("hidden");

  /** The text of the highlighted option, if one is. */
  const highlighted = (element: CFAutocomplete) =>
    element.shadowRoot!.querySelector(".option.highlighted")
      ?.querySelector(".option-label")?.textContent;

  /** Types `text` into the input, as the input's value, and lets it show. */
  const type = async (element: CFAutocomplete, text: string) => {
    const input = inputOf(element);
    input.value = text;
    input.dispatchEvent(new InputEvent("input"));
    time.tick(0);
    await element.updateComplete;
  };

  /** Presses `key` in the input, and returns the event it sent. */
  const press = async (element: CFAutocomplete, key: string) => {
    const event = new KeyboardEvent("keydown", { key, cancelable: true });
    inputOf(element).dispatchEvent(event);
    await element.updateComplete;
    return event;
  };

  /** Focuses the input, which opens the dropdown. */
  const focus = async (element: CFAutocomplete) => {
    element.focus();
    await element.updateComplete;
  };

  const click = async (element: CFAutocomplete, target: HTMLElement) => {
    target.click();
    await element.updateComplete;
  };

  /** The details of each `name` event `element` sends from now on. */
  const eventsFrom = (element: CFAutocomplete, name: string) => {
    const details: unknown[] = [];
    element.addEventListener(name, (event) => {
      details.push((event as CustomEvent).detail);
    });
    return details;
  };

  /** Lets the read a choice waits on answer, then its write go out. */
  const settleWrites = async () => {
    await time.runMicrotasks();
    time.tick(50);
  };

  describe("filtering", () => {
    it("lists every item, with its group, for an empty query", async () => {
      const element = await autocomplete({ items: fruit });
      await focus(element);

      expect(isOpen(element)).toBe(true);
      expect(listed(element)).toEqual([
        "Apple Pie Dessert",
        "banana",
        "Carrot Vegetable",
      ]);
    });

    it("lists the items one of whose words each query word begins", async () => {
      const element = await autocomplete({ items: fruit });
      await focus(element);

      await type(element, "PI");
      expect(listed(element)).toEqual(["Apple Pie Dessert"]);
      await type(element, "yel");
      expect(listed(element)).toEqual(["banana"]);
      await type(element, "veg car");
      expect(listed(element)).toEqual(["Carrot Vegetable"]);
      await type(element, "apple-p");
      expect(listed(element)).toEqual(["Apple Pie Dessert"]);
      await type(element, "--");
      expect(listed(element)).toHaveLength(3);
    });

    it("lists no item that a query word begins no word of", async () => {
      const element = await autocomplete({ items: fruit });
      await focus(element);

      await type(element, "ple");

      expect(listed(element)).toEqual([]);
      expect(
        element.shadowRoot!.querySelector(".empty-state")?.textContent,
      ).toBe("No matching options");
    });

    it("lists at most four items more than `maxVisible`", async () => {
      const items = ["a", "b", "c", "d", "e", "f", "g"].map((value) => ({
        value,
      }));
      const element = await autocomplete({ items, maxVisible: 1 });
      await focus(element);

      expect(listed(element)).toEqual(["a", "b", "c", "d", "e"]);
    });

    it("lists items that arrive while the query stands", async () => {
      const element = await autocomplete({ items: [{ value: "a" }] });
      await focus(element);
      expect(listed(element)).toEqual(["a"]);

      element.items = [{ value: "a" }, { value: "b" }];
      await element.updateComplete;

      expect(listed(element)).toEqual(["a", "b"]);
    });

    it("lists the items a bound cell holds", async () => {
      const items = createMockCellHandle<AutocompleteItem[]>([]);
      const element = await autocomplete({ items });
      await focus(element);

      pushUpdate(items, [{ value: "from-cell" }]);
      await element.updateComplete;

      expect(listed(element)).toEqual(["from-cell"]);
    });
  });

  describe("custom values", () => {
    it("lists the trimmed query as a custom value where `allowCustom` is set", async () => {
      const element = await autocomplete({ items: fruit, allowCustom: true });
      await focus(element);

      await type(element, " kiwi ");

      expect(listed(element)).toEqual(['Add "kiwi"']);
      expect(optionsOf(element)[0].classList.contains("custom")).toBe(true);
    });

    it("lists no custom value where `allowCustom` is not set", async () => {
      const element = await autocomplete({ items: fruit });
      await focus(element);

      await type(element, "kiwi");

      expect(listed(element)).toEqual([]);
    });

    it("lists no custom value for a query naming an item, whatever its case and surrounding spaces", async () => {
      const element = await autocomplete({ items: fruit, allowCustom: true });
      await focus(element);

      await type(element, " apple pie ");
      expect(listed(element)).toEqual(["Apple Pie Dessert"]);
      await type(element, "BANANA");
      expect(listed(element)).toEqual(["banana"]);
    });

    it("lists no custom value for a value a multi-select holds", async () => {
      const element = await autocomplete({
        allowCustom: true,
        multiple: true,
        value: ["kiwi"],
      });
      await focus(element);

      await type(element, "kiwi");

      expect(listed(element)).toEqual([]);
    });

    it("emits `cf-select` for a custom value, and writes it to the cell", async () => {
      const value = createMockCellHandle<string>("");
      await value.sync();
      const element = await autocomplete({ allowCustom: true, value });
      const selects = eventsFrom(element, "cf-select");
      await focus(element);
      await type(element, "kiwi ");

      await click(element, optionsOf(element)[0]);
      await settleWrites();

      expect(selects).toEqual([
        { value: "kiwi", label: "kiwi", isCustom: true },
      ]);
      expect(writesSent(value)).toEqual([
        expect.objectContaining({ type: "cell:set", value: "kiwi" }),
      ]);
    });
  });

  describe("single-select", () => {
    it("shows the selected item's label in the input", async () => {
      const element = await autocomplete({ items: fruit, value: "carrot" });

      expect(inputOf(element).value).toBe("Carrot");
    });

    it("shows the selected value itself where no item labels it", async () => {
      const element = await autocomplete({ items: fruit, value: "banana" });
      expect(inputOf(element).value).toBe("banana");

      element.value = "durian";
      await element.updateComplete;
      expect(inputOf(element).value).toBe("durian");
    });

    it("shows nothing in the input with nothing selected", async () => {
      const element = await autocomplete({ items: fruit });

      expect(inputOf(element).value).toBe("");
    });

    it("emits `cf-select` with the chosen item, writes its value, and closes", async () => {
      const value = createMockCellHandle<string>("banana");
      await value.sync();
      const items = [
        ...fruit,
        { value: "fig", label: "Fig", data: { id: 7 } },
      ];
      const element = await autocomplete({ items, value });
      const selects = eventsFrom(element, "cf-select");
      const changes = eventsFrom(element, "cf-change");
      const closes = eventsFrom(element, "cf-close");
      await focus(element);
      await type(element, "");

      await click(element, optionsOf(element)[3]);
      await settleWrites();

      expect(selects).toEqual([
        {
          value: "fig",
          label: "Fig",
          group: undefined,
          isCustom: false,
          data: { id: 7 },
        },
      ]);
      expect(changes[0]).toEqual({ value: "fig", oldValue: "banana" });
      expect(writesSent(value)).toEqual([
        expect.objectContaining({ type: "cell:set", value: "fig" }),
      ]);
      expect(closes).toHaveLength(1);
      expect(isOpen(element)).toBe(false);
      expect(inputOf(element).value).toBe("Fig");
    });

    it("emits `cf-select` with no `data` for an item without any", async () => {
      const element = await autocomplete({ items: fruit });
      const selects = eventsFrom(element, "cf-select");
      await focus(element);

      await click(element, optionsOf(element)[0]);

      expect(selects).toEqual([
        {
          value: "apple-pie",
          label: "Apple Pie",
          group: "Dessert",
          isCustom: false,
        },
      ]);
    });

    it("takes the selected label as the query on focus, all of it selected", async () => {
      const element = await autocomplete({ items: fruit, value: "carrot" });

      await focus(element);
      await settle();

      const input = inputOf(element);
      expect(listed(element)).toEqual(["Carrot Vegetable"]);
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6]);
    });

    it("clears the selection when Backspace is pressed with no query", async () => {
      const value = createMockCellHandle<string>("carrot");
      await value.sync();
      const element = await autocomplete({ items: fruit, value });

      const event = await press(element, "Backspace");
      await settleWrites();

      expect(event.defaultPrevented).toBe(true);
      expect(writesSent(value)).toEqual([
        expect.objectContaining({ type: "cell:set", value: "" }),
      ]);
    });

    it("leaves the selection when Backspace is pressed over a query", async () => {
      const value = createMockCellHandle<string>("carrot");
      await value.sync();
      const element = await autocomplete({ items: fruit, value });
      await focus(element);

      const event = await press(element, "Backspace");
      await settleWrites();

      expect(event.defaultPrevented).toBe(false);
      expect(writesSent(value)).toEqual([]);
    });

    it("leaves Backspace alone with nothing selected", async () => {
      const element = await autocomplete({ items: fruit });

      const event = await press(element, "Backspace");

      expect(event.defaultPrevented).toBe(false);
    });
  });

  describe("multi-select", () => {
    /** A multi-select of `fruit` bound to a cell holding `selected`. */
    const multiSelect = async (selected: string[]) => {
      const value = createMockCellHandle<string[]>(selected);
      await value.sync();
      const element = await autocomplete({
        items: fruit,
        multiple: true,
        value,
      });
      return { element, value };
    };

    it("lists the selected items after the others, marked as already added", async () => {
      const { element } = await multiSelect(["banana"]);
      await focus(element);

      expect(listed(element)).toEqual([
        "Apple Pie Dessert",
        "Carrot Vegetable",
        "banana Already added Remove",
      ]);
      const options = optionsOf(element);
      expect(options[2].classList.contains("already-selected")).toBe(true);
      expect(options[2].classList.contains("selected-separator")).toBe(true);
      expect(options[1].classList.contains("already-selected")).toBe(false);
    });

    it("separates no selected item where it is listed first", async () => {
      const { element } = await multiSelect(["banana"]);
      await focus(element);

      await type(element, "ban");

      expect(listed(element)).toEqual(["banana Already added Remove"]);
      expect(optionsOf(element)[0].classList.contains("selected-separator"))
        .toBe(false);
    });

    it("shows the query, not the selection, in the input", async () => {
      const { element } = await multiSelect(["banana"]);
      expect(inputOf(element).value).toBe("");

      await focus(element);
      await type(element, "car");

      expect(inputOf(element).value).toBe("car");
    });

    it("adds a chosen item to the cell's list, and closes", async () => {
      const { element, value } = await multiSelect(["banana"]);
      await focus(element);

      await click(element, optionsOf(element)[1]);
      await settleWrites();

      expect(writesSent(value)).toEqual([
        expect.objectContaining({
          type: "cell:set",
          value: ["banana", "carrot"],
        }),
      ]);
      expect(isOpen(element)).toBe(false);
    });

    it("removes a selected item that is chosen, and stays open", async () => {
      const { element, value } = await multiSelect(["banana", "carrot"]);
      await focus(element);

      await click(element, optionsOf(element)[1]);
      await settleWrites();

      expect(writesSent(value)).toEqual([
        expect.objectContaining({ type: "cell:set", value: ["carrot"] }),
      ]);
      expect(isOpen(element)).toBe(true);
    });

    it("writes the first item chosen into a cell the worker answers holds nothing", async () => {
      const value = createMockCellHandle<string[]>();
      await value.sync();
      const element = await autocomplete({
        items: fruit,
        multiple: true,
        value,
      });
      await focus(element);

      await click(element, optionsOf(element)[1]);
      await settleWrites();

      expect(writesSent(value)).toEqual([
        expect.objectContaining({ type: "cell:set", value: ["banana"] }),
      ]);
    });

    it("writes the first item chosen into a cell it has not read, once the worker answers", async () => {
      const value = createMockCellHandle<string[]>();
      const element = await autocomplete({
        items: fruit,
        multiple: true,
        value,
      });
      await focus(element);

      await click(element, optionsOf(element)[1]);
      await settleWrites();

      expect(writesSent(value)).toEqual([
        expect.objectContaining({ type: "cell:set", value: ["banana"] }),
      ]);
    });

    it("adds no item the worker's answer already holds", async () => {
      const value = createMockCellHandle<string[]>();
      const element = await autocomplete({
        items: fruit,
        multiple: true,
        value,
      });
      await focus(element);

      // Chosen while the cell shows nothing, and found among its items once
      // the cell answers.
      optionsOf(element)[1].click();
      pushUpdate(value, ["banana"]);
      await settleWrites();

      expect(writesSent(value)).toEqual([]);
    });

    it("highlights the selected item past the listing limit that Enter removes", async () => {
      const items = ["a", "b", "c", "d", "e", "f", "g"].map((value) => ({
        value,
      }));
      const value = createMockCellHandle<string[]>(["g"]);
      await value.sync();
      const element = await autocomplete({
        items,
        maxVisible: 1,
        multiple: true,
        value,
      });
      await focus(element);

      await press(element, "ArrowUp");
      expect(highlighted(element)).toBe("g");
      expect(inputOf(element).getAttribute("aria-activedescendant")).toBe(
        optionsOf(element).at(-1)!.id,
      );

      await press(element, "Enter");
      await settleWrites();
      expect(writesSent(value)).toEqual([
        expect.objectContaining({ type: "cell:set", value: [] }),
      ]);
    });
  });

  describe("keyboard", () => {
    it("opens the dropdown on ArrowDown, then moves the highlight down, wrapping", async () => {
      const element = await autocomplete({ items: fruit });
      const opens = eventsFrom(element, "cf-open");

      const first = await press(element, "ArrowDown");
      expect(first.defaultPrevented).toBe(true);
      expect(opens).toHaveLength(1);
      expect(highlighted(element)).toBe("Apple Pie");

      await press(element, "ArrowDown");
      expect(highlighted(element)).toBe("banana");
      await press(element, "ArrowDown");
      await press(element, "ArrowDown");
      expect(highlighted(element)).toBe("Apple Pie");
      expect(opens).toHaveLength(1);
    });

    it("moves the highlight up on ArrowUp, wrapping", async () => {
      const element = await autocomplete({ items: fruit });
      await focus(element);

      const event = await press(element, "ArrowUp");

      expect(event.defaultPrevented).toBe(true);
      expect(highlighted(element)).toBe("Carrot");
    });

    it("leaves a closed dropdown closed on ArrowUp", async () => {
      const element = await autocomplete({ items: fruit });

      await press(element, "ArrowUp");

      expect(isOpen(element)).toBe(false);
    });

    it("moves no highlight with no options listed", async () => {
      const element = await autocomplete({ items: fruit });
      await focus(element);
      await type(element, "zzz");

      await press(element, "ArrowDown");

      expect(highlighted(element)).toBeUndefined();
      expect(inputOf(element).hasAttribute("aria-activedescendant"))
        .toBe(false);
    });

    it("names no active descendant while closed", async () => {
      const element = await autocomplete({ items: fruit });

      expect(inputOf(element).hasAttribute("aria-activedescendant"))
        .toBe(false);
      await focus(element);
      expect(inputOf(element).getAttribute("aria-activedescendant"))
        .toBe("option-0");
    });

    it("keeps the highlight on the last option when options go away", async () => {
      const element = await autocomplete({ items: fruit });
      await focus(element);
      await press(element, "ArrowUp");
      expect(highlighted(element)).toBe("Carrot");

      element.items = fruit.slice(0, 2);
      await element.updateComplete;
      expect(highlighted(element)).toBe("banana");

      const selects = eventsFrom(element, "cf-select");
      await press(element, "Enter");
      expect(selects).toEqual([expect.objectContaining({ value: "banana" })]);
    });

    it("scrolls the highlighted option into view", async () => {
      const element = await autocomplete({ items: fruit });
      await focus(element);
      const scrolled: unknown[] = [];
      optionsOf(element)[1].scrollIntoView = (options) => {
        scrolled.push(options);
      };

      await press(element, "ArrowDown");
      await settle();

      expect(scrolled).toEqual([{ block: "nearest", behavior: "auto" }]);
    });

    it("highlights the option the pointer enters", async () => {
      const element = await autocomplete({ items: fruit });
      await focus(element);

      optionsOf(element)[2].dispatchEvent(new MouseEvent("mouseenter"));
      await element.updateComplete;

      expect(highlighted(element)).toBe("Carrot");
    });

    it("chooses the highlighted option on Enter", async () => {
      const element = await autocomplete({ items: fruit });
      const selects = eventsFrom(element, "cf-select");
      await focus(element);
      await press(element, "ArrowDown");

      const event = await press(element, "Enter");

      expect(event.defaultPrevented).toBe(true);
      expect(selects).toEqual([
        expect.objectContaining({ value: "banana" }),
      ]);
    });

    it("chooses nothing on Enter with no options listed", async () => {
      const element = await autocomplete({ items: fruit });
      const selects = eventsFrom(element, "cf-select");
      await focus(element);
      await type(element, "zzz");

      await press(element, "Enter");

      expect(selects).toEqual([]);
      expect(isOpen(element)).toBe(true);
    });

    it("leaves Enter to the form while the dropdown is closed", async () => {
      const element = await autocomplete({ items: fruit });
      const selects = eventsFrom(element, "cf-select");

      const event = await press(element, "Enter");

      expect(event.defaultPrevented).toBe(false);
      expect(selects).toEqual([]);
    });

    for (const key of ["Escape", "Tab"]) {
      it(`closes the dropdown on ${key}`, async () => {
        const element = await autocomplete({ items: fruit });
        const closes = eventsFrom(element, "cf-close");
        await focus(element);

        const event = await press(element, key);

        expect(isOpen(element)).toBe(false);
        expect(closes).toHaveLength(1);
        expect(event.defaultPrevented).toBe(key === "Escape");
      });
    }

    it("leaves Escape alone while closed", async () => {
      const element = await autocomplete({ items: fruit });
      const closes = eventsFrom(element, "cf-close");

      const event = await press(element, "Escape");

      expect(event.defaultPrevented).toBe(false);
      expect(closes).toEqual([]);
    });

    it("leaves the dropdown alone on other keys", async () => {
      const element = await autocomplete({ items: fruit });
      await focus(element);

      const event = await press(element, "a");

      expect(isOpen(element)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    });
  });

  describe("opening and closing", () => {
    it("opens the dropdown, emitting `cf-open`, once text is typed", async () => {
      const element = await autocomplete({ items: fruit });
      const opens = eventsFrom(element, "cf-open");

      await type(element, "");
      expect(isOpen(element)).toBe(false);

      await type(element, "car");
      expect(isOpen(element)).toBe(true);
      expect(opens).toEqual([{}]);
      expect(inputOf(element).getAttribute("aria-expanded")).toBe("true");
    });

    it("takes only the last of the keystrokes made before the dropdown updates", async () => {
      const element = await autocomplete({ items: fruit });
      const input = inputOf(element);

      input.value = "c";
      input.dispatchEvent(new InputEvent("input"));
      input.value = "ba";
      input.dispatchEvent(new InputEvent("input"));
      time.tick(0);
      await element.updateComplete;

      expect(listed(element)).toEqual(["banana"]);
    });

    it("sends no `cf-open` for typing that ends with its element removed", async () => {
      const element = await autocomplete({ items: fruit });
      const opens = eventsFrom(element, "cf-open");
      const input = inputOf(element);

      input.value = "car";
      input.dispatchEvent(new InputEvent("input"));
      element.remove();
      time.tick(0);

      expect(opens).toEqual([]);
    });

    it("opens no dropdown while disabled", async () => {
      const element = await autocomplete({ items: fruit, disabled: true });
      const opens = eventsFrom(element, "cf-open");

      await press(element, "ArrowDown");

      expect(inputOf(element).disabled).toBe(true);
      expect(isOpen(element)).toBe(false);
      expect(opens).toEqual([]);
    });

    it("closes the dropdown on a click outside the element", async () => {
      const element = await autocomplete({ items: fruit });
      const closes = eventsFrom(element, "cf-close");
      await focus(element);

      await click(element, element);
      expect(isOpen(element)).toBe(true);

      await click(element, document.body);
      expect(isOpen(element)).toBe(false);
      expect(closes).toHaveLength(1);

      await click(element, document.body);
      expect(closes).toHaveLength(1);
    });

    it("closes the dropdown and clears the query on `clear()`", async () => {
      const element = await autocomplete({ items: fruit });
      await focus(element);
      await type(element, "car");

      element.clear();
      await element.updateComplete;

      expect(isOpen(element)).toBe(false);
      expect(inputOf(element).value).toBe("");
    });

    it("closes the dropdown on `blur()`", async () => {
      const element = await autocomplete({ items: fruit });
      await focus(element);

      element.blur();
      await element.updateComplete;

      expect(isOpen(element)).toBe(false);
    });
  });

  describe("dropdown position", () => {
    /** Gives the input the given bounds. */
    const placeInput = (
      element: CFAutocomplete,
      { left = 0, top = 0, width = 0, bottom = 0 },
    ) => {
      inputOf(element).getBoundingClientRect = () =>
        new DOMRect(left, top, width, bottom - top);
    };

    it("places the dropdown under the input on opening", async () => {
      const element = await autocomplete({ items: fruit });
      placeInput(element, { top: 100, bottom: 130, left: 20, width: 200 });

      await focus(element);
      await element.updateComplete;

      expect(dropdownOf(element).style.top).toBe("134px");
      expect(dropdownOf(element).style.left).toBe("20px");
      expect(dropdownOf(element).style.width).toBe("200px");
    });

    it("places the dropdown above the input where only there is room for it", async () => {
      const element = await autocomplete({ items: fruit });
      const bottom = globalThis.innerHeight - 10;
      placeInput(element, { top: bottom - 30, bottom });

      await focus(element);
      await element.updateComplete;

      expect(dropdownOf(element).style.top).toBe(`${bottom - 30 - 120 - 4}px`);
    });

    it("moves the open dropdown with the input on scrolling and resizing", async () => {
      const element = await autocomplete({ items: fruit });
      await focus(element);
      await element.updateComplete;

      placeInput(element, { bottom: 300 });
      globalThis.dispatchEvent(new Event("scroll"));
      globalThis.dispatchEvent(new Event("scroll"));
      await settle();
      await element.updateComplete;
      expect(dropdownOf(element).style.top).toBe("304px");

      placeInput(element, { bottom: 400 });
      globalThis.dispatchEvent(new Event("resize"));
      await settle();
      await element.updateComplete;
      expect(dropdownOf(element).style.top).toBe("404px");
    });

    it("positions nothing for a scroll that ends with its element removed", async () => {
      const element = await autocomplete({ items: fruit });
      await focus(element);
      const errors: unknown[] = [];
      const onError = (event: unknown) => {
        errors.push(event);
      };
      window.addEventListener("error", onError);

      globalThis.dispatchEvent(new Event("scroll"));
      element.remove();
      await settle();
      window.removeEventListener("error", onError);

      expect(errors).toEqual([]);
    });

    it("leaves a closed dropdown where it is on scrolling", async () => {
      const element = await autocomplete({ items: fruit });
      placeInput(element, { bottom: 300 });

      globalThis.dispatchEvent(new Event("scroll"));
      await settle();
      await element.updateComplete;

      expect(dropdownOf(element).style.top).toBe("");
    });
  });

  describe("theme", () => {
    it("writes the given theme's properties onto the host", async () => {
      const name = "--cf-theme-color-primary";
      const element = await autocomplete({ items: fruit });

      element.theme = defaultTheme;
      await element.updateComplete;

      expect(element.style.getPropertyValue(name)).toBe(
        themeProperties(defaultTheme)[name],
      );
    });
  });
});
