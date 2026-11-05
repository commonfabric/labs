import { pattern, type SqliteDb } from "commonfabric";

// FIXTURE (integration): the database is an INPUT, not a `sqliteDatabase()`
// call in the pattern body. An operator wires an injected on-disk source
// (03.3) into `db` from outside, so the query's handle reaches the builtin
// through the pattern's ARGUMENT link. The pattern never names the file.
//
// The test writes that argument itself rather than through the pieces
// controller `cf piece link sqlite:` drives. What the builtin reads is the
// same either way: the link the controller writes carries no schema (a
// schemaless handle resolves to `schema === undefined`, and the emitted link
// embeds none), so neither route can project the handle's `tables` away.
//
// Two projections, because they label through different arms of
// `labelResultSchema`: an aliased column read carries its origin column's
// declared confidentiality, and an expression over that column has a null
// origin, so it inherits the whole-db union with `observes: "value"`.
interface Input {
  db: SqliteDb;
}

// A named constant, then the default export: exporting the `pattern<Input>`
// call directly makes declaration emit inline `SqliteDb`'s private brand
// symbol into the module's default export, which the compiler refuses.
const injected = pattern<Input>(({ db }) => {
  const direct = db.query<{ secret: string }>(
    "SELECT body AS secret FROM records ORDER BY id",
    { reactOn: db },
  );
  const derived = db.query<{ shouted: string }>(
    "SELECT upper(body) AS shouted FROM records ORDER BY id",
    { reactOn: db },
  );
  return { direct, derived };
});

export default injected;
