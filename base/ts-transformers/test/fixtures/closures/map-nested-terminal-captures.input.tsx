import { pattern } from "commonfabric";

const terms = (value: string): string[] => value.split(" ");

// FIXTURE: map-nested-terminal-captures
// Verifies: a terminal chain captures an enclosing local through nested callbacks,
// keeps the callbacks inside its lift as plain JavaScript, and excludes their locals.
// Context: the chain is inside a reactive map callback and feeds another reactive map.
export default pattern<{ groups: string[]; rows: string[] }>(({ groups, rows }) => ({
  matches: groups.map((group) => {
    const tokens = terms(group);
    return rows.map((row) => {
      const hits = tokens.filter((token) => row.includes(token));
      return hits.length;
    }).slice(0, 1).map((count) => count);
  }),
}));
