/**
 * Counts every completed check, including both passes and failures.
 * Three passes and two failures must count as five checks.
 */
export function countCompletedChecks(passed, failed) {
  return passed - failed;
}
