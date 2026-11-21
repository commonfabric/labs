/**
 * The paths one write record of a compiled pattern covers
 * (`planWriteTargets`), and the records that stand for the records a writer
 * formed, one for those that differ only in a member of one container or
 * in the document (`mergedPlanWrites`).
 *
 * The records of the writes of one transaction that name one record of the
 * plan and one entry of the table of inputs instantiate one template with
 * one set of inputs. Given as one record, a write of every member of a
 * container costs one record and the list of the members, whatever the
 * size of the inputs.
 */

import type { CfcAddress, PlanWrite, PlanWriteMember } from "./types.ts";

/** A segment that is an index of an array. */
const INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * The address of each path `write` covers: its target, or, for a record
 * that lists members, the target with each member at the `*` of its path,
 * and the same path in each further document the record lists. Throws for
 * a record that lists members where the path of its target has no `*`, or
 * more than one.
 */
export const planWriteTargets = (write: PlanWrite): CfcAddress[] => {
  const { target, members, documents } = write;
  let paths: (readonly string[])[] = [target.path];
  if (members !== undefined) {
    const star = target.path.indexOf("*");
    if (star < 0 || target.path.indexOf("*", star + 1) >= 0) {
      throw new Error(
        "A write record that lists members names their place by one `*`.",
      );
    }
    const at = (member: string): string[] => [
      ...target.path.slice(0, star),
      member,
      ...target.path.slice(star + 1),
    ];
    paths = members.flatMap((member) =>
      typeof member === "string" ? [at(member)] : Array.from(
        { length: member[1] - member[0] + 1 },
        (_, offset) => at(`${member[0] + offset}`),
      )
    );
  }
  return [target.id, ...(documents ?? [])].flatMap((id) =>
    paths.map((path) => ({ ...target, id, path }))
  );
};

/** The record each record of `planWritesPerTarget` stands for. */
const sources = new WeakMap<PlanWrite, PlanWrite>();

/**
 * One record for each path `write` covers, each with that path as its
 * target and no list: `write` itself where it lists nothing, and where its
 * lists are not well formed (`planWriteTargets`).
 */
export const planWritesPerTarget = <W extends PlanWrite>(write: W): W[] => {
  if (write.members === undefined && write.documents === undefined) {
    return [write];
  }
  let targets: CfcAddress[];
  try {
    targets = planWriteTargets(write);
  } catch {
    return [write];
  }
  const { members: _members, documents: _documents, ...rest } = write;
  return targets.map((target) => {
    const one = { ...rest, target } as W;
    sources.set(one, write);
    return one;
  });
};

/**
 * The record that `write`, a record of `planWritesPerTarget`, stands for a
 * path of; `write` itself where it is none of those.
 */
export const planWriteSource = <W extends PlanWrite>(write: W): W =>
  (sources.get(write) as W | undefined) ?? write;

/** Whether a record is one that is given as it is, and never merged. */
const standsAlone = (write: PlanWrite): boolean =>
  write.members !== undefined || write.documents !== undefined ||
  write.decided !== undefined || write.observed !== undefined ||
  write.enumeration === true || write.removes === true ||
  write.moves !== undefined || write.start !== undefined ||
  write.membersChanged === true || write.membersAppended === true;

/** What a record names beside its target and its element keys, as text. */
const sameBut = (write: PlanWrite): string =>
  JSON.stringify([
    write.compiledPattern,
    write.record,
    write.instance,
    write.inputs,
    write.unchanged === true,
    write.relabel === true,
    write.bound === true,
  ]);

/** The members given, with indices next to each other as one range. */
const listed = (members: readonly string[]): PlanWriteMember[] => {
  const indices = members.filter((member) => INDEX.test(member)).map(Number)
    .sort((a, b) => a - b);
  const found: PlanWriteMember[] = [];
  let first: number | undefined;
  let last = -1;
  const close = () => {
    if (first === undefined) return;
    found.push(first === last ? `${first}` : [first, last]);
  };
  for (const index of indices) {
    if (first !== undefined && index === last + 1) {
      last = index;
      continue;
    }
    close();
    first = last = index;
  }
  close();
  for (const member of members) if (!INDEX.test(member)) found.push(member);
  return found;
};

/**
 * `writes`, the records of one transaction in the order they were formed,
 * with one record in the place of those that name one record of the plan
 * and one entry of the table of inputs, carry the same marks, and differ
 * in their target only: by the document, or by one segment of the path,
 * the member of one container (`PlanWrite.documents`, `PlanWrite.members`).
 * The records returned cover the paths the records given cover, and the
 * last record given for a path is the last returned for it: a record that
 * a later one of the same path replaces is left as it is, before the
 * others.
 */
export const mergedPlanWrites = (
  writes: readonly PlanWrite[],
): PlanWrite[] => {
  const pathKey = ({ target }: PlanWrite) =>
    JSON.stringify([target.space, target.scope, target.id, target.path]);
  const lastAt = new Map<string, PlanWrite>();
  for (const write of writes) {
    if (write.enumeration !== true) lastAt.set(pathKey(write), write);
  }
  const replaced: PlanWrite[] = [];
  // The records to merge, by everything but the target, in order.
  const groups = new Map<string, PlanWrite[]>();
  // What is returned behind `replaced`: a record given as it is, or the
  // group merged in the place of its first record.
  const order: (PlanWrite | string)[] = [];
  for (const write of writes) {
    if (
      write.enumeration !== true && lastAt.get(pathKey(write)) !== write
    ) {
      replaced.push(write);
    } else if (standsAlone(write)) {
      order.push(write);
    } else {
      const key = sameBut(write);
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, [write]);
        order.push(key);
      } else group.push(write);
    }
  }
  return [
    ...replaced,
    ...order.flatMap((each) =>
      typeof each === "string" ? mergedGroup(groups.get(each)!) : [each]
    ),
  ];
};

/**
 * Helper for `mergedPlanWrites()`: the records for one group of records
 * that differ in their target only, each at a path of its own.
 */
const mergedGroup = (group: readonly PlanWrite[]): PlanWrite[] => {
  if (group.length < 2) return [...group];
  const merged: PlanWrite[] = [];
  // One path in several documents of one space and scope.
  const byPath = new Map<string, PlanWrite[]>();
  for (const write of group) {
    const { space, scope, path } = write.target;
    const key = JSON.stringify([space, scope, path]);
    const held = byPath.get(key);
    if (held === undefined) byPath.set(key, [write]);
    else held.push(write);
  }
  const single: PlanWrite[] = [];
  for (const held of byPath.values()) {
    if (held.length < 2) {
      single.push(held[0]);
      continue;
    }
    merged.push({
      ...held[0],
      documents: held.slice(1).map(({ target }) => target.id),
    });
  }
  // The members of one container: the paths of one document and one
  // length that differ in one segment. The segment taken is, of those at
  // which the paths differ, the one that leaves the fewest containers.
  const byShape = new Map<string, PlanWrite[]>();
  for (const write of single) {
    const { space, scope, id, path } = write.target;
    const key = JSON.stringify([space, scope, id, path.length]);
    const held = byShape.get(key);
    if (held === undefined) byShape.set(key, [write]);
    else held.push(write);
  }
  for (const held of byShape.values()) {
    const length = held[0].target.path.length;
    let best: Map<string, PlanWrite[]> | undefined;
    for (let at = length - 1; at >= 0 && held.length > 1; at--) {
      if (held[0].target.path[at] === "*") continue;
      const containers = new Map<string, PlanWrite[]>();
      for (const write of held) {
        const starred = JSON.stringify(
          write.target.path.map((segment, index) =>
            index === at ? "*" : segment
          ),
        );
        const members = containers.get(starred);
        if (members === undefined) containers.set(starred, [write]);
        else members.push(write);
      }
      if (best === undefined || containers.size < best.size) {
        best = containers;
      }
    }
    if (best === undefined || best.size === held.length) {
      for (const write of held) merged.push(write);
      continue;
    }
    for (const [starred, members] of best) {
      if (members.length < 2) {
        merged.push(members[0]);
        continue;
      }
      const path = JSON.parse(starred) as string[];
      const at = path.indexOf("*");
      merged.push({
        ...members[0],
        target: { ...members[0].target, path },
        members: listed(members.map(({ target }) => target.path[at])),
      });
    }
  }
  return merged;
};
