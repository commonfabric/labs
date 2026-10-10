import {
  action,
  assert,
  currentPrincipal,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import MeetingRooms from "./main.tsx";

const MEETING = "a".repeat(64);
const NEXT = "b".repeat(64);

export default pattern(() => {
  const directory = MeetingRooms({});
  const me = new Writable("");
  const reserve = action(() => {
    me.set(currentPrincipal() ?? "");
    directory.reserve.send({ meeting: MEETING, attempt: "first-attempt" });
  });
  const repeat = action(() =>
    directory.reserve.send({ meeting: MEETING, attempt: "first-attempt" })
  );
  const competing = action(() =>
    directory.reserve.send({ meeting: MEETING, attempt: "another-device" })
  );
  const wrongPublish = action(() =>
    directory.publish.send({ meeting: MEETING, attempt: "another-device" })
  );
  const publish = action(() =>
    directory.publish.send({ meeting: MEETING, attempt: "first-attempt" })
  );
  const next = action(() =>
    directory.reserve.send({ meeting: NEXT, attempt: "first-attempt" })
  );
  const reserved = assert(() =>
    directory.claims[MEETING]?.state === "reserved" &&
    directory.claims[MEETING]?.creator === me.get() && me.get() !== "" &&
    directory.claims[MEETING]?.attempt === "first-attempt" &&
    Object.keys(directory.claims).length === 1
  );
  const allocate = action(() =>
    directory.allocate.send({
      meeting: MEETING,
      attempt: "first-attempt",
      allocation: {
        space: "did:key:meeting-room",
        publicationSeed: "root-cause",
      },
    })
  );
  const conflicting = action(() =>
    directory.allocate.send({
      meeting: MEETING,
      attempt: "first-attempt",
      allocation: {
        space: "did:key:other-room",
        publicationSeed: "other-cause",
      },
    })
  );
  const allocated = assert(() =>
    directory.claims[MEETING]?.state === "allocated" &&
    directory.claims[MEETING]?.allocation?.space === "did:key:meeting-room" &&
    directory.claims[MEETING]?.allocation?.publicationSeed === "root-cause"
  );
  const ready = assert(() =>
    directory.claims[MEETING]?.state === "ready" &&
    directory.claims[MEETING]?.attempt === "first-attempt" &&
    Object.keys(directory.claims).length === 1
  );
  return {
    [TESTS]: [
      { assertion: assert(() => Object.keys(directory.claims).length === 0) },
      { action: reserve },
      { assertion: reserved },
      { action: repeat },
      { assertion: reserved },
      { action: competing },
      { assertion: reserved },
      { action: wrongPublish },
      { assertion: reserved },
      { action: publish },
      { assertion: reserved },
      { action: allocate },
      { assertion: allocated },
      { action: allocate },
      { assertion: allocated },
      { action: conflicting },
      { assertion: allocated },
      { action: wrongPublish },
      { assertion: allocated },
      { action: publish },
      { assertion: ready },
      { action: publish },
      { assertion: ready },
      { action: competing },
      { assertion: ready },
      { action: conflicting },
      { assertion: ready },
      { action: next },
      {
        assertion: assert(() =>
          Object.keys(directory.claims).length === 2 &&
          directory.claims[NEXT]?.state === "reserved" &&
          directory.claims[MEETING]?.state === "ready"
        ),
      },
    ],
    directory,
  };
});
