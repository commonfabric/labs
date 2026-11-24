/**
 * A program worker for the program worker tests that says it is serving and
 * then fails to load its program.
 */

import {
  type ProgramWorkerMessage,
  serveProgram,
} from "../../../../../lib/view/languages/typescript/programchannel.ts";
import type { ProgramSpec } from "../../../../../lib/view/languages/typescript/semantics.ts";

self.onmessage = ({ data }: MessageEvent<ProgramWorkerMessage<ProgramSpec>>) =>
  serveProgram(data, () => Promise.reject(new Error("no program")));
