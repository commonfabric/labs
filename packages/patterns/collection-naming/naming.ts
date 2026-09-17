/**
 * A member namespace for a collection pattern: the table that gives each
 * member its name by identity, the two backfills over what the collection held
 * before it numbered anything — one writing the namespace alone, one also
 * asking each member to store its own name — the declaration the collection
 * publishes so a consumer learns the policy rather than assuming one, and —
 * re-exported from `allocator.ts`, so that one import reaches the whole
 * namespace — the allocator its create verb calls. Nothing here knows what
 * kind of piece a member is beyond the one verb `recordNames()` sends to: a
 * member is a cell, compared by identity and never read through.
 *
 * The namespace is one map cell on the collection, `{ "42": <member> }`,
 * written one key at a time. A name is a decimal string, dense from `1`, one
 * more than the largest name present, and never reused: a member keeps its
 * name whatever happens to it, and an entry outlives the member's place in the
 * collection's list. Concurrent allocations serialize through the runtime's
 * commit retry. A keyset read of the map conflicts with a key write to it
 * (`docs/specs/memory-v2/08-conflict-granularity.md`), so of two verbs that
 * read the same keys, the second to commit is rejected, re-runs against the
 * first one's write, and takes the next name.
 *
 * The split from `allocator.ts` is by what a declaration needs at runtime.
 * Nothing there takes a `commonfabric` value, so a plain `deno test` can
 * import it; the readers and lifts here take `lift`, `equals` and `Writable`,
 * which are ambient declarations binding nothing outside the runtime, so a
 * declaration reaching for one of those belongs in this module.
 *
 * `docs/specs/collection-naming.md` is the design this implements.
 */

import {
  type ComparableCell,
  Default,
  equals,
  lift,
  type ReadonlyCell,
  Writable,
} from "commonfabric";

import {
  assignName,
  createNamed,
  incrementName,
  isLargerName,
  isMemberName,
  type NamesMap,
  type NamesMapCell,
  nextNameAmong,
} from "./allocator.ts";

export {
  assignName,
  createNamed,
  incrementName,
  isLargerName,
  isMemberName,
  type NamesMap,
  type NamesMapCell,
  nextNameAmong,
};

/**
 * What a collection holds its member names to over time. Published beside
 * the names rather than implied by them, so a consumer that needs a promise
 * — a printed citation, a reference leaving the fabric — can read whether it
 * has one.
 */
export interface NamingPolicy {
  /**
   * Whether a name is unique across the collection's whole history, or only
   * among its current members.
   */
  unique: "history" | "current";

  /** Whether a name, once assigned, is never retired or reassigned. */
  permanent: boolean;

  /** Whether a retired name may be given to another member. */
  reuse: boolean;

  /**
   * What a name is made of: a monotonic sequence, a random code, a string a
   * person chose, or a derivation from the member's own content.
   */
  allocator: "sequence" | "random" | "human" | "derived";
}

/** What a collection declares about the names it gives its members. */
export interface NamingDeclaration {
  /**
   * The collection's own name, which a binding uses to reach it. Absent when
   * the collection makes no claim about what it is bound as.
   */
  name?: string;

  /** The policy the names are held to. */
  policy: NamingPolicy;

  /**
   * Whether the collection offers the compact spelling that joins its name to
   * a member's with a hyphen. Only a collection whose member names cannot
   * contain a hyphen may say so.
   */
  compact: boolean;
}

/**
 * The declaration for the sequence this module allocates: unique across
 * history, permanent, never reused, and eligible for the compact spelling
 * because a decimal name holds no hyphen. It names no collection; a
 * collection that declares one spreads this and adds its own `name`.
 */
export const SEQUENCE_NAMING: NamingDeclaration = {
  policy: {
    unique: "history",
    permanent: true,
    reuse: false,
    allocator: "sequence",
  },
  compact: true,
};

/**
 * One row of a collection's names table: a member, and the name the
 * collection calls it by.
 *
 * ONE ROW PER NAMED MEMBER, addressed by the member it describes. A row keeps
 * its identity wherever it sits in the table, so a member looking itself up
 * by identity finds one row, and a table recomputed over an unchanged map
 * writes nothing.
 */
export interface NamesTableRow {
  /**
   * The member. `unknown` because it is written as a reference and only ever
   * compared; anything wider would read the member back whole.
   */
  member: unknown;

  /** The member's name. */
  name: string;
}

/**
 * The name `table` gives `member`, or `undefined` when it has none. Matching
 * is by identity: `equals` compares what each side refers to, whether it
 * arrived as a cell or as the raw link a read left behind.
 */
export function nameOf(
  member: object,
  table: readonly NamesTableRow[],
): string | undefined {
  return table.find((row) => equals(member, row.member as object))?.name;
}

/**
 * The names table derived from the namespace: one row per named member,
 * addressed by the member. The table publishes exactly the names the grammar
 * admits — `isMemberName()` — so a key a foreign writer put in the map is no
 * member's name here, as it is no name to the allocator. A collection derives
 * this once and hands it to each member it creates, so a member's reverse
 * lookup is a scan of the rows rather than a read of the map.
 */
export const namesTable = lift(
  (
    { names }: {
      // A record of CELLS, which is what lets one declaration serve both of
      // the table's needs: the cell is the member's identity, which addresses
      // its row, and a cell always writes as a link, so the rows below are
      // the same documents on every run over the same map. Defaulted in the
      // form `NamesMap` explains.
      // deno-lint-ignore ban-types
      names: Default<Record<string, ReadonlyCell<unknown>>, {}>;
    },
  ): NamesTableRow[] => {
    // An entry under a key the grammar does not admit is not a name and gets
    // no row. An entry with nothing behind it yet (mid-sync) reads as
    // `undefined`, has no identity to address a row by, and gets no row
    // rather than a junk one. Nothing else is filtered: the values are cells,
    // so a value a foreign writer stored under a name — `null`, a scalar —
    // arrives as a cell too, and telling it apart would mean reading through
    // the member.
    const rows: unknown[] = Object.entries(names)
      .filter(([name, member]) => isMemberName(name) && member !== undefined)
      .map(([name, member]) =>
        Writable.for<NamesTableRow>(member).set({ member, name })
      );
    return rows as NamesTableRow[];
  },
);

/**
 * Whether `value` is an object, which is what a position has to hold for a
 * member to be there: a member is a document, and a document reads as an
 * object whatever schema it arrived through — a materialized value, a query
 * proxy, a cell.
 *
 * `Object(value) === value` is the whole test, and it is one expression on
 * purpose: coercing a primitive yields a fresh wrapper that fails the
 * comparison, coercing an object yields the object itself, and there is no
 * arm to drop. A `typeof` test does not decide this, because `typeof null` is
 * `object`. A function is an object here and a member never is one, which
 * costs nothing: `FabricValue` holds no function, so no stored position can.
 *
 * The bound is that an object is not necessarily a member. An array passes,
 * and so does any object a foreign writer left at a position; telling either
 * apart from a member would mean reading through the member.
 */
const isObject = (value: unknown): boolean => Object(value) === value;

/**
 * Names every member of `members` that has no name, in filing order, and
 * returns the names it wrote — exactly the keys it added to `names`, in the
 * order it added them. An entry records the member a position holds rather
 * than the position, so it names that member still once the list has shifted
 * under it; only a position holding an object is named, so `undefined`,
 * `null` and every other primitive name nothing, while an object that is no
 * member — an array, or whatever a foreign writer left there — is named as
 * though it were one. A member already named is skipped, whatever position it
 * holds, and a member listed at two positions is named once: membership is
 * asked of IDENTITY, never of position. Idempotent: a run over a fully named
 * list writes nothing and returns `[]`.
 *
 * Called from a verb body for the reason `assignName()` is: the keyset read
 * and the key writes are one transaction, so a create that lands while a
 * backfill runs serializes with it rather than colliding on a name.
 */
export function backfillNames(
  members: {
    get(): readonly unknown[];
    key(index: number): { resolveAsCell(): object };
  },
  names: NamesMapCell,
): string[] {
  const map = names.get() ?? {};
  // The members with a name: those the map already holds, and — as the walk
  // goes — those this run names, so a member met again is not named again.
  const named = Object.values(map) as (object | undefined)[];
  const listed = members.get();
  const written: string[] = [];
  let next = nextNameAmong(Object.keys(map));
  for (let index = 0; index < listed.length; index++) {
    // Only a position holding an object can hold a member. At one holding
    // `undefined`, `null`, or any other primitive there is no member link for
    // `resolveAsCell()` to follow, so an entry written for it would address
    // the position itself — the thing this walk exists to not do.
    if (!isObject(listed[index])) continue;
    // The member the position holds, pinned to its own document. An entry
    // outlives its member's place in the list, so what the map records has to
    // be the member; the cell at a position is an address in the list, which
    // names whoever sits there when the entry is read. The pinned cell is
    // also the identity `equals` matches against the map's links.
    const member = members.key(index).resolveAsCell();
    if (named.some((other) => equals(member, other))) continue;
    names.key(next).set(member);
    written.push(next);
    named.push(member);
    next = incrementName(next);
  }
  return written;
}

/**
 * What one `recordNames()` run reports, as three lists of names in filing
 * order. Together they cover every listed member the run could name: a member
 * at a position holding no object is in none of them, and neither is one the
 * namespace holds only under a key outside the name grammar.
 */
export interface RecordNamesResult {
  /**
   * The names the run wrote into the namespace. Empty when every listed
   * member was already named, which is what a second run writes.
   */
  assigned: string[];

  /**
   * The names of the members that already report them. The run sent these
   * members nothing and wrote nothing for them.
   */
  named: string[];

  /**
   * The names the run asked members to store, one send each. A send's effect
   * is invisible to the transaction that makes it, so the run confirms none of
   * them: a later run reports whichever landed under `named` and asks for the
   * rest again.
   */
  pending: string[];
}

/**
 * Names every member of `members` the namespace does not hold, exactly as
 * `backfillNames()` does, and additionally asks each listed member to store
 * the name the namespace holds for it by sending that name to the member's own
 * `recordName` verb. A member that already reports that name is sent nothing,
 * so a run over a fully recorded list writes nothing at all — no key and no
 * event.
 *
 * The member contract this rests on is `recordName({ name })`: a member that
 * stores its own name provides it, takes the name the collection allocated,
 * and refuses a name that disagrees with one it already stores. A member whose
 * pattern declares no such verb stores the payload as ordinary data at that
 * name in its result, because a send to a path holding no stream is an
 * ordinary write — `Cell.send` in `packages/runner/src/cell.ts` delegates to
 * `set`. So a collection calls this only where every member declares the verb.
 *
 * What the result can and cannot say follows from where the writes land. The
 * namespace is this collection's own document, so `assigned` is what this
 * transaction wrote. A member's stored name is the member's own document,
 * which only the member can write, so `pending` is a list of requests: the
 * names asked for, none of them confirmed. A name that keeps appearing there
 * across runs is a member whose own verb is refusing it, which `recordName`
 * does for a member that already stores a different name.
 *
 * Called from a verb body for the reason `assignName()` is: the keyset read
 * and the key writes are one transaction, so a create that lands while this
 * runs serializes with it rather than colliding on a name.
 */
export function recordNames(
  members: {
    // The stored values, for each member's own report of its name, and the
    // position's cell, for the verb this sends to. The verb is named
    // structurally because no collection's member type is in scope here.
    get(): readonly ({ shortName?: string } | undefined)[];
    key(index: number): {
      resolveAsCell(): {
        key(verb: "recordName"): { send(event: { name: string }): void };
      };
    };
  },
  names: NamesMapCell,
): RecordNamesResult {
  const map = names.get() ?? {};
  // The members the namespace holds, read as `backfillNames()` reads them:
  // every value in the map whatever key it sits under, so that allocation
  // here and there agree on which member is already named.
  const held = Object.values(map) as (object | undefined)[];
  // The name each of those sits under, for the entries under a name the
  // grammar admits. A member held only under a foreign key is named as far as
  // allocation is concerned and has no name for a member to record.
  const entries = Object.entries(map)
    .filter(([name]) => isMemberName(name)) as [string, object | undefined][];
  const listed = members.get();
  const assigned: string[] = [];
  const named: string[] = [];
  const pending: string[] = [];
  const handled: object[] = [];
  let next = nextNameAmong(Object.keys(map));
  for (let index = 0; index < listed.length; index++) {
    const value = listed[index];
    // Only a position holding an object can hold a member, for the reason
    // `backfillNames()` gives.
    if (!isObject(value)) continue;
    const member = members.key(index).resolveAsCell();
    // Each member once, however many positions hold it: membership is asked
    // of IDENTITY, never of position, so a collection listing one member
    // twice asks it for its name once.
    if (handled.some((other) => equals(member, other))) continue;
    handled.push(member);
    let name = entries.find(([, other]) => equals(member, other))?.[0];
    if (name === undefined) {
      if (held.some((other) => equals(member, other))) continue;
      name = next;
      names.key(name).set(member);
      held.push(member);
      entries.push([name, member]);
      assigned.push(name);
      next = incrementName(name);
    }
    if (value?.shortName === name) {
      named.push(name);
      continue;
    }
    member.key("recordName").send({ name });
    pending.push(name);
  }
  return { assigned, named, pending };
}

/**
 * A member's own name, looked up in its collection's names table by
 * identity: `undefined` for a member no table names, or one handed no table.
 *
 * Re-runs whenever any row changes, and writes nothing when the row it finds
 * is unchanged. The parameter declares the rows' members as comparable cells
 * and nothing more, so surveying the whole table expands no member.
 */
export const ownName = lift(
  (
    { table, self }: {
      table: { member: ComparableCell<unknown>; name: string }[] | Default<[]>;
      self: ComparableCell<unknown>;
    },
  ): string | undefined => nameOf(self, table),
);
