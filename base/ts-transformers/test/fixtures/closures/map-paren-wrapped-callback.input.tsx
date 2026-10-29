import { pattern } from "commonfabric";

interface Row {
  label: string;
}

// FIXTURE: map-paren-wrapped-callback
// Verifies: a parenthesized inline map callback lowers exactly like its bare
//   spelling — rows.map(((r) => r.label)) → rows.mapWithPattern(pattern(...))
// Context: paren-invariance (target spec §5.7) at the extraction seam; a blind
//   arguments[0] read here once skipped the lowering entirely, emitting a raw
//   reactive .map that throws at runtime
export default pattern<{ rows: Row[] }>(({ rows }) => {
  const out = rows.map(((r) => r.label));
  return { out };
});
