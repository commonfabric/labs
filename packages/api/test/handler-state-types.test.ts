import { describe, it } from "@std/testing/bdd";
import type {
  Cell,
  ComparableCell,
  HandlerState,
  OpaqueCell,
  ReadonlyCell,
  Stream,
  WriteonlyCell,
} from "@commonfabric/api";
import type { MustBeTrue, Same } from "@commonfabric/utils/types";

interface Item {
  id: string;
}

declare function appendItem(list: WriteonlyCell<Item[]>, item: Item): void;

describe("HandlerState", () => {
  // The assertions are the type checker's, and `deno task check` is what runs
  // them. `Same` yields `false` on a mismatch, which `MustBeTrue` refuses.

  it("passes a cell of every kind through unchanged", () => {
    type _Cell = MustBeTrue<Same<HandlerState<Cell<Item[]>>, Cell<Item[]>>>;
    type _Readonly = MustBeTrue<
      Same<HandlerState<ReadonlyCell<Item[]>>, ReadonlyCell<Item[]>>
    >;
    type _Writeonly = MustBeTrue<
      Same<HandlerState<WriteonlyCell<Item[]>>, WriteonlyCell<Item[]>>
    >;
    type _Comparable = MustBeTrue<
      Same<HandlerState<ComparableCell<Item>>, ComparableCell<Item>>
    >;
    type _Opaque = MustBeTrue<
      Same<HandlerState<OpaqueCell<Item>>, OpaqueCell<Item>>
    >;
    type _Stream = MustBeTrue<Same<HandlerState<Stream<Item>>, Stream<Item>>>;
  });

  it("passes a cell held in a state field through unchanged", () => {
    type _Field = MustBeTrue<
      Same<
        HandlerState<{ list: WriteonlyCell<Item[]>; pick: ReadonlyCell<Item> }>,
        {
          readonly list: WriteonlyCell<Item[]>;
          readonly pick: ReadonlyCell<Item>;
        }
      >
    >;

    // Never called: the call to `appendItem` compiles only when the field is
    // still a `WriteonlyCell`.
    const _probe = (state: HandlerState<{ list: WriteonlyCell<Item[]> }>) =>
      appendItem(state.list, { id: "a" });
  });

  it("makes plain data readonly at every depth", () => {
    type _Data = MustBeTrue<
      Same<
        HandlerState<{ count: number; items: Item[] }>,
        {
          readonly count: number;
          readonly items: ReadonlyArray<{ readonly id: string }>;
        }
      >
    >;
  });
});
