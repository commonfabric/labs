/**
 * The verb list guest. It shows the pattern's items, which it is granted to
 * read, and adds one only by sending the pattern's `addItem` verb an event:
 * the list is the pattern's, so the guest asks for an item rather than writing
 * it. Which items are checked off is the guest's to write, and so is whether
 * the list hides them, kept in `output`. The count of checked items is only
 * shown, never stored: a count each guest wrote from its own reading could
 * overwrite a newer one.
 */

import { connectFabric } from "@commonfabric/iframe-sandbox/guest";

import {
  type AddItemEvent,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeOutputData,
  type IframeStateData,
  type ListItem,
} from "./contract.ts";

const fabric = connectFabric();
const items = fabric.cell<IframeStateData["items"]>("items");
const checked = fabric.cell<IframeStateData["checked"]>("checked");
const output = fabric.cell<IframeOutputData>("output");
const addItem = fabric.stream<AddItemEvent>("addItem");

const root = document.querySelector<HTMLDivElement>("#root")!;
root.innerHTML = `
  <main class="app cf-stack">
    <h1>Verb list</h1>
    <p class="cf-muted" id="status" aria-live="polite">Loading…</p>
    <div class="add cf-row" id="add-row" aria-busy="false">
      <label class="visually-hidden" for="new-item">New item</label>
      <input id="new-item" placeholder="Add an item" autocomplete="off" disabled>
      <button type="button" class="cf-primary" id="add" disabled>Add</button>
    </div>
    <label class="cf-row cf-muted">
      <input type="checkbox" id="hide-checked" disabled>
      Hide checked items
    </label>
    <p id="error" role="alert"></p>
    <ul id="items"></ul>
  </main>
`;
const status = root.querySelector<HTMLParagraphElement>("#status")!;
const field = root.querySelector<HTMLInputElement>("#new-item")!;
const addRow = root.querySelector<HTMLDivElement>("#add-row")!;
const add = root.querySelector<HTMLButtonElement>("#add")!;
const hideChecked = root.querySelector<HTMLInputElement>("#hide-checked")!;
const error = root.querySelector<HTMLParagraphElement>("#error")!;
const itemList = root.querySelector<HTMLUListElement>("#items")!;

/** The row drawn for each item, by item id. */
const rows = new Map<string, HTMLLIElement>();

/** Set once every resource an action reads has answered its first pull. */
let hydrated = false;

/** Whether an `addItem` event is on its way to the pattern. */
let sending = false;

function showError(cause: unknown): void {
  error.textContent = cause instanceof Error ? cause.message : String(cause);
}

function rowFor(item: ListItem): HTMLLIElement {
  let row = rows.get(item.id);
  if (!row) {
    row = document.createElement("li");
    row.dataset.itemId = item.id;
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.addEventListener("change", () => setChecked(item.id, box.checked));
    label.append(box, document.createElement("span"));
    row.append(label);
    rows.set(item.id, row);
  }
  return row;
}

function render(): void {
  const list = items.get() ?? [];
  const marks = checked.get() ?? {};
  const hiding = output.get()?.hideChecked === true;
  const present = new Set(list.map((item) => item.id));
  for (const [id, row] of rows) {
    if (!present.has(id)) {
      row.remove();
      rows.delete(id);
    }
  }
  list.forEach((item, index) => {
    const row = rowFor(item);
    const box = row.querySelector("input")!;
    box.checked = marks[item.id] === true;
    box.disabled = !hydrated;
    row.toggleAttribute("data-checked", box.checked);
    row.hidden = hiding && box.checked;
    row.querySelector("span")!.textContent = item.text;
    if (itemList.children[index] !== row) {
      itemList.insertBefore(row, itemList.children[index] ?? null);
    }
  });

  field.disabled = !hydrated;
  hideChecked.checked = hiding;
  hideChecked.disabled = !hydrated;
  addRow.setAttribute("aria-busy", String(sending));
  add.disabled = !hydrated || sending || field.value.trim() === "";
  const done = list.filter((item) => marks[item.id] === true).length;
  status.textContent = !hydrated
    ? "Loading…"
    : list.length === 0
    ? "Nothing on the list yet."
    : `${list.length} ${
      list.length === 1 ? "item" : "items"
    }, ${done} checked off.`;
}

async function submit(): Promise<void> {
  const text = field.value.trim();
  if (!hydrated || sending || text === "") return;
  sending = true;
  error.textContent = "";
  render();
  try {
    // A fresh id for each item asked for, so the pattern can tell a second
    // item with the same text from this one sent again.
    await addItem.send({ id: crypto.randomUUID(), text });
    // A draft typed while the event was on its way is kept.
    if (field.value.trim() === text) field.value = "";
  } catch (cause) {
    showError(cause);
  } finally {
    sending = false;
    render();
    field.focus();
  }
}

// A write first stores the resource's default if it holds none, so the child
// write has a parent to land in. That happens here rather than at startup, so
// a viewer who changes nothing writes nothing. A write that fails changes no
// value and so reaches no sink, so the catch redraws from what is stored.

async function setChecked(id: string, value: boolean): Promise<void> {
  try {
    await checked.initialize(DEFAULT_STATE.checked);
    await checked.key(id).set(value);
  } catch (cause) {
    showError(cause);
    render();
  }
}

async function setHideChecked(value: boolean): Promise<void> {
  try {
    await output.initialize(DEFAULT_OUTPUT);
    await output.key("hideChecked").set(value);
  } catch (cause) {
    showError(cause);
    render();
  }
}

field.addEventListener("input", render);
field.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void submit();
});
add.addEventListener("click", () => void submit());
hideChecked.addEventListener(
  "change",
  () => void setHideChecked(hideChecked.checked),
);

const stops = [items.sink(render), checked.sink(render), output.sink(render)];
void (async () => {
  try {
    await Promise.all([items.pull(), checked.pull(), output.pull()]);
    hydrated = true;
    render();
  } catch (cause) {
    showError(cause);
  }
})();

globalThis.addEventListener("pagehide", () => {
  stops.forEach((stop) => stop());
  fabric.disconnect();
}, { once: true });
