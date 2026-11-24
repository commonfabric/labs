import { action, assert, pattern, TESTS } from "commonfabric";
import Nested from "./nested.tsx";
import Mapped from "./mapped.tsx";

export default pattern(() => {
  const nested = Nested({});
  const mapped = Mapped({});
  return {
    [TESTS]: [
      {
        action: action(() => {
          nested.cast.send({ key: "alice", optionId: "one", color: "green" });
          mapped.cast.send({ key: "alice", optionId: "one", color: "green" });
        }),
      },
      {
        assertion: assert(() =>
          nested.rows[0].colors[0] === "green" &&
          mapped.rows[0].color === "green"
        ),
      },
      {
        action: action(() => {
          nested.cast.send({ key: "alice", optionId: "one", color: "yellow" });
          mapped.cast.send({ key: "alice", optionId: "one", color: "yellow" });
        }),
      },
      {
        assertion: assert(() =>
          nested.rows[0].colors[0] === "yellow" &&
          mapped.rows[0].color === "yellow"
        ),
      },
      {
        action: action(() => {
          nested.retract.send({ key: "alice" });
          mapped.retract.send({ key: "alice" });
        }),
      },
      {
        assertion: assert(() =>
          nested.rows[0].colors.length === 0 &&
          nested.rows[0].names.length === 0 &&
          mapped.rows[0].color === "" && mapped.rows[0].names === ""
        ),
      },
      {
        action: action(() => {
          nested.cast.send({ key: "alice", optionId: "one", color: "green" });
          mapped.cast.send({ key: "alice", optionId: "one", color: "green" });
        }),
      },
      {
        assertion: assert(() =>
          nested.rows[0].colors.length === 1 &&
          nested.rows[0].colors[0] === "green" &&
          mapped.rows[0].color === "green" && mapped.rows[0].names === "alice"
        ),
      },
    ],
  };
});
