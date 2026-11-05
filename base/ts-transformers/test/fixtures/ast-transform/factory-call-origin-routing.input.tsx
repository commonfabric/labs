// FIXTURE: factory-call-origin-routing
// Verifies: live module-scope factories stay direct while eager pattern input
//   factories lower through invokeFactory with an exact public contract.
// Context: Covers property access, const aliases, typed element access, and a
//   schema-compatible same-kind union for pattern, module, and handler kinds.
import {
  byRef,
  handler,
  lift,
  pattern,
  type HandlerFactory,
  type ModuleFactory,
  type PatternFactory,
} from "commonfabric";

interface Input {
  value: number;
}

interface Output {
  result: number;
}

interface EquivalentInput {
  value: number;
}

interface EquivalentOutput {
  result: number;
}

type PatternOperation = PatternFactory<Input, Output>;
type ModuleOperation = ModuleFactory<Input, Output>;
type HandlerOperation = HandlerFactory<Output, Input>;
type CompatiblePatternChoice =
  | PatternOperation
  | PatternFactory<EquivalentInput, EquivalentOutput>;

const livePattern = pattern<Input, Output>(({ value }) => ({
  result: value * 2,
}));
const liveModule = lift((input: Input): Output => ({
  result: input.value + 1,
}));
const liveHandler = handler((event: Output, _context: Input) => event.result);
const schemaLightRef = byRef<Input, Output>("fixture:schema-light-module");

export default pattern<{
  pattern: PatternOperation;
  patterns: Record<string, PatternOperation>;
  module: ModuleOperation;
  modules: Record<string, ModuleOperation>;
  handler: HandlerOperation;
  handlers: Record<string, HandlerOperation>;
  choice: CompatiblePatternChoice;
  reference: typeof schemaLightRef;
  value: number;
}>((input) => {
  const patternAlias = input.pattern;
  const moduleAlias = input.module;
  const handlerAlias = input.handler;

  return {
    livePattern: livePattern({ value: input.value }),
    liveModule: liveModule({ value: input.value }),
    liveHandler: liveHandler({ value: input.value }),
    patternProperty: input.pattern({ value: input.value }),
    patternAlias: patternAlias({ value: input.value }),
    patternElement: input.patterns["primary"]!({ value: input.value }),
    moduleProperty: input.module({ value: input.value }),
    moduleAlias: moduleAlias({ value: input.value }),
    moduleElement: input.modules["primary"]!({ value: input.value }),
    handlerProperty: input.handler({ value: input.value }),
    handlerAlias: handlerAlias({ value: input.value }),
    handlerElement: input.handlers["primary"]!({ value: input.value }),
    compatibleChoice: input.choice({ value: input.value }),
    schemaLightReference: input.reference({ value: input.value }),
  };
});
