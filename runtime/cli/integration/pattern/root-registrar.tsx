/**
 * Exercises registration through an existing space root's `addPiece` stream.
 * The integration suite calls `register` from a fresh process, where dispatch
 * has started only the addressed piece, so the case pins that the send starts
 * the root at delivery.
 */

import { handler, NAME, pattern, str, type Stream, wish } from "commonfabric";
import "commonfabric/schema";

interface EntryInput {
  label: string;
}

interface EntryOutput {
  label: string;
}

const Entry = pattern<EntryInput, EntryOutput>(({ label }) => ({
  [NAME]: str`Entry ${label}`,
  label,
}));

interface RegisterEvent {
  label: string;
}

interface RegisterState {
  addPiece: Stream<{ piece: EntryOutput }>;
}

const register = handler<RegisterEvent, RegisterState>(
  ({ label }, { addPiece }) => {
    addPiece.send({ piece: Entry({ label }) });
  },
);

interface RootRegistrarOutput {
  register: Stream<RegisterEvent>;
}

export default pattern<Record<string, never>, RootRegistrarOutput>(() => {
  const { addPiece } = wish<{
    addPiece: Stream<{ piece: EntryOutput }>;
  }>({ query: "#default" }).result!;

  return {
    [NAME]: "Root registrar",
    register: register({ addPiece }),
  };
});
