import * as assert from "assert";
import {
  assessmentFromDetails,
  formatLabReference,
  parseLabReference,
  parseLabReferences,
} from "../manual";
import type { AutolabAssessmentDetails } from "../types";

suite("Manually added Autolab labs", () => {
  test("parses a lab page URL", () => {
    assert.deepStrictEqual(
      parseLabReference("https://cs.lhs.fuhsd.org/courses/apcsa-f26/assessments/lab3"),
      { course: "apcsa-f26", assessment: "lab3" },
    );
  });

  test("parses a course URL and an installation served under a path", () => {
    assert.deepStrictEqual(
      parseLabReference("https://example.edu/autolab/courses/15122"),
      { course: "15122", assessment: undefined },
    );
  });

  test("ignores query strings, fragments, and surrounding whitespace", () => {
    assert.deepStrictEqual(
      parseLabReference("  https://example.edu/courses/c1/assessments/lab1?tab=handin#top  "),
      { course: "c1", assessment: "lab1" },
    );
  });

  test("decodes escaped course and lab names", () => {
    assert.deepStrictEqual(
      parseLabReference("https://example.edu/courses/intro%20cs/assessments/lab%201"),
      { course: "intro cs", assessment: "lab 1" },
    );
  });

  test("accepts the course/lab shorthand and a bare course name", () => {
    assert.deepStrictEqual(parseLabReference("c1/lab1"), { course: "c1", assessment: "lab1" });
    assert.deepStrictEqual(parseLabReference("c1"), { course: "c1" });
  });

  test("rejects a URL pointing at a different Autolab server", () => {
    assert.throws(
      () => parseLabReference("https://other.edu/courses/c1/assessments/lab1", "https://example.edu"),
      /other\.edu/,
    );
    assert.doesNotThrow(
      () => parseLabReference("https://example.edu/courses/c1/assessments/lab1", "https://example.edu"),
    );
  });

  test("rejects input with no course in it", () => {
    assert.throws(() => parseLabReference(""), /course or lab URL/);
    assert.throws(() => parseLabReference("https://example.edu/profile"), /Could not find a course/);
    assert.throws(() => parseLabReference("a/b/c/d"), /lab URL/);
  });

  test("drops malformed and duplicate configured entries", () => {
    const labs = parseLabReferences([
      "https://example.edu/courses/c1/assessments/lab1",
      "c1/lab1",
      "https://example.edu/profile",
      "c1/lab2",
    ]);
    assert.deepStrictEqual(labs.map(formatLabReference), ["c1/lab1", "c1/lab2"]);
  });

  test("fills a placeholder lab in from the assessment details", () => {
    const details = {
      name: "lab3",
      display_name: "Lab 3: Recursion",
      start_at: "2026-09-01T00:00:00Z",
      due_at: "2026-09-08T23:59:00Z",
      end_at: null,
      category_name: "Labs",
    } as AutolabAssessmentDetails;

    assert.deepStrictEqual(assessmentFromDetails("lab3", details), {
      name: "lab3",
      display_name: "Lab 3: Recursion",
      start_at: "2026-09-01T00:00:00Z",
      due_at: "2026-09-08T23:59:00Z",
      end_at: null,
      category_name: "Labs",
    });
  });

  test("keeps the lab name visible when details cannot be loaded", () => {
    assert.deepStrictEqual(assessmentFromDetails("lab3", undefined), {
      name: "lab3",
      display_name: "lab3",
      start_at: null,
      due_at: null,
      end_at: null,
    });
  });
});
