import {
  type Cell,
  Default,
  handler,
  pattern,
  UI,
  Writable,
  wish,
} from "commonfabric";

interface Profile {
  name: string;
}

const join = handler<
  { name: string },
  {
    myName: Writable<string>;
    profile: Cell<Profile> | undefined;
  }
>((event, { myName, profile }) => {
  const resolved = profile?.get();
  myName.set(resolved ? resolved.name : event.name);
});

interface CardState {
  myName: Default<string, "">;
  profile?: Cell<Profile>;
}

// FIXTURE: builder-arg-hoisted-nullish-selection
// Verifies: the remedy the `reactive:call-argument-computation` diagnostic
//   advises — a reactive `??` selection hoisted to a body-level const and
//   bound into a bound-handler's builder args — lowers cleanly:
//   const activeProfile = profile ?? profileWish.result;
//     -> __cfLift_1({profile, profileWish:{result: ...key("result")}})
//        .for("activeProfile", true)   (authored-name cause)
//   join({ myName, profile: activeProfile })
//     -> binds the named derived node, with builder-layer cause layering
//        ?.for(["boundJoin", "profile"], true)   (optional, since the type of
//        `activeProfile` admits `undefined`)
// Context: the INLINE form of this `??` in the builder args is rejected with
//   the hoist diagnostic (see fixtures/bug-repro/ and
//   test/builder-argument-computation-diagnostic.test.ts); this golden pins
//   that the advised hoisted form compiles, and what it compiles to.
export default pattern<CardState>(({ myName, profile }) => {
  const profileWish = wish<Profile>({ query: "#profile" });
  const activeProfile = profile ?? profileWish.result;
  const boundJoin = join({
    myName,
    profile: activeProfile,
  });
  return {
    [UI]: (
      <div>
        <cf-button onClick={() => boundJoin.send({ name: "guest" })}>
          Join
        </cf-button>
      </div>
    ),
  };
});
