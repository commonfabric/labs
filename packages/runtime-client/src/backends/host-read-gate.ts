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
  cellLabelRefusal,
  cellLabelSources,
  type DisplayFitSources,
  type MembershipWatch,
  readRefusal,
  type RenderLabelSummary,
  type RenderPolicy,
} from "@commonfabric/html/worker";
import type { FabricValue } from "@commonfabric/data-model";
import {
  type Cancel,
  type Cell,
  hostValueOf,
  isStream,
  type MetaField,
  readProjected,
  type SinkConsumedLabel,
  sinkProjected,
  useCancelGroup,
} from "@commonfabric/runner";
import {
  type CfcLabelView,
  cfcLabelViewForResolvedCell,
  redactCaveatSourcesForDisplay,
  reportCfcDenial,
} from "@commonfabric/runner/cfc";

import {
  type CellGetResponse,
  type CellReadRefusal,
  type CellRef,
  type CellRefusedAnswer,
  type CellUpdateNotification,
  type CellValueResponse,
  type HostReadDecided,
  NotificationType,
} from "@/protocol/mod.ts";
import { createCellRef } from "./utils.ts";

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
 * Whether `cell` is a stream, which holds no value and whose sink delivers
 * the events sent to it. A plain answer rather than `isStream()`'s narrowing,
 * since a stream is subscribed to as a cell.
 */
function holdsEvents(cell: Cell<unknown>): boolean {
  return isStream(cell);
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
      const read = readProjected(cell, hostValueOf);
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
        const { cfcLabelView: _withheld, ...address } = createCellRef(cell);
        return decided({ ...refused, cell: address });
      }
      value = read.value;
    }
    const refField = options.includeRef ? { cell: createCellRef(cell) } : {};
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
            ? update(hostValueOf(event), undefined)
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
    const watch: MembershipWatch = {
      watched: new Set<string>(),
      addCancel,
      reeval: decide,
    };
    addCancel(sinkProjected(cell, (value) => {
      inspect(value);
      return hostValueOf(value);
    }, (value, read, cfcLabel) => {
      last = { value, cfcLabel };
      consumed = read;
      decide();
    }, { includeCfcLabel }));
    return cancel;
  }

  /** A refusal of a read, reported as a refused render is. */
  #refuse(
    refusal: RenderLabelSummary,
    policy: RenderPolicy,
  ): CellGetResponse & CellRefusedAnswer {
    this.#report(refusal, policy);
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
