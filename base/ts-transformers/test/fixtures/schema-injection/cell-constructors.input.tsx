import {
  Cell,
  ComparableCell,
  ReadonlyCell,
  Stream,
  type PerUser,
  type Writable,
  Writable as WritableConstructor,
  WriteonlyCell,
} from "commonfabric";

interface Event {
  message: string;
}

// FIXTURE: cell-constructors
// Verifies: schema injection treats new CellLike(...) like cell constructor calls.
//   new Cell<string>("hello") -> new Cell<string>("hello", { type: "string" })
//   new WritableConstructor.perUser("Ada") -> schema includes scope: "user"
//   const contextual: PerUser<Writable<string>> = new WritableConstructor("")
//     -> contextual schema includes scope: "user"
export default function TestCellConstructors() {
  const explicitString = new Cell<string>("hello");
  const inferredNumber = new Cell(123);
  const caused = new WritableConstructor("Ada").for("name");
  const contextual: PerUser<Writable<string>> = new WritableConstructor("");
  const scoped = new WritableConstructor.perUser("Ada");
  const event = new Stream.perSpace<Event>({ message: "ready" });
  const comparable = new ComparableCell(200);
  const readonly = new ReadonlyCell(300);
  const writeonly = new WriteonlyCell(400);
  const LocalWritable = WritableConstructor;
  const aliased = new LocalWritable("aliased");

  return {
    explicitString,
    inferredNumber,
    caused,
    contextual,
    scoped,
    event,
    comparable,
    readonly,
    writeonly,
    aliased,
  };
}
