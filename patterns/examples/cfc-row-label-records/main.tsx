/// <cts-enable />
// CFC Phase 3 demo: per-row rules COMPOSE with per-column (Phase 2) labels.
//
// A patient-records table mixes both label sources on one row entity:
// - the per-row rule derives WHO the row concerns from the row itself
//   (patient ∧ clinic owner — every field of the row inherits it), and
// - the ssn column additionally carries a static per-column "pii" label.
//
// So reading r.ssn observes {pii ∧ patient ∧ owner} while r.diagnosis
// observes {patient ∧ owner} — and a declared output ceiling that admits the
// patient and the owner (but not "pii") accepts a diagnosis projection while
// REFUSING an ssn projection of the very same rows.
//
// Spec: docs/specs/sqlite-builtin/06-cfc.md ("Read — re-derive per row,
// attach, ceiling")
import {
  cfSqlite,
  computed,
  handler,
  NAME,
  pattern,
  sqliteDatabase,
  type SqliteDb,
  Stream,
  UI,
  type VNode,
} from "commonfabric";

interface DiagnosisRow {
  id: number;
  patient_email: string;
  diagnosis: string;
}

export interface RecordsOutput {
  [NAME]: string;
  [UI]: VNode;
  seed: Stream<void>;
}

const seedRecords = handler<void, { db: SqliteDb }>((_, { db }) => {
  db.exec(
    "INSERT INTO records (patient_email, ssn, diagnosis) VALUES (?, ?, ?)",
    ["ada@a.example", "111-22-3333", "sprained wrist"],
  );
  db.exec(
    "INSERT INTO records (patient_email, ssn, diagnosis) VALUES (?, ?, ?)",
    ["grace@g.example", "444-55-6666", "common cold"],
  );
});

export default pattern<Record<string, never>, RecordsOutput>(() => {
  const { table, all, principal, match, dbOwner } = cfSqlite;
  const ADDR = /[^\s<>,;"]+@[^\s<>,;"]+/g;

  const records = table(
    {
      id: "integer primary key",
      patient_email: "text",
      // Per-COLUMN (Phase 2) static label: ssn is pii wherever it flows.
      ssn: { type: "string", ifc: { confidentiality: ["pii"] } },
      diagnosis: "text",
    },
    // Per-ROW (Phase 3) rule: the whole row is confidential to the patient it
    // concerns (derived from the row's own data) and the clinic owner.
    (f) => ({
      confidentiality: all(
        principal("mailto", match(f.patient_email, ADDR, { min: 1 })),
        dbOwner(),
      ),
    }),
  );

  const db = sqliteDatabase({ tables: { records } });

  const ceiling = [
    "did:mailto:ada@a.example",
    "did:mailto:grace@g.example",
    { __ctDbOwner: true },
  ];

  // Diagnosis projection: per-row label only ⟹ fits the ceiling.
  const diagnoses = db.query<DiagnosisRow>(
    "SELECT id, patient_email, diagnosis FROM records ORDER BY id",
    { reactOn: db, maxConfidentiality: ceiling, onExceed: "fail" },
  );

  // SSN projection of the SAME rows: the per-column "pii" label rides every
  // row and the ceiling does not admit it ⟹ the query REFUSES (fail closed).
  const ssns = db.query<{ id: number; patient_email: string; ssn: string }>(
    "SELECT id, patient_email, ssn FROM records ORDER BY id",
    { reactOn: db, maxConfidentiality: ceiling, onExceed: "fail" },
  );

  const diagnosisRows = computed<DiagnosisRow[]>(() => diagnoses.result ?? []);
  const diagnosisError = computed<string>(() => String(diagnoses.error ?? ""));
  const ssnError = computed<string>(() => String(ssns.error ?? ""));

  const seed = seedRecords({ db });

  return {
    [NAME]: "Per-Row × Per-Column Labels (CFC Phase 3)",
    [UI]: (
      <cf-screen title="Patient Records — composed labels">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>
                Diagnoses (per-row label fits the ceiling)
              </cf-heading>
              <cf-label>
                Each row's label is derived from its own patient_email (∧ the
                clinic owner). The declared ceiling admits the patients and the
                owner, so this projection flows.
              </cf-label>
              <cf-button id="seed-button" onClick={seed}>
                Seed sample records
              </cf-button>
              <cf-vstack gap="1" id="diagnosis-list">
                {diagnosisRows.map((row) => (
                  <cf-label>
                    #{row.id} {row.patient_email}: {row.diagnosis}
                  </cf-label>
                ))}
              </cf-vstack>
              <div id="diagnosis-error">{diagnosisError}</div>
            </cf-vstack>
          </cf-card>

          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>
                SSNs (per-column "pii" exceeds the ceiling — refused)
              </cf-heading>
              <cf-label>
                The very same rows, projected with the ssn column: Phase 2's
                static "pii" label rides every row, the ceiling does not admit
                it, and onExceed:"fail" refuses the whole query — the two label
                sources compose on one row entity.
              </cf-label>
              <div id="ssn-error">{ssnError}</div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-screen>
    ),
    seed,
  };
});
