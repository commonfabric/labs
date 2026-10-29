import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
// Importing this module also registers the custom matcher it defines.
import { stripSymbols } from "../src/equal-ignoring-symbols.ts";

const testSymbol1 = Symbol("test1");
const testSymbol2 = Symbol("test2");

describe("stripSymbols()", () => {
  it("strips symbols from objects", () => {
    const obj = {
      name: "test",
      [testSymbol1]: "should be removed",
      value: 42,
    };

    expect(stripSymbols(obj)).toEqual({
      name: "test",
      value: 42,
    });
  });

  it("strips symbols from nested objects", () => {
    const obj = {
      user: {
        name: "John",
        [testSymbol1]: "removed",
        settings: {
          theme: "dark",
          [testSymbol2]: "also removed",
        },
      },
    };

    expect(stripSymbols(obj)).toEqual({
      user: {
        name: "John",
        settings: {
          theme: "dark",
        },
      },
    });
  });

  it("strips symbols from objects inside an array", () => {
    const arr = [
      { name: "a", [testSymbol1]: "removed" },
      { name: "b", [testSymbol2]: "removed" },
    ];

    expect(stripSymbols(arr)).toEqual([
      { name: "a" },
      { name: "b" },
    ]);
  });

  it("returns a primitive unchanged", () => {
    expect(stripSymbols(42)).toBe(42);
    expect(stripSymbols("string")).toBe("string");
    expect(stripSymbols(true)).toBe(true);
    expect(stripSymbols(null)).toBe(null);
    expect(stripSymbols(undefined)).toBe(undefined);
  });
});

describe("`toEqualIgnoringSymbols()` matcher", () => {
  it("matches objects that differ only in symbol keys", () => {
    const obj1 = {
      name: "test",
      [testSymbol1]: "ignored",
      value: 42,
    };

    const obj2 = {
      name: "test",
      value: 42,
    };

    expect(obj1).toEqualIgnoringSymbols(obj2);
  });

  it("matches nested objects that differ only in symbol keys", () => {
    const obj1 = {
      user: {
        name: "John",
        [testSymbol1]: "ignored",
        settings: {
          theme: "dark",
          [testSymbol2]: "also ignored",
        },
      },
    };

    const obj2 = {
      user: {
        name: "John",
        settings: {
          theme: "dark",
        },
      },
    };

    expect(obj1).toEqualIgnoringSymbols(obj2);
  });

  it("throws when objects differ in a non-symbol property", () => {
    const obj1 = {
      name: "test1",
      [testSymbol1]: "ignored",
    };

    const obj2 = {
      name: "test2",
    };

    expect(() => {
      expect(obj1).toEqualIgnoringSymbols(obj2);
    }).toThrow();
  });

  it("includes the caller's custom message in the failure", () => {
    let message: string | undefined;
    try {
      expect(
        { name: "test1" },
        "custom message",
      ).toEqualIgnoringSymbols({ name: "test2" });
    } catch (error) {
      message = (error as Error).message;
    }

    if (!message) {
      throw new Error("expected matcher to throw");
    }
    expect(message).toContain(
      "custom message: expected objects to be equal when ignoring symbols",
    );
  });

  it("matches arrays whose elements differ only in symbol keys", () => {
    const arr1 = [
      { name: "a", [testSymbol1]: "ignored" },
      { name: "b", [testSymbol2]: "ignored" },
    ];

    const arr2 = [
      { name: "a" },
      { name: "b" },
    ];

    expect(arr1).toEqualIgnoringSymbols(arr2);
  });
});

describe("`toMatchObjectIgnoringSymbols()` matcher", () => {
  it("matches a subset of the properties, ignoring symbol keys", () => {
    const obj1 = {
      name: "test",
      [testSymbol1]: "ignored",
      value: 42,
      extra: "field",
    };

    const obj2 = {
      name: "test",
      value: 42,
    };

    expect(obj1).toMatchObjectIgnoringSymbols(obj2);
  });

  it("matches a nested subset of the properties, ignoring symbol keys", () => {
    const obj1 = {
      user: {
        name: "John",
        [testSymbol1]: "ignored",
        age: 30,
        settings: {
          theme: "dark",
          [testSymbol2]: "also ignored",
          fontSize: 14,
        },
      },
      extraField: true,
    };

    const obj2 = {
      user: {
        name: "John",
        settings: {
          theme: "dark",
        },
      },
    };

    expect(obj1).toMatchObjectIgnoringSymbols(obj2);
  });

  it("throws when an expected property is missing", () => {
    const obj1 = {
      name: "test",
      [testSymbol1]: "ignored",
    };

    const obj2 = {
      name: "test",
      value: 42, // This property is missing in obj1
    };

    expect(() => {
      expect(obj1).toMatchObjectIgnoringSymbols(obj2);
    }).toThrow();
  });

  it("throws when a property value differs", () => {
    const obj1 = {
      name: "test1",
      [testSymbol1]: "ignored",
    };

    const obj2 = {
      name: "test2",
    };

    expect(() => {
      expect(obj1).toMatchObjectIgnoringSymbols(obj2);
    }).toThrow();
  });

  it("throws when a nested property value differs", () => {
    const obj1 = {
      user: {
        name: "John",
        [testSymbol1]: "ignored",
        settings: {
          theme: "dark",
        },
      },
    };

    const obj2 = {
      user: {
        name: "John",
        settings: {
          theme: "light",
        },
      },
    };

    expect(() => {
      expect(obj1).toMatchObjectIgnoringSymbols(obj2);
    }).toThrow();
  });

  it("throws when a number value differs", () => {
    expect(() => {
      expect({ value: 1 }).toMatchObjectIgnoringSymbols({ value: 2 });
    }).toThrow();
  });

  it("matches `NaN` against `NaN`", () => {
    expect({ value: NaN, [testSymbol1]: "ignored" })
      .toMatchObjectIgnoringSymbols({ value: NaN });
  });

  it("includes the caller's custom message in a partial-match failure", () => {
    let message: string | undefined;
    try {
      expect(
        { name: "test" },
        "partial custom message",
      ).toMatchObjectIgnoringSymbols({ value: 42 });
    } catch (error) {
      message = (error as Error).message;
    }

    if (!message) {
      throw new Error("expected matcher to throw");
    }
    expect(message).toContain(
      "partial custom message: expected object to match when ignoring symbols",
    );
  });
});
