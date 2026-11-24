import { computed, pattern } from "commonfabric";

// FIXTURE: index-signature-extras-optional
// Verifies: a capture path that resolves through a string index signature
// (an "extras" key like `priority` below) shrinks to an OPTIONAL property.
// Index signatures never guarantee a key exists, so the shrunken capture
// schema must not list the key in `required` — otherwise elements without
// the extra fail schema validation and the whole capture reads undefined
// (regression: editable-list assert_extra_passthrough after #4017).
interface TaggedItem {
  id: string;
  label: string;
  // deno-lint-ignore no-explicit-any
  [extra: string]: any;
}

interface Input {
  items: TaggedItem[];
}

export default pattern<Input>(({ items }) => {
  // Extras key: only exists on some elements; must shrink to `priority?`.
  const extraIsNine = computed(() => items[2]?.priority === 9);
  // Declared key for contrast: stays required as before.
  const labelIsGamma = computed(() => items[2]?.label === "Gamma");
  return { extraIsNine, labelIsGamma };
});
