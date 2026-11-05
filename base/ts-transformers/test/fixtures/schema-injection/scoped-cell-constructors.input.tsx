import {
  Cell,
  Stream,
  type PerUser,
  type Writable,
  Writable as WritableConstructor,
} from "commonfabric";

interface Event {
  message: string;
}

// FIXTURE: scoped-cell-constructors
// Verifies: scoped cell constructor helpers inject top-level schema scopes.
export default function TestScopedCellConstructors() {
  const name = new WritableConstructor.perUser("Ada");
  const draft = Cell.perSession.for<string>("draft");
  const events = new Stream.perSpace<Event>({ message: "ready" });
  const contextual: PerUser<Writable<string>> = new WritableConstructor("");
  const inherited = new WritableConstructor("");

  return {
    name,
    draft,
    events,
    contextual,
    inherited,
  };
}
