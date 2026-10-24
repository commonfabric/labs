// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
import { Default, NAME, pattern, UI } from "commonfabric";
import Note from "./notes/note.tsx";

export default pattern<{ title: string | Default<"Suggestion Tester"> }>(
  ({ title }) => {
    const note = Note({
      title: "Demo",
      content: "hello",
    });

    return {
      [NAME]: title,
      [UI]: (
        <div>
          <h1>cf-cell-link test</h1>
          <cf-cell-link $cell={note} />
        </div>
      ),
    };
  },
);
