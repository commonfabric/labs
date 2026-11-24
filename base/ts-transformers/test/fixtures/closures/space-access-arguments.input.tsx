import { computed, handler, pattern, spaceAccess, Writable } from "commonfabric";

interface State {
  room: Writable<{ title: string }>;
}

// FIXTURE: space-access-arguments
// Verifies: a spaceAccess() call keeps the arguments its author wrote, in a
//   computed and in a handler alike
//   computed(() => spaceAccess(room)) → lift(({ room }) => spaceAccess(room))({ room })
//   computed(() => spaceAccess(undefined)) → lift(() => spaceAccess(undefined))()
// Context: spaceAccess() is a plain call; an `undefined` target means "not
//   known yet" and must not be dropped into a call with no target
const probe = handler<unknown, State>((_event, { room }) => {
  console.log(spaceAccess(room), spaceAccess(undefined));
});

export default pattern<State>(({ room }) => {
  return {
    level: computed(() => spaceAccess(room)),
    unknown: computed(() => spaceAccess(undefined)),
    probe: probe({ room }),
  };
});
