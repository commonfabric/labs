/**
 * Cell moves the repository has decided to ship, for
 * `check-cause-assignments.ts`.
 *
 * A compiler change that moves a pattern's anonymous cells to new numbers
 * under an unchanged source fails that gate, and the default answer is to
 * change the compiler so that the numbers hold. Where they cannot, the move
 * is declared here, in the change that makes it, where review sees it.
 *
 * An entry forgives one pattern's moves between exactly two builds of it: the
 * base revision's and the change's, each named by the digest the gate prints
 * for it. So an entry forgives nothing once either compiler moves on, and a
 * second move of the same pattern is gated again. Once the change has merged,
 * its base and its own build are the same and the entry forgives nothing; the
 * gate then names it as one to remove.
 */

/** One pattern's moves, forgiven between two builds of it. */
export interface AcceptedMove {
  /** The pattern's key, as `pattern-files.ts` names it. */
  pattern: string;

  /** The digest of the base revision's build, as the gate prints it. */
  base: string;

  /** The digest of the change's build, as the gate prints it. */
  head: string;

  /**
   * Why the move ships: what the change gains by it, and what becomes of the
   * deployed pieces whose cells it moves. The gate refuses to run on an entry
   * that gives none.
   */
  reason: string;
}

const FACTORY_LOWERING_REASON =
  "Factory@1 replaces wrapper and sibling-params lowering with directly " +
  "branded factory nodes and canonical list binding, intentionally changing " +
  "the anonymous internal graph. The owner-approved pre-launch wipe discards " +
  "pieces compiled with the previous numbering.";

export const ACCEPTED_MOVES: readonly AcceptedMove[] = [
  {
    pattern: "dev/factory-outputs/parking-coordinator/main.tsx",
    base: "f27f805b94509fbe",
    head: "48fe0eaab53ee547",
    reason: FACTORY_LOWERING_REASON,
  },
  {
    pattern: "dev/scope-bug-computed-vnode-blank/main.tsx",
    base: "cccef577f8f7281e",
    head: "39bc0514cd2cb848",
    reason: FACTORY_LOWERING_REASON,
  },
  {
    pattern: "examples/simple-list/simple-list.tsx",
    base: "d7bc1b43d84c048e",
    head: "b92219bd88476070",
    reason: FACTORY_LOWERING_REASON,
  },
  {
    pattern: "system/home/home-ben.tsx",
    base: "4bbc49158d6a9177",
    head: "e3badf2d663e04cf",
    reason: FACTORY_LOWERING_REASON,
  },
  {
    pattern: "apps/topics/topic.tsx",
    base: "0e328ddd95b18ce0",
    head: "fbd40b82aa47001e",
    reason: FACTORY_LOWERING_REASON,
  },
  {
    pattern: "examples/map-demo/map-demo.tsx",
    base: "03e9d2add615280e",
    head: "db423179917a9b4e",
    reason: FACTORY_LOWERING_REASON,
  },
  {
    pattern: "apps/person-workbench/main.tsx",
    base: "192e0983cb46a445",
    head: "f46c92234ac0b818",
    reason: FACTORY_LOWERING_REASON,
  },
  {
    pattern: "apps/self-improving-classifier/self-improving-classifier.tsx",
    base: "2631fd44a76de719",
    head: "0c5809a6213ec0df",
    reason: FACTORY_LOWERING_REASON,
  },
  {
    pattern: "apps/store-mapper/store-mapper.tsx",
    base: "a62cfac9484430ac",
    head: "caaee50f8f00a7a6",
    reason: FACTORY_LOWERING_REASON,
  },
  {
    pattern: "dev/render-test/render-test.tsx",
    base: "246ddf235d9f0c53",
    head: "b1816ba991604e57",
    reason: FACTORY_LOWERING_REASON,
  },
  {
    pattern: "system/loom/main.tsx",
    base: "00091eaea4151c47",
    head: "b0514bcaacee2a2e",
    reason: FACTORY_LOWERING_REASON,
  },
];
