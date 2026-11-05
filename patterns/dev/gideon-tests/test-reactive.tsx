// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
import { generateObject, JSONSchema, pattern, Reactive } from "commonfabric";

interface Email {
  id: string;
  content: string;
}

interface ExtractedData {
  summary: string;
}

// Generic building block - T is a type parameter
function BuildingBlock<T>(emails: Reactive<Email[]>, schema: JSONSchema) {
  // This is the problematic case: generateObject<T> where T is a type parameter
  // The result is Reactive<T | undefined> where T is unresolved
  const analyses = emails.map((email: Email) => {
    const analysis = generateObject<T>({
      prompt: email.content,
      schema,
    });

    return {
      email,
      analysis,
      result: analysis.result, // Reactive<T | undefined> - T is a type parameter!
    };
  });

  return { analyses };
}

// Pattern that uses the building block
export default pattern(({ emails }: { emails: Reactive<Email[]> }) => {
  const data = BuildingBlock<ExtractedData>(emails, { type: "object" });
  return { data };
});
