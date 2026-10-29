/**
 * Type-level tests for factory input acceptance.
 *
 * If any type assertion is wrong, this file fails to compile.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Default, Writable } from "@commonfabric/api";
import type { MustBeTrue } from "@commonfabric/utils/types";

import type {
  FactoryInput,
  HandlerFactory,
  PatternFactory,
  StripCell,
} from "../src/builder/types.ts";
type AssertAssignable<T, U> = [T] extends [U] ? true : never;
type AssertNotAssignable<T, U> = [T] extends [U] ? never : true;

interface Ship {
  name: string;
}

interface PlayerData {
  name: string;
  ships: Ship[];
}

type PlayerCell = Writable<PlayerData | null | Default<null>>;
type ReactivePlayerData = {
  name: FactoryInput<string>;
  ships: Array<FactoryInput<Ship>>;
};

interface HandlerState {
  name: string;
  player1: PlayerCell;
}

interface RoomInput {
  player1: PlayerCell;
}

type HandlerBinding = {
  name: FactoryInput<string>;
  player1: Writable<ReactivePlayerData | null>;
};

type RoomBinding = {
  player1: Writable<ReactivePlayerData | null>;
};

type WrongRoomBinding = {
  player1: Writable<
    {
      name: FactoryInput<number>;
      ships: Array<FactoryInput<Ship>>;
    } | null
  >;
};

const _handlerBinding: MustBeTrue<
  AssertAssignable<HandlerBinding, FactoryInput<StripCell<HandlerState>>>
> = true;

const _roomBinding: MustBeTrue<
  AssertAssignable<RoomBinding, FactoryInput<StripCell<RoomInput>>>
> = true;

const _handlerFactory: MustBeTrue<
  AssertAssignable<
    HandlerFactory<void, HandlerState>,
    (inputs: HandlerBinding) => unknown
  >
> = true;

const _patternFactory: MustBeTrue<
  AssertAssignable<
    PatternFactory<StripCell<RoomInput>, unknown>,
    (inputs: RoomBinding) => unknown
  >
> = true;

const _wrongRoomBinding: MustBeTrue<
  AssertNotAssignable<WrongRoomBinding, FactoryInput<StripCell<RoomInput>>>
> = true;

describe("factory input types", () => {
  it("accepts reactive cell handles without casts", () => {
    expect(true).toBe(true);
  });
});
