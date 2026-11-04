import { NAME, pattern, UI } from "commonfabric";
import type { DebugInput } from "../../../debug-view/main.tsx";

export default pattern<DebugInput>((_) => ({
  [NAME]: "Agent sessions without command authorization",
  [UI]: <cf-screen>Agent sessions</cf-screen>,
}));
