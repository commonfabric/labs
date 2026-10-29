import { ConsoleMethod } from "./harness/console.ts";

export type ConsoleMessage = {
  metadata:
    | { pieceId?: string; patternId?: string; space?: string }
    | undefined;
  method: ConsoleMethod;
  args: any[];
};
