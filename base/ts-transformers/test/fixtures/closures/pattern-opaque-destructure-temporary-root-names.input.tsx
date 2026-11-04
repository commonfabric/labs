import {
  computed,
  generateObjectStream,
  pattern,
  resultOf,
} from "commonfabric";

// FIXTURE: pattern-opaque-destructure-temporary-root-names
// Verifies: a direct opaque stream result remains a stable reactive root before
//   resultOf() projects its usable value.
export default pattern<{ messages: string[] }>(({ messages }) => {
  const preview = computed(() => messages[0] ?? "");
  const request = generateObjectStream({
    prompt: preview,
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
    },
  });
  const result = resultOf(request);
  return <div>{result?.title ?? "Untitled"}</div>;
});
