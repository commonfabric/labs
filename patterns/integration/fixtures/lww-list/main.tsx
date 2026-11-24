import {
  Default,
  NAME,
  pattern,
  type PerSpace,
  UI,
  type VNode,
} from "commonfabric";

/**
 * Plain shared list — fixture for the cellset-lww lost-update
 * characterization (cellset-lww-lost-update.test.ts).
 *
 * Elements are plain objects (no Cell links), so reads are unaffected by the
 * reader-blackout defects; the test drives writes directly through the
 * harness `set`/`push` commands (the CellSet / CellPush request paths).
 */

export interface ListItem {
  body: string;
}

const DEFAULT_ITEMS: ListItem[] = [];

export interface LwwListInput {
  items?: PerSpace<ListItem[] | Default<typeof DEFAULT_ITEMS>>;
}

export interface LwwListOutput {
  [NAME]: string;
  [UI]: VNode;
  items: PerSpace<ListItem[] | Default<typeof DEFAULT_ITEMS>>;
}

export default pattern<LwwListInput, LwwListOutput>(({ items }) => ({
  [NAME]: "LWW list fixture",
  [UI]: (
    <div>
      <span>lww list fixture</span>
    </div>
  ),
  items,
}));
