import type { SinkConsumedLabel } from "./cell.ts";
import { ConsoleMethod } from "./harness/console.ts";

export type ConsoleMessage = {
  metadata:
    | { pieceId?: string; patternId?: string; space?: string }
    | undefined;
  method: ConsoleMethod;
  args: any[];

  /**
   * The labels of everything the action that logged had read by then: what
   * its arguments can have been made from, and so what a reader of them is
   * to be decided on. Called during the handler, while the action's
   * transaction still holds its reads. Absent for code that runs outside an
   * action, which reads no cell.
   */
  consumed?: () => SinkConsumedLabel;
};
