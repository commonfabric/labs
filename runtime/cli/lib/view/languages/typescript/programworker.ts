/**
 * A program worker's entry: loaded in a Deno Worker by the TypeScript semantic
 * service when it prewarms, it builds the program the first message describes
 * and answers the queries that arrive on that message's port. The protocol is
 * in `programchannel.ts`.
 */

import { type ProgramWorkerMessage, serveProgram } from "./programchannel.ts";
import type { ProgramSpec } from "./semantics.ts";

self.onmessage = ({ data }: MessageEvent<ProgramWorkerMessage<ProgramSpec>>) =>
  serveProgram(data, async (spec) => {
    // deno-lint-ignore cf-imports/no-inline-module-import -- loaded once the worker has said it is serving, so that a query waits for TypeScript to load rather than being answered elsewhere
    const { localProgram } = await import("./semantics.ts");
    return localProgram(spec);
  });
