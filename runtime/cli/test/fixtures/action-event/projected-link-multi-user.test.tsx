/// <cts-enable />

/** The projected event link with an independently running participant. */

import { multiUserTest } from "commonfabric";
import { participant, setup } from "./projected-link.test.tsx";

export default multiUserTest({ setup, participants: { alice: participant } });
