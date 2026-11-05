import { NAME, pattern, UI, type Writable } from "commonfabric";
import type { DebugInput, DebugOutput } from "../../../debug-view/main.tsx";

export default pattern<DebugInput, DebugOutput>(({ commandsCell }) => {
  const protectedCommands: Writable<DebugOutput["commandQueue"]> = commandsCell;
  return {
    [NAME]: "Alternate agent sessions",
    [UI]: <cf-screen>Alternate agent sessions</cf-screen>,
    status: "alternate",
    sourceCount: 0,
    sessionCount: 0,
    commandCount: 0,
    receiptCount: 0,
    activityCount: 0,
    commandQueue: protectedCommands,
  };
});
