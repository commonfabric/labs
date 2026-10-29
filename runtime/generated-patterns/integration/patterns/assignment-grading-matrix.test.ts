import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface StudentArgument {
  id?: string;
  name?: string;
}

interface AssignmentArgument {
  id?: string;
  title?: string;
  weight?: number;
  maxScore?: number;
}

interface GradeArgument {
  studentId?: string;
  assignmentId?: string;
  score?: number;
}

export const assignmentGradingMatrixScenario: PatternIntegrationScenario<
  {
    students?: StudentArgument[];
    assignments?: AssignmentArgument[];
    grades?: GradeArgument[];
  }
> = {
  name: "assignment grading matrix tracks weighted averages",
  module: new URL(
    "./assignment-grading-matrix.pattern.ts",
    import.meta.url,
  ),
  exportName: "assignmentGradingMatrix",
  argument: {
    students: [
      { id: " S-Alex ", name: "alex rivera" },
      { name: "  bella   cho " },
      { id: " cam.ortiz ", name: "Cam ORTIZ" },
    ],
    assignments: [
      { id: " Essay-1 ", title: "  Essay Draft ", weight: 2, maxScore: 50 },
      { id: "quiz-1", title: "Quick Quiz", weight: 1, maxScore: 20 },
      { title: "Capstone", weight: 3 },
    ],
    grades: [
      { studentId: "S-Alex", assignmentId: "Essay-1", score: 46 },
      { studentId: "S-ALEX", assignmentId: "quiz-1", score: 18 },
      { studentId: "student-2", assignmentId: "Essay-1", score: 41 },
      { studentId: "student-2", assignmentId: "assignment-3", score: 92 },
      { studentId: "cam.ortiz", assignmentId: "quiz-1", score: 14 },
      { studentId: "unknown", assignmentId: "quiz-1", score: 12 },
    ],
  },
  steps: [
    {
      expect: [
        {
          path: "students",
          value: [
            { id: "s-alex", name: "Alex rivera" },
            { id: "student-2", name: "Bella cho" },
            { id: "cam-ortiz", name: "Cam ORTIZ" },
          ],
        },
        {
          path: "assignments",
          value: [
            {
              id: "essay-1",
              title: "Essay Draft",
              weight: 2,
              maxScore: 50,
            },
            {
              id: "quiz-1",
              title: "Quick Quiz",
              weight: 1,
              maxScore: 20,
            },
            {
              id: "assignment-3",
              title: "Capstone",
              weight: 3,
              maxScore: 100,
            },
          ],
        },
        {
          path: "gradeEntries",
          value: [
            { studentId: "s-alex", assignmentId: "essay-1", score: 46 },
            { studentId: "s-alex", assignmentId: "quiz-1", score: 18 },
            { studentId: "student-2", assignmentId: "essay-1", score: 41 },
            {
              studentId: "student-2",
              assignmentId: "assignment-3",
              score: 92,
            },
            { studentId: "cam-ortiz", assignmentId: "quiz-1", score: 14 },
          ],
        },
        {
          path: "gradeMatrix.rows.0",
          value: {
            studentId: "s-alex",
            studentName: "Alex rivera",
            grades: [
              {
                assignmentId: "essay-1",
                assignmentTitle: "Essay Draft",
                score: 46,
                maxScore: 50,
                percent: 92,
                weight: 2,
                completed: true,
              },
              {
                assignmentId: "quiz-1",
                assignmentTitle: "Quick Quiz",
                score: 18,
                maxScore: 20,
                percent: 90,
                weight: 1,
                completed: true,
              },
              {
                assignmentId: "assignment-3",
                assignmentTitle: "Capstone",
                score: 0,
                maxScore: 100,
                percent: 0,
                weight: 3,
                completed: false,
              },
            ],
            averagePercent: 60.67,
            weightedPercent: 45.67,
            completionPercent: 66.67,
          },
        },
        {
          path: "gradeMatrix.rows.1",
          value: {
            studentId: "student-2",
            studentName: "Bella cho",
            grades: [
              {
                assignmentId: "essay-1",
                assignmentTitle: "Essay Draft",
                score: 41,
                maxScore: 50,
                percent: 82,
                weight: 2,
                completed: true,
              },
              {
                assignmentId: "quiz-1",
                assignmentTitle: "Quick Quiz",
                score: 0,
                maxScore: 20,
                percent: 0,
                weight: 1,
                completed: false,
              },
              {
                assignmentId: "assignment-3",
                assignmentTitle: "Capstone",
                score: 92,
                maxScore: 100,
                percent: 92,
                weight: 3,
                completed: true,
              },
            ],
            averagePercent: 58,
            weightedPercent: 73.33,
            completionPercent: 66.67,
          },
        },
        {
          path: "gradeMatrix.rows.2",
          value: {
            studentId: "cam-ortiz",
            studentName: "Cam ORTIZ",
            grades: [
              {
                assignmentId: "essay-1",
                assignmentTitle: "Essay Draft",
                score: 0,
                maxScore: 50,
                percent: 0,
                weight: 2,
                completed: false,
              },
              {
                assignmentId: "quiz-1",
                assignmentTitle: "Quick Quiz",
                score: 14,
                maxScore: 20,
                percent: 70,
                weight: 1,
                completed: true,
              },
              {
                assignmentId: "assignment-3",
                assignmentTitle: "Capstone",
                score: 0,
                maxScore: 100,
                percent: 0,
                weight: 3,
                completed: false,
              },
            ],
            averagePercent: 23.33,
            weightedPercent: 11.67,
            completionPercent: 33.33,
          },
        },
        {
          path: "gradeMatrix.assignmentStats",
          value: [
            {
              assignmentId: "essay-1",
              assignmentTitle: "Essay Draft",
              averageScore: 43.5,
              maxScore: 50,
              averagePercent: 87,
              submissions: 2,
              completionPercent: 66.67,
              weight: 2,
            },
            {
              assignmentId: "quiz-1",
              assignmentTitle: "Quick Quiz",
              averageScore: 16,
              maxScore: 20,
              averagePercent: 80,
              submissions: 2,
              completionPercent: 66.67,
              weight: 1,
            },
            {
              assignmentId: "assignment-3",
              assignmentTitle: "Capstone",
              averageScore: 92,
              maxScore: 100,
              averagePercent: 92,
              submissions: 1,
              completionPercent: 33.33,
              weight: 3,
            },
          ],
        },
        {
          path: "topPerformer",
          value: {
            studentId: "student-2",
            studentName: "Bella cho",
            weightedPercent: 73.33,
            completionPercent: 66.67,
          },
        },
        {
          path: "standoutAssignment",
          value: {
            assignmentId: "assignment-3",
            assignmentTitle: "Capstone",
            averagePercent: 92,
            completionPercent: 33.33,
            submissions: 1,
          },
        },
        {
          path: "summaryLabel",
          value: "Class average 43.6% across 3 students for 3 assignments",
        },
      ],
    },
    {
      events: [{
        stream: "controls.recordGrade",
        payload: {
          studentId: "cam.ortiz",
          assignmentId: "assignment-3",
          score: 88,
        },
      }],
      expect: [
        {
          path: "gradeEntries",
          value: [
            { studentId: "s-alex", assignmentId: "essay-1", score: 46 },
            { studentId: "s-alex", assignmentId: "quiz-1", score: 18 },
            { studentId: "student-2", assignmentId: "essay-1", score: 41 },
            {
              studentId: "student-2",
              assignmentId: "assignment-3",
              score: 92,
            },
            { studentId: "cam-ortiz", assignmentId: "quiz-1", score: 14 },
            {
              studentId: "cam-ortiz",
              assignmentId: "assignment-3",
              score: 88,
            },
          ],
        },
        {
          path: "gradeMatrix.rows.2",
          value: {
            studentId: "cam-ortiz",
            studentName: "Cam ORTIZ",
            grades: [
              {
                assignmentId: "essay-1",
                assignmentTitle: "Essay Draft",
                score: 0,
                maxScore: 50,
                percent: 0,
                weight: 2,
                completed: false,
              },
              {
                assignmentId: "quiz-1",
                assignmentTitle: "Quick Quiz",
                score: 14,
                maxScore: 20,
                percent: 70,
                weight: 1,
                completed: true,
              },
              {
                assignmentId: "assignment-3",
                assignmentTitle: "Capstone",
                score: 88,
                maxScore: 100,
                percent: 88,
                weight: 3,
                completed: true,
              },
            ],
            averagePercent: 52.67,
            weightedPercent: 55.67,
            completionPercent: 66.67,
          },
        },
        {
          path: "gradeMatrix.assignmentStats.2",
          value: {
            assignmentId: "assignment-3",
            assignmentTitle: "Capstone",
            averageScore: 90,
            maxScore: 100,
            averagePercent: 90,
            submissions: 2,
            completionPercent: 66.67,
            weight: 3,
          },
        },
        {
          path: "standoutAssignment",
          value: {
            assignmentId: "assignment-3",
            assignmentTitle: "Capstone",
            averagePercent: 90,
            completionPercent: 66.67,
            submissions: 2,
          },
        },
        {
          path: "summaryLabel",
          value: "Class average 58.2% across 3 students for 3 assignments",
        },
      ],
    },
    {
      events: [{
        stream: "controls.recordGrade",
        payload: {
          studentId: "s-alex",
          assignmentId: "assignment-3",
          delta: 55,
        },
      }],
      expect: [
        {
          path: "gradeEntries",
          value: [
            { studentId: "s-alex", assignmentId: "essay-1", score: 46 },
            { studentId: "s-alex", assignmentId: "quiz-1", score: 18 },
            {
              studentId: "s-alex",
              assignmentId: "assignment-3",
              score: 55,
            },
            { studentId: "student-2", assignmentId: "essay-1", score: 41 },
            {
              studentId: "student-2",
              assignmentId: "assignment-3",
              score: 92,
            },
            { studentId: "cam-ortiz", assignmentId: "quiz-1", score: 14 },
            {
              studentId: "cam-ortiz",
              assignmentId: "assignment-3",
              score: 88,
            },
          ],
        },
        {
          path: "gradeMatrix.rows.0",
          value: {
            studentId: "s-alex",
            studentName: "Alex rivera",
            grades: [
              {
                assignmentId: "essay-1",
                assignmentTitle: "Essay Draft",
                score: 46,
                maxScore: 50,
                percent: 92,
                weight: 2,
                completed: true,
              },
              {
                assignmentId: "quiz-1",
                assignmentTitle: "Quick Quiz",
                score: 18,
                maxScore: 20,
                percent: 90,
                weight: 1,
                completed: true,
              },
              {
                assignmentId: "assignment-3",
                assignmentTitle: "Capstone",
                score: 55,
                maxScore: 100,
                percent: 55,
                weight: 3,
                completed: true,
              },
            ],
            averagePercent: 79,
            weightedPercent: 73.17,
            completionPercent: 100,
          },
        },
        {
          path: "gradeMatrix.assignmentStats.2",
          value: {
            assignmentId: "assignment-3",
            assignmentTitle: "Capstone",
            averageScore: 78.33,
            maxScore: 100,
            averagePercent: 78.33,
            submissions: 3,
            completionPercent: 100,
            weight: 3,
          },
        },
        {
          path: "standoutAssignment",
          value: {
            assignmentId: "essay-1",
            assignmentTitle: "Essay Draft",
            averagePercent: 87,
            completionPercent: 66.67,
            submissions: 2,
          },
        },
        {
          path: "summaryLabel",
          value: "Class average 67.4% across 3 students for 3 assignments",
        },
      ],
    },
  ],
};

export const scenarios = [assignmentGradingMatrixScenario];

describe("assignment-grading-matrix", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
