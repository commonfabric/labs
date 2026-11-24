// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * This is a hand-driven probe for the data model, not an automated test,
 * despite the directory it sits in and the name it carries. It takes a
 * JavaScript expression typed into the UI, stores the result in a cell, and
 * renders back a description of what came out, so that the round trip through
 * storage can be inspected for values whose handling is hard to predict:
 * `undefined`, `null`, `NaN`, the infinities, a signed zero, a nested
 * container. The description renders through the debug renderer, which
 * writes each of those as itself, `-0` included, so what the display shows
 * is the round trip and not the renderer.
 *
 * Nothing here asserts anything, so nothing here can fail. What it produces is
 * a display for a person to read, and the `VERSION` string exists so that a
 * reader can tell from the console which build of it they are looking at.
 */

import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  toIndentedDebugString,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

const VERSION = "v26";

function describeValue(val: any): string {
  return `typeof: ${typeof val}\n\nvalue:  ${toIndentedDebugString(val)}`;
}

function nowTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${
    pad(d.getHours())
  }:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface Input {
  value: Writable<any | Default<null>>;
  inputText: Writable<string | Default<"">>;
  errorMsg: Writable<string | Default<"">>;
  evalTime: Writable<string | Default<"(never)">>;
}

export interface Output {
  [NAME]: string;
  [UI]: VNode;
  value: any;
  evalAndStore: Stream<void>;
  rerenderDisplay: Stream<void>;
}

const evalAndStore = handler<
  void,
  {
    value: Writable<any>;
    inputText: Writable<string>;
    errorMsg: Writable<string>;
    evalTime: Writable<string>;
  }
>((_, { value, inputText, errorMsg, evalTime }) => {
  const expr = inputText.get();
  console.log(`[data-model-test] evaluating: ${expr}`);
  try {
    // Intentional use of `new Function` for testing: This pattern exists to
    // exercise the data model's serialization of arbitrary JS values. Patterns
    // run inside the sandboxed piece runtime, not the host.
    const result = new Function(`return (${expr})`)();
    console.log(`[data-model-test] result:`, result);
    value.set(result);
    errorMsg.set("");
    evalTime.set(nowTimestamp());
  } catch (e: any) {
    console.log(`[data-model-test] error:`, e);
    errorMsg.set(String(e));
  }
});

const rerenderDisplay = handler<
  void,
  { value: Writable<any>; evalTime: Writable<string> }
>(
  (_, { value, evalTime }) => {
    const v = value.get();
    console.log(`[data-model-test] rerender from stored value:`, v);
    evalTime.set(nowTimestamp());
  },
);

export default pattern<Input, Output>(
  ({ value, inputText, errorMsg, evalTime }) => {
    console.log(`[data-model-test] loaded ${VERSION}`);

    const boundEvalAndStore = evalAndStore({
      value,
      inputText,
      errorMsg,
      evalTime,
    });
    const boundRerenderDisplay = rerenderDisplay({ value, evalTime });

    const display = computed(() => {
      const ts = evalTime.get();
      const desc = describeValue(value.get());
      return `evaluated at: ${ts}\n${desc}`;
    });

    return {
      [NAME]: "Data Model Test",
      [UI]: (
        <cf-vstack gap={1} style="padding: 1rem; max-width: 500px;">
          <h3>Data Model Test</h3>
          <cf-textarea
            $value={inputText}
            placeholder='JS expression, e.g. 42, "hello", undefined, {a: [1,2]}'
          />
          <cf-button onClick={boundEvalAndStore}>Evaluate & Store</cf-button>
          <cf-button onClick={boundRerenderDisplay}>Rerender Display</cf-button>
          <pre
            style={{
              padding: "12px",
              backgroundColor: "#f3f4f6",
              borderRadius: "8px",
              whiteSpace: "pre-wrap",
              minHeight: "60px",
              fontFamily: "monospace",
            }}
          >
          {display}
          </pre>
          <div style={{ color: "red", fontSize: "0.875rem" }}>{errorMsg}</div>
          <div style={{ color: "grey", fontSize: "9pt" }}>{VERSION}</div>
        </cf-vstack>
      ),
      value,
      evalAndStore: boundEvalAndStore,
      rerenderDisplay: boundRerenderDisplay,
    };
  },
);
