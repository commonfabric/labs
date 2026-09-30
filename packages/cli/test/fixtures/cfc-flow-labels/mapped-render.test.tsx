/**
 * Labeled SQLite mapped-render scaling fixture. Each render demands the full
 * mapped view at the named row count; seeding precedes the render intervals.
 * Run the same file with --cfc-enforcement-mode disabled --cfc-flow-labels off
 * and with --cfc-shell-posture, adding --verbose --stats-threshold 0 to both.
 */
import {
  action,
  assert,
  pattern,
  sqliteDatabase,
  type SqliteDb,
  table,
  TESTS,
  UI,
  Writable,
} from "commonfabric";

interface Row {
  id: number;
  title: string;
}

const MappedRows = pattern<{ db: SqliteDb; count: number }>(({ db, count }) => {
  const query = db.query<Row>(
    "SELECT id, title FROM messages ORDER BY id LIMIT ?",
    { params: [count] },
  );
  return {
    query,
    [UI]: <div>{query.result?.map((row) => <p>{row.title}</p>)}</div>,
  };
});

export default pattern(() => {
  const db = sqliteDatabase({
    tables: {
      messages: table({
        id: "integer primary key",
        title: {
          type: "string",
          sqlType: "text",
          ifc: { confidentiality: ["fixture-private"] },
        },
      }),
    },
  });
  const seed = action(() => {
    for (let i = 1; i <= 150; i++) {
      db.exec("INSERT INTO messages (id, title) VALUES (?, ?)", [
        i,
        `Message ${i}`,
      ]);
    }
  });
  const small = MappedRows({ db, count: 11 });
  const medium = MappedRows({ db, count: 50 });
  const large = MappedRows({ db, count: 150 });

  const copied = new Writable<Row[]>([]);

  return {
    small,
    copied,
    [TESTS]: [
      { action: seed },
      { action: action(() => console.log("Mapped render N=11")) },
      { assertion: assert(() => small.query.result?.length === 11) },
      { render: small[UI] },
      {
        action: action(() => {
          console.log("Labeled copy N=11");
          copied.set((small.query.result ?? []).map((row: Row) => ({
            id: row.id,
            title: row.title,
          })));
        }),
      },
      { assertion: assert(() => copied.get().length === 11) },
      { action: action(() => console.log("Mapped render N=50")) },
      { assertion: assert(() => medium.query.result?.length === 50) },
      { render: medium[UI] },
      {
        action: action(() => {
          console.log("Labeled copy N=50");
          copied.set((medium.query.result ?? []).map((row: Row) => ({
            id: row.id,
            title: row.title,
          })));
        }),
      },
      { assertion: assert(() => copied.get().length === 50) },
      { action: action(() => console.log("Mapped render N=150")) },
      { assertion: assert(() => large.query.result?.length === 150) },
      { render: large[UI] },
      {
        action: action(() => {
          console.log("Labeled copy N=150");
          copied.set((large.query.result ?? []).map((row: Row) => ({
            id: row.id,
            title: row.title,
          })));
        }),
      },
      { assertion: assert(() => copied.get().length === 150) },
      { settle: true },
    ],
  };
});
