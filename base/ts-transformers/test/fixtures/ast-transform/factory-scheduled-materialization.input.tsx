// FIXTURE: factory-scheduled-materialization
// Verifies: factories delivered to scheduled lift/handler callbacks are
//   runner-materialized callables and therefore remain direct calls.
// Expected: no invokeFactory lowering inside either scheduled callback.
import {
  handler,
  lift,
  type ModuleFactory,
  type PatternFactory,
} from "commonfabric";

interface Input {
  value: number;
}
interface Output {
  result: number;
}

export const apply = lift((input: {
  operation: PatternFactory<Input, Output>;
  value: number;
}) => input.operation({ value: input.value }));

export const react = handler((event: {
  operation: PatternFactory<Input, Output>;
  value: number;
}, context: {
  operation: ModuleFactory<Input, Output>;
  value: number;
}) => {
  event.operation({ value: event.value });
  context.operation({ value: context.value });
});
