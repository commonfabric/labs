/** The originator's only authorized writer leaves the attestation as created. */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import Invitation from "./invitation.tsx";
import { retainOriginator } from "./privacy.tsx";
import type { Profile } from "./views.tsx";

export default pattern(() => {
  const profile = new Writable<Profile>({ name: "Book lover" });
  const invitation = Invitation({ originatorProfile: profile });
  const retain = retainOriginator({});
  const created = assert(() => Object.keys(invitation.originator).length === 0);
  const runRetain = action(() => {
    retain.send();
    retain.send();
  });
  const retained = assert(() =>
    Object.keys(invitation.originator).length === 0
  );
  return {
    [TESTS]: [
      { assertion: created },
      { action: runRetain },
      { assertion: retained },
    ],
  };
});
