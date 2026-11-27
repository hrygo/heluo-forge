"""Offline tests for the diff format emitted by the pinned PR-Agent reviewer."""

import asyncio
import hashlib
import json
import runpy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

coverage = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/pr-agent-coverage.py"))
diff_files = coverage["diff_files"]

RENDERED = (
    "\n\n## File: 'src/example.py'\n\n@@ -1,3 +1,3 @@\n"
    "__new hunk__\n1  unchanged\n2 +河洛  \n3  tail\n"
    "__old hunk__\n unchanged\n-old\n tail"
)


def source_file(path, removed, added):
    return SimpleNamespace(filename=path, num_minus_lines=removed, num_plus_lines=added)


def digest(rows):
    return hashlib.sha256(rows.encode()).hexdigest()


class DiffCoverage(unittest.TestCase):
    def test_both_sides_preserve_positions_and_exact_text(self):
        self.assertEqual(diff_files(RENDERED, [source_file("src/example.py", 1, 1)], 1), [{
            "path": "src/example.py",
            "left": digest("2\told\n"),
            "right": digest("2\t河洛  \n"),
        }])

    def test_empty_new_hunk_can_include_complete_old_rows(self):
        rendered = "\n\n## File: 'src/example.py'\n\n@@ -19,2 +18,0 @@\n__new hunk__\n__old hunk__\n-first\n-"
        self.assertEqual(diff_files(rendered, [source_file("src/example.py", 2, 0)], 1), [{
            "path": "src/example.py",
            "left": digest("19\tfirst\n20\t\n"),
            "right": digest(""),
        }])

    def test_refuses_filtered_files_and_a_deletion_notice(self):
        source = [source_file("src/example.py", 1, 1)]
        with self.assertRaises(ValueError):
            diff_files(RENDERED, source, 2)
        with self.assertRaises(ValueError):
            diff_files(RENDERED + "\n\n## File 'src/deleted.py' was deleted",
                       [*source, source_file("src/deleted.py", 1, 0)], 2)

    def test_refuses_clipping_and_dropped_deletion_hunks(self):
        with self.assertRaises(ValueError):
            diff_files(RENDERED.rsplit("\n", 1)[0], [source_file("src/example.py", 1, 1)], 1)
        with self.assertRaises(ValueError):
            diff_files(RENDERED, [source_file("src/example.py", 2, 1)], 1)

    def test_refuses_ambiguous_paths_and_coordinates(self):
        for corrupted in [
            RENDERED.replace("src/example.py", "src/example.py'\n\n## File: 'extra.py"),
            RENDERED.replace("2 +河洛", "1 +河洛"),
            RENDERED + "\n\n" + RENDERED,
        ]:
            with self.subTest(corrupted=corrupted), self.assertRaises(ValueError):
                diff_files(corrupted, [source_file("src/example.py", 1, 1)], 1)


class StubHandler:
    async def _get_completion(self, **_request):
        return "stubbed model response", self.finish, None


class StubReviewer:
    patches_diff = RENDERED
    prediction_data = None
    review_chunk_count = 1
    review_failed_chunk_count = 0
    remaining_files_list = ()
    partial_files_list = ()
    incremental = SimpleNamespace(is_incremental=False)
    is_answer = False

    def __init__(self, finish, sent):
        self.ai_handler = StubHandler()
        self.ai_handler.finish = finish
        self.sent = sent
        self.git_provider = SimpleNamespace(
            get_pr_identity=lambda: {
                "provider": "github", "repo": "corp/example", "number": 42, "head_sha": "a" * 40,
            },
            pr=SimpleNamespace(base=SimpleNamespace(sha="b" * 40, ref="main"), changed_files=1),
            get_diff_files=lambda: [source_file("src/example.py", 1, 1)],
        )

    async def _get_prediction(self, model, patches_diff=None):
        messages = [{"role": "user", "content": f"The PR code diff:\n======\n{self.sent}\n======\n"}]
        response, _, _ = await self.ai_handler._get_completion(model=model, messages=messages)
        return response

    def _prepare_pr_review(self):
        self._pending_sink_output = ("review", {"merge_recommendation": "no_concerns_found"}, "")
        return "published ordinary review"


class SelectedReview(unittest.TestCase):
    def run_review(self, finish="stop", sent=RENDERED, replace_result=False, second_attempt=False,
                   action_failed=False):
        reviewer = StubReviewer(finish, sent)

        async def action():
            reviewer.prediction = await reviewer._get_prediction("synthetic-model")
            if second_attempt:
                reviewer.prediction = await reviewer._get_prediction("synthetic-model")
            if replace_result:
                reviewer.prediction = "result from a different request"
            self.assertEqual(reviewer._prepare_pr_review(), "published ordinary review")
            if action_failed:
                raise SystemExit(1)

        with tempfile.TemporaryDirectory() as temp:
            evidence_path = Path(temp) / "review.json"

            def run():
                coverage["run_with_coverage"](
                    lambda: asyncio.run(action()), StubReviewer, StubHandler, evidence_path,
                    {"runId": "7", "runAttempt": "2", "invocation": "retry"},
                )

            if action_failed:
                with self.assertRaises(SystemExit):
                    run()
            else:
                run()
            return evidence_path.read_text() if evidence_path.exists() else None

    def test_single_selected_request_binds_revision_result_and_rows(self):
        proof = self.run_review()
        self.assertEqual(json.loads(proof), {
            "version": 1, "runId": "7", "runAttempt": "2", "invocation": "retry",
            "pr": {"provider": "github", "repo": "corp/example", "number": 42, "head": "a" * 40,
                   "base": "b" * 40, "baseRef": "main"},
            "review": {"merge_recommendation": "no_concerns_found"},
            "files": [{"path": "src/example.py", "left": digest("2\told\n"), "right": digest("2\t河洛  \n")}],
        })
        self.assertNotIn("unchanged", proof)

    def test_no_proof_when_dispatched_diff_is_different(self):
        self.assertIsNone(self.run_review(sent=RENDERED.replace("河洛", "modified")))

    def test_no_proof_for_unselected_truncated_or_mixed_attempts(self):
        self.assertIsNone(self.run_review(replace_result=True))
        self.assertIsNone(self.run_review(finish="length"))
        self.assertIsNone(self.run_review(second_attempt=True))

    def test_no_proof_when_runner_fails_after_preparing_review(self):
        self.assertIsNone(self.run_review(action_failed=True))


if __name__ == "__main__":
    unittest.main()
