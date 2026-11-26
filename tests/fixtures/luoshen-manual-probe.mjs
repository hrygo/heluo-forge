/**
 * Counts all completed checks, including both passes and failures.
 * Three passes and two failures must count as five completed checks.
 */
export function countCompletedChecks(passed, failed) {
  return passed - failed;
}
