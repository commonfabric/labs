import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { isValidFabricValue } from "@commonfabric/data-model";
import { keybindDetail } from "./cf-keybind.ts";

type FakeModifiers = {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
};

/**
 * Stands in for a native `KeyboardEvent`, which Deno does not define. Like the
 * native one, it is a class instance, and so not a `FabricValue`.
 */
class FakeKeyboardEvent {
  readonly #code: string;
  readonly #key: string;
  readonly #modifiers: FakeModifiers;

  constructor(code: string, key: string, modifiers: FakeModifiers = {}) {
    this.#code = code;
    this.#key = key;
    this.#modifiers = modifiers;
  }

  get code(): string {
    return this.#code;
  }

  get key(): string {
    return this.#key;
  }

  get altKey(): boolean {
    return this.#modifiers.altKey ?? false;
  }

  get ctrlKey(): boolean {
    return this.#modifiers.ctrlKey ?? false;
  }

  get metaKey(): boolean {
    return this.#modifiers.metaKey ?? false;
  }

  get shiftKey(): boolean {
    return this.#modifiers.shiftKey ?? false;
  }

  get repeat(): boolean {
    return this.#modifiers.repeat ?? false;
  }
}

function keyboardEvent(
  ...args: ConstructorParameters<typeof FakeKeyboardEvent>
): KeyboardEvent {
  return new FakeKeyboardEvent(...args) as unknown as KeyboardEvent;
}

describe("keybindDetail()", () => {
  it("returns a `FabricValue`, which a worker-hosted pattern can be sent", () => {
    const detail = keybindDetail(
      "next",
      keyboardEvent("ArrowRight", "ArrowRight"),
    );

    expect(isValidFabricValue(detail)).toBe(true);
  });

  it("returns a `FabricValue` for a binding with no name", () => {
    const detail = keybindDetail(undefined, keyboardEvent("KeyO", "o"));

    expect(isValidFabricValue(detail)).toBe(true);
  });

  it("returns the matched key, its modifiers, and whether it repeated", () => {
    const detail = keybindDetail(
      "open",
      keyboardEvent("KeyO", "o", { metaKey: true, repeat: true }),
    );

    expect(detail).toStrictEqual({
      name: "open",
      code: "KeyO",
      key: "o",
      alt: false,
      ctrl: false,
      meta: true,
      shift: false,
      repeat: true,
    });
  });
});
