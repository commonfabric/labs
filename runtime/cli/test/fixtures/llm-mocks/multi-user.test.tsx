import { multiUserTest } from "commonfabric";
import alice from "./subject.tsx";

export const llmMocks = [];
export default multiUserTest({ participants: { alice } });
