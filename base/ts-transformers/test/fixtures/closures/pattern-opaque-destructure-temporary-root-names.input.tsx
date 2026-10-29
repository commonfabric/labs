import { computed, generateObject, pattern } from "commonfabric";

// FIXTURE: pattern-opaque-destructure-temporary-root-names
// Verifies: destructured opaque temporaries preserve generated root suffixes
//   const { result } = generateObject(...) uses the synthesized __cf_destructure_* binding consistently
// NOTE (CT-1800): generateObject's `result` is declared optional, so the captured
//   `result` is emitted optional (absent from `required`). The lift therefore
//   fires while pending, keeping the `?? "Untitled"` fallback live.
export default pattern<{ messages: string[] }>(({ messages }) => {
  const preview = computed(() => messages[0] ?? "");
  const { result } = generateObject({
    prompt: preview,
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
    },
  });
  return <div>{result?.title ?? "Untitled"}</div>;
});
