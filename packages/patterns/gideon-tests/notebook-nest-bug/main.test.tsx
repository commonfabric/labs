import {
  action,
  assert,
  pattern,
  resultOf,
  TESTS,
  wish,
  Writable,
} from "commonfabric";
import type { MinimalPiece } from "../../notes/schemas.tsx";
import NotebookNestBug from "./main.tsx";

export default pattern(() => {
  const pieceRegistryRequest = wish<Writable<MinimalPiece[]>>({
    query: "#pieceRegistry",
  });
  const pieceRegistry = resultOf(pieceRegistryRequest.result);
  const subject = NotebookNestBug({});

  const action_create_nested_notebooks = action(() => {
    subject.requestCreate.send();
  });

  const assert_starts_empty = assert(() => pieceRegistry.get().length === 0);
  const assert_registers_complete_tree = assert(() =>
    pieceRegistry.get().length === 12
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { action: action_create_nested_notebooks },
      { assertion: assert_registers_complete_tree },
    ],
    subject,
  };
});
