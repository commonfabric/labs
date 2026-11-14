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
  type FitWatch,
  readRefusal,
  type RenderLabelSummary,
  type RenderPolicy,
  UNREADABLE_LABELS,
} from "@commonfabric/html/worker";
import { fabricAwareEqual, type FabricValue } from "@commonfabric/data-model";
import { isPlainObject } from "@commonfabric/js-values/types";
import {
  type Cancel,
  type Cell,
  hostValueOf,
  isStream,
  type MetaField,
  type ProjectedRead,
  readProjected,
  type SinkConsumedLabel,
  sinkProjected,
  useCancelGroup,
} from "@commonfabric/runner";
import {
  type CfcLabelView,
  cfcLabelViewForResolvedCell,
  type CfcModulePolicySource,
  redactCaveatSourcesForDisplay,
  reportCfcDenial,
  type SpaceMembershipProvider,
  StoredCfcMetadataError,
} from "@commonfabric/runner/cfc";

import {
  type CellFieldsResponse,
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

/**
 * The read that lists a record's fields: each field as a link to its own
 * cell, so that nothing a field holds is read, and the read consumes the
 * record's own label and no field's.
 */
const FIELDS_SCHEMA = {
  type: "object",
  additionalProperties: { asCell: ["cell"] },
} as const;

/**
 * What the display ceiling's refusal of a host's read says: that the ceiling
 * refused it, and the kind of label `refusal` was decided on, which carries
 * nothing of the label itself.
 */
function displayCeilingRefusal(refusal: RenderLabelSummary): CellReadRefusal {
  return Object.freeze({
    refusedBy: "display-ceiling",
    labelSource: refusal.labelSource,
  });
}

/**
 * Reads `cell` once through `project`, as `readProjected()` does, or returns
 * `undefined` where the read reached a document whose stored labels this
 * build cannot interpret. Such a read fails closed with a
 * `StoredCfcMetadataError` (`docs/specs/cfc-stored-envelope.md`), and is
 * decided as one whose labels could not be read, which refuses it.
 */
function readProjectedOrUnreadable<R>(
  cell: Cell<unknown>,
  project: (value: unknown) => R,
): ProjectedRead<R> | undefined {
  try {
    return readProjected(cell, project);
  } catch (error) {
    if (error instanceof StoredCfcMetadataError) return undefined;
    throw error;
  }
}

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

/**
 * The names of the fields a {@link FIELDS_SCHEMA} read listed, or `undefined`
 * where the cell holds no record: nothing, a list, or a single value.
 */
function fieldNamesOf(value: unknown): string[] | undefined {
  // A record is a plain object: a class instance such as `FabricBytes` holds
  // no fields to list, whatever own properties it has.
  return isPlainObject(value) ? Object.keys(value) : undefined;
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
 * What a host read gate's decisions consult beyond the labels, as a render's
 * do (`DisplayFitSources`), with access lists and module policy manifests it
 * can also load, as a decision made once loads what it consults first.
 */
export type HostReadSources =
  & Omit<DisplayFitSources, "membership" | "modulePolicies">
  & {
    readonly membership?: SpaceMembershipProvider;
    readonly modulePolicies?: Pick<
      CfcModulePolicySource,
      "resolve" | "subscribe" | "load"
    >;
  };

/**
 * Decides a host's reads of cells under one display policy.
 *
 * A gate built with no policy returns every read as read, the plain read
 * the worker makes without a ceiling: no projection measured, nothing
 * refused.
 */
export class HostReadGate {
  readonly #policy: RenderPolicy | undefined;
  readonly #sources: HostReadSources;

  /**
   * @param policy The root render policy every mount starts from, or
   *   `undefined` for a worker that renders with no ceiling.
   * @param sources What a decision consults beyond the labels: the
   *   exchange-rule resolver and the providers a subscription watches, the
   *   ones every mount is given.
   */
  constructor(policy: RenderPolicy | undefined, sources: HostReadSources) {
    this.#policy = policy;
    this.#sources = sources;
  }

  /**
   * Loads what a decision on a read of `cell` consults, so that {@link read}
   * decides on the access lists and module policy manifests the space last
   * sent rather than refusing on one not yet synced: a read made once has no
   * subscription to decide it again when one arrives. Each round decides the
   * read as {@link read} does and loads what that decision would watch and
   * does not already admit: an access list granting no role, or a manifest
   * that does not verify. A refusal stops a decision before it reaches the
   * labels behind it, so a load can bring more labels into the next round,
   * and the rounds end once one finds nothing new. A load that fails is
   * taken as loaded, and the read is decided on what the replica holds,
   * which refuses what it cannot admit. A load waits on the space that
   * holds the document, so a read whose labels name a space that never
   * answers waits as a read of that space would.
   */
  async settle(cell: Cell<unknown>): Promise<void> {
    await this.#settle((policy, sources, watch) => {
      const read = readProjectedOrUnreadable(cell, hostValueOf);
      if (read === undefined) return;
      readRefusal(cell, [read.consumed], policy, sources, watch);
    });
  }

  /**
   * Loads what a decision on a read of `root`'s metadata consults, as
   * {@link settle} does for a read of its value.
   */
  async settleMetadata(root: Cell<unknown>): Promise<void> {
    await this.#settle((policy, sources, watch) => {
      cellLabelRefusal(root, cellLabelSources(root), policy, sources, watch);
    });
  }

  /**
   * Runs `decide` with sources whose subscriptions load what they would
   * watch, and waits for those loads, until a round loads nothing new.
   */
  async #settle(
    decide: (
      policy: RenderPolicy,
      sources: DisplayFitSources,
      watch: FitWatch,
    ) => void,
  ): Promise<void> {
    const policy = this.#policy;
    if (policy === undefined) return;
    const { membership, modulePolicies } = this.#sources;
    // What failed to load reads as what the replica holds, which a decision
    // refuses when it cannot admit it.
    const quietly = (load: Promise<void>) => load.catch(() => {});
    const loaded = new Set<string>();
    let loads: Promise<void>[];
    do {
      const round: Promise<void>[] = [];
      loads = round;
      const loading: DisplayFitSources = {
        ...this.#sources,
        membership: membership && {
          readerRole: (space) => membership.readerRole(space),
          subscribe: (space) => {
            if (membership.readerRole(space) === null) {
              round.push(quietly(membership.load(space)));
            }
            return () => {};
          },
        },
        modulePolicies: modulePolicies && {
          subscribe: (reference, space) => {
            if (modulePolicies.resolve(reference, [space]) === undefined) {
              round.push(quietly(modulePolicies.load(reference, space)));
            }
            return () => {};
          },
        },
      };
      // A settled read is decided once, so nothing is kept to cancel and no
      // change decides it again.
      const ignore = () => {};
      const watch: FitWatch = {
        watched: new Set(loaded),
        addCancel: ignore,
        reeval: ignore,
      };
      decide(policy, loading, watch);
      for (const key of watch.watched) loaded.add(key);
      await Promise.all(round);
    } while (loads.length > 0);
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
      const read = this.#decide(cell, cell, hostValueOf, policy);
      if ("refusal" in read) {
        const refused = this.#refuse(read.refusal, policy);
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
   * whenever the membership or a module policy its labels name changes. A
   * read that finds the value and label the last update delivered sends
   * nothing: the host holds them already, and a change elsewhere in what the
   * read depends on is no change to it. Each change to a refused read
   * delivers a refusal of its own, so a host that listens only for change
   * still hears one, and the first value admitted after a refusal is
   * delivered whatever it holds. `inspect` sees each value as it was read,
   * before conversion.
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
    // Sends `value` with `label`, the display form of a label view.
    const sendUpdate = (
      value: FabricValue,
      label: CfcLabelView | undefined,
    ): void =>
      deliver(decided({
        type: NotificationType.CellUpdate as const,
        cell: ref,
        value,
        ...(includeCfcLabel ? { cfcLabel: label } : {}),
      }));
    // What the last update delivered, or `undefined` while none has, and
    // again after a refusal.
    let sent:
      | { value: FabricValue; cfcLabel: CfcLabelView | undefined }
      | undefined;
    const deliverValue = (
      value: FabricValue,
      cfcLabel: CfcLabelView | undefined,
    ): void => {
      const label = includeCfcLabel ? displayLabel(cfcLabel) : undefined;
      if (
        sent !== undefined && fabricAwareEqual(sent.value, value) &&
        fabricAwareEqual(sent.cfcLabel, label)
      ) {
        return;
      }
      sent = { value, cfcLabel: label };
      sendUpdate(value, label);
    };
    // An event is an occurrence, and two alike are two: each is sent as it
    // comes, compared with nothing.
    const deliverEvent = (
      event: FabricValue,
      cfcLabel: CfcLabelView | undefined,
    ): void =>
      sendUpdate(event, includeCfcLabel ? displayLabel(cfcLabel) : undefined);
    const policy = this.#policy;
    if (policy === undefined) {
      const send = holdsEvents(cell) ? deliverEvent : deliverValue;
      return cell.sink((value, cfcLabel) => {
        inspect(value);
        send(hostValueOf(value), cfcLabel);
      }, { includeCfcLabel });
    }
    const refusedUpdate = (refusal: RenderLabelSummary) => {
      this.#report(refusal, policy);
      sent = undefined;
      return decided({
        type: NotificationType.CellUpdate as const,
        cell: ref,
        refused: displayCeilingRefusal(refusal),
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
            ? decided({
              type: NotificationType.CellUpdate as const,
              cell: ref,
              value: hostValueOf(event),
              // An event carries the label of the stream's document, which
              // the decision above was made on.
              ...(includeCfcLabel
                ? {
                  cfcLabel: displayLabel(cfcLabelViewForResolvedCell(cell, {
                    kickCrossSpaceTargets: false,
                  })),
                }
                : {}),
            })
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
      if (refusal === undefined) deliverValue(last.value, last.cfcLabel);
      else deliver(refusedUpdate(refusal));
    };
    const watch: FitWatch = {
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

  /**
   * The fields the record `cell` holds, each as the address of the field
   * within it, or the refusal that stands in place of the list. The list is
   * read under {@link FIELDS_SCHEMA}, which reads nothing a field holds.
   *
   * The list is decided as a read of the record itself is: on what the read
   * consumed, and on the record's own labels, the stored ones or, where it
   * stores none, its own schema's. The schema the list is read under carries
   * no information-flow constraint, so it is never what the list is decided
   * on. How much of the record's document that covers is the display fit's to
   * say. A fit that decides on every label the document stores refuses the
   * list of a record holding one field the viewer may not see; one that
   * decides on the record's own node and on what the read consumed, which
   * includes no field's label, lists every field of it.
   *
   * The names come from the record, not its schema, which a host may hold
   * only as a reference it cannot resolve. An address carries no label view,
   * and each field's own read is decided as any read is. A cell that holds no
   * record, nothing at all, a list or a single value, is answered with no
   * list, which is not the empty list of a record that holds no fields.
   */
  async fields(cell: Cell<unknown>): Promise<CellFieldsResponse> {
    const listed = cell.asSchema(FIELDS_SCHEMA);
    await this.#settle((policy, sources, watch) => {
      const read = readProjectedOrUnreadable(listed, fieldNamesOf);
      if (read === undefined) return;
      readRefusal(cell, [read.consumed], policy, sources, watch);
    });
    const policy = this.#policy;
    let names: string[] | undefined;
    if (policy === undefined) {
      names = fieldNamesOf(listed.get());
    } else {
      const read = this.#decide(cell, listed, fieldNamesOf, policy);
      if ("refusal" in read) return this.#refuse(read.refusal, policy);
      names = read.value;
    }
    // Nothing to list, which is not a record that holds no fields.
    if (names === undefined) return decided({});
    const fields: Record<string, CellRef> = {};
    for (const name of names) {
      const { cfcLabelView: _withheld, ...address } = createCellRef(
        cell.key(name),
      );
      fields[name] = address;
    }
    return decided({ fields });
  }

  /**
   * Reads `read` once through `project` and decides it under `policy` as a
   * read of `cell`, on what it consumed: the projection, or the label that
   * refuses it.
   */
  #decide<R>(
    cell: Cell<unknown>,
    read: Cell<unknown>,
    project: (value: unknown) => R,
    policy: RenderPolicy,
  ): { value: R } | { refusal: RenderLabelSummary } {
    const projected = readProjectedOrUnreadable(read, project);
    if (projected === undefined) return { refusal: UNREADABLE_LABELS };
    const refusal = readRefusal(
      cell,
      [projected.consumed],
      policy,
      this.#sources,
    );
    return refusal === undefined ? { value: projected.value } : { refusal };
  }

  /** A refusal of a read, reported as a refused render is. */
  #refuse(
    refusal: RenderLabelSummary,
    policy: RenderPolicy,
  ): CellGetResponse & CellRefusedAnswer {
    this.#report(refusal, policy);
    return decided({ refused: displayCeilingRefusal(refusal) });
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
