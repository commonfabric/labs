import {
  pattern,
  type PerSession,
  type PerUser,
  type SqliteDb,
  sqliteDatabase,
  table,
} from "commonfabric";

interface Input {
  seed?: string;
}

// A SqliteDb declared with a scope wrapper must lower to `sqliteDatabase
// .asScope(<scope>)(...)`, so the runtime binds the db (and its on-disk file)
// to that scope. `sqliteDatabase` is an opaque factory (its public type is
// `(...) => Reactive<SqliteDb>` plus an `asScope` method, with no
// argumentSchema/resultSchema), so this exercises the asScope-method path of
// the contextual-scope lowering.
export default pattern<Input>(() => {
  const userDb: PerUser<SqliteDb> = sqliteDatabase({
    tables: { notes: table({ id: "integer primary key", body: "text" }) },
  });
  const sessionDb: PerSession<SqliteDb> = sqliteDatabase({ tables: {} });
  const spaceDb = sqliteDatabase({ tables: {} });

  return { userDb, sessionDb, spaceDb };
});
