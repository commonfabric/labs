/// <cts-enable />
// FIXTURE: SQL-aggregate selection and parsing before reactive bubble rendering.
import { action, assert, pattern, TESTS } from "commonfabric";
import Thread from "./main.tsx";

export default pattern(() => {
  const thread = Thread({});
  return {
    [TESTS]: [
      { assertion: assert(() => thread.bubbles.length === 0) },
      { action: action(() => thread.seed.send({ count: 11 })) },
      { assertion: assert(() => thread.thread.result?.length === 1) },
      {
        assertion: assert(() =>
          typeof thread.thread.result?.[0]?.packed === "string"
        ),
      },
      { assertion: assert(() => thread.bubbles.length === 0) },
      { action: action(() => thread.open.send()) },
      { assertion: assert(() => thread.bubbles.length === 11) },
      { assertion: assert(() => thread.bubbles[0].text === "Message 0") },
      { assertion: assert(() => thread.bubbles[10].text === "Message 10") },
      { assertion: assert(() => thread.bubbles[0].me === true) },
      { assertion: assert(() => thread.bubbles[1].me === false) },
    ],
  };
});
