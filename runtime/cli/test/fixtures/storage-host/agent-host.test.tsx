/** An agent request keeps the API origin supplied by its storage host. */
import { agent, assert, pattern, TESTS } from "commonfabric";

export default pattern(() => {
  const request = agent({
    task: "test the agent host",
    inputs: {},
    resultSchema: { type: "object" },
  });
  return {
    [TESTS]: [
      { assertion: assert(() => request.host === "https://fabric.example") },
    ],
  };
});
