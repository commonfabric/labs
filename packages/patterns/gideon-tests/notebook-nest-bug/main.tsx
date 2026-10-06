// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
import {
  action,
  computed,
  NAME,
  pattern,
  resultOf,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import Note from "../../notes/note.tsx";
import Notebook from "../../notes/notebook.tsx";
import { type MinimalPiece } from "../../notes/schemas.tsx";

export default pattern<
  Record<PropertyKey, never>,
  { [NAME]: string; [UI]: VNode; requestCreate: Stream<void> }
>(() => {
  const pieceRegistryWish = wish<Writable<MinimalPiece[]>>({
    query: "#pieceRegistry",
  });
  const pieceRegistry = resultOf(pieceRegistryWish.result);

  // "idle" | "creating" | "done"
  const status = new Writable<string>("idle");

  const requestCreate = action(() => {
    console.log("requestCreate");
    status.set("creating");

    // === Tree A ===
    const noteA1 = Note({
      title: "Note A1",
      content: "leaf",

      isHidden: true,
    });
    const noteAC1 = Note({
      title: "Note AC1",
      content: "leaf",

      isHidden: true,
    });
    const noteAG1 = Note({
      title: "Note AG1",
      content: "leaf",

      isHidden: true,
    });
    const nbAGrandchild = Notebook({
      title: "A-Grandchild",
      notes: [noteAG1],
      isHidden: true,
    });
    const nbAChild = Notebook({
      title: "A-Child",
      notes: [noteAC1, nbAGrandchild],
      isHidden: true,
    });
    const nbA = Notebook({ title: "Notebook A", notes: [noteA1, nbAChild] });

    // === Tree B ===
    const noteB1 = Note({
      title: "Note B1",
      content: "leaf",

      isHidden: true,
    });
    const noteBC1 = Note({
      title: "Note BC1",
      content: "leaf",

      isHidden: true,
    });
    const noteBG1 = Note({
      title: "Note BG1",
      content: "leaf",

      isHidden: true,
    });
    const nbBGrandchild = Notebook({
      title: "B-Grandchild",
      notes: [noteBG1],
      isHidden: true,
    });
    const nbBChild = Notebook({
      title: "B-Child",
      notes: [noteBC1, nbBGrandchild],
      isHidden: true,
    });
    const nbB = Notebook({ title: "Notebook B", notes: [noteB1, nbBChild] });

    pieceRegistry.push(
      noteA1,
      noteAC1,
      noteAG1,
      nbAGrandchild,
      nbAChild,
      nbA,
      noteB1,
      noteBC1,
      noteBG1,
      nbBGrandchild,
      nbBChild,
      nbB,
    );

    status.set("done");
  });

  return {
    [NAME]: "Nest Bug Repro",
    requestCreate,
    [UI]: (
      <cf-vstack gap="4" padding="6">
        <span style={{ fontSize: "18px", fontWeight: "600" }}>
          Nest Bug Repro {status}
        </span>

        {/* Idle: show button */}
        <cf-button
          variant="primary"
          onClick={requestCreate}
          style={{
            display: computed(() =>
              status.get() === "idle" ? "inline-flex" : "none"
            ),
          }}
        >
          Create Nested Notebooks
        </cf-button>

        {/* Creating: indicator */}
        <cf-hstack
          gap="2"
          align="center"
          style={{
            display: computed(() =>
              status.get() === "creating" ? "flex" : "none"
            ),
          }}
        >
          <span
            style={{
              fontSize: "14px",
              color: "var(--cf-color-text-secondary, #666)",
            }}
          >
            Creating notebooks...
          </span>
        </cf-hstack>

        {/* Done: success */}
        <cf-card
          style={{
            display: computed(() => status.get() === "done" ? "block" : "none"),
          }}
        >
          <cf-vstack gap="2" padding="4">
            <span
              style={{
                fontSize: "16px",
                fontWeight: "600",
                color: "var(--cf-color-success, #16a34a)",
              }}
            >
              Done! Created 12 pieces (6 notes + 6 notebooks)
            </span>
            <span
              style={{
                fontSize: "13px",
                color: "var(--cf-color-text-secondary, #666)",
              }}
            >
              3 levels of nesting: parent &gt; child &gt; grandchild
            </span>
          </cf-vstack>
        </cf-card>
      </cf-vstack>
    ),
  };
});
