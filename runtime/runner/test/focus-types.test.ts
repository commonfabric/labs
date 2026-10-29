/**
 * Type-level tests for Cell.key() with multiple keys
 *
 * These tests verify that key() correctly handles multiple keys.
 * If the types are incorrect, these tests will fail to compile.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { MustBeTrue } from "@commonfabric/utils/types";
import type {
  AsCell,
  Cell,
  KeyResultType,
  Stream,
} from "../src/builder/types.ts";

//
// Type-level assertions (compile-time checks)
//

/**
 * Helper type that asserts two types are equal.
 * If T and U are not the same, this produces `never`.
 */
type AssertEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never)
  : never;

// Test data types
type User = {
  name: string;
  age: number;
  profile: {
    bio: string;
    avatar: string;
    settings: {
      theme: "light" | "dark";
      notifications: boolean;
    };
  };
  posts: Array<{
    id: number;
    title: string;
    content: string;
  }>;
};

//
// KeyResultType type tests
//

// Use value assignments to enforce type checks at compile time

// Empty keys should return the original type
const _test1: MustBeTrue<
  AssertEqual<KeyResultType<User, [], AsCell>, Cell<User>>
> = true;

// Single key
const _test2: MustBeTrue<
  AssertEqual<KeyResultType<User, ["name"], AsCell>, Cell<string>>
> = true;

const _test3: MustBeTrue<
  AssertEqual<KeyResultType<User, ["age"], AsCell>, Cell<number>>
> = true;

const _test4: MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["profile"], AsCell>,
    Cell<User["profile"]>
  >
> = true;

// Two keys
const _test5: MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["profile", "bio"], AsCell>,
    Cell<string>
  >
> = true;

const _test6: MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["profile", "settings"], AsCell>,
    Cell<User["profile"]["settings"]>
  >
> = true;

// Three keys
const _test7: MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["profile", "settings", "theme"], AsCell>,
    Cell<"light" | "dark">
  >
> = true;

const _test8: MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["profile", "settings", "notifications"], AsCell>,
    Cell<boolean>
  >
> = true;

// Array access
const _test9: MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["posts", 0], AsCell>,
    Cell<User["posts"][0]>
  >
> = true;

const _test10: MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["posts", 0, "title"], AsCell>,
    Cell<string>
  >
> = true;

// Unknown keys should fall back to Cell<any>
const _test11: MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["unknownKey"], AsCell>,
    Cell<any>
  >
> = true;

const _test12: MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["profile", "unknownKey"], AsCell>,
    Cell<any>
  >
> = true;

//
// Nested Cell and Stream type tests
//

// Type with nested Cell and Stream
type StateWithNestedCells = {
  user: Cell<User>;
  events: Stream<{ type: string; data: unknown }>;
  nested: {
    counter: Cell<number>;
    notifications: Stream<string>;
  };
};

// When accessing a property that is Cell<T>, returns Cell<T> directly (not Cell<Cell<T>>)
const _testNestedCell1: MustBeTrue<
  AssertEqual<
    KeyResultType<StateWithNestedCells, ["user"], AsCell>,
    Cell<User>
  >
> = true;

// When accessing a property that is Stream<T>, returns Stream<T> directly (not Cell<Stream<T>>)
const _testNestedStream1: MustBeTrue<
  AssertEqual<
    KeyResultType<StateWithNestedCells, ["events"], AsCell>,
    Stream<{ type: string; data: unknown }>
  >
> = true;

// Nested path to Cell - returns Cell<number> directly
const _testNestedCell2: MustBeTrue<
  AssertEqual<
    KeyResultType<StateWithNestedCells, ["nested", "counter"], AsCell>,
    Cell<number>
  >
> = true;

// Nested path to Stream - returns Stream<string> directly
const _testNestedStream2: MustBeTrue<
  AssertEqual<
    KeyResultType<StateWithNestedCells, ["nested", "notifications"], AsCell>,
    Stream<string>
  >
> = true;

//
// Runtime tests (behavior verification)
//

describe("Cell.key() with multiple keys", () => {
  it("compiles with correct types - this test verifies the type assertions above", () => {
    // If this file compiles, the type tests pass
    // The type assertions above use MustBeTrue which would cause compile errors if wrong
    expect(true).toBe(true);
  });

  it("key() with no keys should have same type as the cell", () => {
    // This is a compile-time check - if types are wrong, this won't compile
    const checkType = <T>(_cell: Cell<T>, _keyed: Cell<T>) => {};
    const _useCheckType = (cell: Cell<User>) => {
      // @ts-expect-error - key() with no args returns Cell<User>, not void
      const _keyed: void = cell.key();
      // This should compile fine:
      checkType(cell, cell.key());
    };
    expect(true).toBe(true);
  });

  it("key() with multiple keys works", () => {
    const _useCheckType = (cell: Cell<User>) => {
      // Single key
      const _name: Cell<string> = cell.key("name");

      // Two keys
      const _bio: Cell<string> = cell.key("profile", "bio");

      // Three keys
      const _theme: Cell<"light" | "dark"> = cell.key(
        "profile",
        "settings",
        "theme",
      );

      // Array access
      const _post: Cell<User["posts"][0]> = cell.key("posts", 0);
      const _title: Cell<string> = cell.key("posts", 0, "title");
    };
    expect(true).toBe(true);
  });
});
