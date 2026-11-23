/**
 * The compiled patterns a runtime registered, by the identity it computed for
 * each: the content hash of the plan and the value code together. A
 * `plan-write` write-policy input names a compiled pattern by that identity,
 * and the commit preparation honors it only for a pattern registered here, so
 * a caller never names an identity it did not get from `register`.
 */

import type { FabricValue } from "@commonfabric/api";
import { deepFreeze, hashStringOf } from "@commonfabric/data-model";

import { LabelTable, type Template } from "./plan-template.ts";
import {
  type RuntimeWritePolicyAuthorization,
  runtimeWritePolicyAuthorized,
} from "./types.ts";

/**
 * The part of a compiled pattern's plan the commit preparation reads: the
 * label templates of its outputs and write edges, its template table, and
 * the membership template and source of each collection. The plan carries more; the
 * whole plan is what its identity hashes.
 */
export interface CompiledPlan {
  /**
   * The identity of each pattern whose source the plan holds code of
   * (`Plan.patterns`): entry 0 is the pattern the plan is compiled from,
   * the others the patterns compiled into it.
   */
  readonly patterns?: readonly string[];
  readonly outputs: readonly {
    /** Absent where the plan has no template for the output. */
    readonly template?: Template;
    readonly kept?: boolean;
  }[];
  readonly bodies: readonly {
    /**
     * For a handler declared at a binding of module scope, what identifies
     * it for a writer claim (`compiledWriterOf`): the content-addressed
     * identity of its module and the path of its binding in that module.
     */
    readonly code?: {
      readonly module: string;
      readonly binding: readonly string[];
    };
    readonly writes: readonly { readonly template: Template }[];
  }[];
  readonly cones: readonly {
    readonly writes: readonly { readonly template: Template }[];
  }[];
  readonly templates: readonly Template[];
  readonly collections: readonly {
    readonly membership: Template;
    /**
     * What the collection iterates: a slot, another collection, or the
     * array an output computes.
     */
    readonly source?: {
      readonly slot?: number;
      readonly collection?: number;
      readonly output?: number;
    };
  }[];
  readonly stateCells: readonly {
    readonly first?: { readonly cone: number; readonly write: number };
  }[];
  /** The operations, each with the template of its operands. */
  readonly operations?: readonly {
    readonly kind?: string;
    readonly input?: Template;
  }[];
  /**
   * The reads no template names a slot for. An entry of kind `search` is
   * what the resolution of the operation it names read.
   */
  readonly dynamicReads?: readonly {
    readonly why?: { readonly kind?: string; readonly operation?: number };
  }[];
}

/**
 * The compiled patterns one runtime registered, and the table its template
 * labels are interned in. `Runtime` holds one and hands it to every
 * transaction it creates.
 */
export class CompiledPlanRegistry {
  readonly #plans = new Map<string, CompiledPlan>();
  readonly #labels = new LabelTable();

  /** The table the runtime's template labels are interned in. */
  get labels(): LabelTable {
    return this.#labels;
  }

  /**
   * Registers a compiled pattern and returns its identity, the content hash
   * of `plan` and `code` together: the plan and the value code are addressed
   * together, so neither can be swapped under the other's identity. Throws
   * without the runtime's mark.
   */
  register(
    plan: CompiledPlan,
    code: string,
    authorization?: RuntimeWritePolicyAuthorization,
  ): string {
    if (!runtimeWritePolicyAuthorized(authorization)) {
      throw new Error(
        "Registering a compiled pattern takes the runtime's authorization",
      );
    }
    const frozen = deepFreeze(structuredClone(plan));
    const identity = hashStringOf({
      plan: frozen as unknown as FabricValue,
      code,
    });
    if (!this.#plans.has(identity)) this.#plans.set(identity, frozen);
    return identity;
  }

  /**
   * Returns the plan registered under `identity`, or `undefined` where none
   * is or the runtime's mark is missing.
   */
  plan(
    identity: string,
    authorization?: RuntimeWritePolicyAuthorization,
  ): CompiledPlan | undefined {
    if (!runtimeWritePolicyAuthorized(authorization)) return undefined;
    return this.#plans.get(identity);
  }
}
