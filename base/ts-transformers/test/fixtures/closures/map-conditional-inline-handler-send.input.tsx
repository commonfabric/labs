import { Cell, handler, pattern, UI } from "commonfabric";

interface Item {
  id: string;
  label: string;
}

interface VoteEvent {
  id: string;
  step: "single" | "double";
}

interface State {
  items: Item[];
  canVote: boolean;
  votes: VoteEvent[];
}

const castVote = handler<VoteEvent, { votes: Cell<VoteEvent[]> }>(
  (event, { votes }) => {
    votes.set([
      ...votes.get(),
      event,
    ]);
  },
);

// FIXTURE: map-conditional-inline-handler-send
// Verifies: inline onClick handlers inside conditional JSX branches retain
// imperative handler semantics when nested in reactive map callbacks.
//   onClick={() => boundCastVote.send(...)} → bare handler callback body
//   not lift(...)(...boundCastVote.send(...))
// Context: The conditional branch makes expression rewriting recurse into the
// handler subtree; the authored handler arrow must be treated as safe context.
export default pattern<State>((state) => {
  const boundCastVote = castVote({ votes: state.votes }).for(
    { stream: "boundCastVote" },
  );

  return {
    [UI]: (
      <div>
        {state.items.map((item) => {
          return (
            <div>
              {state.canVote && (
                <button
                  type="button"
                  onClick={() =>
                    boundCastVote.send({
                      id: item.id,
                      step: "single",
                    })}
                >
                  {item.label}
                </button>
              )}
            </div>
          );
        })}
      </div>
    ),
  };
});
