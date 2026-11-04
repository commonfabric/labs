/**
 * Type-level coverage for the public IDerivable array helper surface.
 *
 * The runtime assertions are trivial; this file fails if Cell or OpaqueCell
 * stop exposing typed reactive array helpers.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Cell, OpaqueCell, Reactive } from "@commonfabric/api";

interface Item {
  label: string;
  active: boolean;
  tags: string[];
}

function acceptItems(value: Reactive<Item[]>) {
  return value;
}

function acceptStrings(value: Reactive<string[]>) {
  return value;
}

function acceptNumber(value: Reactive<number>) {
  return value;
}

function exerciseCell(items: Cell<Item[]>) {
  acceptStrings(
    items.map((item, index, array) => `${index}:${item.label}:${array.length}`),
  );
  acceptItems(
    items.filter((item, index, array) => item.active || index < array.length),
  );
  acceptStrings(items.flatMap((item) => item.tags));
  acceptNumber(
    items.findIndex((item, index, array) =>
      item.active && index < array.length
    ),
  );
}

function exerciseOpaqueCell(items: OpaqueCell<Item[]>) {
  acceptStrings(
    items.map((item, index, array) => `${index}:${item.label}:${array.length}`),
  );
  acceptItems(
    items.filter((item, index, array) => item.active || index < array.length),
  );
  acceptStrings(items.flatMap((item) => item.tags));
  acceptNumber(
    items.findIndex((item, index, array) =>
      item.active && index < array.length
    ),
  );
}

describe("IDerivable type surface", () => {
  it("exposes typed array helpers on Cell", () => {
    expect(exerciseCell).toBeDefined();
  });

  it("exposes typed array helpers on OpaqueCell", () => {
    expect(exerciseOpaqueCell).toBeDefined();
  });
});
