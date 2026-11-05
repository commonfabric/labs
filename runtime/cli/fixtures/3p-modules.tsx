import { type JSONSchema, NAME, pattern, str, UI } from "commonfabric";
import TurndownService from "turndown";

const Input = {
  type: "object",
  properties: {
    foo: {
      type: "string",
    },
  },
  required: ["foo"],
  description: "input",
} as const satisfies JSONSchema;

const Output = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "string",
      },
    },
  },
} as const satisfies JSONSchema;

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}
export default pattern(
  (_state) => {
    const html = `
    <div id="root">
      <ul foo="bar">
        <li>one</li> 
        <li>two</li> 
        <li>three</li> 
      </ul>
    </div>
    `;
    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
    });
    // test turndown
    const parsed = turndown.turndown(html);
    assert(parsed.length > 0, "turndown parsed HTML");

    return {
      [NAME]: str`3P Test`,
      [UI]: (
        <div>
          <h2>3P Test</h2>
        </div>
      ),
    };
  },
  Input,
  Output,
);
