import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface MedicationDoseSeed {
  id?: string;
  name?: string;
  dosage?: string;
  scheduledTime?: string;
  instructions?: string;
}

interface MedicationDose {
  id: string;
  medication: string;
  dosage: string;
  scheduledTime: string;
  instructions: string;
}

interface DoseRecord {
  id: string;
  medication: string;
  scheduledTime: string;
  takenAt: string;
}

interface AdherenceSnapshot {
  total: number;
  taken: number;
  pending: number;
  percentage: number;
}

interface MedicationAdherenceArgs {
  doses: Default<MedicationDoseSeed[], []>;
}

interface MarkDoseEvent {
  doseId?: string;
  takenAt?: string;
}

const timePattern = /^\d{2}:\d{2}$/;

const toHoursMinutes = (value: Date): string => {
  const hours = value.getUTCHours().toString().padStart(2, "0");
  const minutes = value.getUTCMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
};

const sanitizeTime = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (timePattern.test(trimmed)) {
      return trimmed;
    }
    const attempt = new Date(trimmed);
    if (!Number.isNaN(attempt.getTime())) {
      return toHoursMinutes(attempt);
    }
  }
  return fallback;
};

const sanitizeDoseId = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const sanitizeMedicationName = (
  value: unknown,
  fallbackIndex: number,
): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return `Medication ${fallbackIndex + 1}`;
};

const sanitizeDosage = (value: unknown): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return "Standard dosage";
};

const sanitizeInstructions = (value: unknown): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return "Take with water";
};

const compareTimes = (left: string, right: string): number => {
  if (left === right) return 0;
  const [leftHours, leftMinutes] = left.split(":", 2);
  const [rightHours, rightMinutes] = right.split(":", 2);
  const leftValue = Number.parseInt(leftHours, 10) * 60 +
    Number.parseInt(leftMinutes, 10);
  const rightValue = Number.parseInt(rightHours, 10) * 60 +
    Number.parseInt(rightMinutes, 10);
  return leftValue - rightValue;
};

const toMedicationDose = (
  seed: MedicationDoseSeed | undefined,
  index: number,
  usedIds: Set<string>,
): MedicationDose => {
  const baseId = sanitizeDoseId(seed?.id, `dose-${index + 1}`);
  let id = baseId;
  let disambiguator = 1;
  while (usedIds.has(id)) {
    disambiguator += 1;
    id = `${baseId}-${disambiguator}`;
  }
  usedIds.add(id);
  const medication = sanitizeMedicationName(seed?.name, index);
  const dosage = sanitizeDosage(seed?.dosage);
  const scheduledTime = sanitizeTime(seed?.scheduledTime, "08:00");
  const instructions = sanitizeInstructions(seed?.instructions);
  return { id, medication, dosage, scheduledTime, instructions };
};

const sanitizeSchedule = (
  entries: readonly MedicationDoseSeed[] | undefined,
): MedicationDose[] => {
  if (!Array.isArray(entries)) {
    return [];
  }
  const usedIds = new Set<string>();
  const sanitized = entries.map((entry, index) =>
    toMedicationDose(entry, index, usedIds)
  );
  sanitized.sort((left, right) =>
    compareTimes(left.scheduledTime, right.scheduledTime)
  );
  return sanitized;
};

const computeAdherenceSnapshot = (
  input: { schedule: MedicationDose[]; records: DoseRecord[] },
): AdherenceSnapshot => {
  const total = input.schedule.length;
  const taken = Math.min(input.records.length, total);
  const pending = Math.max(total - taken, 0);
  const percentage = total === 0
    ? 100
    : Math.round((taken / total) * 10000) / 100;
  return { total, taken, pending, percentage };
};

const computeUpcoming = (
  input: { schedule: MedicationDose[]; records: DoseRecord[] },
): MedicationDose[] => {
  if (input.schedule.length === 0) {
    return [];
  }
  const takenIds = new Set<string>();
  for (const record of input.records) {
    takenIds.add(record.id);
  }
  return input.schedule.filter((dose) => !takenIds.has(dose.id));
};

const markDoseTaken = handler(
  (
    event: MarkDoseEvent | undefined,
    context: {
      taken: Cell<DoseRecord[]>;
      history: Cell<string[]>;
      schedule: Cell<MedicationDose[]>;
    },
  ) => {
    const schedule = context.schedule.get() ?? [];
    const id = sanitizeDoseId(event?.doseId, "");
    if (id.length === 0) return;
    const dose = schedule.find((entry) => entry.id === id);
    if (!dose) return;

    const existing = context.taken.get();
    const log = context.history.get();
    const takenRecords = Array.isArray(existing) ? existing : [];
    if (takenRecords.some((record) => record.id === id)) {
      return;
    }

    const takenAt = sanitizeTime(event?.takenAt, dose.scheduledTime);
    const nextRecords = [...takenRecords, {
      id: dose.id,
      medication: dose.medication,
      scheduledTime: dose.scheduledTime,
      takenAt,
    }];
    nextRecords.sort((left, right) =>
      compareTimes(left.scheduledTime, right.scheduledTime)
    );
    context.taken.set(nextRecords);

    const message =
      `Took ${dose.medication} scheduled for ${dose.scheduledTime} at ${takenAt}`;
    const historyEntries = Array.isArray(log) ? log : [];
    context.history.set([...historyEntries, message]);
  },
);

const resetAdherence = handler(
  (
    _event: unknown,
    context: { taken: Cell<DoseRecord[]>; history: Cell<string[]> },
  ) => {
    context.taken.set([]);
    context.history.set([]);
  },
);

// Module-scope lift definitions
const liftSanitizeSchedule = lift(sanitizeSchedule);

const liftAdherence = lift((input: {
  schedule: MedicationDose[];
  records: DoseRecord[];
}) => computeAdherenceSnapshot(input));

const liftAdherencePercentage = lift((snapshot: AdherenceSnapshot) =>
  snapshot.percentage
);
const liftTakenCount = lift((snapshot: AdherenceSnapshot) => snapshot.taken);
const liftTotalCount = lift((snapshot: AdherenceSnapshot) => snapshot.total);
const liftRemainingCount = lift((snapshot: AdherenceSnapshot) =>
  snapshot.pending
);

const liftRemainingLabel = lift((count: number) =>
  `${count} dose${count === 1 ? "" : "s"} remaining`
);

const liftUpcomingDoses = lift((input: {
  schedule: MedicationDose[];
  records: DoseRecord[];
}) => computeUpcoming(input));

export const medicationAdherencePattern = pattern<MedicationAdherenceArgs>(
  ({ doses }) => {
    const schedule = liftSanitizeSchedule(doses);
    const takenRecords = cell<DoseRecord[]>([]);
    const history = cell<string[]>([]);

    const adherence = liftAdherence({
      schedule,
      records: takenRecords,
    });

    const adherencePercentage = liftAdherencePercentage(adherence);
    const takenCount = liftTakenCount(adherence);
    const totalCount = liftTotalCount(adherence);
    const remainingCount = liftRemainingCount(adherence);

    const percentageLabel = str`${adherencePercentage}% adherence`;
    const adherenceLabel = str`${takenCount} of ${totalCount} doses taken`;
    const remainingLabel = liftRemainingLabel(remainingCount);

    const upcomingDoses = liftUpcomingDoses({
      schedule,
      records: takenRecords,
    });

    return {
      schedule,
      takenRecords,
      history,
      stats: adherence,
      adherencePercentage,
      percentageLabel,
      adherenceLabel,
      remainingLabel,
      upcomingDoses,
      markDose: markDoseTaken({
        taken: takenRecords,
        history,
        schedule,
      }),
      reset: resetAdherence({ taken: takenRecords, history }),
    };
  },
);

export type { AdherenceSnapshot, DoseRecord, MedicationDose };

export default medicationAdherencePattern;
