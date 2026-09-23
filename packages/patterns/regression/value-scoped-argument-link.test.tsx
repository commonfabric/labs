/**
 * A child pattern whose argument is `Writable<PerUser<T>>` reads the cell its
 * caller passes in, whether that cell is space- or user-scoped, and writes
 * back through it.
 *
 * `Writable<PerUser<T>>` puts the scope on the value (`scope: "user"` beside
 * `asCell: ["cell"]`). The passed link is stored in the argument slot's base
 * instance, so the child's binding must read that slot at its base scope; a
 * binding addressed at the slot's user instance reads nothing.
 *
 * Run: deno task cf test packages/patterns/regression/value-scoped-argument-link.test.tsx
 */
import {
  action,
  assert,
  computed,
  pattern,
  PerUser,
  TESTS,
  Writable,
} from "commonfabric";

interface Run {
  status: string;
}

interface ChildInput {
  run: Writable<PerUser<Run>>;
}

const Child = pattern<ChildInput>(({ run }) => ({
  status: computed(() => run.get()?.status ?? "missing"),
  finish: action(() => run.set({ status: "finished" })),
}));

export default pattern(() => {
  const spaceRun = new Writable<Run>({ status: "space" });
  const userRun = new Writable.perUser<Run>({ status: "user" });

  const readsSpace = Child({ run: spaceRun });
  const readsUser = Child({ run: userRun });

  const assertSpaceRead = assert(() => readsSpace.status === "space");
  const assertUserRead = assert(() => readsUser.status === "user");
  const assertSpaceWrittenBack = assert(() =>
    spaceRun.get().status === "finished" &&
    readsSpace.status === "finished"
  );

  return {
    [TESTS]: [
      { assertion: assertSpaceRead },
      { assertion: assertUserRead },
      { action: readsSpace.finish },
      { assertion: assertSpaceWrittenBack },
    ],
  };
});
