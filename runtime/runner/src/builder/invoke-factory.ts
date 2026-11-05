import type { FactoryContract } from "../factory-contract.ts";
import { reactive, stream } from "./reactive.ts";
import { getTopFrame } from "./pattern.ts";
import type { FactoryInput, NodeRef, Reactive, Stream } from "./types.ts";
import { connectInputAndOutputs } from "./node-utils.ts";

/**
 * Private transformer target for a call whose factory is symbolic at eager
 * graph-construction time. It records the binding and call-site contract; the
 * selected artifact remains entirely outside the node's serialized identity.
 */
export function invokeFactory(
  factory: unknown,
  input: FactoryInput<unknown>,
  expected: Extract<FactoryContract, { kind: "handler" }>,
): Stream<unknown>;
export function invokeFactory(
  factory: unknown,
  input: FactoryInput<unknown>,
  expected: Exclude<FactoryContract, { kind: "handler" }>,
): Reactive<unknown>;
export function invokeFactory(
  factory: unknown,
  input: FactoryInput<unknown>,
  expected: FactoryContract,
): Reactive<unknown> | Stream<unknown> {
  const frame = getTopFrame();

  if (expected.kind === "handler") {
    const eventStream = stream<unknown>(expected.eventSchema ?? true);
    const node: NodeRef = {
      module: factory as NodeRef["module"],
      inputs: { $ctx: input, $event: eventStream },
      outputs: {} as Reactive<unknown>,
      frame,
      expectedFactory: expected,
    };
    connectInputAndOutputs(node);
    return eventStream;
  }

  // Pattern results are live views over child result documents. Their public
  // Factory@1 contract stays on expectedFactory and must not be merged into the
  // current payload; module/lift outputs retain their execution schema.
  const outputs = expected.kind === "pattern"
    ? reactive<unknown>()
    : reactive<unknown>(undefined, expected.resultSchema);
  const node: NodeRef = {
    module: factory as NodeRef["module"],
    inputs: input,
    outputs,
    frame,
    expectedFactory: expected,
  };
  connectInputAndOutputs(node);
  (outputs as unknown as { connect(node: NodeRef): void }).connect(node);
  return outputs;
}
