/// <cts-enable />
import {
  computed,
  pattern,
  toCompactDebugString,
  toIndentedDebugString,
} from "commonfabric";

interface Entry {
  title: string;
  tags: string[];
}

// The two debug renderers: `compact` is rendered in the reactive tier,
// and `indented` in a function body.
export default pattern<{ entry: Entry }>(({ entry }) => {
  return {
    compact: toCompactDebugString(entry),
    indented: computed(() => {
      let text = "entry: ";
      text += toIndentedDebugString(entry);
      return text;
    }),
  };
});
