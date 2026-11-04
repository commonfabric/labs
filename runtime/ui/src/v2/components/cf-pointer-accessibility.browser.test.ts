import {
  assertEquals,
  assertInstanceOf,
  assertStringIncludes,
} from "@std/assert";
import "./cf-chip/index.ts";
import "./cf-tags/index.ts";
import "./cf-tile/index.ts";

type UpdatingElement = HTMLElement & {
  updateComplete: Promise<unknown>;
};

async function mount<T extends UpdatingElement>(element: T): Promise<T> {
  document.body.append(element);
  await element.updateComplete;
  return element;
}

Deno.test("cf-chip exposes separate primary and remove buttons", async () => {
  const chip = document.createElement("cf-chip") as UpdatingElement & {
    label: string;
    interactive: boolean;
    removable: boolean;
  };
  chip.label = "Roadmap";
  chip.interactive = true;
  chip.removable = true;

  await mount(chip);
  try {
    const action = chip.shadowRoot?.querySelector(".chip-action");
    const remove = chip.shadowRoot?.querySelector(".chip-remove");
    assertInstanceOf(action, HTMLButtonElement);
    assertInstanceOf(remove, HTMLButtonElement);
    assertEquals(action.type, "button");
    assertEquals(action.getAttribute("aria-labelledby"), "chip-label");
    assertEquals(
      remove.getAttribute("aria-labelledby"),
      "chip-remove-prefix chip-label",
    );
    assertStringIncludes(
      chip.shadowRoot?.getElementById("chip-label")?.textContent ?? "",
      "Roadmap",
    );

    let nativeClicks = 0;
    let chipClicks = 0;
    let removes = 0;
    chip.addEventListener("click", () => nativeClicks++);
    chip.addEventListener("cf-click", () => chipClicks++);
    chip.addEventListener("cf-remove", () => removes++);

    action.click();
    assertEquals(nativeClicks, 1);
    assertEquals(chipClicks, 1);
    assertEquals(removes, 0);

    remove.click();
    assertEquals(nativeClicks, 1);
    assertEquals(chipClicks, 1);
    assertEquals(removes, 1);
  } finally {
    chip.remove();
  }
});

Deno.test("cf-chip leaves display-only chips out of the tab order", async () => {
  const chip = document.createElement("cf-chip") as UpdatingElement & {
    label: string;
  };
  chip.label = "Status";

  await mount(chip);
  try {
    assertEquals(chip.shadowRoot?.querySelector("button"), null);
    assertEquals(
      chip.shadowRoot?.querySelector(".chip-content") !== null,
      true,
    );
  } finally {
    chip.remove();
  }
});

Deno.test("cf-tile exposes its title as a button without swallowing details", async () => {
  const tile = document.createElement("cf-tile") as UpdatingElement & {
    item: { title: string };
    summary: string;
    clickable: boolean;
  };
  tile.item = { title: "Project notes" };
  tile.summary = "Three pages";
  tile.clickable = true;

  await mount(tile);
  try {
    const action = tile.shadowRoot?.querySelector(".tile-action");
    const summary = tile.shadowRoot?.querySelector("summary");
    assertInstanceOf(action, HTMLButtonElement);
    assertInstanceOf(summary, HTMLElement);
    assertEquals(action.textContent?.trim(), "Project notes");

    let clicks = 0;
    tile.addEventListener("cf-click", () => clicks++);
    action.click();
    assertEquals(clicks, 1);
    summary.click();
    assertEquals(clicks, 1);

    tile.clickable = false;
    await tile.updateComplete;
    assertEquals(tile.shadowRoot?.querySelector(".tile-action"), null);
    assertEquals(
      tile.shadowRoot?.querySelector(".tile-title")?.textContent?.trim(),
      "Project notes",
    );
  } finally {
    tile.remove();
  }
});

Deno.test("cf-tags exposes named edit, remove, and add buttons", async () => {
  const tags = document.createElement("cf-tags") as UpdatingElement & {
    tags: string[];
    readonly: boolean;
  };
  tags.tags = ["alpha"];

  await mount(tags);
  try {
    const edit = tags.shadowRoot?.querySelector(".tag-edit");
    const remove = tags.shadowRoot?.querySelector(".tag-remove");
    const add = tags.shadowRoot?.querySelector(".add-tag");
    assertInstanceOf(edit, HTMLButtonElement);
    assertInstanceOf(remove, HTMLButtonElement);
    assertInstanceOf(add, HTMLButtonElement);
    assertEquals(edit.getAttribute("aria-label"), "Edit alpha");
    assertEquals(remove.getAttribute("aria-label"), "Remove alpha");
    assertEquals(add.textContent?.trim(), "+ Add tag");

    edit.click();
    await tags.updateComplete;
    assertInstanceOf(
      tags.shadowRoot?.querySelector("#tag-input-0"),
      HTMLInputElement,
    );
  } finally {
    tags.remove();
  }

  const readonlyTags = document.createElement("cf-tags") as UpdatingElement & {
    tags: string[];
    readonly: boolean;
  };
  readonlyTags.tags = ["stable"];
  readonlyTags.readonly = true;

  await mount(readonlyTags);
  try {
    assertEquals(readonlyTags.shadowRoot?.querySelector("button"), null);
    assertEquals(
      readonlyTags.shadowRoot?.querySelector(".tag-text")?.textContent,
      "stable",
    );
  } finally {
    readonlyTags.remove();
  }
});

Deno.test("cf-tags add button reveals the new-tag textbox", async () => {
  const tags = document.createElement("cf-tags") as UpdatingElement & {
    tags: string[];
  };
  tags.tags = [];

  await mount(tags);
  try {
    const add = tags.shadowRoot?.querySelector(".add-tag");
    assertInstanceOf(add, HTMLButtonElement);
    add.click();
    await tags.updateComplete;
    assertInstanceOf(
      tags.shadowRoot?.querySelector("#new-tag-input"),
      HTMLInputElement,
    );
  } finally {
    tags.remove();
  }
});
