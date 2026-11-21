/**
 * The donut menu guest. The logo is the document's own `cf-asset:` reference;
 * the menu is built here, each picture from its asset's URL; and the favorite
 * is drawn onto a canvas from its asset's decoded image. Choosing a favorite
 * is the one thing the guest writes.
 */

import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import { describeFailure } from "@commonfabric/js-values/describe-failure";

import { DEFAULT_STATE, type IframeStateData, MENU } from "./contract.ts";

const fabric = connectFabric();
const state = fabric.cell<IframeStateData>("state");

const status = document.querySelector<HTMLParagraphElement>("#status")!;
const menu = document.querySelector<HTMLUListElement>("#menu")!;
const canvas = document.querySelector<HTMLCanvasElement>("#favorite")!;
const error = document.querySelector<HTMLParagraphElement>("#error")!;

/** The button that chooses each donut, by donut id. */
const buttons = new Map<string, HTMLButtonElement>();

for (const donut of MENU) {
  const picture = fabric.asset(donut.picture);
  const item = document.createElement("li");
  const image = document.createElement("img");
  image.src = picture.url;
  image.alt = donut.name;
  image.dataset.picture = donut.picture;
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.donut = donut.id;
  button.textContent = donut.name;
  button.disabled = true;
  button.addEventListener("click", () => {
    choose(donut.id).then(
      () => (error.textContent = ""),
      (failure) => (error.textContent = describeFailure(failure)),
    );
  });
  buttons.set(donut.id, button);
  item.append(image, button);
  menu.append(item);
}

/** Makes the donut `id` the favorite. */
async function choose(id: string): Promise<void> {
  // A child write needs the state to exist; the default stands in for it
  // until the first write creates it.
  await state.initialize(DEFAULT_STATE);
  await state.key("favorite").set(id);
}

/** How many times `show()` has run; each call's number is its generation. */
let shows = 0;

/**
 * Draws the favorite's picture onto the canvas, or clears it, for the `show()`
 * call numbered `generation`. A picture decoded after a later call is not
 * drawn, so the canvas shows the latest value whichever decode finishes first.
 */
async function draw(
  favorite: string | null,
  generation: number,
): Promise<boolean> {
  const context = canvas.getContext("2d")!;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const donut = MENU.find((candidate) => candidate.id === favorite);
  if (donut === undefined) return true;
  const image = await fabric.asset(donut.picture).image();
  if (generation !== shows) return false;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return true;
}

/** Shows `value`, the stored state or its default. */
function show(value: IframeStateData | undefined): void {
  const generation = ++shows;
  const favorite = value?.favorite ?? DEFAULT_STATE.favorite;
  const donut = MENU.find((candidate) => candidate.id === favorite);
  status.textContent = donut === undefined
    ? "Choose a favorite."
    : `The favorite is ${donut.name}.`;
  for (const [id, button] of buttons) {
    button.setAttribute("aria-pressed", String(id === favorite));
  }
  draw(favorite, generation).then(
    (drawn) => {
      if (!drawn) return;
      canvas.dataset.drawn = favorite ?? "";
      error.textContent = "";
    },
    (failure) => {
      // A failure for a value since replaced is no longer news, even when the
      // later value names the same favorite.
      if (generation !== shows) return;
      error.textContent = describeFailure(failure);
    },
  );
}

// The sink draws every value once the state has loaded; before that it hears
// nothing useful. A pull that loads a value hands it to the sink, so the pull
// draws only a state that holds nothing, which the sink never hears.
let shown = false;
state.sink((value) => {
  if (value === undefined) return;
  shown = true;
  show(value);
});
state.pull().then(
  (value) => {
    if (!shown) show(value);
    for (const button of buttons.values()) button.disabled = false;
  },
  (failure) => (error.textContent = describeFailure(failure)),
);
