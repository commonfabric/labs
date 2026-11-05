import { multiUserTest } from "commonfabric";
import alice from "./subject.tsx";

export default multiUserTest({ participants: { alice } });
