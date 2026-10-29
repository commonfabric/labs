import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type AttendanceStatus = "present" | "absent";

interface StudentSeed {
  id?: string;
  name?: string;
}

interface StudentRecord {
  id: string;
  name: string;
  sortKey: string;
}

interface AttendanceMark {
  studentId?: string;
  status?: string;
  present?: boolean;
}

interface RecordAttendanceEvent {
  sessionId?: string;
  date?: string;
  topic?: string;
  attendance?: AttendanceMark[];
  marks?: AttendanceMark[];
}

interface AttendanceEntryInternal {
  sessionId: string;
  date: string;
  topic: string;
  presentIds: string[];
  absentIds: string[];
  recordedOrder: number;
}

interface AttendanceEntryView {
  sessionId: string;
  date: string;
  topic: string;
  presentIds: string[];
  absentIds: string[];
}

interface AbsentStudentSummary {
  id: string;
  name: string;
}

interface SessionSummary {
  sessionId: string;
  date: string;
  topic: string;
  presentCount: number;
  absentCount: number;
  absentStudents: AbsentStudentSummary[];
}

interface StudentAttendanceTrackerArgs {
  roster: Default<StudentSeed[], []>;
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const sanitizeStudentName = (
  value: unknown,
  fallback: string,
): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.replace(/\s+/g, " ");
};

const slugify = (value: string): string => {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const sanitizeStudentId = (
  value: unknown,
  fallback: string,
  name: string,
): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  const slug = slugify(name);
  return slug.length > 0 ? `${slug}-${fallback}` : fallback;
};

const sanitizeRoster = (
  value: readonly StudentSeed[] | undefined,
): StudentRecord[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const sanitized: StudentRecord[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const seed = value[index];
    const fallbackId = `student-${index + 1}`;
    const name = sanitizeStudentName(seed?.name, `Student ${index + 1}`);
    const id = sanitizeStudentId(seed?.id, fallbackId, name);
    if (seen.has(id)) continue;
    seen.add(id);
    sanitized.push({ id, name, sortKey: name.toLowerCase() });
  }
  sanitized.sort((left, right) => {
    const nameCompare = left.sortKey.localeCompare(right.sortKey);
    if (nameCompare !== 0) return nameCompare;
    return left.id.localeCompare(right.id);
  });
  return sanitized;
};

const sanitizeDate = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isoDatePattern.test(trimmed)) {
      return trimmed;
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return fallback;
};

const sanitizeTopic = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.replace(/\s+/g, " ");
};

const sanitizeSessionId = (
  value: unknown,
  fallback: string,
  date: string,
): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  if (date.length > 0) {
    return `${date}-${fallback}`;
  }
  return fallback;
};

const toAttendanceList = (
  event: RecordAttendanceEvent | undefined,
): AttendanceMark[] => {
  if (Array.isArray(event?.attendance)) return event.attendance;
  if (Array.isArray(event?.marks)) return event.marks;
  return [];
};

const normalizeStudentIdRef = (
  value: unknown,
  roster: readonly StudentRecord[],
): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  for (const student of roster) {
    if (student.id === trimmed) return student.id;
    if (student.id.toLowerCase() === trimmed.toLowerCase()) {
      return student.id;
    }
  }
  return null;
};

const interpretStatus = (
  mark: AttendanceMark | undefined,
): AttendanceStatus => {
  if (!mark) return "absent";
  if (typeof mark.present === "boolean") {
    return mark.present ? "present" : "absent";
  }
  const raw = mark.status;
  if (typeof raw !== "string") return "absent";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "present" || normalized === "p" || normalized === "yes") {
    return "present";
  }
  return "absent";
};

const computeAttendanceSets = (
  event: RecordAttendanceEvent | undefined,
  roster: readonly StudentRecord[],
): { present: Set<string> } => {
  const present = new Set<string>();
  const marks = toAttendanceList(event);
  for (const mark of marks) {
    const id = normalizeStudentIdRef(mark?.studentId, roster);
    if (!id) continue;
    if (interpretStatus(mark) === "present") {
      present.add(id);
    }
  }
  return { present };
};

const toOrderedAttendance = (
  roster: readonly StudentRecord[],
  present: Set<string>,
): { presentIds: string[]; absentIds: string[] } => {
  const presentIds: string[] = [];
  const absentIds: string[] = [];
  for (const student of roster) {
    if (present.has(student.id)) {
      presentIds.push(student.id);
    } else {
      absentIds.push(student.id);
    }
  }
  return { presentIds, absentIds };
};

const createAttendanceEntry = (
  event: RecordAttendanceEvent | undefined,
  roster: readonly StudentRecord[],
  order: number,
): AttendanceEntryInternal => {
  const date = sanitizeDate(event?.date, "1970-01-01");
  const topic = sanitizeTopic(event?.topic, `Session ${order}`);
  const sessionId = sanitizeSessionId(
    event?.sessionId,
    `session-${order}`,
    date,
  );
  const { present } = computeAttendanceSets(event, roster);
  const { presentIds, absentIds } = toOrderedAttendance(roster, present);
  return {
    sessionId,
    date,
    topic,
    presentIds,
    absentIds,
    recordedOrder: order,
  };
};

const compareEntries = (
  left: AttendanceEntryInternal,
  right: AttendanceEntryInternal,
): number => {
  if (left.date !== right.date) {
    return left.date.localeCompare(right.date);
  }
  if (left.sessionId !== right.sessionId) {
    return left.sessionId.localeCompare(right.sessionId);
  }
  return left.recordedOrder - right.recordedOrder;
};

const projectView = (
  entries: readonly AttendanceEntryInternal[],
): AttendanceEntryView[] => {
  return entries.map((entry) => ({
    sessionId: entry.sessionId,
    date: entry.date,
    topic: entry.topic,
    presentIds: [...entry.presentIds],
    absentIds: [...entry.absentIds],
  }));
};

const computeSummaries = (
  entries: readonly AttendanceEntryInternal[],
  roster: readonly StudentRecord[],
): SessionSummary[] => {
  const rosterById = new Map<string, StudentRecord>();
  for (const student of roster) {
    rosterById.set(student.id, student);
  }
  const sorted = [...entries].sort(compareEntries);
  return sorted.map((entry) => {
    const absentStudents: AbsentStudentSummary[] = entry.absentIds.map((id) => {
      const student = rosterById.get(id);
      return { id, name: student?.name ?? id };
    });
    return {
      sessionId: entry.sessionId,
      date: entry.date,
      topic: entry.topic,
      presentCount: entry.presentIds.length,
      absentCount: entry.absentIds.length,
      absentStudents,
    };
  });
};

const formatSessionLabel = (summary: SessionSummary): string => {
  if (summary.absentCount === 0) {
    return `${summary.date} ${summary.topic}: perfect attendance`;
  }
  const names = summary.absentStudents.map((student) => student.name).join(
    ", ",
  );
  const plural = summary.absentCount === 1 ? "absence" : "absences";
  return `${summary.date} ${summary.topic}: ${summary.absentCount} ${plural} (${names})`;
};

const recordAttendance = handler(
  (
    event: RecordAttendanceEvent | undefined,
    context: {
      log: Cell<AttendanceEntryInternal[]>;
      roster: Cell<StudentRecord[]>;
      runtimeSeed: Cell<number>;
    },
  ) => {
    const roster = context.roster.get() ?? [];
    const order = (context.runtimeSeed.get() ?? 0) + 1;
    const nextEntry = createAttendanceEntry(event, roster, order);
    const existing = context.log.get() ?? [];
    const filtered = existing.filter((entry) =>
      entry.sessionId !== nextEntry.sessionId
    );
    const updated = [...filtered, nextEntry].sort(compareEntries);
    context.log.set(updated);
    context.runtimeSeed.set(order);
  },
);

// Module-scope lift definitions
const liftRosterView = lift((value: readonly StudentSeed[] | undefined) =>
  sanitizeRoster(value)
);

const liftAttendanceLog = lift((entries: readonly AttendanceEntryInternal[]) =>
  projectView(entries)
);

const liftSessionSummaries = lift((inputs: {
  entries: AttendanceEntryInternal[];
  roster: StudentRecord[];
}) => computeSummaries(inputs.entries, inputs.roster));

const liftLatestSummary = lift((summaries: readonly SessionSummary[]) =>
  summaries.length === 0 ? null : summaries[summaries.length - 1]
);

const liftSessionAbsenceLabels = lift((summaries: readonly SessionSummary[]) =>
  summaries.map((summary) => formatSessionLabel(summary))
);

const liftTotalAbsences = lift((summaries: readonly SessionSummary[]) =>
  summaries.reduce((sum, summary) => sum + summary.absentCount, 0)
);

const liftTotalSessions = lift((summaries: readonly SessionSummary[]) =>
  summaries.length
);

const liftAbsenceWord = lift((count: number) =>
  count === 1 ? "absence" : "absences"
);

const liftSessionWord = lift((count: number) =>
  count === 1 ? "session" : "sessions"
);

export const studentAttendanceTrackerPattern = pattern<
  StudentAttendanceTrackerArgs
>(
  ({ roster }) => {
    const runtimeSeed = cell(0);

    const rosterView = liftRosterView(roster);

    const attendanceLogInternal = cell<AttendanceEntryInternal[]>([]);

    const attendanceLog = liftAttendanceLog(attendanceLogInternal);

    const sessionSummaries = liftSessionSummaries({
      entries: attendanceLogInternal,
      roster: rosterView,
    });

    const latestSummary = liftLatestSummary(sessionSummaries);

    const sessionAbsenceLabels = liftSessionAbsenceLabels(sessionSummaries);

    const totalAbsences = liftTotalAbsences(sessionSummaries);

    const totalSessions = liftTotalSessions(sessionSummaries);

    const absenceWord = liftAbsenceWord(totalAbsences);

    const sessionWord = liftSessionWord(totalSessions);

    const absenceSummaryLabel =
      str`${totalAbsences} ${absenceWord} across ${totalSessions} ${sessionWord}`;

    return {
      roster: rosterView,
      attendanceLog,
      sessionSummaries,
      latestSummary,
      sessionAbsenceLabels,
      totalAbsences,
      totalSessions,
      absenceSummaryLabel,
      recordAttendance: recordAttendance({
        log: attendanceLogInternal,
        roster: rosterView,
        runtimeSeed,
      }),
    };
  },
);

export default studentAttendanceTrackerPattern;

export type {
  AbsentStudentSummary,
  AttendanceEntryView,
  SessionSummary,
  StudentRecord,
};
