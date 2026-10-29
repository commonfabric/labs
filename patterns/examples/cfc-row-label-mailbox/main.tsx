/// <cts-enable />
// CFC Phase 3 demo: per-row, DATA-DERIVED SQLite labels.
//
// Each email row's confidentiality is computed from the row's own columns —
// the sender, every recipient on a messy RFC-5322 "To" line (regex split), and
// the db owner — and authored-by integrity is minted only when the row's own
// auth column shows dmarc=pass. The labels are enforced fail-closed:
//
// - the inbox query re-derives each row's label (alias-proof, by TRUE column
//   origin) and attaches it to that row's entity doc;
// - the "skim" query declares an output ceiling (maxConfidentiality) and
//   drops rows it does not admit (onExceed:"skip" — a declared, observable
//   existence release);
// - COUNT(*) refuses outright: an aggregate's contributors cannot be
//   re-labeled per row, and a skipped row cannot be un-counted;
// - every db.exec INSERT runs the same rule as a write gate (the computed
//   row label is recorded as the write's CFC policy input before commit).
//
// Spec: docs/specs/sqlite-builtin/06-cfc.md ("Per-row labels, derived from
// row data")
import {
  cfSqlite,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  PerSession,
  sqliteDatabase,
  type SqliteDb,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

interface MailRow {
  id: number;
  from_addr: string;
  to_addrs: string;
  auth: string;
  body: string;
}

/** The inbox projection: `from_addr` is aliased to `sender`, so the returned
 *  rows carry `sender` and NOT `from_addr`. */
interface InboxRow {
  id: number;
  sender: string;
  to_addrs: string;
  auth: string;
  body: string;
}

interface MailboxInput {
  draftFrom: PerSession<Writable<string | Default<"">>>;
  draftTo: PerSession<Writable<string | Default<"">>>;
  draftBody: PerSession<Writable<string | Default<"">>>;
}

export interface MailboxOutput {
  [NAME]: string;
  [UI]: VNode;
  seed: Stream<void>;
}

const seedMail = handler<void, { db: SqliteDb }>((_, { db }) => {
  db.exec(
    "INSERT INTO emails (from_addr, to_addrs, auth, body) VALUES (?, ?, ?, ?)",
    [
      "Alice Example <Alice@A.example>",
      "bob@example.com",
      "spf=pass dmarc=pass dkim=pass",
      "Lunch tomorrow?",
    ],
  );
  db.exec(
    "INSERT INTO emails (from_addr, to_addrs, auth, body) VALUES (?, ?, ?, ?)",
    [
      "carol@c.example",
      '"Dave D" <dave@d.example>, erin@e.example',
      "",
      "Quarterly numbers attached.",
    ],
  );
});

const sendMail = handler<
  void,
  {
    db: SqliteDb;
    draftFrom: Writable<string>;
    draftTo: Writable<string>;
    draftBody: Writable<string>;
  }
>((_, { db, draftFrom, draftTo, draftBody }) => {
  // The write gate evaluates the per-row rule against these bound values: a
  // draft without a sender address fails closed (the rule's min:1 anchor).
  db.exec(
    "INSERT INTO emails (from_addr, to_addrs, auth, body) VALUES (?, ?, ?, ?)",
    [draftFrom.get(), draftTo.get(), "", draftBody.get()],
  );
  draftBody.set("");
});

export default pattern<MailboxInput, MailboxOutput>(
  ({ draftFrom, draftTo, draftBody }) => {
    const { table, all, principal, match, whenMatches, authoredBy, dbOwner } =
      cfSqlite;
    // Pull address tokens out of a messy "Name <addr>, addr" recipient line.
    const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;

    const emails = table(
      {
        id: "integer primary key",
        from_addr: "text",
        to_addrs: "text",
        auth: "text",
        body: "text",
      },
      (f) => ({
        // Row confidentiality = sender ∧ every recipient ∧ the mailbox owner.
        // (Conjunctive `all()` — `any()` (one OR-clause) unlocks per-user
        // views once the clause-aware label profile lands; it errors today
        // rather than silently meaning the wrong thing.)
        confidentiality: all(
          principal("mailto", match(f.from_addr, ADDR, { min: 1 })),
          principal("mailto", match(f.to_addrs, ADDR)),
          dbOwner(),
        ),
        // Provenance from row data is forgeable by the row's writer, so this
        // mints a self-describing claimed-authored-by atom (not the trusted
        // AuthoredBy family), gated on the row's own auth evidence.
        integrity: whenMatches(
          f.auth,
          /dmarc=pass/,
          authoredBy(principal("mailto", match(f.from_addr, ADDR, { min: 1 }))),
        ),
      }),
    );

    const db = sqliteDatabase({ tables: { emails } });

    // The full inbox. `from_addr AS sender` also demonstrates that the rule's
    // inputs resolve by TRUE column origin, never by output name.
    const inbox = db.query<InboxRow>(
      "SELECT id, from_addr AS sender, to_addrs, auth, body FROM emails " +
        "ORDER BY id",
      { reactOn: db },
    );

    // A skim view with a DECLARED output ceiling: only rows whose computed
    // label fits {alice, bob, owner} survive; the rest are skipped (declared
    // existence release). Carol's mail to Dave+Erin is dropped here.
    const aliceBobSlice = db.query<MailRow>(
      "SELECT id, from_addr, to_addrs, auth, body FROM emails ORDER BY id",
      {
        reactOn: db,
        maxConfidentiality: [
          "did:mailto:alice@a.example",
          "did:mailto:bob@example.com",
          { __ctDbOwner: true },
        ],
        onExceed: "skip",
      },
    );

    // Aggregates on a rule-bearing table FAIL CLOSED: the count derives from
    // every row, including rows a ceiling would not admit.
    const mailCount = db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM emails",
      { reactOn: db },
    );

    const inboxRows = computed<InboxRow[]>(() => inbox.result ?? []);
    const sliceRows = computed<MailRow[]>(() => aliceBobSlice.result ?? []);
    const countError = computed<string>(() => String(mailCount.error ?? ""));

    const seed = seedMail({ db });

    return {
      [NAME]: "Per-Row Labeled Mailbox (CFC Phase 3)",
      [UI]: (
        <cf-screen title="Per-Row Labeled Mailbox">
          <cf-vstack gap="3" style={{ padding: "1rem" }}>
            <cf-card>
              <cf-vstack slot="content" gap="2">
                <cf-heading level={3}>Inbox (all rows)</cf-heading>
                <cf-label>
                  Every row carries its own data-derived label: sender ∧
                  recipients ∧ owner, re-derived from the row at read time.
                </cf-label>
                <cf-button id="seed-button" onClick={seed}>
                  Seed sample mail
                </cf-button>
                <cf-vstack gap="1" id="inbox-list">
                  {inboxRows.map((row) => (
                    <cf-card>
                      <cf-vstack slot="content" gap="1">
                        <cf-label>
                          #{row.id} from {row.sender} → {row.to_addrs}
                        </cf-label>
                        <div>{row.body}</div>
                        <cf-label>
                          {row.auth
                            ? "auth: " + row.auth +
                              " ⟹ claimed-authored-by minted"
                            : "no auth evidence ⟹ no authorship claim"}
                        </cf-label>
                      </cf-vstack>
                    </cf-card>
                  ))}
                </cf-vstack>
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack slot="content" gap="2">
                <cf-heading level={3}>
                  Alice+Bob slice (declared ceiling, onExceed:"skip")
                </cf-heading>
                <cf-label>
                  This query declares maxConfidentiality [alice, bob, owner].
                  Rows with other participants are dropped — a declared,
                  observable existence release.
                </cf-label>
                <cf-vstack gap="1" id="slice-list">
                  {sliceRows.map((row) => (
                    <cf-label>
                      #{row.id} from {row.from_addr}: {row.body}
                    </cf-label>
                  ))}
                </cf-vstack>
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack slot="content" gap="2">
                <cf-heading level={3}>COUNT(*) fails closed</cf-heading>
                <cf-label>
                  An aggregate's contributors cannot be re-labeled per row, so
                  the query refuses rather than under-labels:
                </cf-label>
                <div id="count-error">{countError}</div>
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack slot="content" gap="2">
                <cf-heading level={3}>Compose (write gate)</cf-heading>
                <cf-label>
                  The INSERT evaluates the same rule: no sender address ⟹ the
                  write is rejected (min:1 anchor, fail closed).
                </cf-label>
                <cf-input placeholder="From (address)" $value={draftFrom} />
                <cf-input
                  placeholder="To (addresses, messy is fine)"
                  $value={draftTo}
                />
                <cf-input placeholder="Body" $value={draftBody} />
                <cf-button
                  id="send-button"
                  onClick={sendMail({ db, draftFrom, draftTo, draftBody })}
                >
                  Send
                </cf-button>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
      ),
      seed,
    };
  },
);
