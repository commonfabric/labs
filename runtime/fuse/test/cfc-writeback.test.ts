import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { CFC_ENFORCEMENT_MODES } from "@commonfabric/runner/cfc";

import {
  cfcFailClosedLabel,
  type CfcLabel,
  type CfcNodeAnnotation,
  CfcProjectionAnnotator,
  type CfcProjectionRef,
} from "../annotations.ts";
import {
  applyPreparedCreate,
  applyPreparedExistingWrite,
  applyPreparedMetadataMutation,
  applyPreparedParent,
  applyPreparedSymlink,
  authorizeCreateWriteback,
  authorizeExistingWriteback,
  authorizeMetadataWriteback,
  authorizeNamespaceMutationWriteback,
  authorizeSymlinkWriteback,
  CFC_WRITEBACK_FINALIZE_XATTR,
  CFC_WRITEBACK_PREPARE_XATTR,
  type CfcPreparedWriteback,
  type CfcPreparedWritebackLabels,
  type CfcWritebackOperation,
  CfcWritebackStore,
  isCfcEnforcing,
  metadataFieldsForSetattrFlags,
} from "../cfc-writeback.ts";
import {
  FUSE_SET_ATTR_BKUPTIME,
  FUSE_SET_ATTR_CHGTIME,
  FUSE_SET_ATTR_CRTIME,
  FUSE_SET_ATTR_CTIME,
  FUSE_SET_ATTR_MODE,
} from "../platform.ts";
import { FsTree } from "../tree.ts";

const SECRET_LABEL: CfcLabel = {
  confidentiality: [{ type: "test-label", value: "secret" }],
};
const TOP_LABEL: CfcLabel = {
  confidentiality: [{ type: "test-label", value: "top" }],
};

function annotationOf(tree: FsTree, ino: bigint): CfcNodeAnnotation {
  const annotation = tree.getCfcAnnotation(ino);
  if (!annotation) throw new Error(`inode ${ino} carries no annotation`);
  return annotation;
}

/**
 * A tree holding an annotated directory `result` with one annotated file
 * `title`, both at `generation-1`.
 */
function annotatedTree(): {
  tree: FsTree;
  parentIno: bigint;
  fileIno: bigint;
  parent: CfcNodeAnnotation;
  file: CfcNodeAnnotation;
} {
  const tree = new FsTree();
  const annotator = new CfcProjectionAnnotator(tree, {
    space: "did:key:zSpace",
    entity: "of:piece",
    rootKind: "pieces",
    cell: "result",
    generation: "generation-1",
    labelView: {
      version: 1,
      entries: [{ path: ["title"], label: SECRET_LABEL }],
    },
  });
  const parentIno = tree.addDir(tree.rootIno, "result", "object");
  annotator.annotateJsonDirectory(parentIno, [], { title: "old" });
  const fileIno = tree.addFile(parentIno, "title", "old", "string");
  annotator.annotateJsonScalar(fileIno, ["title"], "old");
  annotator.annotateEntry(parentIno, "title", fileIno, {
    labelPath: ["title"],
  });
  return {
    tree,
    parentIno,
    fileIno,
    parent: annotationOf(tree, parentIno),
    file: annotationOf(tree, fileIno),
  };
}

function writeback(
  operation: CfcWritebackOperation,
  target: CfcPreparedWriteback["target"],
  expectedGeneration: string,
  labels: CfcPreparedWritebackLabels = {},
): CfcPreparedWriteback {
  return { version: 1, operation, target, expectedGeneration, labels };
}

/** `prepared` as it would read had its writer stamped a version other than 1. */
function withVersion2(prepared: CfcPreparedWriteback): CfcPreparedWriteback {
  return JSON.parse(JSON.stringify({ ...prepared, version: 2 }));
}

/** `annotation` with a ref generation that no longer matches its own. */
function withStaleRef(annotation: CfcNodeAnnotation): CfcNodeAnnotation {
  return {
    ...annotation,
    ref: { ...annotation.ref, generation: "generation-0" },
  };
}

describe("cfc-writeback", () => {
  describe("isCfcEnforcing()", () => {
    it("returns `true` for the two enforcing modes and `false` for the others", () => {
      expect(
        Object.fromEntries(
          CFC_ENFORCEMENT_MODES.map((mode) => [mode, isCfcEnforcing(mode)]),
        ),
      ).toEqual({
        "disabled": false,
        "observe": false,
        "enforce-explicit": true,
        "enforce-strict": true,
      });
    });
  });

  describe("metadataFieldsForSetattrFlags()", () => {
    it("returns `ctime` for each change-time flag", () => {
      for (
        const flag of [
          FUSE_SET_ATTR_CTIME,
          FUSE_SET_ATTR_CRTIME,
          FUSE_SET_ATTR_CHGTIME,
          FUSE_SET_ATTR_BKUPTIME,
        ]
      ) {
        expect(metadataFieldsForSetattrFlags(flag)).toEqual(["ctime"]);
      }
    });

    it("returns no `ctime` for a flag that changes only the mode", () => {
      expect(metadataFieldsForSetattrFlags(FUSE_SET_ATTR_MODE)).toEqual([
        "mode",
      ]);
    });
  });

  describe("authorizeExistingWriteback()", () => {
    it("returns allowed without a prepare in `disabled` mode", () => {
      const { file } = annotatedTree();
      const diagnostics: string[] = [];

      expect(
        authorizeExistingWriteback({
          mode: "disabled",
          operation: "write",
          annotation: file,
          diagnostics,
        }),
      ).toEqual({ allowed: true, requiresPrepare: false });
      expect(diagnostics).toEqual([]);
    });

    it("returns refused for an annotation whose ref generation is stale, even with a matching prepare", () => {
      const { file } = annotatedTree();
      const prepared = writeback(
        "write",
        { ref: file.ref },
        file.generation,
      );

      expect(
        authorizeExistingWriteback({
          mode: "enforce-strict",
          operation: "write",
          annotation: withStaleRef(file),
          prepared,
        }),
      ).toEqual({
        allowed: false,
        requiresPrepare: true,
        reason: "stale CFC ref generation",
      });
      expect(
        authorizeExistingWriteback({
          mode: "enforce-strict",
          operation: "write",
          annotation: file,
          prepared,
        }),
      ).toEqual({ allowed: true, requiresPrepare: true, prepared });
    });
  });

  describe("authorizeMetadataWriteback()", () => {
    it("returns allowed without a prepare in `disabled` mode", () => {
      const { file } = annotatedTree();
      const diagnostics: string[] = [];

      expect(
        authorizeMetadataWriteback({
          mode: "disabled",
          annotation: file,
          requestedFields: ["mode"],
          diagnostics,
        }),
      ).toEqual({ allowed: true, requiresPrepare: false });
      expect(diagnostics).toEqual([]);
    });

    it("reports a malformed prepare in `observe` mode and returns it only when it is valid", () => {
      const { file } = annotatedTree();
      const valid = writeback(
        "setattr-metadata",
        { ref: file.ref },
        file.generation,
        { metadataLabels: { mode: SECRET_LABEL } },
      );
      const stale = { ...valid, expectedGeneration: "generation-0" };

      const staleDiagnostics: string[] = [];
      expect(
        authorizeMetadataWriteback({
          mode: "observe",
          annotation: file,
          prepared: stale,
          requestedFields: ["mode"],
          diagnostics: staleDiagnostics,
        }),
      ).toEqual({ allowed: true, requiresPrepare: false });
      expect(staleDiagnostics).toEqual([
        "malformed prepared CFC writeback metadata for setattr-metadata",
      ]);

      const validDiagnostics: string[] = [];
      expect(
        authorizeMetadataWriteback({
          mode: "observe",
          annotation: file,
          prepared: valid,
          requestedFields: ["mode"],
          diagnostics: validDiagnostics,
        }),
      ).toEqual({ allowed: true, requiresPrepare: false, prepared: valid });
      expect(validDiagnostics).toEqual([]);
    });

    it("returns refused for a prepare that carries no metadata labels", () => {
      const { file } = annotatedTree();
      const labelled = writeback(
        "setattr-metadata",
        { ref: file.ref },
        file.generation,
        { metadataLabels: { mode: SECRET_LABEL } },
      );

      expect(
        authorizeMetadataWriteback({
          mode: "enforce-strict",
          annotation: file,
          prepared: { ...labelled, labels: {} },
          requestedFields: [],
        }),
      ).toEqual({
        allowed: false,
        requiresPrepare: true,
        reason: "missing or stale prepared CFC metadata writeback",
      });
      expect(
        authorizeMetadataWriteback({
          mode: "enforce-strict",
          annotation: file,
          prepared: labelled,
          requestedFields: [],
        }).allowed,
      ).toBe(true);
    });
  });

  describe("authorizeNamespaceMutationWriteback()", () => {
    it("returns allowed without a prepare in `disabled` mode, even under a stale parent", () => {
      const { parent } = annotatedTree();
      const diagnostics: string[] = [];

      expect(
        authorizeNamespaceMutationWriteback({
          mode: "disabled",
          operation: "unlink",
          parentAnnotation: withStaleRef(parent),
          name: "title",
          diagnostics,
        }),
      ).toEqual({ allowed: true, requiresPrepare: false });
      expect(diagnostics).toEqual([]);
    });

    it("reports a malformed prepare in `observe` mode and returns it only when it is valid", () => {
      const { parent } = annotatedTree();
      const valid = writeback(
        "unlink",
        { parentRef: parent.ref, name: "title" },
        parent.generation,
      );
      const misnamed = writeback(
        "unlink",
        { parentRef: parent.ref, name: "other" },
        parent.generation,
      );

      const misnamedDiagnostics: string[] = [];
      expect(
        authorizeNamespaceMutationWriteback({
          mode: "observe",
          operation: "unlink",
          parentAnnotation: parent,
          prepared: misnamed,
          name: "title",
          diagnostics: misnamedDiagnostics,
        }),
      ).toEqual({ allowed: true, requiresPrepare: false });
      expect(misnamedDiagnostics).toEqual([
        "malformed prepared CFC writeback metadata for unlink:title",
      ]);

      const validDiagnostics: string[] = [];
      expect(
        authorizeNamespaceMutationWriteback({
          mode: "observe",
          operation: "unlink",
          parentAnnotation: parent,
          prepared: valid,
          name: "title",
          diagnostics: validDiagnostics,
        }),
      ).toEqual({ allowed: true, requiresPrepare: false, prepared: valid });
      expect(validDiagnostics).toEqual([]);
    });

    it("returns refused for an unannotated parent in `enforce-strict` mode and allowed in `enforce-explicit` mode", () => {
      expect(
        authorizeNamespaceMutationWriteback({
          mode: "enforce-strict",
          operation: "rmdir",
          name: "dir",
        }),
      ).toEqual({
        allowed: false,
        requiresPrepare: true,
        reason: "missing coherent parent CFC annotation",
      });
      expect(
        authorizeNamespaceMutationWriteback({
          mode: "enforce-explicit",
          operation: "rmdir",
          name: "dir",
        }),
      ).toEqual({ allowed: true, requiresPrepare: false });
    });

    it("returns refused for a parent whose ref generation is stale, even with a matching prepare", () => {
      const { parent } = annotatedTree();
      const prepared = writeback(
        "unlink",
        { parentRef: parent.ref, name: "title" },
        parent.generation,
      );

      for (const mode of ["enforce-explicit", "enforce-strict"] as const) {
        expect(
          authorizeNamespaceMutationWriteback({
            mode,
            operation: "unlink",
            parentAnnotation: withStaleRef(parent),
            prepared,
            name: "title",
          }),
        ).toEqual({
          allowed: false,
          requiresPrepare: true,
          reason: "stale parent CFC ref generation",
        });
        expect(
          authorizeNamespaceMutationWriteback({
            mode,
            operation: "unlink",
            parentAnnotation: parent,
            prepared,
            name: "title",
          }),
        ).toEqual({ allowed: true, requiresPrepare: true, prepared });
      }
    });

    it("returns refused for a prepare whose version is not 1", () => {
      const { parent } = annotatedTree();
      const prepared = writeback(
        "unlink",
        { parentRef: parent.ref, name: "title" },
        parent.generation,
      );

      expect(
        authorizeNamespaceMutationWriteback({
          mode: "enforce-strict",
          operation: "unlink",
          parentAnnotation: parent,
          prepared: withVersion2(prepared),
          name: "title",
        }).allowed,
      ).toBe(false);
    });

    it("returns refused for a prepare naming another directory at the parent's generation", () => {
      const { parent } = annotatedTree();
      const elsewhere: CfcProjectionRef = { ...parent.ref, path: ["other"] };

      expect(
        authorizeNamespaceMutationWriteback({
          mode: "enforce-strict",
          operation: "unlink",
          parentAnnotation: parent,
          prepared: writeback(
            "unlink",
            { parentRef: elsewhere, name: "title" },
            parent.generation,
          ),
          name: "title",
        }).allowed,
      ).toBe(false);
    });

    it("returns allowed for a matching prepare when no paired name needs checking", () => {
      const { parent } = annotatedTree();

      // A paired name means nothing to an unlink, and a rename that states
      // none has only its own name to match.
      expect(
        authorizeNamespaceMutationWriteback({
          mode: "enforce-strict",
          operation: "unlink",
          parentAnnotation: parent,
          prepared: writeback(
            "unlink",
            { parentRef: parent.ref, name: "title" },
            parent.generation,
          ),
          name: "title",
          pairedName: "ignored",
        }).allowed,
      ).toBe(true);
      expect(
        authorizeNamespaceMutationWriteback({
          mode: "enforce-strict",
          operation: "rename-source",
          parentAnnotation: parent,
          prepared: writeback(
            "rename-source",
            { parentRef: parent.ref, sourceName: "title" },
            parent.generation,
          ),
          name: "title",
        }).allowed,
      ).toBe(true);
    });

    it("returns allowed for a rename source covered by the destination's prepare only when it states the source name", () => {
      const { parent } = annotatedTree();
      const destinationPrepare = writeback(
        "rename-destination",
        {
          destinationParentRef: parent.ref,
          sourceName: "title",
          destinationName: "renamed",
        },
        parent.generation,
      );
      const request = {
        mode: "enforce-strict",
        operation: "rename-source",
        parentAnnotation: parent,
        name: "title",
        pairedName: "renamed",
      } as const;

      expect(
        authorizeNamespaceMutationWriteback({
          ...request,
          prepared: destinationPrepare,
          allowPairedRenamePrepare: true,
        }).allowed,
      ).toBe(true);
      expect(
        authorizeNamespaceMutationWriteback({
          ...request,
          prepared: destinationPrepare,
        }).allowed,
      ).toBe(false);
      expect(
        authorizeNamespaceMutationWriteback({
          ...request,
          prepared: writeback(
            "rename-destination",
            {
              destinationParentRef: parent.ref,
              name: "title",
              destinationName: "renamed",
            },
            parent.generation,
          ),
          allowPairedRenamePrepare: true,
        }).allowed,
      ).toBe(false);
    });
  });

  describe("authorizeSymlinkWriteback()", () => {
    it("returns allowed without a prepare in `disabled` mode, even under a stale parent", () => {
      const { parent } = annotatedTree();
      const diagnostics: string[] = [];

      expect(
        authorizeSymlinkWriteback({
          mode: "disabled",
          parentAnnotation: withStaleRef(parent),
          name: "link",
          targetText: "../target",
          diagnostics,
        }),
      ).toEqual({ allowed: true, requiresPrepare: false });
      expect(diagnostics).toEqual([]);
    });

    it("reports a malformed prepare in `observe` mode and returns it only when it is valid", () => {
      const { parent } = annotatedTree();
      const valid = writeback(
        "symlink",
        { parentRef: parent.ref, name: "link", targetText: "../target" },
        parent.generation,
      );
      const retargeted = writeback(
        "symlink",
        { parentRef: parent.ref, name: "link", targetText: "../elsewhere" },
        parent.generation,
      );
      const request = {
        mode: "observe",
        parentAnnotation: parent,
        name: "link",
        targetText: "../target",
      } as const;

      const retargetedDiagnostics: string[] = [];
      expect(
        authorizeSymlinkWriteback({
          ...request,
          prepared: retargeted,
          diagnostics: retargetedDiagnostics,
        }),
      ).toEqual({ allowed: true, requiresPrepare: false });
      expect(retargetedDiagnostics).toEqual([
        "malformed prepared CFC writeback metadata for symlink:link",
      ]);

      const validDiagnostics: string[] = [];
      expect(
        authorizeSymlinkWriteback({
          ...request,
          prepared: valid,
          diagnostics: validDiagnostics,
        }),
      ).toEqual({ allowed: true, requiresPrepare: false, prepared: valid });
      expect(validDiagnostics).toEqual([]);
    });

    it("returns refused for an unannotated parent in `enforce-strict` mode and allowed in `enforce-explicit` mode", () => {
      const request = { name: "link", targetText: "../target" };

      expect(
        authorizeSymlinkWriteback({ ...request, mode: "enforce-strict" }),
      ).toEqual({
        allowed: false,
        requiresPrepare: true,
        reason: "missing coherent parent CFC annotation",
      });
      expect(
        authorizeSymlinkWriteback({ ...request, mode: "enforce-explicit" }),
      ).toEqual({ allowed: true, requiresPrepare: false });
    });

    it("returns refused for a parent whose ref generation is stale, even with a matching prepare", () => {
      const { parent } = annotatedTree();
      const prepared = writeback(
        "symlink",
        { parentRef: parent.ref, name: "link", targetText: "../target" },
        parent.generation,
      );
      const request = {
        mode: "enforce-strict",
        prepared,
        name: "link",
        targetText: "../target",
      } as const;

      expect(
        authorizeSymlinkWriteback({
          ...request,
          parentAnnotation: withStaleRef(parent),
        }),
      ).toEqual({
        allowed: false,
        requiresPrepare: true,
        reason: "stale parent CFC ref generation",
      });
      expect(
        authorizeSymlinkWriteback({ ...request, parentAnnotation: parent }),
      ).toEqual({ allowed: true, requiresPrepare: true, prepared });
    });

    it("returns refused for a prepare whose version is not 1", () => {
      const { parent } = annotatedTree();

      expect(
        authorizeSymlinkWriteback({
          mode: "enforce-strict",
          parentAnnotation: parent,
          prepared: withVersion2(
            writeback(
              "symlink",
              { parentRef: parent.ref, name: "link", targetText: "../target" },
              parent.generation,
            ),
          ),
          name: "link",
          targetText: "../target",
        }).allowed,
      ).toBe(false);
    });

    describe("a prepare binding the target identity instead of the text", () => {
      // Each case asks for the same link; what varies is which identity the
      // request states and whether it may defer stating one.

      const targetIdentity = { space: "did:key:zSpace", path: ["target"] };

      function authorize(
        parent: CfcNodeAnnotation,
        preparedTarget: CfcPreparedWriteback["target"],
        request: { targetIdentity?: unknown; allowDeferred?: boolean },
      ): boolean {
        return authorizeSymlinkWriteback({
          mode: "enforce-strict",
          parentAnnotation: parent,
          prepared: writeback(
            "symlink",
            { parentRef: parent.ref, name: "link", ...preparedTarget },
            parent.generation,
          ),
          name: "link",
          targetText: "../target",
          targetIdentity: request.targetIdentity,
          allowDeferredTargetIdentity: request.allowDeferred,
        }).allowed;
      }

      it("returns refused when the prepare binds neither text nor identity", () => {
        const { parent } = annotatedTree();

        expect(
          authorize(parent, {}, { allowDeferred: true }),
        ).toBe(false);
      });

      it("returns allowed for a request stating no identity only when it may defer one", () => {
        const { parent } = annotatedTree();

        expect(authorize(parent, { targetIdentity }, { allowDeferred: true }))
          .toBe(true);
        expect(authorize(parent, { targetIdentity }, {})).toBe(false);
      });

      it("returns allowed only for a request stating the same identity", () => {
        const { parent } = annotatedTree();

        expect(
          authorize(parent, { targetIdentity }, {
            targetIdentity: { path: ["target"], space: "did:key:zSpace" },
          }),
        ).toBe(true);
        expect(
          authorize(parent, { targetIdentity }, {
            targetIdentity: { ...targetIdentity, path: ["other"] },
          }),
        ).toBe(false);
      });
    });
  });

  describe("authorizeCreateWriteback()", () => {
    it("returns allowed without a prepare in `disabled` mode, even under a stale parent", () => {
      const { parent } = annotatedTree();
      const diagnostics: string[] = [];

      expect(
        authorizeCreateWriteback({
          mode: "disabled",
          operation: "create",
          parentAnnotation: withStaleRef(parent),
          name: "fresh",
          diagnostics,
        }),
      ).toEqual({ allowed: true, requiresPrepare: false });
      expect(diagnostics).toEqual([]);
    });

    it("reports a missing prepare in `observe` mode and returns a prepare only when it is valid", () => {
      const { parent } = annotatedTree();
      const valid = writeback(
        "create",
        { parentRef: parent.ref, name: "fresh" },
        parent.generation,
      );
      const request = {
        mode: "observe",
        operation: "create",
        parentAnnotation: parent,
        name: "fresh",
      } as const;

      const missingDiagnostics: string[] = [];
      expect(
        authorizeCreateWriteback({
          ...request,
          diagnostics: missingDiagnostics,
        }),
      ).toEqual({ allowed: true, requiresPrepare: false });
      expect(missingDiagnostics).toEqual([
        "missing prepared CFC writeback metadata for create:fresh",
      ]);

      const validDiagnostics: string[] = [];
      expect(
        authorizeCreateWriteback({
          ...request,
          prepared: valid,
          diagnostics: validDiagnostics,
        }),
      ).toEqual({ allowed: true, requiresPrepare: false, prepared: valid });
      expect(validDiagnostics).toEqual([]);

      expect(
        authorizeCreateWriteback({
          ...request,
          prepared: { ...valid, operation: "mkdir" },
        }),
      ).toEqual({ allowed: true, requiresPrepare: false });
    });

    it("returns refused for an unannotated parent in `enforce-strict` mode", () => {
      expect(
        authorizeCreateWriteback({
          mode: "enforce-strict",
          operation: "mkdir",
          name: "dir",
        }),
      ).toEqual({
        allowed: false,
        requiresPrepare: true,
        reason: "missing coherent parent CFC annotation",
      });
    });

    it("returns refused for a parent whose ref generation is stale, even with a matching prepare", () => {
      const { parent } = annotatedTree();
      const prepared = writeback(
        "mkdir",
        { parentRef: parent.ref, name: "dir" },
        parent.generation,
      );
      const request = {
        mode: "enforce-strict",
        operation: "mkdir",
        prepared,
        name: "dir",
      } as const;

      expect(
        authorizeCreateWriteback({
          ...request,
          parentAnnotation: withStaleRef(parent),
        }),
      ).toEqual({
        allowed: false,
        requiresPrepare: true,
        reason: "stale parent CFC ref generation",
      });
      expect(
        authorizeCreateWriteback({ ...request, parentAnnotation: parent }),
      ).toEqual({ allowed: true, requiresPrepare: true, prepared });
    });

    it("returns allowed without a prepare in `enforce-explicit` mode under a parent with no namespace annotation", () => {
      const { parent } = annotatedTree();
      const request = {
        mode: "enforce-explicit",
        operation: "create",
        name: "fresh",
      } as const;

      expect(
        authorizeCreateWriteback({
          ...request,
          parentAnnotation: {
            ...parent,
            namespaceLabel: undefined,
            entries: undefined,
          },
        }),
      ).toEqual({ allowed: true, requiresPrepare: false });
      expect(
        authorizeCreateWriteback({ ...request, parentAnnotation: parent })
          .allowed,
      ).toBe(false);
    });
  });

  describe("CfcWritebackStore", () => {
    let directory: string;
    let storagePath: string;

    beforeEach(() => {
      directory = Deno.makeTempDirSync();
      storagePath = `${directory}/writeback.json`;
    });

    afterEach(() => {
      Deno.removeSync(directory, { recursive: true });
    });

    function prepareText(prepared: CfcPreparedWriteback): string {
      return JSON.stringify(prepared);
    }

    function writePrepare(): CfcPreparedWriteback {
      return writeback(
        "write",
        { ref: annotatedTree().file.ref },
        "generation-1",
        { contentLabel: SECRET_LABEL },
      );
    }

    describe("constructor()", () => {
      it("starts empty when the file is missing or empty", () => {
        expect(new CfcWritebackStore({ storagePath }).snapshot().records)
          .toEqual([]);
        Deno.writeTextFileSync(storagePath, "  \n");
        expect(new CfcWritebackStore({ storagePath }).snapshot().records)
          .toEqual([]);
      });

      it("throws for a file that is not a version 1 store, and leaves the file as it was", () => {
        for (
          const [text, reason] of [
            ["{", "it is not JSON"],
            ["[]", "it is not a version 1 store"],
            [
              JSON.stringify({ version: 2, records: [] }),
              "it is not a version 1 store",
            ],
            [
              JSON.stringify({ version: 1, records: {} }),
              "it is not a version 1 store",
            ],
          ]
        ) {
          Deno.writeTextFileSync(storagePath, text);

          expect(() => new CfcWritebackStore({ storagePath })).toThrow(
            new Error(
              `Cannot read the CFC writeback recovery store ${storagePath}: ` +
                `${reason}. Move it aside to start without its records.`,
            ),
          );
          expect(Deno.readTextFileSync(storagePath)).toBe(text);
        }
      });

      it("throws for a file it cannot read at all", () => {
        Deno.mkdirSync(storagePath);

        expect(() => new CfcWritebackStore({ storagePath })).toThrow(
          Deno.errors.IsADirectory,
        );
      });

      it("loads the records of a store", () => {
        const prepared = writePrepare();
        const valid = {
          version: 1,
          key: "5:write:",
          status: "mutation-applied",
          diagnostics: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          prepared,
        };
        const unprepared = { ...valid, key: "6:write:", prepared: undefined };
        Deno.writeTextFileSync(
          storagePath,
          JSON.stringify({ version: 1, records: [valid, unprepared] }),
        );

        const store = new CfcWritebackStore({ storagePath });

        expect(store.snapshot().records.map((record) => record.key)).toEqual(
          ["5:write:", "6:write:"],
        );
        expect(store.getPrepared(5n, "write")).toEqual(prepared);
        expect(store.getPrepared(6n, "write")).toBeUndefined();
      });

      it("keeps a record it does not recognize, unread, and writes it back unchanged", () => {
        // A newer mount may write records this one cannot read, and the
        // store must hand them back rather than lose them.

        const valid = {
          version: 1,
          key: "5:write:",
          status: "mutation-applied",
          diagnostics: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          prepared: writePrepare(),
        };
        const unrecognized = [
          "not a record",
          { ...valid, key: "7:write:", version: 2 },
          { ...valid, key: 8 },
          { ...valid, key: "9:write:", status: "unknown" },
          { ...valid, key: "10:write:", diagnostics: "none" },
          { ...valid, key: "11:write:", createdAt: 0 },
          { ...valid, key: "12:write:", updatedAt: 0 },
          { ...valid, key: "13:write:", prepared: { version: 1 } },
        ];
        Deno.writeTextFileSync(
          storagePath,
          JSON.stringify({ version: 1, records: [valid, ...unrecognized] }),
        );

        const store = new CfcWritebackStore({ storagePath });
        expect(store.snapshot().records.map((record) => record.key)).toEqual(
          ["5:write:"],
        );
        store.deleteAllForIno(5n);

        expect(JSON.parse(Deno.readTextFileSync(storagePath)).records)
          .toEqual(unrecognized);
      });
    });

    describe("instance members", () => {
      describe("setPreparedXattr()", () => {
        it("persists a prepare by replacing the store file whole, leaving nothing beside it", () => {
          // A link to the file as it was keeps its old content only when the
          // store is replaced by a rename rather than rewritten in place.

          Deno.writeTextFileSync(
            storagePath,
            JSON.stringify({ version: 1, records: [] }),
          );
          const store = new CfcWritebackStore({ storagePath });
          Deno.linkSync(storagePath, `${directory}/before.json`);

          store.setPreparedXattr(
            5n,
            CFC_WRITEBACK_PREPARE_XATTR,
            prepareText(writePrepare()),
          );

          expect(
            [...Deno.readDirSync(directory)].map((entry) => entry.name).sort(),
          ).toEqual(["before.json", "writeback.json"]);
          expect(Deno.readTextFileSync(`${directory}/before.json`)).toBe(
            JSON.stringify({ version: 1, records: [] }),
          );
          expect(
            new CfcWritebackStore({ storagePath }).getPrepared(5n, "write"),
          ).toEqual(writePrepare());
        });

        it("leaves the store readable and writable by its owner alone", () => {
          const store = new CfcWritebackStore({ storagePath });

          store.setPreparedXattr(
            5n,
            CFC_WRITEBACK_PREPARE_XATTR,
            prepareText(writePrepare()),
          );

          expect(Deno.statSync(storagePath).mode! & 0o777).toBe(0o600);
        });

        it("throws when the store cannot be replaced, leaving no scratch file", () => {
          const store = new CfcWritebackStore({ storagePath });
          // A directory in the store's place, which a file cannot be renamed
          // over.
          Deno.mkdirSync(`${storagePath}/occupied`, { recursive: true });

          expect(() =>
            store.setPreparedXattr(
              5n,
              CFC_WRITEBACK_PREPARE_XATTR,
              prepareText(writePrepare()),
            )
          ).toThrow(Deno.errors.IsADirectory);

          expect([...Deno.readDirSync(directory)].map((entry) => entry.name))
            .toEqual(["writeback.json"]);
          expect(Deno.statSync(storagePath).isDirectory).toBe(true);
        });

        it("throws when the scratch file cannot be written", () => {
          const store = new CfcWritebackStore({ storagePath });
          Deno.chmodSync(directory, 0o500);
          try {
            expect(() =>
              store.setPreparedXattr(
                5n,
                CFC_WRITEBACK_PREPARE_XATTR,
                prepareText(writePrepare()),
              )
            ).toThrow(Deno.errors.PermissionDenied);
          } finally {
            Deno.chmodSync(directory, 0o700);
          }

          expect([...Deno.readDirSync(directory)]).toEqual([]);
        });

        it("returns a failure and stores nothing for prepare metadata of the wrong shape", () => {
          const store = new CfcWritebackStore();
          const prepared = writePrepare();

          for (
            const value of [
              [],
              { ...prepared, version: 2 },
              { ...prepared, expectedGeneration: 1 },
              { ...prepared, target: "title" },
              { ...prepared, labels: [] },
            ]
          ) {
            expect(
              store.setPreparedXattr(
                5n,
                CFC_WRITEBACK_PREPARE_XATTR,
                JSON.stringify(value),
              ),
            ).toEqual({ ok: false, reason: "invalid prepare metadata" });
          }
          expect(store.getPrepared(5n, "write")).toBeUndefined();
          expect(store.snapshot().counts["malformed-prepare"]).toBe(5);
        });
      });

      describe("setFinalizeXattr()", () => {
        it("returns a failure and keeps the prepare for a name other than the finalize xattr", () => {
          const store = new CfcWritebackStore();
          store.setPreparedXattr(
            5n,
            CFC_WRITEBACK_PREPARE_XATTR,
            prepareText(writePrepare()),
          );

          expect(
            store.setFinalizeXattr(
              5n,
              CFC_WRITEBACK_PREPARE_XATTR,
              JSON.stringify({
                version: 1,
                operation: "write",
                committedGeneration: "generation-2",
              }),
            ),
          ).toEqual({ ok: false, reason: "unsupported writeback xattr" });
          expect(store.getPrepared(5n, "write")).toEqual(writePrepare());
        });

        it("returns a failure and keeps the prepare for finalize metadata of the wrong shape", () => {
          const store = new CfcWritebackStore();
          store.setPreparedXattr(
            5n,
            CFC_WRITEBACK_PREPARE_XATTR,
            prepareText(writePrepare()),
          );
          const finalized = {
            version: 1,
            operation: "write",
            committedGeneration: "generation-2",
          };

          for (
            const value of [
              "{",
              "[]",
              JSON.stringify({ ...finalized, version: 2 }),
              JSON.stringify({ ...finalized, operation: "rename" }),
              JSON.stringify({ ...finalized, committedGeneration: 2 }),
            ]
          ) {
            expect(
              store.setFinalizeXattr(5n, CFC_WRITEBACK_FINALIZE_XATTR, value),
            ).toEqual({ ok: false, reason: "invalid finalize metadata" });
          }
          expect(store.getPrepared(5n, "write")).toEqual(writePrepare());
        });

        it("returns success, removing the operation's unprepared record and keeping other operations' prepares, when nothing is prepared for the finalized operation", () => {
          // A store loaded from disk can hold a record that carries no
          // prepare; finalizing its operation removes it.

          Deno.writeTextFileSync(
            storagePath,
            JSON.stringify({
              version: 1,
              records: [{
                version: 1,
                key: "5:truncate:",
                status: "mutation-applied",
                diagnostics: [],
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              }],
            }),
          );
          const store = new CfcWritebackStore({ storagePath });
          store.setPreparedXattr(
            5n,
            CFC_WRITEBACK_PREPARE_XATTR,
            prepareText(writePrepare()),
          );
          const finalized = {
            version: 1,
            operation: "truncate",
            committedGeneration: "generation-2",
          };

          expect(
            store.setFinalizeXattr(
              5n,
              CFC_WRITEBACK_FINALIZE_XATTR,
              JSON.stringify(finalized),
            ),
          ).toEqual({ ok: true, finalized });
          expect(store.getPrepared(5n, "write")).toEqual(writePrepare());
          expect(store.snapshot().records.map((record) => record.key))
            .toEqual(["5:write:"]);
        });
      });

      describe("deleteAllForIno()", () => {
        it("removes and persists the removal of every record for the inode, and no other", () => {
          const store = new CfcWritebackStore({ storagePath });
          const parentRef = annotatedTree().parent.ref;
          store.setPreparedXattr(
            7n,
            CFC_WRITEBACK_PREPARE_XATTR,
            prepareText(writePrepare()),
          );
          store.setPreparedXattr(
            7n,
            CFC_WRITEBACK_PREPARE_XATTR,
            prepareText(
              writeback(
                "create",
                { parentRef, name: "fresh" },
                "generation-1",
              ),
            ),
          );
          store.setPreparedXattr(
            77n,
            CFC_WRITEBACK_PREPARE_XATTR,
            prepareText(writePrepare()),
          );

          store.deleteAllForIno(7n);

          expect(store.getPrepared(7n, "write")).toBeUndefined();
          expect(store.getPrepared(7n, "create", "fresh")).toBeUndefined();
          expect(store.getPrepared(77n, "write")).toEqual(writePrepare());
          expect(
            new CfcWritebackStore({ storagePath }).snapshot().records.map((
              record,
            ) => record.key),
          ).toEqual(["77:write:"]);
        });
      });

      describe("markMutationApplied()", () => {
        it("records the requested metadata fields in sorted order", () => {
          const store = new CfcWritebackStore();
          store.setPreparedXattr(
            5n,
            CFC_WRITEBACK_PREPARE_XATTR,
            prepareText(
              writeback(
                "setattr-metadata",
                { ref: annotatedTree().file.ref, metadataFields: ["gid"] },
                "generation-1",
              ),
            ),
          );

          store.markMutationApplied(5n, "setattr-metadata", undefined, {
            requestedFields: ["uid", "mode"],
          });

          const [record] = store.snapshot().records;
          expect(record.status).toBe("mutation-applied");
          expect(record.requestedFields).toEqual(["mode", "uid"]);
        });
      });

      it("leaves the records unchanged when a state change names no record", () => {
        const store = new CfcWritebackStore();
        store.setPreparedXattr(
          5n,
          CFC_WRITEBACK_PREPARE_XATTR,
          prepareText(writePrepare()),
        );
        const before = store.snapshot();

        store.markMutationApplied(5n, "truncate");
        store.markRunnerCommitFailed(6n, "write", "transport closed");
        store.markReadyForExactRecomputation(5n, "write", "named");
        store.markFinalizedPendingCleanup(6n, "write");

        expect(store.snapshot()).toEqual(before);
      });

      describe("reconcileTree()", () => {
        it("skips records without a prepare and reports prepares with no projection node", () => {
          const { tree, fileIno, file } = annotatedTree();
          const store = new CfcWritebackStore();
          store.setPreparedXattr(5n, CFC_WRITEBACK_PREPARE_XATTR, "{");
          store.setPreparedXattr(
            99n,
            CFC_WRITEBACK_PREPARE_XATTR,
            prepareText(
              writeback(
                "write",
                { ref: { ...file.ref, path: ["missing"] } },
                "generation-1",
              ),
            ),
          );

          expect(store.reconcileTree(tree)).toEqual({
            inspected: 1,
            rebound: 0,
            reapplied: 0,
            finalized: 0,
            stale: 0,
            diagnostics: [
              "prepared CFC writeback 99:write: has no current projection node",
            ],
          });
          expect(store.snapshot().records.map((record) => record.status))
            .toEqual(["malformed-prepare", "pending-prepare"]);
          expect(annotationOf(tree, fileIno).generation).toBe(file.generation);
        });

        describe("a metadata prepare", () => {
          // The prepare labels both `mode` and `uid`; which of the two the
          // recovered annotation keeps depends on which fields are requested.

          function reconcileMetadata(
            metadataFields: ("mode" | "uid")[] | undefined,
            applied?: ("mode" | "uid")[],
          ): CfcNodeAnnotation {
            const { tree, fileIno, file } = annotatedTree();
            const store = new CfcWritebackStore();
            store.setPreparedXattr(
              fileIno,
              CFC_WRITEBACK_PREPARE_XATTR,
              prepareText(
                writeback(
                  "setattr-metadata",
                  { ref: file.ref, metadataFields },
                  file.generation,
                  { metadataLabels: { mode: TOP_LABEL, uid: TOP_LABEL } },
                ),
              ),
            );
            if (applied) {
              store.markMutationApplied(
                fileIno,
                "setattr-metadata",
                undefined,
                { requestedFields: applied },
              );
            }
            expect(store.reconcileTree(tree).reapplied).toBe(1);
            const recovered = annotationOf(tree, fileIno);
            expect(recovered.contentLabel).toEqual(file.contentLabel);
            expect(recovered.generation).toMatch(/^prepared:sha256:/);
            return recovered;
          }

          it("reapplies the labels of the fields the prepare names", () => {
            const { metadataLabels } = reconcileMetadata(["uid"]);

            expect(metadataLabels.uid).toEqual(TOP_LABEL);
            expect(metadataLabels.mode).toEqual(cfcFailClosedLabel());
          });

          it("reapplies the labels of the fields the applied mutation requested over those the prepare names", () => {
            const { metadataLabels } = reconcileMetadata(["uid"], ["mode"]);

            expect(metadataLabels.mode).toEqual(TOP_LABEL);
            expect(metadataLabels.uid).toEqual(cfcFailClosedLabel());
          });

          it("reapplies the labels of every field when the prepare names none", () => {
            const { metadataLabels } = reconcileMetadata(undefined);

            expect(metadataLabels.mode).toEqual(TOP_LABEL);
            expect(metadataLabels.uid).toEqual(TOP_LABEL);
          });
        });

        it("reapplies a namespace prepare to the parent directory and the named entry", () => {
          const { tree, parentIno, parent } = annotatedTree();
          const store = new CfcWritebackStore();
          store.setPreparedXattr(
            parentIno,
            CFC_WRITEBACK_PREPARE_XATTR,
            prepareText(
              writeback(
                "unlink",
                { parentRef: parent.ref, name: "title" },
                parent.generation,
                { namespaceLabel: TOP_LABEL, nameLabel: TOP_LABEL },
              ),
            ),
          );

          expect(store.reconcileTree(tree).reapplied).toBe(1);

          const recovered = annotationOf(tree, parentIno);
          expect(recovered.generation).toMatch(/^prepared:sha256:/);
          expect(recovered.namespaceLabel).toEqual(TOP_LABEL);
          expect(
            recovered.entries?.entries.find((entry) => entry.name === "title")
              ?.nameLabel,
          ).toEqual(TOP_LABEL);
        });
      });

      describe("status()", () => {
        it("returns the storage path, the counts, and a summary of each record", () => {
          const store = new CfcWritebackStore({ storagePath });
          store.setPreparedXattr(
            5n,
            CFC_WRITEBACK_PREPARE_XATTR,
            prepareText(writePrepare()),
          );
          store.markRunnerCommitFailed(5n, "write", "transport closed");
          const [record] = store.snapshot().records;

          expect(store.status()).toEqual({
            storagePath,
            counts: {
              "pending-prepare": 0,
              "mutation-applied": 0,
              "runner-commit-failed": 1,
              "stale-generation": 0,
              "malformed-prepare": 0,
              "ready-for-exact-recomputation": 0,
              "finalized-pending-cleanup": 0,
            },
            records: [{
              status: "runner-commit-failed",
              operation: "write",
              name: undefined,
              ino: "5",
              expectedGeneration: "generation-1",
              diagnostics: ["transport closed"],
              updatedAt: record.updatedAt,
            }],
          });
        });
      });
    });
  });

  describe("applyPreparedExistingWrite()", () => {
    it("leaves an unannotated node unannotated", () => {
      const tree = new FsTree();
      const ino = tree.addFile(tree.rootIno, "plain", "", "string");

      applyPreparedExistingWrite(
        tree,
        ino,
        writeback("write", {}, "generation-1", { contentLabel: TOP_LABEL }),
      );

      expect(tree.getCfcAnnotation(ino)).toBeUndefined();
    });
  });

  describe("applyPreparedMetadataMutation()", () => {
    it("leaves an unannotated node unannotated", () => {
      const tree = new FsTree();
      const ino = tree.addFile(tree.rootIno, "plain", "", "string");

      applyPreparedMetadataMutation(
        tree,
        ino,
        writeback("setattr-metadata", {}, "generation-1", {
          metadataLabels: { mode: TOP_LABEL },
        }),
        ["mode"],
      );

      expect(tree.getCfcAnnotation(ino)).toBeUndefined();
    });
  });

  describe("applyPreparedParent()", () => {
    function annotateChild(
      tree: FsTree,
      ino: bigint,
      file: CfcNodeAnnotation,
      name: string,
    ): void {
      tree.setCfcAnnotation(ino, {
        ...file,
        ref: { ...file.ref, path: [name] },
      });
    }

    function entryNamed(
      tree: FsTree,
      parentIno: bigint,
      name: string,
    ) {
      return annotationOf(tree, parentIno).entries?.entries.find((entry) =>
        entry.name === name
      );
    }

    it("leaves an unannotated directory unannotated", () => {
      const tree = new FsTree();
      const ino = tree.addDir(tree.rootIno, "plain", "object");

      applyPreparedParent(
        tree,
        ino,
        writeback("unlink", { name: "child" }, "generation-1", {
          namespaceLabel: TOP_LABEL,
        }),
      );

      expect(tree.getCfcAnnotation(ino)).toBeUndefined();
    });

    it("labels the named entry with the kind of the child it names", () => {
      const { tree, parentIno, parent, file } = annotatedTree();
      const children = {
        dir: tree.addDir(parentIno, "sub", "object"),
        symlink: tree.addSymlink(parentIno, "link", "../title"),
        callable: tree.addCallable(
          parentIno,
          "tool",
          "tool",
          "cell",
          "result",
          new Uint8Array(),
        ),
        file: tree.addFile(parentIno, "plain", "", "string"),
      };
      const names = {
        dir: "sub",
        symlink: "link",
        callable: "tool",
        file: "plain",
      };

      for (const kind of ["dir", "symlink", "callable", "file"] as const) {
        const name = names[kind];
        annotateChild(tree, children[kind], file, name);

        applyPreparedParent(
          tree,
          parentIno,
          writeback(
            "unlink",
            { parentRef: parent.ref, name },
            parent.generation,
            { nameLabel: TOP_LABEL, existenceLabel: TOP_LABEL },
          ),
        );

        expect(entryNamed(tree, parentIno, name)).toMatchObject({
          name,
          kind,
          nameLabel: TOP_LABEL,
          existenceLabel: TOP_LABEL,
        });
      }
    });

    it("labels the entry fail-closed where the prepare states no entry label", () => {
      const { tree, parentIno, parent } = annotatedTree();

      applyPreparedParent(
        tree,
        parentIno,
        writeback(
          "unlink",
          { parentRef: parent.ref, name: "title" },
          parent.generation,
        ),
      );

      expect(entryNamed(tree, parentIno, "title")).toMatchObject({
        nameLabel: cfcFailClosedLabel(),
        existenceLabel: cfcFailClosedLabel(),
      });
    });

    it("labels the source name of a rename source and the destination name of a rename destination", () => {
      for (
        const [operation, names] of [
          ["rename-source", { sourceName: "title" }],
          ["rename-destination", { destinationName: "title" }],
        ] as const
      ) {
        const { tree, parentIno, parent, file } = annotatedTree();
        annotateChild(
          tree,
          tree.addFile(parentIno, "other", "", "string"),
          file,
          "other",
        );

        applyPreparedParent(
          tree,
          parentIno,
          writeback(
            operation,
            { parentRef: parent.ref, name: "other", ...names },
            parent.generation,
            { nameLabel: TOP_LABEL },
          ),
        );

        expect(entryNamed(tree, parentIno, "title")?.nameLabel).toEqual(
          TOP_LABEL,
        );
        expect(entryNamed(tree, parentIno, "other")).toBeUndefined();
      }
    });

    it("leaves the entries unchanged when the prepare names no entry or names an unannotated child", () => {
      const { tree, parentIno, parent } = annotatedTree();
      tree.addFile(parentIno, "bare", "", "string");
      const entriesBefore = structuredClone(parent.entries);

      for (const target of [{}, { name: "bare" }, { name: "absent" }]) {
        applyPreparedParent(
          tree,
          parentIno,
          writeback(
            "unlink",
            { parentRef: parent.ref, ...target },
            parent.generation,
            { namespaceLabel: TOP_LABEL, nameLabel: TOP_LABEL },
          ),
        );

        const after = annotationOf(tree, parentIno);
        expect(after.namespaceLabel).toEqual(TOP_LABEL);
        expect(after.entries).toEqual(entriesBefore);
      }
    });
  });

  describe("applyPreparedCreate()", () => {
    it("creates the child without an annotation under an unannotated parent", () => {
      const tree = new FsTree();
      const parentIno = tree.addDir(tree.rootIno, "plain", "object");

      const childIno = applyPreparedCreate(
        tree,
        parentIno,
        "fresh",
        "file",
        writeback("create", { name: "fresh" }, "generation-1"),
      );

      expect(tree.lookup(parentIno, "fresh")).toBe(childIno);
      expect(tree.getNode(childIno)?.kind).toBe("file");
      expect(tree.getCfcAnnotation(childIno)).toBeUndefined();
      expect(tree.getCfcAnnotation(parentIno)).toBeUndefined();
    });
  });

  describe("applyPreparedSymlink()", () => {
    it("creates the link without an annotation under an unannotated parent", () => {
      const tree = new FsTree();
      const parentIno = tree.addDir(tree.rootIno, "plain", "object");

      const childIno = applyPreparedSymlink(
        tree,
        parentIno,
        "link",
        "../target",
        writeback("symlink", { name: "link" }, "generation-1"),
      );

      expect(tree.lookup(parentIno, "link")).toBe(childIno);
      expect(tree.getNode(childIno)).toMatchObject({
        kind: "symlink",
        target: "../target",
      });
      expect(tree.getCfcAnnotation(childIno)).toBeUndefined();
      expect(tree.getCfcAnnotation(parentIno)).toBeUndefined();
    });
  });
});
