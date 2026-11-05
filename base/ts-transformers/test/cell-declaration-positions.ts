/**
 * The positions a pattern author declares a cell type in, for tests that hold
 * one spelling of a cell type to what another emits in each of them. A cell is
 * lowered by a different path in each: a builder's argument and a property of
 * it, a handler's state and its event and a property of each, and a closure's
 * capture.
 */

import { callSchemas, parseModule } from "./transformed-ast.ts";

/** One position a cell type is declared in. */
export interface CellDeclarationPosition {
  /**
   * Source that declares `c` with `cellType` in this position and reads it,
   * for a module that imports `computed`, `handler`, `lift`, and `pattern`.
   */
  readonly source: (cellType: string) => string;

  /** The schema emitted for `c`, read from the transformed `output`. */
  readonly schemaOf: (output: string) => unknown;
}

/** Each position a cell type is declared in, by a phrase naming it. */
export const CELL_DECLARATION_POSITIONS: Readonly<
  Record<string, CellDeclarationPosition>
> = {
  "a `lift()` property": {
    source: (cellType) =>
      `const f = lift(({ c }: { c: ${cellType} }) => JSON.stringify(c.get()));`,
    schemaOf: (output) =>
      propertyC(callSchemas(parseModule(output), "lift")[0]),
  },
  "a `lift()` argument": {
    source: (cellType) =>
      `const f = lift((c: ${cellType}) => JSON.stringify(c.get()));`,
    schemaOf: (output) => callSchemas(parseModule(output), "lift")[0],
  },
  "a `handler()` state property": {
    source: (cellType) =>
      `const h = handler<void, { c: ${cellType} }>((_e, { c }) => {
         console.log(JSON.stringify(c.get()));
       });`,
    schemaOf: (output) =>
      propertyC(callSchemas(parseModule(output), "handler")[1]),
  },
  "a `handler()` state": {
    source: (cellType) =>
      `const h = handler<void, ${cellType}>((_e, c) => {
         console.log(JSON.stringify(c.get()));
       });`,
    schemaOf: (output) => callSchemas(parseModule(output), "handler")[1],
  },
  "a `handler()` event": {
    source: (cellType) =>
      `const h = handler<${cellType}, Record<string, never>>((c) => {
         console.log(JSON.stringify(c.get()));
       });`,
    schemaOf: (output) => callSchemas(parseModule(output), "handler")[0],
  },
  "a `handler()` event property": {
    source: (cellType) =>
      `const h = handler<{ c: ${cellType} }, Record<string, never>>((e) => {
         console.log(JSON.stringify(e.c.get()));
       });`,
    schemaOf: (output) =>
      propertyC(callSchemas(parseModule(output), "handler")[0]),
  },
  "a `computed()` capture": {
    source: (cellType) =>
      `export default pattern<{ c: ${cellType} }>(({ c }) => ({
         s: computed(() => JSON.stringify(c.get())),
       }));`,
    schemaOf: (output) =>
      propertyC(callSchemas(parseModule(output), "lift")[0]),
  },
};

/** The schema of property `c` in `schema`. */
function propertyC(schema: Record<string, unknown> | undefined): unknown {
  return (schema?.properties as Record<string, unknown> | undefined)?.c;
}
