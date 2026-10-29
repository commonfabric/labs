import { assertEquals } from "@std/assert";
import type {
  Default,
  FactoryInput,
  HandlerFactory,
  JSONSchema,
  PatternFactory,
  PatternFunction,
  Reactive,
  SELF,
  StripCell,
  WishFunction,
  WishParams,
  WishState,
  Writable,
} from "@commonfabric/api";
// Evaluating this module is what installs the ambient schema declarations
// the assertions below rest on.
import * as schemaModule from "@commonfabric/api/schema";
import type { Schema, SchemaWithoutCell } from "@commonfabric/api/schema";
import type { MustBeTrue } from "@commonfabric/utils/types";
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

type SchemaPatternOverloadAcceptsFactoryInput = PatternFunction extends {
  <IS extends JSONSchema = JSONSchema, OS extends JSONSchema = JSONSchema>(
    fn: (
      input: Reactive<Schema<IS>> & { [SELF]: Reactive<Schema<OS>> },
    ) => FactoryInput<Schema<OS>>,
    argumentSchema: IS,
    resultSchema: OS,
  ): PatternFactory<SchemaWithoutCell<IS>, Schema<OS>>;
} ? true
  : never;

type SchemaWishOverloadAcceptsFactoryInput = WishFunction extends {
  <S extends JSONSchema = JSONSchema>(
    target: FactoryInput<WishParams>,
    schema: S,
  ): Reactive<WishState<Schema<S>>>;
} ? true
  : never;

const _schemaPatternOverload: MustBeTrue<
  SchemaPatternOverloadAcceptsFactoryInput
> = true;

const _schemaWishOverload: MustBeTrue<
  SchemaWishOverloadAcceptsFactoryInput
> = true;

Deno.test("FactoryInput accepts reactive cell handles in factory bindings", () => {
  assertEquals(
    [
      typeof schemaModule,
      _handlerBinding,
      _roomBinding,
      _handlerFactory,
      _patternFactory,
      _wrongRoomBinding,
      _schemaPatternOverload,
      _schemaWishOverload,
    ],
    ["object", true, true, true, true, true, true, true],
  );
});
