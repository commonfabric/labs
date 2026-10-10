import { pressKey } from "@commonfabric/deno-web-test/commands";
import { focusedPair } from "./mod.ts";

Deno.test("a pressed Tab moves focus, and Shift+Tab moves it back", async function () {
  const { first, second } = focusedPair();
  try {
    await pressKey("Tab");
    if (document.activeElement !== second) {
      throw new Error("Tab did not move focus to the second button");
    }
    await pressKey("Tab", { modifiers: ["Shift"] });
    if (document.activeElement !== first) {
      throw new Error("Shift+Tab did not move focus back to the first button");
    }
  } finally {
    first.remove();
    second.remove();
  }
});

Deno.test("a dispatched Tab moves nothing", function () {
  const { first, second } = focusedPair();
  try {
    first.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    if (document.activeElement !== first) {
      throw new Error("a dispatched Tab moved focus");
    }
  } finally {
    first.remove();
    second.remove();
  }
});

Deno.test("a press settles once the browser has handled all of it", async function () {
  const { first, second } = focusedPair();
  const seen: string[] = [];
  for (const type of ["keydown", "keyup"]) {
    first.addEventListener(type, (event) => {
      if (event instanceof KeyboardEvent) {
        seen.push(`${type} ${JSON.stringify(event.key)} ${event.isTrusted}`);
      }
    });
  }
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  document.body.append(checkbox);
  try {
    await pressKey(" ");
    const expected = ['keydown " " true', 'keyup " " true'];
    if (JSON.stringify(seen) !== JSON.stringify(expected)) {
      throw new Error(`listeners saw ${JSON.stringify(seen)}`);
    }
    // A checkbox toggles on the keyup of Space, the last thing a press does.
    checkbox.focus();
    await pressKey(" ");
    if (!checkbox.checked) {
      throw new Error("Space did not check the focused checkbox");
    }
  } finally {
    first.remove();
    second.remove();
    checkbox.remove();
  }
});

// The next two fail on purpose: `commands.test.ts` expects each refusal by
// name. A test bundled without a type check can name any key at all.
Deno.test("an unknown key is refused", async function () {
  // @ts-expect-error: "Space" is not a key a test may press.
  await pressKey("Space");
});

Deno.test("an unknown modifier is refused", async function () {
  // @ts-expect-error: "Hyper" is not a key a test may hold down.
  await pressKey("Tab", { modifiers: ["Hyper"] });
});
