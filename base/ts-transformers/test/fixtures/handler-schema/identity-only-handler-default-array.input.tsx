import { Default, equals, handler, Writable } from "commonfabric";

type MentionablePiece = {
  title?: string;
  isHidden?: boolean;
  mentioned?: MentionablePiece[];
  backlinks?: MentionablePiece[];
};

// CT-1639 Gap B: the array carries a `Default<[]>` union member. The items must
// still shrink to `{ type: "unknown", asCell: ["comparable"] }` — identical to
// the non-Default `identity-only-handler-payload` fixture — so that the
// equals()/findIndex removal idiom keeps matching live links. Before the fix the
// expanded `Default<[]>` union dropped the items `comparable`, silently breaking
// equals()-based removal.
const removePiece = handler<
  { piece: MentionablePiece },
  { pieceRegistry: Writable<MentionablePiece[] | Default<[]>> }
>(({ piece }, { pieceRegistry }) => {
  const current = pieceRegistry.get();
  const idx = current.findIndex((c) => equals(c, piece));
  if (idx >= 0) pieceRegistry.set(current.toSpliced(idx, 1));
});

// FIXTURE: identity-only-handler-default-array
// Verifies: a `Writable<T[] | Default<[]>>` array used only for identity removal
// keeps `asCell: ["comparable"]` on its items (with `default: []` from the
// Default<[]> collapse), matching the non-Default identity-only fixture. (CT-1639)
export { removePiece };
