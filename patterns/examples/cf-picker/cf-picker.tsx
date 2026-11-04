import {
  computed,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import Counter from "../counter/counter.tsx";
import Note from "../../system/notes/note.tsx";

type Input = Record<string, never>;

export type Result = {
  [NAME]: string;
  [UI]: VNode;
  counterAValue: number;
  counterBValue: number;
  counterCValue: number;
};

export default pattern<Input, Result>(
  (_) => {
    // Create counter instances - these are Reactives to pattern results
    const counterA = Counter({ value: 10 });
    const counterB = Note({
      content: "This is item B (a Note)",
    });
    const counterC = Counter({ value: 30 });

    const selectedIndex = new Writable(0);
    const items = computed(() => [counterA, counterB, counterC]);
    const selection = computed(() => items[selectedIndex.get()]);

    return {
      [NAME]: "cf-picker demo",
      [UI]: (
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <h3>cf-picker Component Demo</h3>

          <cf-card>
            <cf-button
              onClick={() => {
                selectedIndex.set(Math.max(0, selectedIndex.get() - 1));
              }}
            >
              Prev
            </cf-button>
            <cf-button
              onClick={() => {
                selectedIndex.set(
                  Math.min(items.length - 1, selectedIndex.get() + 1),
                );
              }}
            >
              Next
            </cf-button>
            <div>
              {selection}
            </div>
          </cf-card>

          <cf-card>
            <cf-picker $items={items} $selectedIndex={selectedIndex} />
          </cf-card>
        </cf-vstack>
      ),
      counterAValue: counterA.value,
      counterBValue: 0, // Note doesn't have .value
      counterCValue: counterC.value,
    };
  },
);
