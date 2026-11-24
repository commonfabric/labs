/// <cts-enable />
// FIXTURE: labeled SQLite message aggregates expanded into reactive bubbles.
import {
  action,
  cfSqlite,
  type Confidential,
  handler,
  lift,
  NAME,
  pattern,
  type ReadonlyCell,
  sqliteDatabase,
  type SqliteDb,
  UI,
  Writable,
} from "commonfabric";

interface ThreadRow {
  id: number;
  packed: string;
}

interface ParseRow extends ThreadRow {
  packed: Confidential<string, ["cfc-prepare-messages"]>;
}

interface Bubble {
  text: string;
  me: boolean;
}

const seed = handler<{ count: number }, { db: SqliteDb }>(
  ({ count }, { db }) => {
    for (let index = 0; index < count; index++) {
      db.exec(
        "INSERT INTO messages (id, thread_id, payload) VALUES (?, ?, ?)",
        [
          index,
          1,
          JSON.stringify({ text: `Message ${index}`, me: index % 2 === 0 }),
        ],
      );
    }
  },
);

const selectThread = lift<
  { rows: ReadonlyCell<ThreadRow>[]; selected: boolean },
  ReadonlyCell<ThreadRow>[]
>(({ rows, selected }) => selected && rows?.length ? [rows[0]] : []);

const parseThread = lift<{ rows: ParseRow[] }, Bubble[]>(
  ({ rows }) => rows.length ? JSON.parse(rows[0].packed) : [],
);

export default pattern(() => {
  const { table } = cfSqlite;
  const db = sqliteDatabase({
    tables: {
      messages: table({
        id: "integer primary key",
        thread_id: "integer",
        payload: {
          type: "string",
          ifc: { confidentiality: ["cfc-prepare-messages"] },
        },
      }),
    },
  });
  // Concatenation keeps the JSON aggregate textual across the SQLite driver.
  const thread = db.query<ThreadRow>(
    "SELECT thread_id AS id, (json_group_array(json(payload) ORDER BY id) || '') AS packed FROM messages GROUP BY thread_id",
    { reactOn: db },
  );
  const selected = new Writable.perSession(false);
  const rows = thread.result ?? [];
  const selection = selectThread({ rows, selected });
  const bubbles = parseThread({ rows: selection });
  const elements = bubbles.map((message) => (
    <div className={message.me ? "cfc-bubble me" : "cfc-bubble"}>
      {message.text}
    </div>
  ));
  const open = action(() => selected.set(true));

  return {
    [NAME]: "CFC preparation ladder",
    [UI]: (
      <div>
        <cf-button id="cfc-open" onClick={open}>Open thread</cf-button>
        <div id="cfc-bubbles">{elements}</div>
      </div>
    ),
    db,
    thread,
    selected,
    selection,
    bubbles,
    elements,
    open,
    seed: seed({ db }),
  };
});
