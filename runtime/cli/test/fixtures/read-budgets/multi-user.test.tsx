import { multiUserTest } from "commonfabric";
import alice from "./subject.tsx";

export const readBudgets = {};
export default multiUserTest({ participants: { alice } });
