import { Default, handler, pattern, UI, Writable } from "commonfabric";

const join = handler<
  { name: string },
  {
    myName: Writable<string>;
    label: string;
  }
>((event, { myName }) => {
  myName.set(event.name);
});

interface CardState {
  myName: Default<string, "">;
  users: Default<string[], []>;
}

// FIXTURE: builder-arg-ternary-label
// Verifies: a ternary over a reactive comparison written inline in a
//   bound-handler's builder args lowers via the conditional emitter's ifElse
//   path (predicate lifted, literal branches preserved) rather than tripping
//   the compute-wrap guard:
//   label: users.length > 0 ? "join the others" : "be first"
//     -> ifElse(<schemas>, __cfLift_1({users}), "join the others", "be first")
// Context: contrast with the BINARY comparison form (`users.length === 0`)
//   at the same position, which is rejected with the
//   `reactive:call-argument-computation` hoist diagnostic — pinned in
//   test/builder-argument-computation-diagnostic.test.ts.
export default pattern<CardState>(({ myName, users }) => {
  const boundJoin = join({
    myName,
    label: users.length > 0 ? "join the others" : "be first",
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
