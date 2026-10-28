/**
 * A slider driven by real pointer events in a browser: pressing the track
 * moves there, a drag reports each move and commits once on release, the
 * thumb can be grabbed without jumping, and a capture lost before release
 * still ends the drag, a press focuses the slider for the keys that follow,
 * and a second pointer is ignored. Unit tests drive the same moves by value; this file
 * is where the pointer, its capture and the track's geometry meet them.
 */

import { expect } from "@std/expect";
import "./index.ts";
import type { CFSlider } from "./index.ts";

const pointer = {
  bubbles: true,
  composed: true,
  pointerId: 1,
  button: 0,
  isPrimary: true,
};

/** A 200px slider over 0–100 in the page, and the events it fires. */
async function mounted(): Promise<{
  slider: CFSlider;
  track: Element;
  thumb: Element;
  at: (percent: number) => number;
  events: { type: string; detail: unknown }[];
}> {
  const slider = document.createElement("cf-slider") as CFSlider;
  slider.style.width = "200px";
  slider.style.minWidth = "200px";
  slider.value = 20;
  document.body.append(slider);
  await slider.updateComplete;
  const track = slider.shadowRoot?.querySelector(".track");
  const thumb = slider.shadowRoot?.querySelector(".thumb");
  if (!track || !thumb) throw new Error("the slider did not render");
  const rect = track.getBoundingClientRect();
  const events: { type: string; detail: unknown }[] = [];
  for (const type of ["cf-input", "cf-change"]) {
    slider.addEventListener(type, (event) => {
      if (event instanceof CustomEvent) {
        events.push({ type, detail: event.detail });
      }
    });
  }
  return {
    slider,
    track,
    thumb,
    at: (percent) => rect.left + rect.width * percent / 100,
    events,
  };
}

Deno.test("pressing the track moves there, and a drag commits once on release", async () => {
  const { slider, track, at, events } = await mounted();
  try {
    const y = track.getBoundingClientRect().top + 2;
    track.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...pointer,
        clientX: at(50),
        clientY: y,
      }),
    );
    track.dispatchEvent(
      new PointerEvent("pointermove", {
        ...pointer,
        clientX: at(75),
        clientY: y,
      }),
    );
    track.dispatchEvent(
      new PointerEvent("pointerup", {
        ...pointer,
        clientX: at(75),
        clientY: y,
      }),
    );

    expect(slider.value).toBe(75);
    expect(events).toEqual([
      { type: "cf-input", detail: { value: 50, oldValue: 20 } },
      { type: "cf-input", detail: { value: 75, oldValue: 50 } },
      { type: "cf-change", detail: { value: 75, oldValue: 20 } },
    ]);
  } finally {
    slider.remove();
  }
});

Deno.test("grabbing the thumb keeps its value until it moves", async () => {
  const { slider, thumb, at, events } = await mounted();
  try {
    const rect = thumb.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    thumb.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...pointer,
        clientX: rect.left + rect.width / 2 + 3,
        clientY: y,
      }),
    );
    expect(slider.value).toBe(20);
    expect(events).toEqual([]);

    thumb.dispatchEvent(
      new PointerEvent("pointermove", {
        ...pointer,
        clientX: at(30),
        clientY: y,
      }),
    );
    thumb.dispatchEvent(
      new PointerEvent("pointerup", {
        ...pointer,
        clientX: at(30),
        clientY: y,
      }),
    );
    expect(events.at(-1)).toEqual({
      type: "cf-change",
      detail: { value: 30, oldValue: 20 },
    });
  } finally {
    slider.remove();
  }
});

Deno.test("a capture lost before release ends the drag", async () => {
  const { slider, track, at } = await mounted();
  try {
    const y = track.getBoundingClientRect().top + 2;
    track.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...pointer,
        clientX: at(40),
        clientY: y,
      }),
    );
    expect(slider.accessForTestingOnly.dragging).toBe(true);

    track.dispatchEvent(new PointerEvent("lostpointercapture", pointer));
    expect(slider.accessForTestingOnly.dragging).toBe(false);

    // A move after the drag ended moves nothing.
    track.dispatchEvent(
      new PointerEvent("pointermove", {
        ...pointer,
        clientX: at(90),
        clientY: y,
      }),
    );
    expect(slider.value).toBe(40);
  } finally {
    slider.remove();
  }
});

Deno.test("a press focuses the slider, and the keys that follow move it", async () => {
  const { slider, track, at } = await mounted();
  try {
    const y = track.getBoundingClientRect().top + 2;
    track.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...pointer,
        clientX: at(50),
        clientY: y,
      }),
    );
    track.dispatchEvent(
      new PointerEvent("pointerup", {
        ...pointer,
        clientX: at(50),
        clientY: y,
      }),
    );
    expect(document.activeElement).toBe(slider);

    slider.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(slider.value).toBe(51);
  } finally {
    slider.remove();
  }
});

Deno.test("only the primary pointer drags, one drag at a time", async () => {
  const { slider, track, at } = await mounted();
  try {
    const y = track.getBoundingClientRect().top + 2;
    // A pointer that is not the primary one (a second finger whose first
    // landed elsewhere) does not start a drag. Pointer 1 is the mouse, which
    // a page can always capture, so a press the slider did not ignore would
    // reach its move rather than fail on capture first.
    track.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...pointer,
        isPrimary: false,
        clientX: at(80),
        clientY: y,
      }),
    );
    expect(slider.value).toBe(20);
    track.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...pointer,
        clientX: at(30),
        clientY: y,
      }),
    );
    // Nor does a second, non-primary pointer during the drag.
    track.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...pointer,
        isPrimary: false,
        clientX: at(90),
        clientY: y,
      }),
    );
    expect(slider.value).toBe(30);
    // A press while a drag is under way is not a second drag either.
    track.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...pointer,
        clientX: at(70),
        clientY: y,
      }),
    );
    expect(slider.value).toBe(30);
  } finally {
    slider.remove();
  }
});
