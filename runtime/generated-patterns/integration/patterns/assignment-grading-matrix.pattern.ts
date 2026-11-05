import { type Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface StudentInput {
  id?: string;
  name?: string;
}

interface AssignmentInput {
  id?: string;
  title?: string;
  weight?: number;
  maxScore?: number;
}

interface GradeInput {
  studentId?: string;
  assignmentId?: string;
  score?: number;
}

interface StudentRecord {
  id: string;
  name: string;
}

interface AssignmentRecord {
  id: string;
  title: string;
  weight: number;
  maxScore: number;
}

interface GradeRecord {
  studentId: string;
  assignmentId: string;
  score: number;
}

interface AssignmentStatistic {
  assignmentId: string;
  assignmentTitle: string;
  averageScore: number;
  maxScore: number;
  averagePercent: number;
  submissions: number;
  completionPercent: number;
  weight: number;
}

interface StudentGradeCell {
  assignmentId: string;
  assignmentTitle: string;
  score: number;
  maxScore: number;
  percent: number;
  weight: number;
  completed: boolean;
}

interface StudentGradeRow {
  studentId: string;
  studentName: string;
  grades: StudentGradeCell[];
  averagePercent: number;
  weightedPercent: number;
  completionPercent: number;
}

interface GradeMatrixView {
  rows: StudentGradeRow[];
  assignmentStats: AssignmentStatistic[];
  classAveragePercent: number;
  studentCount: number;
  assignmentCount: number;
}

interface TopPerformer {
  studentId: string;
  studentName: string;
  weightedPercent: number;
  completionPercent: number;
}

interface AssignmentHighlight {
  assignmentId: string;
  assignmentTitle: string;
  averagePercent: number;
  completionPercent: number;
  submissions: number;
}

interface AssignmentGradingMatrixArgs {
  students: Default<StudentInput[], []>;
  assignments: Default<AssignmentInput[], []>;
  grades: Default<GradeInput[], []>;
}

interface RecordGradeEvent {
  studentId?: string;
  assignmentId?: string;
  score?: number;
  delta?: number;
}

const roundToTwo = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const formatPercent = (value: number): string => {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toFixed(1)}%`;
};

const sanitizeIdentifier = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const normalized = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (normalized.length > 0) return normalized;
  }
  return fallback;
};

const sanitizeName = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return fallback;
  const first = trimmed.charAt(0).toUpperCase();
  return `${first}${trimmed.slice(1)}`;
};

const sanitizePositive = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = roundToTwo(value);
  if (normalized <= 0) return fallback;
  return normalized;
};

const sanitizeScore = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return roundToTwo(value);
};

const clampScore = (score: number, maxScore: number): number => {
  if (maxScore <= 0) return 0;
  if (score <= 0) return 0;
  if (score >= maxScore) return roundToTwo(maxScore);
  return roundToTwo(score);
};

const claimIdentifier = (
  used: Set<string>,
  candidate: string,
  fallback: string,
): string => {
  const base = candidate.length > 0 ? candidate : fallback;
  let next = base;
  let suffix = 2;
  while (used.has(next)) {
    next = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(next);
  return next;
};

const buildOrderMap = (ids: readonly string[]): Map<string, number> => {
  const order = new Map<string, number>();
  ids.forEach((value, index) => {
    order.set(value, index);
  });
  return order;
};

const sanitizeStudents = (value: readonly StudentInput[]): StudentRecord[] => {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  const sanitized: StudentRecord[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index] as StudentInput | undefined;
    const fallbackId = `student-${index + 1}`;
    const idCandidate = sanitizeIdentifier(raw?.id, fallbackId);
    const id = claimIdentifier(used, idCandidate, fallbackId);
    const nameFallback = `Student ${index + 1}`;
    const name = sanitizeName(raw?.name, nameFallback);
    sanitized.push({ id, name });
  }
  return sanitized;
};

const sanitizeAssignments = (
  value: readonly AssignmentInput[],
): AssignmentRecord[] => {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  const sanitized: AssignmentRecord[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index] as AssignmentInput | undefined;
    const fallbackId = `assignment-${index + 1}`;
    const idCandidate = sanitizeIdentifier(raw?.id, fallbackId);
    const id = claimIdentifier(used, idCandidate, fallbackId);
    const titleFallback = `Assignment ${index + 1}`;
    const title = sanitizeName(raw?.title, titleFallback);
    const weight = sanitizePositive(raw?.weight, 1);
    const maxScore = sanitizePositive(raw?.maxScore, 100);
    sanitized.push({ id, title, weight, maxScore });
  }
  return sanitized;
};

const sanitizeGrades = (
  value: unknown,
  students: readonly StudentRecord[],
  assignments: readonly AssignmentRecord[],
): GradeRecord[] => {
  if (!Array.isArray(value)) return [];
  const studentOrder = buildOrderMap(students.map((student) => student.id));
  const assignmentOrder = buildOrderMap(
    assignments.map((assignment) => assignment.id),
  );
  const assignmentById = new Map<string, AssignmentRecord>();
  for (const assignment of assignments) {
    assignmentById.set(assignment.id, assignment);
  }
  const map = new Map<string, GradeRecord>();
  for (const entry of value as GradeInput[]) {
    if (!entry) continue;
    const studentId = sanitizeIdentifier(entry.studentId, "");
    const assignmentId = sanitizeIdentifier(entry.assignmentId, "");
    if (!studentOrder.has(studentId)) continue;
    const assignment = assignmentById.get(assignmentId);
    if (!assignment) continue;
    const scoreValue = sanitizeScore(entry.score) ?? 0;
    const clamped = clampScore(scoreValue, assignment.maxScore);
    const key = `${studentId}::${assignmentId}`;
    map.set(key, { studentId, assignmentId, score: clamped });
  }
  const sanitized = Array.from(map.values());
  sanitized.sort((left, right) => {
    const studentDiff = (studentOrder.get(left.studentId) ?? 0) -
      (studentOrder.get(right.studentId) ?? 0);
    if (studentDiff !== 0) return studentDiff;
    return (assignmentOrder.get(left.assignmentId) ?? 0) -
      (assignmentOrder.get(right.assignmentId) ?? 0);
  });
  return sanitized;
};

const buildGradeMatrix = (
  entries: readonly GradeRecord[],
  students: readonly StudentRecord[],
  assignments: readonly AssignmentRecord[],
): GradeMatrixView => {
  const entryMap = new Map<string, GradeRecord>();
  for (const entry of entries) {
    const key = `${entry.studentId}::${entry.assignmentId}`;
    entryMap.set(key, entry);
  }
  const rows: StudentGradeRow[] = [];
  let weightedTotal = 0;
  let weightedCount = 0;
  for (const student of students) {
    const cells: StudentGradeCell[] = [];
    let percentSum = 0;
    let weightedSum = 0;
    let weightTotal = 0;
    let completed = 0;
    for (const assignment of assignments) {
      const key = `${student.id}::${assignment.id}`;
      const grade = entryMap.get(key);
      const score = grade?.score ?? 0;
      const percent = assignment.maxScore === 0
        ? 0
        : roundToTwo((score / assignment.maxScore) * 100);
      const isCompleted = grade !== undefined;
      if (isCompleted) completed += 1;
      percentSum += percent;
      weightedSum += percent * assignment.weight;
      weightTotal += assignment.weight;
      cells.push({
        assignmentId: assignment.id,
        assignmentTitle: assignment.title,
        score: roundToTwo(score),
        maxScore: assignment.maxScore,
        percent,
        weight: assignment.weight,
        completed: isCompleted,
      });
    }
    const averagePercent = assignments.length === 0
      ? 0
      : roundToTwo(percentSum / assignments.length);
    const weightedPercent = weightTotal === 0
      ? 0
      : roundToTwo(weightedSum / weightTotal);
    const completionPercent = assignments.length === 0
      ? 0
      : roundToTwo((completed / assignments.length) * 100);
    rows.push({
      studentId: student.id,
      studentName: student.name,
      grades: cells,
      averagePercent,
      weightedPercent,
      completionPercent,
    });
    weightedTotal += weightedPercent;
    weightedCount += 1;
  }
  const classAveragePercent = weightedCount === 0
    ? 0
    : roundToTwo(weightedTotal / weightedCount);
  const assignmentStats: AssignmentStatistic[] = assignments.map(
    (assignment) => {
      let totalScore = 0;
      let submissions = 0;
      for (const student of students) {
        const key = `${student.id}::${assignment.id}`;
        const grade = entryMap.get(key);
        if (!grade) continue;
        totalScore += grade.score;
        submissions += 1;
      }
      const averageScore = submissions === 0
        ? 0
        : roundToTwo(totalScore / submissions);
      const averagePercent = assignment.maxScore === 0
        ? 0
        : roundToTwo((averageScore / assignment.maxScore) * 100);
      const completionPercent = students.length === 0
        ? 0
        : roundToTwo((submissions / students.length) * 100);
      return {
        assignmentId: assignment.id,
        assignmentTitle: assignment.title,
        averageScore,
        maxScore: assignment.maxScore,
        averagePercent,
        submissions,
        completionPercent,
        weight: assignment.weight,
      };
    },
  );
  return {
    rows,
    assignmentStats,
    classAveragePercent,
    studentCount: rows.length,
    assignmentCount: assignments.length,
  };
};

const identifyTopPerformer = (matrix: GradeMatrixView): TopPerformer => {
  if (matrix.rows.length === 0) {
    return {
      studentId: "none",
      studentName: "none",
      weightedPercent: 0,
      completionPercent: 0,
    };
  }
  let best = matrix.rows[0];
  for (let index = 1; index < matrix.rows.length; index += 1) {
    const current = matrix.rows[index];
    if (current.weightedPercent > best.weightedPercent) {
      best = current;
      continue;
    }
    if (current.weightedPercent === best.weightedPercent) {
      if (current.completionPercent > best.completionPercent) {
        best = current;
        continue;
      }
      if (
        current.completionPercent === best.completionPercent &&
        current.studentName.localeCompare(best.studentName) < 0
      ) {
        best = current;
      }
    }
  }
  return {
    studentId: best.studentId,
    studentName: best.studentName,
    weightedPercent: best.weightedPercent,
    completionPercent: best.completionPercent,
  };
};

const highlightAssignment = (
  stats: readonly AssignmentStatistic[],
): AssignmentHighlight => {
  if (stats.length === 0) {
    return {
      assignmentId: "none",
      assignmentTitle: "none",
      averagePercent: 0,
      completionPercent: 0,
      submissions: 0,
    };
  }
  let best = stats[0];
  for (let index = 1; index < stats.length; index += 1) {
    const current = stats[index];
    if (current.averagePercent > best.averagePercent) {
      best = current;
      continue;
    }
    if (current.averagePercent === best.averagePercent) {
      if (current.completionPercent > best.completionPercent) {
        best = current;
        continue;
      }
      if (
        current.completionPercent === best.completionPercent &&
        current.assignmentTitle.localeCompare(best.assignmentTitle) < 0
      ) {
        best = current;
      }
    }
  }
  return {
    assignmentId: best.assignmentId,
    assignmentTitle: best.assignmentTitle,
    averagePercent: best.averagePercent,
    completionPercent: best.completionPercent,
    submissions: best.submissions,
  };
};

const updateGradeEntries = (
  list: readonly GradeRecord[],
  event: RecordGradeEvent | undefined,
  students: readonly StudentRecord[],
  assignments: readonly AssignmentRecord[],
): GradeRecord[] => {
  if (!event) return [...list];
  const studentId = sanitizeIdentifier(event.studentId, "");
  const assignmentId = sanitizeIdentifier(event.assignmentId, "");
  if (studentId.length === 0 || assignmentId.length === 0) {
    return [...list];
  }
  const studentExists = students.some((student) => student.id === studentId);
  if (!studentExists) return [...list];
  const assignment = assignments.find((item) => item.id === assignmentId);
  if (!assignment) return [...list];
  const absolute = sanitizeScore(event.score);
  const delta = sanitizeScore(event.delta);
  let nextScore: number | null = null;
  if (absolute !== null) {
    nextScore = clampScore(absolute, assignment.maxScore);
  } else if (delta !== null && delta !== 0) {
    const current = list.find((entry) =>
      entry.studentId === studentId && entry.assignmentId === assignmentId
    );
    const base = current?.score ?? 0;
    nextScore = clampScore(base + delta, assignment.maxScore);
  }
  if (nextScore === null) return [...list];
  const updated: GradeRecord[] = [];
  let replaced = false;
  for (const entry of list) {
    if (entry.studentId === studentId && entry.assignmentId === assignmentId) {
      if (!replaced) {
        updated.push({ studentId, assignmentId, score: nextScore });
        replaced = true;
      }
      continue;
    }
    updated.push(entry);
  }
  if (!replaced) {
    updated.push({ studentId, assignmentId, score: nextScore });
  }
  const studentOrder = buildOrderMap(students.map((student) => student.id));
  const assignmentOrder = buildOrderMap(
    assignments.map((assignment) => assignment.id),
  );
  updated.sort((left, right) => {
    const studentDiff = (studentOrder.get(left.studentId) ?? 0) -
      (studentOrder.get(right.studentId) ?? 0);
    if (studentDiff !== 0) return studentDiff;
    return (assignmentOrder.get(left.assignmentId) ?? 0) -
      (assignmentOrder.get(right.assignmentId) ?? 0);
  });
  return updated;
};

const recordGrade = handler(
  (
    event: RecordGradeEvent | undefined,
    context: {
      rawGrades: Cell<GradeInput[]>;
      students: Cell<StudentRecord[]>;
      assignments: Cell<AssignmentRecord[]>;
    },
  ) => {
    const students = context.students.get();
    const assignments = context.assignments.get();
    const studentList = Array.isArray(students) ? students : [];
    const assignmentList = Array.isArray(assignments) ? assignments : [];
    const existing = sanitizeGrades(
      context.rawGrades.get(),
      studentList,
      assignmentList,
    );
    const next = updateGradeEntries(
      existing,
      event,
      studentList,
      assignmentList,
    );
    context.rawGrades.set(next.map((entry) => ({ ...entry })));
  },
);

const liftSanitizeStudents = lift(sanitizeStudents);

const liftSanitizeAssignments = lift(sanitizeAssignments);

const liftGradeEntries = lift((input: {
  entries: GradeInput[] | undefined;
  students: StudentRecord[];
  assignments: AssignmentRecord[];
}) => {
  const baseEntries = Array.isArray(input.entries) ? input.entries : [];
  return sanitizeGrades(baseEntries, input.students, input.assignments);
});

const liftGradeMatrix = lift((input: {
  entries: GradeRecord[];
  students: StudentRecord[];
  assignments: AssignmentRecord[];
}) => {
  return buildGradeMatrix(input.entries, input.students, input.assignments);
});

const liftClassAverageText = lift((matrix: GradeMatrixView) =>
  formatPercent(matrix.classAveragePercent)
);

const liftStudentCountText = lift((matrix: GradeMatrixView) =>
  `${matrix.studentCount}`
);

const liftAssignmentCountText = lift((matrix: GradeMatrixView) =>
  `${matrix.assignmentCount}`
);

export const assignmentGradingMatrix = pattern<AssignmentGradingMatrixArgs>(
  ({ students, assignments, grades }) => {
    const sanitizedStudents = liftSanitizeStudents(students);
    const sanitizedAssignments = liftSanitizeAssignments(assignments);
    const gradeEntries = liftGradeEntries({
      entries: grades,
      students: sanitizedStudents,
      assignments: sanitizedAssignments,
    });
    const gradeMatrix = liftGradeMatrix({
      entries: gradeEntries,
      students: sanitizedStudents,
      assignments: sanitizedAssignments,
    });
    const topPerformer = identifyTopPerformer(gradeMatrix);
    const standoutAssignment = highlightAssignment(gradeMatrix.assignmentStats);
    const classAverageText = liftClassAverageText(gradeMatrix);
    const studentCountText = liftStudentCountText(gradeMatrix);
    const assignmentCountText = liftAssignmentCountText(gradeMatrix);
    const summaryLabel =
      str`Class average ${classAverageText} across ${studentCountText} students for ${assignmentCountText} assignments`;

    return {
      students: sanitizedStudents,
      assignments: sanitizedAssignments,
      gradeEntries,
      gradeMatrix,
      topPerformer,
      standoutAssignment,
      summaryLabel,
      controls: {
        recordGrade: recordGrade({
          rawGrades: grades,
          students: sanitizedStudents,
          assignments: sanitizedAssignments,
        }),
      },
    };
  },
);

export default assignmentGradingMatrix;
