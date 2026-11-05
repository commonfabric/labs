import type { JSONSchema } from "./builder/types.ts";

/**
 * Called instead of `fn(argument)` when a debugger breakpoint is set.
 * Logs context to the console, then pauses at `debugger` so you can
 * inspect everything in DevTools before the function executes.
 */
export function patternBreakpoint(
  fn: (...args: any[]) => any,
  isValidArgument: boolean,
  argument: any,
  inputSchema: JSONSchema | undefined,
  outputSchema: JSONSchema | undefined,
  inputsCell: any,
): any {
  console.log(
    "%c[Breakpoint]",
    "color: #ef4444; font-weight: bold",
    {
      isValidArgument,
      argument,
      inputSchema,
      outputSchema,
      inputsCell,
      fn,
    },
  );
  // deno-lint-ignore no-debugger
  debugger;
  return isValidArgument ? fn(argument) : undefined;
}
