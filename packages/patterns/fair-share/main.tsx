/**
 * Fair Share — a shared expense ledger.
 *
 * Track who paid for what in a group, split each expense among the people who
 * shared it, and see net balances plus a minimal "settle up" plan of who should
 * pay whom. Inspired by group expense-splitting apps.
 *
 * Scope:
 * - `people` and `expenses` are the shared ledger. Cells default to per-space
 *   scope, so anyone in the space sees and edits the same ledger.
 * - `myName` is per-user: each viewer picks which person they are, which powers
 *   a personal "you are owed / you owe" summary and a row highlight.
 * - Form drafts are per-session cells, so concurrent viewers don't share each
 *   other's half-typed input or chip toggles.
 *
 * Identity: items are matched with `equals()` (the pattern idiom) — never via
 * synthetic id fields, which read as Cells inside `.map()` and break `===`.
 * People are referenced from expenses by their (unique) name, the natural key.
 *
 * Money is computed in integer cents with largest-remainder allocation, so
 * displayed shares always sum back to the total and balances tie out exactly.
 */
import {
  computed,
  Default,
  equals,
  handler,
  hasError,
  hasSchemaMismatch,
  isPending,
  isSyncing,
  NAME,
  pattern,
  type PerUser,
  resultOf,
  UI,
  wish,
  Writable,
} from "commonfabric";

// ============ TYPES ============

interface Person {
  name: string;
  // Optional avatar snapshot (image URL or emoji/glyph), sourced from the
  // person's shared profile when they "join with your profile". Display-only —
  // `name` stays the natural key, so the money/balance logic is unaffected.
  avatar?: string;
}

interface Expense {
  description: string;
  amount: number;
  paidBy: string; // Person.name
  sharedBy: string[]; // Person.name[]; empty => split among everyone
  date: string; // YYYY-MM-DD
}

interface Balance {
  name: string;
  avatar?: string;
  paid: number;
  share: number;
  net: number; // paid - share; positive => is owed, negative => owes
}

interface Settlement {
  from: string; // debtor name
  to: string; // creditor name
  amount: number;
}

interface State {
  people: Writable<Person[] | Default<[]>>;
  expenses: Writable<Expense[] | Default<[]>>;
  myName: PerUser<string | Default<"">>;
}

// ============ HELPERS ============

const getTodayDate = (): string => new Date().toISOString().split("T")[0];

const toCents = (n: number): number => Math.round((n || 0) * 100);

const money = (n: number): string => `$${(n || 0).toFixed(2)}`;

// Allocate `cents` across `names` so the parts sum back to `cents` exactly.
// Largest-remainder: the first `remainder` recipients get one extra cent.
const splitCents = (cents: number, names: string[]): Map<string, number> => {
  const out = new Map<string, number>();
  const n = names.length;
  if (n === 0) return out;
  const base = Math.floor(cents / n);
  const remainder = cents - base * n;
  names.forEach((name, i) => out.set(name, base + (i < remainder ? 1 : 0)));
  return out;
};

const computeSettlements = (balances: Balance[]): Settlement[] => {
  const creditors = balances
    .map((b) => ({ name: b.name, rem: Math.round(b.net * 100) }))
    .filter((b) => b.rem > 0)
    .sort((a, b) => b.rem - a.rem);
  const debtors = balances
    .map((b) => ({ name: b.name, rem: -Math.round(b.net * 100) }))
    .filter((b) => b.rem > 0)
    .sort((a, b) => b.rem - a.rem);

  const result: Settlement[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i];
    const c = creditors[j];
    const cents = Math.min(d.rem, c.rem);
    if (cents > 0) {
      result.push({ from: d.name, to: c.name, amount: cents / 100 });
    }
    d.rem -= cents;
    c.rem -= cents;
    if (d.rem === 0) i++;
    if (c.rem === 0) j++;
  }
  return result;
};

// Snapshot the current viewer's shared profile (name + avatar) into the shared
// `people` ledger and select them as "you". This is the participant/roster
// idiom: each viewer contributes their own #profile snapshot on join, rather
// than the app querying everyone's private profile state (see
// docs/specs/shared-profile-rosters.md). `name` stays the natural key.
// Exported for tests.
export const joinWithProfile = handler<
  unknown,
  {
    people: Writable<Person[]>;
    myName: Writable<string>;
    name: string;
    avatar: string;
  }
>((_event, { people, myName, name, avatar }) => {
  const n = (name ?? "").trim();
  if (!n) return;
  const av = (avatar ?? "").trim();
  const cur = people.get();
  const idx = cur.findIndex((p) => p.name === n);
  if (idx < 0) {
    people.push(av ? { name: n, avatar: av } : { name: n });
  } else if (av && !cur[idx].avatar) {
    // Backfill the avatar snapshot if this name was added by hand earlier.
    // Write through the element's cell — replacing the array slot with a
    // fresh object literal would re-mint the person's entity identity and
    // orphan previously-held references (selection cells, expense rows read
    // earlier). See packages/patterns/primitives/editable-list.tsx.
    people.key(idx).key("avatar").set(av);
  }
  myName.set(n);
});

// ============ PATTERN ============

export default pattern<State>(({ people, expenses, myName }) => {
  // --- Per-session form drafts (local to each viewer) ---
  const personDraft = Writable.perSession.of<string>("");
  const descDraft = Writable.perSession.of<string>("");
  const amountDraft = Writable.perSession.of<string>("");
  const paidByDraft = Writable.perSession.of<string>(""); // Person.name
  const splitWith = Writable.perSession.of<string[]>([]); // Person.name[]

  // --- Identity (resolve per-user name once at top level) ---
  const me = (myName ?? "").trim();

  // The current viewer's *shared profile* (resolved via wish). `#profile` is the
  // live cell bound to <cf-profile-badge>; the field targets give the name/avatar
  // we snapshot into the ledger on "join". Profile-count-agnostic: resolves the
  // viewer's default profile.
  const profileWish = wish<{ name?: string; avatar?: string }>({
    query: "#profile",
  });
  const profileNameWish = wish<string>({ query: "#profileName" });
  const profileAvatarWish = wish<string>({ query: "#profileAvatar" });
  const profile = hasError(profileWish.result) ||
      isPending(profileWish.result) ||
      isSyncing(profileWish.result) ||
      hasSchemaMismatch(profileWish.result)
    ? undefined
    : resultOf(profileWish.result);
  const profileName = hasError(profileNameWish.result) ||
      isPending(profileNameWish.result) ||
      isSyncing(profileNameWish.result) ||
      hasSchemaMismatch(profileNameWish.result)
    ? ""
    : resultOf(profileNameWish.result);
  const profileAvatar = hasError(profileAvatarWish.result) ||
      isPending(profileAvatarWish.result) ||
      isSyncing(profileAvatarWish.result) ||
      hasSchemaMismatch(profileAvatarWish.result)
    ? ""
    : resultOf(profileAvatarWish.result);
  const myProfileName = computed(() => profileName.trim());
  const myProfileAvatar = computed(() => profileAvatar.trim());
  const hasProfile = computed(() => profileName.trim() !== "");

  // --- Derived data ---
  const peopleOptions = computed(() =>
    people.get().map((p) => ({ label: p.name, value: p.name }))
  );

  const total = computed(() => {
    let cents = 0;
    for (const e of expenses.get()) cents += toCents(e.amount);
    return cents / 100;
  });

  const balances = computed<Balance[]>(() => {
    const ppl = people.get();
    const paidCents = new Map<string, number>();
    const shareCents = new Map<string, number>();
    for (const p of ppl) {
      paidCents.set(p.name, 0);
      shareCents.set(p.name, 0);
    }

    for (const e of expenses.get()) {
      const cents = toCents(e.amount);
      if (paidCents.has(e.paidBy)) {
        paidCents.set(e.paidBy, paidCents.get(e.paidBy)! + cents);
      }
      const everyone = ppl.map((p) => p.name);
      const names = (e.sharedBy && e.sharedBy.length ? e.sharedBy : everyone)
        .filter((name) => shareCents.has(name));
      if (names.length === 0) continue;
      const alloc = splitCents(cents, names);
      for (const name of names) {
        shareCents.set(name, shareCents.get(name)! + (alloc.get(name) ?? 0));
      }
    }

    return ppl.map((p) => {
      const paid = (paidCents.get(p.name) ?? 0) / 100;
      const share = (shareCents.get(p.name) ?? 0) / 100;
      return {
        name: p.name,
        avatar: p.avatar ?? "",
        paid,
        share,
        net: paid - share,
      };
    });
  });

  const settlements = computed(() => computeSettlements(balances));

  const myNet = computed(() => {
    if (!me) return null;
    const mine = balances.find((b) => b.name === me);
    return mine ? mine.net : null;
  });

  // Display helper for the "split with" chips in the form.
  const splitChips = computed(() =>
    people.get().map((p) => ({
      name: p.name,
      included: splitWith.get().length === 0 ||
        splitWith.get().includes(p.name),
    }))
  );

  return {
    [NAME]: "Fair Share",
    [UI]: (
      <cf-vstack gap="4" style={{ padding: "1rem", maxWidth: "720px" }}>
        <cf-heading level={2}>Fair Share</cf-heading>
        <cf-text tone="muted">
          A shared ledger for group expenses — track who paid, split fairly, and
          settle up.
        </cf-text>

        {/* ===== You ===== */}
        <cf-card>
          <cf-vstack gap="3">
            {
              /* Identity via shared profile: the trusted badge shows who you are,
                and "Join" snapshots your profile name+avatar into the ledger. */
            }
            <cf-hstack gap="3" align="center" wrap>
              <cf-label>You are</cf-label>
              <cf-profile-badge $profile={profile} size="sm" />
              <cf-button
                color="primary"
                variant="solid"
                disabled={computed(() => !hasProfile)}
                onClick={joinWithProfile({
                  people,
                  myName,
                  name: myProfileName,
                  avatar: myProfileAvatar,
                })}
              >
                Join with your profile
              </cf-button>
            </cf-hstack>
            {/* Fallback: pick yourself from the people added by hand. */}
            <cf-hstack gap="3" align="center" wrap>
              <cf-label>or pick</cf-label>
              <cf-select
                $value={myName}
                items={peopleOptions}
                style={{ minWidth: "160px" }}
              />
              {computed(() => {
                const net = myNet;
                if (net === null) {
                  return (
                    <cf-text tone="muted">
                      Pick who you are to see your balance.
                    </cf-text>
                  );
                }
                return (
                  <cf-badge
                    color={net > 0 ? "accent" : net < 0 ? "danger" : "neutral"}
                  >
                    {net > 0
                      ? `You are owed ${money(net)}`
                      : net < 0
                      ? `You owe ${money(-net)}`
                      : "You're settled up"}
                  </cf-badge>
                );
              })}
            </cf-hstack>
          </cf-vstack>
        </cf-card>

        {/* ===== People ===== */}
        <cf-card>
          <cf-vstack gap="3">
            <cf-heading level={4}>People</cf-heading>

            {
              /* Bare .map() — wrapping it in computed() breaks the transformer's
                equals() schema inference (array items lose `comparable`), which
                silently breaks removal. Empty state is a separate sibling. */
            }
            <cf-hstack gap="2" wrap>
              {people.map((person) => (
                <cf-hstack gap="1" align="center">
                  <cf-avatar
                    src={person.avatar}
                    name={person.name}
                    size="xs"
                  />
                  <cf-chip
                    label={person.name}
                    removable
                    oncf-remove={() => {
                      const cur = people.get();
                      const idx = cur.findIndex((p) => equals(person, p));
                      if (idx < 0) return;
                      const name = { ...cur[idx] }.name;
                      // Cascade-clean so balances stay zero-sum: drop expenses
                      // they paid (money has no creditor now) and remove them
                      // from every other split. Built with a plain for-loop —
                      // chaining .filter()/.map() on the reactive .get() array
                      // makes the transformer rewrite them to
                      // .filterWithPattern()/.mapWithPattern(), which throw at
                      // runtime here. Kept expenses are pushed by REFERENCE
                      // (not `{ ...e }` clones) and split changes are written
                      // through the element's cell — fresh literals would
                      // re-mint every kept expense's entity identity and
                      // orphan previously-held references.
                      const allExpenses = expenses.get();
                      const cleaned: Expense[] = [];
                      for (let i = 0; i < allExpenses.length; i++) {
                        const e = allExpenses[i];
                        if (e.paidBy === name) continue;
                        const had = [...(e.sharedBy ?? [])];
                        // Empty sharedBy means "split among everyone" — it stays
                        // implicit-everyone (now a smaller group), so keep it as-is.
                        if (had.length === 0) {
                          cleaned.push(e);
                          continue;
                        }
                        const shared = had.filter((s) => s !== name);
                        // An explicit split emptied by this removal is dropped.
                        if (shared.length === 0) continue;
                        if (shared.length !== had.length) {
                          expenses.key(i).key("sharedBy").set(shared);
                        }
                        cleaned.push(e);
                      }
                      people.set(cur.toSpliced(idx, 1));
                      expenses.set(cleaned);
                    }}
                  />
                </cf-hstack>
              ))}
            </cf-hstack>
            {computed(() =>
              people.get().length === 0
                ? <cf-text tone="muted">Add people to get started.</cf-text>
                : null
            )}

            <cf-hstack gap="2" align="center">
              <cf-input
                $value={personDraft}
                placeholder="Add a person…"
                style={{ flex: 1 }}
              />
              <cf-button
                color="primary"
                variant="solid"
                onClick={() => {
                  const name = personDraft.get().trim();
                  if (!name) return;
                  if (people.get().some((p) => p.name === name)) return;
                  people.push({ name });
                  personDraft.set("");
                }}
              >
                Add
              </cf-button>
            </cf-hstack>
          </cf-vstack>
        </cf-card>

        {/* ===== Add expense ===== */}
        <cf-card>
          <cf-vstack gap="3">
            <cf-heading level={4}>Add expense</cf-heading>

            <cf-vstack gap="1">
              <cf-label>Description</cf-label>
              <cf-input $value={descDraft} placeholder="Dinner, taxi, …" />
            </cf-vstack>

            <cf-hstack gap="3" wrap>
              <cf-vstack gap="1" style={{ flex: 1 }}>
                <cf-label>Amount</cf-label>
                <cf-input $value={amountDraft} placeholder="0.00" />
              </cf-vstack>
              <cf-vstack gap="1" style={{ flex: 1 }}>
                <cf-label>Paid by</cf-label>
                <cf-select $value={paidByDraft} items={peopleOptions} />
              </cf-vstack>
            </cf-hstack>

            <cf-vstack gap="1">
              <cf-label>Split between</cf-label>
              <cf-hstack gap="2" wrap>
                {computed(() =>
                  splitChips.map((c) => (
                    <cf-chip
                      label={c.name}
                      interactive
                      onClick={() => {
                        const cur = splitWith.get();
                        // First explicit toggle starts from "everyone".
                        const base = cur.length === 0
                          ? people.get().map((p) => p.name)
                          : cur;
                        splitWith.set(
                          base.includes(c.name)
                            ? base.filter((x) => x !== c.name)
                            : [...base, c.name],
                        );
                      }}
                      style={{ opacity: c.included ? "1" : "0.4" }}
                    />
                  ))
                )}
              </cf-hstack>
              <cf-text variant="caption" tone="muted">
                Tap to toggle. Everyone is included by default.
              </cf-text>
            </cf-vstack>

            <cf-button
              color="primary"
              variant="solid"
              onClick={() => {
                const description = descDraft.get().trim();
                const amount = toCents(parseFloat(amountDraft.get())) / 100;
                const paidBy = paidByDraft.get();
                const ppl = people.get();
                // Number.isFinite rejects NaN AND ±Infinity (e.g. "1e999"),
                // which would otherwise poison totals/splits.
                if (!description || !Number.isFinite(amount) || amount <= 0) {
                  return;
                }
                if (!ppl.some((p) => p.name === paidBy)) return;

                const everyone = ppl.map((p) => p.name);
                const selected = splitWith.get().filter((nm) =>
                  ppl.some((p) => p.name === nm)
                );
                const sharedBy = selected.length === 0 ? everyone : selected;
                if (sharedBy.length === 0) return;

                expenses.push({
                  description,
                  amount,
                  paidBy,
                  sharedBy,
                  date: getTodayDate(),
                });
                descDraft.set("");
                amountDraft.set("");
                splitWith.set([]);
              }}
            >
              Add expense
            </cf-button>
          </cf-vstack>
        </cf-card>

        {/* ===== Expense list ===== */}
        <cf-card>
          <cf-vstack gap="3">
            <cf-hstack
              align="center"
              style={{ justifyContent: "space-between" }}
            >
              <cf-heading level={4}>Expenses</cf-heading>
              <cf-text style={{ fontWeight: "600" }}>
                Total {computed(() => money(total))}
              </cf-text>
            </cf-hstack>

            {/* Bare .map() — see People note above. */}
            {expenses.map((expense) => (
              <cf-hstack
                gap="3"
                align="center"
                style={{
                  justifyContent: "space-between",
                  borderBottom: "1px solid #eee",
                  paddingBottom: "0.5rem",
                }}
              >
                <cf-vstack gap="0" style={{ flex: 1 }}>
                  <span style={{ fontWeight: "600" }}>
                    {expense.description}
                  </span>
                  <cf-text variant="caption" tone="muted">
                    {computed(() => {
                      const n = expense.sharedBy?.length || 0;
                      return `${expense.paidBy} paid · split ${n} way${
                        n === 1 ? "" : "s"
                      } · ${expense.date}`;
                    })}
                  </cf-text>
                </cf-vstack>
                <span style={{ fontWeight: "600" }}>
                  {computed(() => money(expense.amount))}
                </span>
                <cf-button
                  variant="ghost"
                  color="danger"
                  onClick={() => {
                    const cur = expenses.get();
                    const idx = cur.findIndex((el) => equals(expense, el));
                    if (idx >= 0) expenses.set(cur.toSpliced(idx, 1));
                  }}
                >
                  ×
                </cf-button>
              </cf-hstack>
            ))}
            {computed(() =>
              expenses.get().length === 0
                ? <cf-text tone="muted">No expenses yet.</cf-text>
                : null
            )}
          </cf-vstack>
        </cf-card>

        {/* ===== Balances ===== */}
        <cf-card>
          <cf-vstack gap="3">
            <cf-heading level={4}>Balances</cf-heading>
            {
              /* Render the list as a stable array and keep the empty state as a
                separate sibling. A single computed() that returns an array OR a
                single node makes the reactive diff transition array<->object,
                which throws TypeMismatchError. */
            }
            {computed(() =>
              balances.map((b) => (
                <cf-hstack
                  align="center"
                  style={{
                    justifyContent: "space-between",
                    fontWeight: b.name === me ? "700" : "400",
                  }}
                >
                  <cf-hstack gap="2" align="center">
                    <cf-avatar src={b.avatar} name={b.name} size="xs" />
                    <span>{b.name === me ? `${b.name} (you)` : b.name}</span>
                  </cf-hstack>
                  <cf-badge
                    color={b.net > 0
                      ? "accent"
                      : b.net < 0
                      ? "danger"
                      : "neutral"}
                  >
                    {b.net > 0
                      ? `is owed ${money(b.net)}`
                      : b.net < 0
                      ? `owes ${money(-b.net)}`
                      : "settled"}
                  </cf-badge>
                </cf-hstack>
              ))
            )}
            {computed(() =>
              balances.length === 0
                ? <cf-text tone="muted">No balances to show.</cf-text>
                : null
            )}
          </cf-vstack>
        </cf-card>

        {/* ===== Settle up ===== */}
        <cf-card>
          <cf-vstack gap="3">
            <cf-heading level={4}>Settle up</cf-heading>
            {computed(() =>
              settlements.map((s) => (
                <cf-hstack gap="2" align="center">
                  <cf-badge color="danger">{s.from}</cf-badge>
                  <span>→</span>
                  <cf-badge color="accent">{s.to}</cf-badge>
                  <span style={{ fontWeight: "600", marginLeft: "auto" }}>
                    {money(s.amount)}
                  </span>
                </cf-hstack>
              ))
            )}
            {computed(() =>
              settlements.length === 0
                ? <cf-text tone="muted">Everyone is settled up. 🎉</cf-text>
                : null
            )}
          </cf-vstack>
        </cf-card>
      </cf-vstack>
    ),

    // Shared ledger + per-user identity (re-exported for cross-piece reads).
    people,
    expenses,
    myName,
    balances,
    settlements,
    total,
  };
});
