import { BaseFabricCodec } from "./BaseFabricCodec.ts";
import type { TerminalCodec } from "./interface.ts";

/**
 * Base class for a `TerminalCodec`: one whose essential state is already in the
 * domain of the wire format `Encoded`, so the walker passes it through
 * untouched. An instance belongs to that format alone.
 *
 * It adds nothing to {@link BaseFabricCodec} but its own identity, and the
 * identity is the point: `CodecRegistry` reads it to know that a state coming
 * out of here is the answer rather than more work.
 *
 * `State` is as {@link FabricCodec} describes it, passed straight through:
 * this codec's own states, within the one format it serves. The value side is
 * at `never`, as {@link TerminalCodec} says: nothing beyond a `FabricValue` has
 * a wire form.
 *
 * `Encoded` must be a wire format's own value type, and never `FabricValue`.
 * Nothing enforces that. `TerminalCodec<FabricValue>` and `NonterminalCodec`
 * are the same type, so a subclass declared at `FabricValue` satisfies the
 * nonterminal half of every signature while classifying as terminal at run
 * time, and its state would reach the wire unexpanded. A codec whose state is
 * made of `FabricValue`s extends {@link BaseNonterminalCodec}.
 */
export abstract class BaseTerminalCodec<
  Encoded,
  State extends Encoded = Encoded,
> extends BaseFabricCodec<never, Encoded, State>
  implements TerminalCodec<Encoded, State> {
  // This space intentionally left blank.

  static {
    Object.freeze(this);
    Object.freeze(this.prototype);
  }
}
