import { computed, Default, pattern, UI } from "commonfabric";

interface Entry {
  name: string;
  url: string;
}

interface LinksState {
  links: Default<Entry[], []>;
  myName: Default<string, "">;
}

// FIXTURE: map-row-ternary-computed-capture
// Verifies: a binary comparison inside a JSX map-row ternary, comparing the
//   element binding against a computed captured from the enclosing pattern
//   body, lowers without crashing the compute-wrap invariant (lunch-poll
//   PR #4928 shape 2):
//   {links.map((entry) => entry.name === me ? <span/> : null)}
//     -> mapWithPattern row with an ifElse over a lifted comparison
// Context: regression companion to the builder-argument computation
//   diagnostic — this shape is supported and must keep lowering cleanly.
export default pattern<LinksState>(({ links, myName }) => {
  const me = computed(() => myName.trim());
  return {
    [UI]: (
      <div>
        {links.map((entry) => (
          entry.name === me ? <span>{entry.url}</span> : null
        ))}
      </div>
    ),
  };
});
