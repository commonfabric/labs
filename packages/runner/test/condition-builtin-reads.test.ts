/**
 * How `ifElse`, `when` and `unless` read their condition. Each one decides on
 * the condition's truthiness alone, which the condition's root settles, so the
 * decision reads the root and nothing below it. A label held inside a
 * condition that is a record therefore stays off the builtin's output, while a
 * label on the root, or on a link the read follows to reach the root, is one
 * the decision depends on, and the output carries it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { JSONSchema } from "../src/builder/types.ts";
import { UI } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { type CfcConfClause, clauseAlternatives } from "../src/cfc/clause.ts";
import { commitCfcFieldValue } from "../src/cfc/label-representation.ts";
import { buildCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
import { collectConsumedLabel } from "../src/cfc/prepare.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { createSigilLinkFromParsedLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { txToReactivityLog } from "../src/scheduler.ts";
import { vnodeSchema } from "../src/schemas.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const owner = await Identity.fromPassphrase("condition-builtin-reads owner");
const patternSpace = await Identity.fromPassphrase(
  "condition-builtin-reads pattern space",
);
const profileSpace = (await Identity.fromPassphrase(
  "condition-builtin-reads profile space",
)).did();

// A module policy with no exchange rules, so nothing releases a value it
// seals.
const SEAL = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: "sha256:condition-builtin-reads",
  symbol: "sealSheet",
  template: {
    templateVersion: 1,
    exchangeRules: [],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});
const sealedClause = cfcAtom.modulePolicyRef(
  SEAL.manifest.moduleIdentity,
  SEAL.manifest.symbol,
  SEAL.policyDigest,
  profileSpace,
);

// The two spellings the clause is stored in: its subject in the clear in the
// profile space, and committed to a digest once it is stamped in another.
const sealedSpellings = [
  sealedClause,
  cfcAtom.modulePolicyRef(
    SEAL.manifest.moduleIdentity,
    SEAL.manifest.symbol,
    SEAL.policyDigest,
    commitCfcFieldValue(profileSpace),
  ),
];

/** Whether one of `clauses` names the sealing policy, alone or as an option. */
const holdsSealedClause = (clauses: readonly CfcConfClause[]): boolean =>
  clauses.some((clause) =>
    clauseAlternatives(clause).some((atom) =>
      sealedSpellings.some((spelling) => deepEqual(atom, spelling))
    )
  );

// The schema a typed wish for a piece asks with: the piece's view among its
// fields.
const pieceSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    [UI]: { $ref: "#/$defs/VNode" },
  },
  $defs: vnodeSchema.$defs,
} as const satisfies JSONSchema;

/** A view node, as a piece's result document stores one. */
const vnode = (name: string, children: unknown[]) => ({
  type: "vnode",
  name,
  props: {},
  children,
});

/** The three builtins that branch on a condition. */
type Builtin = "ifElse" | "when" | "unless";

/**
 * Which branch each builtin took: `true` where it took the truthy one. An
 * `ifElse` that took neither, because it never wrote its output, shows what
 * it holds instead.
 */
type Branches = { ifElse: unknown; when: boolean; unless: boolean };

/** The branches all three builtins take for a condition that is `truthy`. */
const allTake = (truthy: boolean): Branches => ({
  ifElse: truthy,
  when: truthy,
  unless: truthy,
});

describe("condition-builtin-reads", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let builder: ReturnType<typeof createTrustedBuilder>["commonfabric"];
  // What the scheduler reported as failed actions since the runtime started.
  let actionErrors: string[];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: owner });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    runtime.registerCfcPolicyManifests(undefined, [SEAL]);
    builder = createTrustedBuilder(runtime).commonfabric;
    actionErrors = [];
    runtime.scheduler.onError((error) => actionErrors.push(error.message));
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** A document in the profile space, stored with `entries` as its labels. */
  const seededDoc = async (
    cause: string,
    value: FabricValue,
    entries: LabelMapEntry[],
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const doc = runtime.getCell(profileSpace, cause, undefined, tx);
    writeSeedEnvelopeDoc(tx, profileSpace);
    seedStoredEnvelope(tx, {
      space: profileSpace,
      scope: "space",
      id: doc.getAsNormalizedFullLink().id,
      path: [],
    }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit()).error).toBeUndefined();
    return doc.withTx(undefined);
  };

  /** A document whose stored label seals its whole value. */
  const sealedDoc = (cause: string, value: FabricValue) =>
    seededDoc(cause, value, [
      { path: [], label: { confidentiality: [sealedClause] } },
    ]);

  /** A document in the pattern space holding `value`, or never written. */
  const plainDoc = async (cause: string, value?: FabricValue) => {
    const tx = runtime.edit();
    const doc = runtime.getCell(patternSpace.did(), cause, undefined, tx);
    if (value !== undefined) doc.set(value);
    expect((await tx.commit()).error).toBeUndefined();
    return doc.withTx(undefined);
  };

  /** A stored link to the root of `doc`. */
  const linkTo = (doc: Cell<unknown>): FabricValue =>
    createSigilLinkFromParsedLink(doc.getAsNormalizedFullLink());

  /**
   * Runs `body` as a pattern over `argument`, typed by `argumentSchema` where
   * one is given, and settles it.
   */
  const runPattern = async (
    cause: string,
    body: (input: any) => Record<string, unknown>,
    argument: Record<string, unknown> = {},
    argumentSchema?: JSONSchema,
  ): Promise<Cell<Record<string, unknown>>> => {
    const tx = runtime.edit();
    const resultCell = runtime.getCell<Record<string, unknown>>(
      patternSpace.did(),
      cause,
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      argumentSchema === undefined
        ? builder.pattern(body)
        : builder.pattern(body, argumentSchema),
      argument,
      resultCell,
    );
    expect((await tx.commit()).error).toBeUndefined();
    await result.pull();
    await runtime.idle();
    return result.withTx(undefined);
  };

  /** A pattern applying all three builtins to its `flag`. */
  const allThree = ({ flag }: { flag: unknown }) => ({
    ifElse: builder.ifElse(flag, "yes", "no"),
    when: builder.when(flag, "yes"),
    unless: builder.unless(flag, "fallback"),
  });

  /** Which branch each builtin in an {@link allThree} result took. */
  const branchesOf = async (
    result: Cell<Record<string, unknown>>,
  ): Promise<Branches> => {
    await result.pull();
    const ifElse = result.key("ifElse").get();
    return {
      ifElse: ifElse === "yes" ? true : ifElse === "no" ? false : ifElse,
      when: result.key("when").get() === "yes",
      unless: result.key("unless").get() !== "fallback",
    };
  };

  /** What `read` returns, and the confidentiality it consumed doing so. */
  const consumedBy = (
    read: (tx: IExtendedStorageTransaction) => unknown,
  ): { value: unknown; confidentiality: readonly CfcConfClause[] } => {
    const tx = runtime.edit();
    try {
      const value = read(tx);
      return {
        value,
        confidentiality: collectConsumedLabel(tx).confidentiality,
      };
    } finally {
      tx.abort();
    }
  };

  /**
   * Runs `body` as {@link runPattern} does, and returns which of `ifElse`,
   * `when` and `unless` committed a run that read `doc`. A scheduler run names
   * its action on the transaction, and a builtin's action is named
   * `raw:<builtin>:…`.
   */
  const conditionBuiltinsReading = async (
    doc: Cell<unknown>,
    cause: string,
    body: (input: any) => Record<string, unknown>,
    argument: Record<string, unknown> = {},
  ): Promise<string[]> => {
    const { id } = doc.getAsNormalizedFullLink();
    const reading = new Set<string>();
    const edit = runtime.edit;
    runtime.edit = (options) => {
      const tx = edit.call(runtime, options);
      const commit = tx.commit;
      tx.commit = (commitOptions) => {
        const action = tx.tx.sourceAction;
        const [kind, builtin] = typeof action === "function"
          ? action.name.split(":")
          : [];
        if (kind === "raw" && ["ifElse", "when", "unless"].includes(builtin)) {
          const { reads, shallowReads } = txToReactivityLog(tx);
          if ([...reads, ...shallowReads].some((read) => read.id === id)) {
            reading.add(builtin);
          }
        }
        return commit.call(tx, commitOptions);
      };
      return tx;
    };
    try {
      await runPattern(cause, body, argument);
    } finally {
      runtime.edit = edit;
    }
    return [...reading].sort();
  };

  describe("labels", () => {
    /**
     * Pins `piece` in the owner's default profile under `#sheet`, where a
     * typed wish finds it.
     */
    const pin = async (piece: Cell<unknown>) => {
      const tx = runtime.edit();
      const profile = runtime.getCell(profileSpace, "profile", undefined, tx);
      profile.set({
        name: "Ada",
        initialNameApplied: "Ada",
        avatar: "",
        elements: [{
          cell: piece,
          tag: "#sheet",
          userTags: [],
          title: "pinned",
        }],
      });
      expect((await tx.commit()).error).toBeUndefined();
      const homeTx = runtime.edit();
      const homeDefault = runtime.getCell(
        owner.did(),
        "home-default",
        undefined,
        homeTx,
      );
      homeDefault.key("profiles").set([profile]);
      runtime.getHomeSpaceCell(homeTx).key("defaultPattern").set(homeDefault);
      expect((await homeTx.commit()).error).toBeUndefined();
    };

    /**
     * Pins a piece whose view holds a render boundary over a sealed document,
     * and returns that document.
     */
    const pinPieceShowingSealedDoc = async () => {
      const sealed = await sealedDoc("sealed-sheet", {
        secret: "sealed content",
      });
      const tx = runtime.edit();
      const piece = runtime.getCell(profileSpace, "sheet-piece", undefined, tx);
      piece.set({
        title: "Sheet",
        [UI]: vnode("cf-cfc-render-boundary", [vnode("div", [sealed])]),
      });
      expect((await tx.commit()).error).toBeUndefined();
      await pin(piece.withTx(undefined));
      return sealed;
    };

    /** A typed wish for the piece pinned under `#sheet`. */
    const wishForSheet = () =>
      builder.wish({ query: "#sheet", scope: ["profile"] }, pieceSchema);

    describe("a typed wish result as the condition", () => {
      // The found piece's view holds a sealed document, and the wish result's
      // schema describes that view in full. Nothing the builtins decide turns
      // on it.

      it("leaves the sealed clause off an `ifElse` output", async () => {
        await pinPieceShowingSealedDoc();
        const result = await runPattern("if-else-wish", () => ({
          shown: builder.ifElse(wishForSheet().result, "found", "missing"),
        }));

        const shown = consumedBy((tx) => result.withTx(tx).key("shown").get());

        expect(shown.value).toBe("found");
        expect(holdsSealedClause(shown.confidentiality)).toBe(false);
      });

      it("leaves the sealed clause off a `when` output", async () => {
        await pinPieceShowingSealedDoc();
        const result = await runPattern("when-wish", () => ({
          shown: builder.when(wishForSheet().result, "found"),
        }));

        const shown = consumedBy((tx) => result.withTx(tx).key("shown").get());

        expect(shown.value).toBe("found");
        expect(holdsSealedClause(shown.confidentiality)).toBe(false);
      });

      it("leaves the sealed clause off a title read through an `unless` output", async () => {
        // A truthy condition is the output itself, so the read stops at the
        // title rather than taking the found piece's view, which does hold
        // the clause. That output is a link, which carries no flow stamp of
        // its own; the case below is the one that sees what `unless` reads.
        await pinPieceShowingSealedDoc();
        const result = await runPattern("unless-wish", () => ({
          shown: builder.unless(wishForSheet().result, "fallback"),
        }));

        const title = consumedBy((tx) =>
          result.withTx(tx).key("shown").key("title").get()
        );

        expect(title.value).toBe("Sheet");
        expect(holdsSealedClause(title.confidentiality)).toBe(false);
      });

      it("reads nothing of the sealed document in the runs of `ifElse`, `when` and `unless`", async () => {
        const sealed = await pinPieceShowingSealedDoc();

        const reading = await conditionBuiltinsReading(
          sealed,
          "all-three-wish",
          () => allThree({ flag: wishForSheet().result }),
        );

        expect(reading).toEqual([]);
      });
    });

    describe("a condition whose root is sealed", () => {
      // Each builtin's decision depends on the root, so the root's label
      // reaches the output. `ifElse` and `when` take a truthy condition and
      // `unless` a falsy one, so that no output is a link to the condition
      // and the clause on the output is the decision's alone.

      /** The literal each builtin's output holds once it has decided. */
      const decided: Record<Builtin, string> = {
        ifElse: "yes",
        when: "yes",
        unless: "fallback",
      };

      /** A pattern applying `builtin` alone to its `flag`. */
      const only = (builtin: Builtin) => ({ flag }: { flag: unknown }) => ({
        shown: builtin === "ifElse"
          ? builder.ifElse(flag, "yes", "no")
          : builtin === "when"
          ? builder.when(flag, "yes")
          : builder.unless(flag, "fallback"),
      });

      /**
       * The conditions each case runs, given the value the condition holds:
       * truthy for `ifElse` and `when`, falsy for `unless`.
       */
      const shapes: Array<{
        name: string;
        flag: (value: FabricValue) => Promise<Cell<unknown>>;
      }> = [{
        name: "a sealed document",
        flag: (value) => sealedDoc("sealed-root", value),
      }, {
        name: "a link to a sealed document",
        flag: async (value) =>
          plainDoc("pointer", linkTo(await sealedDoc("sealed-target", value))),
      }, {
        name: "a sealed document holding a link",
        flag: async (value) =>
          sealedDoc("sealed-pointer", linkTo(await plainDoc("target", value))),
      }];

      for (const { name, flag } of shapes) {
        for (const builtin of ["ifElse", "when", "unless"] as const) {
          const article = builtin === "when" ? "a" : "an";
          it(`stamps the sealed clause on ${article} \`${builtin}\` output whose condition is ${name}`, async () => {
            const value = builtin === "unless" ? false : { a: 1 };
            const result = await runPattern(
              `${builtin}-sealed`,
              only(builtin),
              { flag: await flag(value) },
            );

            const shown = consumedBy((tx) =>
              result.withTx(tx).key("shown").get()
            );

            expect(shown.value).toBe(decided[builtin]);
            expect(holdsSealedClause(shown.confidentiality)).toBe(true);
          });
        }
      }

      it("reads the sealed document in the runs of `ifElse`, `when` and `unless`", async () => {
        const flag = await sealedDoc("sealed-false", false);

        const reading = await conditionBuiltinsReading(
          flag,
          "all-three-sealed",
          allThree,
          { flag },
        );

        expect(reading).toEqual(["ifElse", "unless", "when"]);
      });
    });
  });

  describe("truthiness", () => {
    // Each case links the condition to a document of its own, and types it
    // one of two ways: through the pattern's argument schema, as a compiled
    // pattern's argument is typed, or through a schema carried on the link the
    // argument holds, as a typed result's link carries one.

    /** How a case types its condition. */
    type TypedBy = "argument" | "link";

    /**
     * Which branch each builtin takes over a document holding `stored`, or
     * never written, typed by `schema` where one is given.
     */
    const branchesFor = async (
      cause: string,
      stored: FabricValue | undefined,
      schema: JSONSchema | undefined,
      typedBy: TypedBy,
    ): Promise<Branches> => {
      const doc = await plainDoc(cause, stored);
      const result = typedBy === "argument"
        ? await runPattern(`${cause}-run`, allThree, { flag: doc }, {
          type: "object",
          properties: { flag: schema ?? {} },
        })
        : await runPattern(`${cause}-run`, allThree, {
          flag: schema === undefined
            ? linkTo(doc)
            : createSigilLinkFromParsedLink(
              { ...doc.getAsNormalizedFullLink(), schema },
              { includeSchema: true },
            ),
        });
      return branchesOf(result);
    };

    describe("defaults, empty containers, falsy values, links and type mismatches", () => {
      // `truthy` is the condition's truthiness as its schema reads it. Typed
      // through the argument, all three builtins read it so. Typed through
      // the link, `ifElse` does and `when` and `unless` read the stored value
      // without the schema, which `linkTyped` records where the two part: a
      // default stands in, or the stored value fails at the root.
      let zero: FabricValue;
      let empty: FabricValue;
      let object: FabricValue;
      let toFalse: FabricValue;
      let unwritten: FabricValue;
      beforeEach(async () => {
        zero = linkTo(await plainDoc("zero", 0));
        empty = linkTo(await plainDoc("empty", ""));
        object = linkTo(await plainDoc("object", { a: 1 }));
        toFalse = linkTo(
          await plainDoc("to-false", linkTo(await plainDoc("false", false))),
        );
        unwritten = linkTo(await plainDoc("unwritten"));
      });

      const union: JSONSchema = {
        anyOf: [{ type: "number" }, { type: "string" }],
      };
      const nullable: JSONSchema = {
        anyOf: [{ type: "object" }, { type: "null" }],
      };
      // What `when` and `unless` take where they read a value the schema
      // carried on its link refuses at the root, or a default it supplies.
      const onlyIfElseReadsTheLinkSchema = (ifElse: boolean): Branches => ({
        ifElse,
        when: !ifElse,
        unless: !ifElse,
      });
      const cases = (): Array<{
        name: string;
        stored: FabricValue | undefined;
        schema?: JSONSchema;
        truthy: boolean;
        linkTyped?: Branches;
      }> => [
        { name: "`[]`", stored: [], schema: { type: "array" }, truthy: true },
        { name: "`{}`", stored: {}, schema: { type: "object" }, truthy: true },
        {
          name: "`true`",
          stored: true,
          schema: { type: "boolean" },
          truthy: true,
        },
        { name: "`0`", stored: 0, schema: { type: "number" }, truthy: false },
        { name: '`""`', stored: "", schema: { type: "string" }, truthy: false },
        {
          name: "`false`",
          stored: false,
          schema: { type: "boolean" },
          truthy: false,
        },
        {
          name: "`null`",
          stored: null,
          schema: { type: "null" },
          truthy: false,
        },
        { name: "untyped `0`", stored: 0, truthy: false },
        { name: 'untyped `"x"`', stored: "x", truthy: true },
        { name: "untyped `[]`", stored: [], truthy: true },
        { name: "untyped `{}`", stored: {}, truthy: true },
        {
          name: "a link to `0`",
          stored: zero,
          schema: { type: "number" },
          truthy: false,
        },
        {
          name: 'a link to `""`',
          stored: empty,
          schema: { type: "string" },
          truthy: false,
        },
        { name: "an untyped link to `0`", stored: zero, truthy: false },
        {
          name: "a link to a link to `false`",
          stored: toFalse,
          schema: { type: "boolean" },
          truthy: false,
        },
        {
          name: "a link to an object",
          stored: object,
          schema: { type: "object" },
          truthy: true,
        },
        {
          name: "a link to a document not written yet",
          stored: unwritten,
          schema: { type: "boolean" },
          truthy: false,
        },
        { name: "`0` under a union", stored: 0, schema: union, truthy: false },
        {
          name: '`"a"` under a union',
          stored: "a",
          schema: union,
          truthy: true,
        },
        {
          name: "an object under a union of scalars",
          stored: { a: 1 },
          schema: union,
          truthy: false,
          linkTyped: onlyIfElseReadsTheLinkSchema(false),
        },
        {
          name: "`null` under `object | null`",
          stored: null,
          schema: nullable,
          truthy: false,
        },
        {
          name: "an object under `object | null`",
          stored: { a: 1 },
          schema: nullable,
          truthy: true,
        },
        {
          name: "a document not written yet",
          stored: undefined,
          schema: { type: "boolean" },
          truthy: false,
        },
        {
          name: "an untyped document not written yet",
          stored: undefined,
          truthy: false,
        },
        {
          name: "an absent value defaulting to `0`",
          stored: undefined,
          schema: { type: "number", default: 0 },
          truthy: false,
        },
        {
          name: 'an absent value defaulting to `""`',
          stored: undefined,
          schema: { type: "string", default: "" },
          truthy: false,
        },
        {
          name: "an absent value defaulting to `null`",
          stored: undefined,
          schema: { type: ["null", "boolean"], default: null },
          truthy: false,
        },
        {
          name: "an absent value defaulting to `true`",
          stored: undefined,
          schema: { type: "boolean", default: true },
          truthy: true,
          linkTyped: onlyIfElseReadsTheLinkSchema(true),
        },
        {
          name: "an absent value defaulting to `{}`",
          stored: undefined,
          schema: { type: "object", default: {} },
          truthy: true,
          linkTyped: onlyIfElseReadsTheLinkSchema(true),
        },
        {
          name: "an absent value defaulting to `[]`",
          stored: undefined,
          schema: { type: "array", default: [] },
          truthy: true,
          linkTyped: onlyIfElseReadsTheLinkSchema(true),
        },
        {
          name: "an absent value under a union defaulting to `true`",
          stored: undefined,
          schema: {
            anyOf: [{ type: "boolean" }, { type: "null" }],
            default: true,
          },
          truthy: true,
          linkTyped: onlyIfElseReadsTheLinkSchema(true),
        },
        {
          name: "`5` under `string`",
          stored: 5,
          schema: { type: "string" },
          truthy: false,
          linkTyped: onlyIfElseReadsTheLinkSchema(false),
        },
        {
          name: "an object under `string`",
          stored: { a: 1 },
          schema: { type: "string" },
          truthy: false,
          linkTyped: onlyIfElseReadsTheLinkSchema(false),
        },
        {
          name: "an array under `object`",
          stored: [1],
          schema: { type: "object" },
          truthy: false,
          linkTyped: onlyIfElseReadsTheLinkSchema(false),
        },
        {
          name: "an object failing below a root default",
          stored: { n: "bad" },
          schema: {
            type: "object",
            default: { n: 7 },
            properties: { n: { type: "number" } },
          },
          truthy: true,
        },
      ];

      for (const typedBy of ["argument", "link"] as const) {
        it(`takes the branch the condition's truthiness picks when typed through the ${typedBy}`, async () => {
          const observed = [];
          for (const [index, { name, stored, schema }] of cases().entries()) {
            const branches = await branchesFor(
              `case-${index}`,
              stored,
              schema,
              typedBy,
            );
            observed.push({ name, ...branches });
          }

          expect(observed).toEqual(
            cases().map(({ name, truthy, linkTyped }) => ({
              name,
              ...(typedBy === "link" && linkTyped || allTake(truthy)),
            })),
          );
          expect(actionErrors).toEqual([]);
        });
      }
    });

    describe("a condition that fails its schema only below its root", () => {
      // The root settles truthiness, and what lies below it is not read, so a
      // record whose root the schema admits reads as truthy whatever it holds.
      // Reading the whole value would find these `undefined`. Typed through
      // the link, `when` and `unless` read the stored value without the
      // schema, as the cases above show, and take the truthy branch either
      // way.
      const failingBelowRoot: Array<{
        name: string;
        stored: FabricValue;
        schema: JSONSchema;
      }> = [{
        name: "a required property failing inside",
        stored: { box: { n: "bad" } },
        schema: {
          type: "object",
          required: ["box"],
          properties: {
            box: {
              type: "object",
              required: ["n"],
              properties: { n: { type: "number" } },
            },
          },
        },
      }, {
        name: "a missing required property",
        stored: {},
        schema: {
          type: "object",
          required: ["a"],
          properties: { a: { type: "number" } },
        },
      }, {
        name: "a non-empty array no item can satisfy",
        stored: [1],
        schema: { type: "array", items: false },
      }];

      for (const typedBy of ["argument", "link"] as const) {
        it(`takes the truthy branch in all three builtins when typed through the ${typedBy}`, async () => {
          const observed = [];
          for (
            const [index, { name, stored, schema }] of failingBelowRoot
              .entries()
          ) {
            const branches = await branchesFor(
              `below-${index}`,
              stored,
              schema,
              typedBy,
            );
            observed.push({ name, ...branches });
          }

          expect(observed).toEqual(
            failingBelowRoot.map(({ name }) => ({ name, ...allTake(true) })),
          );
        });
      }
    });
  });

  describe("reactivity", () => {
    // Each case types the condition through the pattern's argument, so all
    // three builtins read it through the schema.

    /** An argument schema typing `flag` as `schema`. */
    const flagTypedAs = (schema: JSONSchema): JSONSchema => ({
      type: "object",
      properties: { flag: schema },
    });

    /** Writes `value` into `doc`. */
    const write = async (doc: Cell<unknown>, value: FabricValue) => {
      const tx = runtime.edit();
      doc.withTx(tx).set(value);
      expect((await tx.commit()).error).toBeUndefined();
    };

    it("takes the branch the condition's truthiness picks as the condition changes", async () => {
      const flag = await plainDoc("changing", false);
      const result = await runPattern(
        "changing-run",
        allThree,
        { flag },
        flagTypedAs({ type: ["boolean", "object", "number"] }),
      );
      const seen = [await branchesOf(result)];

      await write(flag, { a: 1 });
      seen.push(await branchesOf(result));
      await write(flag, 0);
      seen.push(await branchesOf(result));

      expect(seen).toEqual([allTake(false), allTake(true), allTake(false)]);
    });

    it("takes the branch the new target's truthiness picks when the condition is pointed elsewhere", async () => {
      const zero = await plainDoc("zero", 0);
      const object = await plainDoc("object", { a: 1 });
      const flag = await plainDoc("pointer", linkTo(zero));
      const result = await runPattern(
        "pointer-run",
        allThree,
        { flag },
        flagTypedAs({ type: ["number", "object"] }),
      );
      const seen = [await branchesOf(result)];

      await write(flag, linkTo(object));
      seen.push(await branchesOf(result));
      await write(flag, linkTo(zero));
      seen.push(await branchesOf(result));

      expect(seen).toEqual([allTake(false), allTake(true), allTake(false)]);
    });

    it("takes the truthy branch once a condition that was not written yet arrives", async () => {
      const flag = await plainDoc("pending");
      const result = await runPattern(
        "pending-run",
        allThree,
        { flag },
        flagTypedAs({ type: "boolean" }),
      );
      const seen = [await branchesOf(result)];

      await write(flag, true);
      seen.push(await branchesOf(result));

      expect(seen).toEqual([allTake(false), allTake(true)]);
      expect(actionErrors).toEqual([]);
    });

    it("takes the truthy branch once the document a condition links to arrives", async () => {
      const target = await plainDoc("pending-target");
      const flag = await plainDoc("pending-pointer", linkTo(target));
      const result = await runPattern(
        "pending-pointer-run",
        allThree,
        { flag },
        flagTypedAs({ type: "boolean" }),
      );
      const seen = [await branchesOf(result)];

      await write(target, true);
      seen.push(await branchesOf(result));

      expect(seen).toEqual([allTake(false), allTake(true)]);
      expect(actionErrors).toEqual([]);
    });
  });
});
