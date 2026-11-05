import { pattern } from "commonfabric";

// FIXTURE: nested-pattern-capture-free
// Verifies: a capture-free nested pattern hoists as a bare registered factory
// with no private params carrier and no curry.
export default pattern<{ title: string }>(({ title }) => ({
  title,
  child: pattern<{ value: string }>(({ value }) => ({ value })),
}));
