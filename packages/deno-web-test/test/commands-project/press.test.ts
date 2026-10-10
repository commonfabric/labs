import { pressKey } from "@commonfabric/deno-web-test/commands";
import { focusedPair } from "./mod.ts";

Deno.test("a pressed Tab moves focus", async function () {
  const { first, second } = focusedPair();
  try {
    await pressKey("Tab");
    if (document.activeElement !== second) {
      throw new Error("focus did not move to the second button");
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

Deno.test("a pressed key reaches listeners as trusted", async function () {
  const { first, second } = focusedPair();
  const seen: { key: string; isTrusted: boolean }[] = [];
  first.addEventListener("keydown", (event) => {
    seen.push({ key: event.key, isTrusted: event.isTrusted });
  });
  try {
    await pressKey(" ");
    if (JSON.stringify(seen) !== '[{"key":" ","isTrusted":true}]') {
      throw new Error(`listeners saw ${JSON.stringify(seen)}`);
    }
  } finally {
    first.remove();
    second.remove();
  }
});

// Fails on purpose: `commands.test.ts` expects the refusal by name. A test
// bundled without a type check can name a key `pressKey` does not know.
Deno.test("an unknown key is refused", function () {
  Reflect.apply(pressKey, undefined, ["Space"]);
});
