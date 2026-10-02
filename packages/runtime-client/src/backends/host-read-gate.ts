/**
 * The worker's decision on what of a cell a host may see.
 *
 * The host shows what it reads: a title, a menu's data panel, a form
 * control's value, what an iframe guest is handed. Each of those reads is a
 * display sink like a render, so the worker decides it the way a render is
 * decided (CFC §8.10.6), by the display fit the reconciler uses, under the
 * display ceiling the worker renders with. A read is decided on the labels of
 * the cell it starts from and of everything it consumed, and what it consumed
 * is measured on the very walk that builds the answer (`readProjected()` with
 * `hostValueOf()`), so the decision is made on what is sent.
 *
 * The gate is the one place that builds an answer to a host's read: the
 * answer types carry a mark, `HostReadDecided`, that only {@link decided}
 * here gives them. A refused read returns a `CellReadRefusal` in place of the
 * value, never an empty value, so that a read the host could not make never
 * reads as a cell that holds nothing.
 */

import {
  canRenderLabelUnderPolicy,
  cellLabelRefusal,
  cellLabelSources,
  CFC_POLICY_PLACEHOLDER_TEXT,
  type DisplayFitSources,
  type FitWatch,
  readRefusal,
  type RenderLabelSummary,
  type RenderPolicy,
} from "@commonfabric/html/worker";
import type { CellScope } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  type Cancel,
  type Cell,
  hostValueOf,
  isStream,
  type JSONSchema,
  type MetaField,
  readProjected,
  type RuntimeTelemetryMarkerResult,
  type SinkConsumedLabel,
  sinkProjected,
  useCancelGroup,
} from "@commonfabric/runner";
import type {
  SchedulerDiagnosisResult,
  TriggerTraceEntry,
} from "@commonfabric/runner/shared";
import {
  type CfcLabelView,
  cfcLabelViewForCell,
  cfcLabelViewForResolvedCell,
  cfcLabelViewOriginSpaces,
  redactCaveatSourcesForDisplay,
  redactEntryPathsForDisplay,
  reportCfcDenial,
} from "@commonfabric/runner/cfc";
import type { OperationFieldSnapshot } from "@commonfabric/memory/v2";

import {
  type CellFieldsResponse,
  type CellGetResponse,
  type CellReadRefusal,
  type CellRef,
  type CellRefusedAnswer,
  type CellUpdateNotification,
  type CellValueResponse,
  type CfcLabelViewResponse,
  type ConsoleNotification,
  type DetectNonIdempotentResponse,
  type ErrorNotification,
  type ErrorReport,
  type HostReadDecided,
  NotificationType,
  type OperationUpdateNotification,
  type PieceRef,
  type SlugResponse,
  type TelemetryNotification,
  type TriggerTraceResponse,
} from "@/protocol/mod.ts";
import { createCellRef } from "./utils.ts";

/**
/**
 * The document a diagnostic names by space and id, which a diagnostic is
 * decided on: its root, whose labels cover everything it holds.
 */
export type DocumentAt = (
  space: string,
  id: string,
  scope?: CellScope,
) => Cell<unknown>;

/** What stands in a diagnostic for a value the ceiling refuses. */
const WITHHELD = CFC_POLICY_PLACEHOLDER_TEXT;

/**
 * The read that lists a record's fields: each field as a link to its own
 * cell, so that nothing a field holds is read, and the read consumes the
 * record's own label and no field's.
 */
const FIELDS_SCHEMA = {
  type: "object",
  additionalProperties: { asCell: ["cell"] },
} as const;

/** What the display ceiling's refusal of a host's read says. */
const DISPLAY_CEILING_REFUSAL: CellReadRefusal = Object.freeze({
  refusedBy: "display-ceiling",
});

/**
 * Marks `answer` as one this gate made. This is the only place the mark is
 * given; the mark exists only in the type.
 */
function decided<T>(answer: T): T & HostReadDecided {
  return answer as T & HostReadDecided;
}

/**
 * The report the transport makes of its own failures: a message it cannot
 * encode, or one from a client it cannot decode or act on. `reason` names
 * the failure, and may quote the message, which was either the host's own or
 * itself to be posted to the host, and so carries nothing the host would not
 * have been sent. Given the gate's mark here, since only this module gives
 * it.
 */
export function transportFailureReport(reason: string): ErrorNotification {
  return decided({
    type: NotificationType.ErrorReport as const,
    message: reason,
  });
}

/**
 * Whether `cell` is a stream, which holds no value and whose sink delivers
 * the events sent to it. A plain answer rather than `isStream()`'s narrowing,
 * since a stream is subscribed to as a cell.
 */
function holdsEvents(cell: Cell<unknown>): boolean {
  return isStream(cell);
}

/** The names of the fields a {@link FIELDS_SCHEMA} read listed. */
function fieldNamesOf(value: unknown): string[] {
  return isObjectNotArray(value) ? Object.keys(value) : [];
}

/** The label view a read asked for, with each caveat's source redacted. */
function displayLabel(
  cfcLabel: CfcLabelView | undefined,
): CfcLabelView | undefined {
  return cfcLabel === undefined
    ? undefined
    : redactCaveatSourcesForDisplay(cfcLabel);
}

/**
 * Decides a host's reads of cells under one display policy.
 *
 * A gate built with no policy returns every read as read, the plain read
 * the worker makes without a ceiling: no projection measured, nothing
 * refused.
 */
export class HostReadGate {
  readonly #policy: RenderPolicy | undefined;
  readonly #sources: DisplayFitSources;

  /**
   * @param policy The root render policy every mount starts from, or
   *   `undefined` for a worker that renders with no ceiling.
   * @param sources What a decision consults beyond the labels: the
   *   exchange-rule resolver and the providers a subscription watches, the
   *   ones every mount is given.
   */
  constructor(policy: RenderPolicy | undefined, sources: DisplayFitSources) {
    this.#policy = policy;
    this.#sources = sources;
  }

  /**
   * Reads `cell` once for a host: its value as `hostValueOf()` builds it, or
   * the refusal that stands in its place. `includeRef` adds the read cell's
   * own ref, and `includeCfcLabel` its display label, to a value.
   */
  read(
    cell: Cell<unknown>,
    options: { includeRef?: boolean; includeCfcLabel?: boolean } = {},
  ): CellGetResponse {
    let value: FabricValue;
    const policy = this.#policy;
    if (policy === undefined) {
      value = hostValueOf(cell.get());
    } else {
      const read = readProjected(cell, this.#hostValue);
      const refusal = readRefusal(
        cell,
        [read.consumed],
        policy,
        this.#sources,
      );
      if (refusal !== undefined) {
        const refused = this.#refuse(refusal, policy);
        if (!options.includeRef) return refused;
        // The address alone, without the label view a ref carries: a
        // refused read gives no label.
        return decided({ ...refused, cell: createCellRef(cell) });
      }
      value = read.value;
    }
    const refField = options.includeRef ? { cell: this.ref(cell) } : {};
    if (!options.includeCfcLabel) return decided({ value, ...refField });
    // The value read above resolved the same links and kicked any
    // cross-space targets already, so the label read kicks none of its own.
    const cfcLabel = cfcLabelViewForResolvedCell(cell, {
      kickCrossSpaceTargets: false,
    });
    return decided({ value, ...refField, cfcLabel: displayLabel(cfcLabel) });
  }

  /**
   * Reads the metadata field `field` of the document `root` names. A metadata
   * field sits beside the document's value, where no label covers it, so the
   * read is decided on every label the document stores.
   */
  readMetadata(root: Cell<unknown>, field: MetaField): CellGetResponse {
    const refusal = this.metadataRefusal(root);
    return refusal ?? decided({ value: root.getMetaRaw(field) });
  }

  /**
   * The refusal of a read of `root`'s metadata, or `undefined` when the
   * document's labels admit one. A metadata link is followed only once its
   * document is admitted, and what it leads to is read through {@link read}.
   */
  metadataRefusal(root: Cell<unknown>): CellGetResponse | undefined {
    const policy = this.#policy;
    if (policy === undefined) return undefined;
    const refusal = cellLabelRefusal(
      root,
      cellLabelSources(root),
      policy,
      this.#sources,
    );
    return refusal === undefined ? undefined : this.#refuse(refusal, policy);
  }

  /** The answer for a read that found nothing to read, such as an absent link. */
  nothing(): CellGetResponse {
    return decided({ value: undefined });
  }

  /**
   * The answer that returns the host the value it sent itself, as an
   * initialization that stored the host's default does. The host holds that
   * value already, so nothing is released.
   */
  sentByHost(value: FabricValue): CellValueResponse {
    return decided({ value });
  }

  /**
   * Subscribes a host to `cell`, delivering each read as a cell update for
   * `ref`: its value, or the refusal that stands in its place, decided again
   * whenever the membership or a module policy its labels name changes. Each
   * change to a refused read delivers a refusal of its own, so a host that
   * listens only for change still hears one. `inspect` sees each value as it
   * was read, before conversion.
   *
   * A stream holds no value: its sink delivers the events sent to it, which
   * no read consumed, so an event is decided on the labels of the stream's
   * own document.
   */
  subscribe(
    cell: Cell<unknown>,
    ref: CellRef,
    options: { includeCfcLabel?: boolean },
    inspect: (value: unknown) => void,
    deliver: (update: CellUpdateNotification) => void,
  ): Cancel {
    const includeCfcLabel = options.includeCfcLabel === true;
    const update = (value: FabricValue, cfcLabel: CfcLabelView | undefined) =>
      decided({
        type: NotificationType.CellUpdate as const,
        cell: ref,
        value,
        ...(includeCfcLabel ? { cfcLabel: displayLabel(cfcLabel) } : {}),
      });
    const policy = this.#policy;
    if (policy === undefined) {
      return cell.sink((value, cfcLabel) => {
        inspect(value);
        deliver(update(hostValueOf(value), cfcLabel));
      }, { includeCfcLabel });
    }
    const refusedUpdate = (refusal: RenderLabelSummary) => {
      this.#report(refusal, policy);
      return decided({
        type: NotificationType.CellUpdate as const,
        cell: ref,
        refused: DISPLAY_CEILING_REFUSAL,
      });
    };
    if (holdsEvents(cell)) {
      return cell.sink((event) => {
        inspect(event);
        const refusal = cellLabelRefusal(
          cell,
          cellLabelSources(cell),
          policy,
          this.#sources,
        );
        deliver(
          refusal === undefined
            ? update(this.#hostValue(event), undefined)
            : refusedUpdate(refusal),
        );
      });
    }
    const [cancel, addCancel] = useCancelGroup();
    let last:
      | { value: FabricValue; cfcLabel: CfcLabelView | undefined }
      | undefined;
    let consumed: SinkConsumedLabel | undefined;
    const decide = () => {
      if (last === undefined) return;
      const refusal = readRefusal(
        cell,
        [consumed],
        policy,
        this.#sources,
        watch,
      );
      deliver(
        refusal === undefined
          ? update(last.value, last.cfcLabel)
          : refusedUpdate(refusal),
      );
    };
    const watch: FitWatch = {
      watched: new Set<string>(),
      addCancel,
      reeval: decide,
    };
    addCancel(sinkProjected(cell, (value) => {
      inspect(value);
      return this.#hostValue(value);
    }, (value, read, cfcLabel) => {
      last = { value, cfcLabel };
      consumed = read;
      decide();
    }, { includeCfcLabel }));
    return cancel;
  }

  /**
   * A ref to `cell` for a host: its address, and the label view the cell
   * holds in the display form {@link #displayView} gives it. Refs minted
   * anywhere else carry no view (`createCellRef()`), so a ref that reaches
   * a host with a view had it decided here.
   */
  ref(cell: Cell<unknown>, schema?: JSONSchema): CellRef {
    const ref = createCellRef(cell, schema);
    const view = cfcLabelViewForCell(cell);
    return view === undefined ? ref : {
      ...ref,
      cfcLabelView: this.#displayView(
        cell,
        redactCaveatSourcesForDisplay(view),
      ),
    };
  }

  /** A ref to the piece `cell` holds, as {@link ref} makes one. */
  pieceRef(cell: Cell<unknown>): PieceRef {
    return { cell: this.ref(cell) };
  }

  /**
   * `cell`'s display label, for a host that asked for it alone. Where the
   * policy refuses the cell, the label's entries are joined at its root,
   * since the paths they sit at name the document's fields (§4.6.4.1).
   */
  label(cell: Cell<unknown>): CfcLabelViewResponse {
    // The value read elsewhere resolved the same links and kicked any
    // cross-space targets already, so the label read kicks none of its own.
    const view = cfcLabelViewForResolvedCell(cell, {
      kickCrossSpaceTargets: false,
    });
    return decided({
      cfcLabel: view === undefined
        ? undefined
        : this.#displayView(cell, redactCaveatSourcesForDisplay(view)),
    });
  }

  /**
   * The slug of the piece `root` is, or the refusal that stands in its
   * place: a metadata field, decided as {@link readMetadata} decides one.
   */
  slug(root: Cell<unknown>): SlugResponse {
    const refusal = this.metadataRefusal(root);
    if (refusal !== undefined && "refused" in refusal) return refusal;
    const slug = root.getMetaRaw("slug");
    return decided({ slug: typeof slug === "string" ? slug : undefined });
  }

  /**
   * An answer built from `root`'s metadata by `build`, such as a piece's
   * source, or the refusal that stands in its place. `build` runs only once
   * the document's labels admit a read of its metadata, so a refused piece's
   * source is neither read for the host nor changed through it.
   */
  async fromMetadata<T extends object>(
    root: Cell<unknown>,
    build: () => Promise<T>,
  ): Promise<HostReadDecided & (T | CellRefusedAnswer)> {
    const refusal = this.metadataRefusal(root);
    if (refusal !== undefined && "refused" in refusal) {
      return decided({ refused: refusal.refused });
    }
    return decided(await build());
  }

  /**
   * An answer built by `build` from what `cell` holds, such as the rows a
   * query of a database returns or the state of a collaborative field, or
   * the refusal that stands in its place. Decided on the labels `cell`
   * carries, which cover everything inside it, since what `build` reads is
   * reached through it and not through a read the gate can measure.
   */
  async fromCell<T extends object>(
    cell: Cell<unknown>,
    build: () => Promise<T>,
  ): Promise<HostReadDecided & (T | CellRefusedAnswer)> {
    const refusal = this.#cellRefusal(cell);
    if (refusal !== undefined) {
      return decided({ refused: this.#refuse(refusal).refused });
    }
    return decided(await build());
  }

  /**
   * An update of the collaborative field `cell` names, for subscription
   * `subscriptionId`: the field as it now stands, or the refusal that stands
   * in its place, decided again at each update, as {@link fromCell} decides.
   */
  operationUpdate(
    cell: Cell<unknown>,
    subscriptionId: string,
    field: OperationFieldSnapshot,
  ): OperationUpdateNotification {
    const refusal = this.#cellRefusal(cell);
    return decided({
      type: NotificationType.OperationUpdate as const,
      subscriptionId,
      ...(refusal === undefined
        ? { field }
        : { refused: this.#refuse(refusal).refused }),
    });
  }

  /**
   * A telemetry marker as a host may see it. A cell update's marker carries
   * the values the update changed between and the path it changed, which are
   * the changed document's contents: where the policy refuses that document,
   * the marker names the document alone, with the placeholder in place of
   * each value. Every other marker carries no cell's contents.
   */
  telemetry(
    marker: RuntimeTelemetryMarkerResult,
    documentAt: DocumentAt,
  ): TelemetryNotification {
    if (
      marker.type === "cell.update" &&
      this.#documentRefused(
        documentAt,
        marker.space,
        marker.change.address.id,
        marker.change.address.scope,
      )
    ) {
      return decided({
        type: NotificationType.Telemetry as const,
        marker: {
          ...marker,
          change: {
            address: { ...marker.change.address, path: [] },
            before: WITHHELD,
            after: WITHHELD,
          },
        },
      });
    }
    return decided({ type: NotificationType.Telemetry as const, marker });
  }

  /**
   * The trigger trace as a host may see it: an entry whose changed document
   * the policy refuses names the document alone, with no path and no preview
   * or size of the values.
   */
  triggerTrace(
    trace: readonly TriggerTraceEntry[],
    documentAt: DocumentAt,
  ): TriggerTraceResponse {
    return decided({
      trace: trace.map((entry) =>
        this.#documentRefused(documentAt, entry.space, entry.entityId)
          ? {
            ...entry,
            path: [],
            before: { kind: entry.before.kind },
            after: { kind: entry.after.kind },
          }
          : entry
      ),
    });
  }

  /**
   * A diagnosis as a host may see it. Each run it reports keys what it read
   * and wrote by `space/id/path` and carries the values: those of a document
   * the policy refuses are joined under `space/id`, with the placeholder in
   * place of their values, and the differing keys are named the same way.
   */
  diagnosis(
    result: SchedulerDiagnosisResult,
    documentAt: DocumentAt,
  ): DetectNonIdempotentResponse {
    const verdicts = new Map<string, boolean>();
    const shown = (key: string): string => {
      const [space, id] = key.split("/", 2);
      if (space === undefined || id === undefined) return key;
      const document = `${space}/${id}`;
      let refused = verdicts.get(document);
      if (refused === undefined) {
        refused = this.#documentRefused(documentAt, space, id);
        verdicts.set(document, refused);
      }
      return refused ? document : key;
    };
    const values = (
      entries: Record<string, FabricValue>,
    ): Record<string, FabricValue> => {
      const out: Record<string, FabricValue> = {};
      for (const [key, value] of Object.entries(entries)) {
        const named = shown(key);
        out[named] = named === key ? value : WITHHELD;
      }
      return out;
    };
    return decided({
      result: {
        ...result,
        nonIdempotent: result.nonIdempotent.map((report) => ({
          ...report,
          runs: report.runs.map((run) => ({
            ...run,
            reads: values(run.reads),
            writes: values(run.writes),
          })),
          differingWriteKeys: [
            ...new Set(report.differingWriteKeys.map(shown)),
          ],
        })),
      },
    });
  }

  /**
   * A pattern's `console` call as a host may see it: the arguments, or the
   * placeholder in their place where the policy refuses what the action that
   * logged had read (`consumed`), which is what they can have been made
   * from. Code that runs outside an action reads no cell, and logs as is.
   */
  console(
    message: { metadata?: ConsoleNotification["metadata"]; method: string },
    args: FabricValue[],
    consumed: (() => SinkConsumedLabel) | undefined,
  ): ConsoleNotification {
    return decided({
      type: NotificationType.ConsoleMessage as const,
      ...message,
      args: this.#consumedRefused(consumed) ? [WITHHELD] : args,
    });
  }

  /**
   * A runtime error as a host may see it: as reported, or, where the policy
   * refuses what the failing action had read (`consumed`), which its message
   * and stack can quote, with both withheld. An error raised outside an
   * action's transaction is reported as is.
   */
  error(
    report: Omit<ErrorReport, "type">,
    consumed?: () => SinkConsumedLabel,
  ): ErrorNotification {
    if (!this.#consumedRefused(consumed)) {
      return decided({
        type: NotificationType.ErrorReport as const,
        ...report,
      });
    }
    const { stackTrace: _withheld, ...rest } = report;
    return decided({
      type: NotificationType.ErrorReport as const,
      ...rest,
      message: `An error occurred. ${WITHHELD}.`,
    });
  }

  /**
   * The view a link to `cell`, or a ref to it, carries for a host: `view`,
   * the display form of the view the cell holds, where the policy admits the
   * cell, and the same joined at its root where it does not, since the paths
   * its entries sit at name the document's fields.
   */
  #displayView = (cell: Cell<unknown>, view: CfcLabelView): CfcLabelView => {
    const policy = this.#policy;
    if (policy === undefined) return view;
    const refusal = cellLabelRefusal(
      cell,
      [{ view, readFailed: false, spaces: cfcLabelViewOriginSpaces(view) }],
      policy,
      this.#sources,
    );
    return refusal === undefined ? view : redactEntryPathsForDisplay(view);
  };

  /** A value in the form a host is handed it, each link's view decided. */
  #hostValue = (value: unknown): FabricValue =>
    hostValueOf(value, this.#displayView);

  /** The refusal of `cell`'s own labels, or `undefined` where they fit. */
  #cellRefusal(cell: Cell<unknown>): RenderLabelSummary | undefined {
    const policy = this.#policy;
    return policy === undefined
      ? undefined
      : cellLabelRefusal(cell, cellLabelSources(cell), policy, this.#sources);
  }

  /**
   * Whether the policy refuses the document `id` in `space`, as a whole. With
   * no policy, nothing is refused and no document is looked up.
   */
  #documentRefused(
    documentAt: DocumentAt,
    space: string,
    id: string,
    scope?: CellScope,
  ): boolean {
    return this.#policy !== undefined &&
      this.#cellRefusal(documentAt(space, id, scope)) !== undefined;
  }

  /**
   * Whether the policy refuses labels an action consumed. Labels that cannot
   * be read refuse; an action that consumed no labeled value is admitted.
   */
  #consumedRefused(
    consumed: (() => SinkConsumedLabel) | undefined,
  ): boolean {
    const policy = this.#policy;
    if (policy === undefined || consumed === undefined) return false;
    let read: SinkConsumedLabel;
    try {
      read = consumed();
    } catch {
      return true;
    }
    if (read.confidentiality.length === 0) return false;
    const spaces = [...read.modulePolicySpaces.values()].flatMap((set) => [
      ...set,
    ]);
    return !canRenderLabelUnderPolicy(
      read.confidentiality,
      read.integrity,
      () => spaces,
      policy,
      this.#sources,
    );
  }

  /**
   * The fields the record `cell` holds, each as the address of the field
   * within it, or the refusal that stands in place of the list. The list is
   * read under {@link FIELDS_SCHEMA}, which reads nothing a field holds, and
   * is decided as any read is, on the record's own node and on what the read
   * consumed, which includes no field's label. A record that holds one field
   * the viewer may not see so lists every field, and each field's own read
   * is decided as any read is. The names come from the record, not its schema, which a host may
   * hold only as a reference it cannot resolve. An address carries no label
   * view, as no ref but {@link ref}'s does: the field's own read decides
   * whether its label may be seen.
   */
  fields(cell: Cell<unknown>): CellFieldsResponse {
    const listed = cell.asSchema(FIELDS_SCHEMA);
    const policy = this.#policy;
    let names: string[];
    if (policy === undefined) {
      names = fieldNamesOf(listed.get());
    } else {
      const read = readProjected(listed, fieldNamesOf);
      const refusal = readRefusal(
        listed,
        [read.consumed],
        policy,
        this.#sources,
      );
      if (refusal !== undefined) return this.#refuse(refusal, policy);
      names = read.value;
    }
    const fields: Record<string, CellRef> = {};
    for (const name of names) fields[name] = createCellRef(cell.key(name));
    return decided({ fields });
  }

  /** A refusal of a read, reported as a refused render is. */
  #refuse(
    refusal: RenderLabelSummary,
    policy: RenderPolicy | undefined = this.#policy,
  ): CellGetResponse & CellRefusedAnswer {
    if (policy !== undefined) this.#report(refusal, policy);
    return decided({ refused: DISPLAY_CEILING_REFUSAL });
  }

  #report(refusal: RenderLabelSummary, policy: RenderPolicy): void {
    reportCfcDenial(
      "render-confidentiality-ceiling",
      "the render policy did not admit a cell's confidentiality label",
      () => ({
        ...refusal,
        ceiling: policy.maxConfidentiality ?? "unbounded",
        declassified: policy.declassifyConfidentiality,
        caveatKindAllow: policy.caveatKindAllow,
        hostRead: true,
      }),
    );
  }
}
