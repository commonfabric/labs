import type { FabricValuePlus } from "@/interface.ts";
import { BaseFabricCodec } from "./BaseFabricCodec.ts";
import type { NonterminalCodec } from "./interface.ts";

/**
 * Base class for a `NonterminalCodec`: one whose essential state is made of
 * `FabricValuePlus<PlusType>`s, which the walker encodes in turn. One instance
 * serves every wire format.
 *
 * It adds nothing to {@link BaseFabricCodec} but the domain --
 * `FabricValuePlus<PlusType>` on the value side and the state side alike --
 * and its own identity, and the identity is the point: `CodecRegistry` reads
 * it to know that a state coming out of here is more work rather than an
 * answer.
 *
 * `PlusType` is as {@link NonterminalCodec} describes it. It comes first so
 * that `State` can default to the whole of the domain it bounds; a subclass
 * naming its state alone writes `never` ahead of it. `State` is as {@link
 * FabricCodec} describes it, passed straight through, and is bounded by
 * `FabricValuePlus<PlusType>` here for the same reason `Encoded` is fixed to
 * it: these are the states a walker will expand.
 */
export abstract class BaseNonterminalCodec<
  PlusType = never,
  State extends FabricValuePlus<PlusType> = FabricValuePlus<PlusType>,
> extends BaseFabricCodec<PlusType, FabricValuePlus<PlusType>, State>
  implements NonterminalCodec<PlusType, State> {
  // This space intentionally left blank.

  static {
    Object.freeze(this);
    Object.freeze(this.prototype);
  }
}
