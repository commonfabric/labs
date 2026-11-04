import { multiUserTest } from "commonfabric";
import { alice, bob } from "./subject.tsx";

export default multiUserTest({
  participants: { alice, bob },
});
