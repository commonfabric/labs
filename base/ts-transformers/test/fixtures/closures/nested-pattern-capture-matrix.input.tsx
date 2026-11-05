import {
  pattern,
  type Cell,
  type HandlerFactory,
  type ModuleFactory,
  type PatternFactory,
} from "commonfabric";

interface OperationInput {
  value: number;
}

interface OperationOutput {
  result: number;
}

// FIXTURE: nested-pattern-capture-matrix
// Verifies: property paths, Cells, every factory kind, deterministic capture
// order, and a compiler-reserved capture-name collision all remain symbolic.
export default pattern<{
  cell: Cell<string>;
  config: { label: string };
  patternOperation: PatternFactory<OperationInput, OperationOutput>;
  moduleOperation: ModuleFactory<OperationInput, OperationOutput>;
  handlerOperation: HandlerFactory<OperationInput, OperationOutput>;
  __cf_pattern_input: string;
}>(({
  cell,
  config,
  patternOperation,
  moduleOperation,
  handlerOperation,
  __cf_pattern_input,
}) => ({
  child: pattern<OperationInput>(({ value }) => ({
    value,
    cell,
    label: config.label,
    patternOperation,
    moduleOperation,
    handlerOperation,
    reserved: __cf_pattern_input,
  })),
}));
