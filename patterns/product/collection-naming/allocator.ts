/**
 * A member namespace's allocator, over plain values: the rule that decides the
 * next name, the two functions a verb calls to take one, and the shapes the
 * namespace is read and written through. A name is a decimal string, dense
 * from `1`, one more than the largest name present, and never reused.
 *
 * Nothing here takes a value from `commonfabric`, and that is a constraint on
 * the module rather than an accident of what it happens to need. `lift`,
 * `equals` and `Writable` are ambient declarations that bind nothing at
 * runtime, so a module importing one of them as a value links only inside the
 * pattern runtime. This one instead takes the namespace as the structural
 * `NamesMapCell` and a member as an opaque `unknown` it stores and never
 * reads, so a plain `deno test` can import it and exercise the allocation rule
 * directly. `naming.ts` beside it holds what does take those values, and
 * re-exports everything declared here.
 *
 * `docs/specs/collection-naming.md` is the design this implements.
 */

/**
 * The namespace: each name to the member it names, held as an unread
 * reference. Declared `unknown` so that a member is stored as a link and a
 * reader of the map — the allocator surveying its keys, a resolver following
 * one entry — expands no member it did not follow.
 *
 * A collection declares it at its input as `Writable<Default<NamesMap, {}>>`,
 * written inline at the property rather than through an alias, and both
 * halves of that are load-bearing. `NamesMap | Default<{}>` adds a bare
 * empty-object arm to the union, and wherever that union reaches a handler
 * unmerged it becomes an `anyOf` whose empty arm reads every value whole —
 * the merge lets a branch that looked win over the opaque one — so the
 * allocator would expand every member to survey the keys; the two-argument
 * form keeps the union to the record type. And the schema generator reads
 * the default off the property's own type node, so a default declared
 * through an alias is dropped from the schema.
 */
export type NamesMap = Record<string, unknown>;

/**
 * The namespace as a verb holds it: read whole for its keys, written one key
 * at a time. Nothing here rewrites the map whole, which is what lets two
 * verbs naming different members merge instead of clobbering each other.
 *
 * Declared structurally, with `get()` returning `undefined` for a map nothing
 * has written yet. A verb reads its binding through a schema that carries no
 * default, so on a collection that has never named a member the map is
 * absent inside the verb however the input declares it; the structural
 * declaration is what makes the readers here handle that where the compiler
 * can see it. A `Writable<NamesMap>` satisfies it.
 */
export interface NamesMapCell {
  /** The map, or `undefined` before the first name is written. */
  get(): NamesMap | undefined;

  /** The entry for `name`, to be set to the member it names. */
  key(name: string): { set(member: unknown): void };
}

/**
 * Whether `key` is a member name: a canonical decimal string — `0`, or a
 * non-zero digit followed by digits, with no leading zeros, no sign, and no
 * exponent. The map can be written by any client over the memory protocol,
 * so a key is not guaranteed to be a name this sequence issued; a key
 * outside the grammar is not a name, and it neither counts as the largest
 * nor blocks allocation.
 */
export const isMemberName = (key: string): boolean =>
  /^(0|[1-9][0-9]*)$/.test(key);

/**
 * Whether canonical decimal `a` is larger than canonical decimal `b`. Names
 * are compared as strings — by length, then lexicographically — and never
 * as JavaScript numbers, which lose distinctness past `2^53` and would
 * reuse a name there.
 */
export const isLargerName = (a: string, b: string): boolean =>
  a.length !== b.length ? a.length > b.length : a > b;

/**
 * The canonical decimal one larger than `name`, as a string. The trailing run
 * of nines turns to zeros and the digit before it goes up by one; a name that
 * is all nines gains a leading `1`.
 */
export const incrementName = (name: string): string => {
  const [, head, nines] = name.match(/^([0-9]*?)(9*)$/)!;
  const zeros = "0".repeat(nines.length);
  if (head === "") return `1${zeros}`;
  return `${head.slice(0, -1)}${Number(head.at(-1)) + 1}${zeros}`;
};

/**
 * The next name the sequence issues over the keys in use: `1` when none of
 * them is a member name, otherwise one more than the largest. The sequence
 * is dense from `1` and a name is never reused, so this is the whole of the
 * allocation rule; what makes it safe under concurrency is where it is
 * called, which `assignName()` states. Keys that are not member names —
 * `isMemberName()` says which — are ignored.
 */
export function nextNameAmong(names: Iterable<string>): string {
  const largest = Array.from(names)
    .filter(isMemberName)
    .reduce<string | undefined>(
      (max, name) => max === undefined || isLargerName(name, max) ? name : max,
      undefined,
    );
  return largest === undefined ? "1" : incrementName(largest);
}

/**
 * Allocates the next name over `names`, calls `create` with it, records what
 * `create` returns under that name, and returns the name and the member.
 * Called from the body of an `action()` or `handler()`, so the read of the
 * map's keys, the create, and the write of the new key land in one
 * transaction. That is what makes the name safe: a concurrent create that
 * read the same keys conflicts on commit and re-runs against this write, and
 * the re-run calls `create` again with the name after it, so a member built
 * holding its name holds the one the map records for it.
 *
 * `create` runs once per run of the verb, between the read of the keys and
 * the write. Nothing here constrains what it does with the name; a member
 * that stores it holds a copy, which stays the map's name for it only because
 * a name is permanent and never reused.
 */
export function createNamed<M>(
  names: NamesMapCell,
  create: (name: string) => M,
): { name: string; member: M } {
  const name = nextNameAmong(Object.keys(names.get() ?? {}));
  const member = create(name);
  names.key(name).set(member);
  return { name, member };
}

/**
 * Like `createNamed()`, except for a member that already exists: allocates
 * the next name over `names`, records `member` under it, and returns the
 * name, in one transaction for the reason `createNamed()` states.
 */
export function assignName(names: NamesMapCell, member: unknown): string {
  return createNamed(names, () => member).name;
}
