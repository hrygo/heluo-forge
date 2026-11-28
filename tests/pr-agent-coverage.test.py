"""Offline tests for the diff format emitted by the pinned PR-Agent reviewer."""

import asyncio
import hashlib
import json
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

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
        messages = [{"role": "user", "content": f"{getattr(self, 'sent_context', '')}\n"
                     f"The PR code diff:\n======\n{self.sent}\n======\n"}]
        response, _, _ = await self.ai_handler._get_completion(model=model, messages=messages)
        return response

    def _prepare_pr_review(self):
        self._pending_sink_output = ("review", {"merge_recommendation": "no_concerns_found"}, "")
        return "published ordinary review"


class SelectedReview(unittest.TestCase):
    def run_review(self, finish="stop", sent=RENDERED, replace_result=False, second_attempt=False,
                   action_failed=False, missing_observer_state=False, context=None, include_context=True):
        reviewer = StubReviewer(finish, sent)
        if missing_observer_state:
            reviewer.incremental = SimpleNamespace()
        if context:
            reviewer.git_provider.pr.changed_files = 4
            if include_context:
                reviewer.sent_context = coverage["review_context_text"](context)

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
                    {"runId": "7", "runAttempt": "2", "invocation": "retry"}, context,
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

    def test_missing_observer_state_keeps_the_ordinary_review(self):
        self.assertIsNone(self.run_review(missing_observer_state=True))

    def test_delta_evidence_requires_the_actual_request_to_contain_captured_history(self):
        context = {"mode": "incremental", "head": "a" * 40, "previousHead": "c" * 40,
                   "files": [{}], "checks": None, "threads": []}
        proof = json.loads(self.run_review(context=context))
        self.assertEqual(proof["version"], 2)
        self.assertEqual(proof["previousHead"], context["previousHead"])
        self.assertEqual(len(proof["files"]), 1)
        self.assertIsNone(self.run_review(context=context, include_context=False))


class ReviewPresentation(unittest.TestCase):
    def test_optional_findings_are_folded_without_changing_the_structured_review(self):
        original = {"review": {"key_issues_to_review": [
            {"issue_header": "[P1] Current regression", "issue_content": "A required check is skipped."},
            {"issue_header": "[P2] Optional check", "issue_content": "Check <input> and @user."},
            {"issue_header": "[P3] Optional clarity", "issue_content": "Make this name clearer."},
        ]}}
        rendered = coverage["render_review_findings"](
            lambda data: "\n".join(issue["issue_header"] for issue in data["review"]["key_issues_to_review"]), original,
        )
        self.assertTrue(rendered.startswith("[P1] Current regression\n"))
        core, optional = rendered.split("<details>", 1)
        self.assertNotIn("[P2]", core)
        self.assertIn("可选改进建议", optional)
        self.assertIn("[P2] Optional check", optional)
        self.assertIn("[P3] Optional clarity", optional)
        self.assertIn("&lt;input&gt;", optional)
        self.assertNotIn("@user", optional)
        self.assertEqual(len(original["review"]["key_issues_to_review"]), 3)


class NativeReviewContext(unittest.TestCase):
    def run_review(self, responses, *, files=("src/example.py",), pending=(), failed_chunks=0):
        context = {"mode": "incremental", "repository": "corp/example", "prNumber": 42,
                   "head": "a" * 40, "base": "b" * 40, "baseRef": "main", "previousHead": "c" * 40,
                   "threads": list(pending), "checks": None, "receipt": "<!-- captured review -->",
                   "files": [{"filename": name, "patch": "@@ -1 +1 @@\n-old\n+new", "status": "modified",
                              "additions": 1, "deletions": 1} for name in files]}
        repo = SimpleNamespace(full_name=context["repository"])
        pull = SimpleNamespace(state="open", head=SimpleNamespace(sha=context["head"], repo=repo),
                               base=SimpleNamespace(sha=context["base"], ref=context["baseRef"], repo=repo))
        result = SimpleNamespace(body=None, structured=None, paths=[], omitted=[], system=None)
        provider = SimpleNamespace(
            pr=pull, get_pr_identity=lambda: {"provider": "github", "repo": repo.full_name, "number": 42,
                                              "head_sha": context["head"]},
            _get_repo=lambda: SimpleNamespace(get_pull=lambda _: pull,
                                              get_git_ref=lambda _: SimpleNamespace(object=SimpleNamespace(sha=context["base"]))),
            publish_persistent_comment_full=lambda body, **_: setattr(result, "body", body),
            get_diff_files=lambda: [], get_filtered_diff_file_names=lambda: [],
        )
        settings = SimpleNamespace(config=SimpleNamespace(publish_output=True), pr_review_prompt=SimpleNamespace(system=(
            "class Review(BaseModel):\n    key_issues_to_review: list\n\nclass PRReview(BaseModel):\n    review: Review\n")))

        def native_merge(outputs, related_tickets=None, max_findings=None):
            combined = {**outputs[0]["review"]}
            combined["key_issues_to_review"] = [issue for output in outputs
                                               for issue in output["review"]["key_issues_to_review"]][:max_findings]
            return {"review": combined}

        class FakeReviewer:
            def __init__(self):
                self.git_provider = provider
                self.incremental = SimpleNamespace(is_incremental=False)
                self.is_answer = False
                self.vars = {}
                self.review_failed_chunk_count = failed_chunks
                self.remaining_files_list = []
                self.partial_files_list = []
                self.prediction_data = None

            def _prepare_pr_review(self):
                result.structured = self.prediction_data or responses[0]
                return native.convert_to_markdown_v2(result.structured)

            async def run(self):
                pass

        native = SimpleNamespace(PRReviewer=FakeReviewer, merge_review_chunks=native_merge, get_settings=lambda: settings,
                                 PRReviewHeader=SimpleNamespace(REGULAR=SimpleNamespace(value="## PR Reviewer Guide")),
                                 PRReviewIdentity=SimpleNamespace(REGULAR=SimpleNamespace(value="<!-- pr-agent:review:full -->")),
                                 convert_to_markdown_v2=lambda data: json.dumps(data))

        def run():
            reviewer = native.PRReviewer()
            result.paths = [file.filename for file in provider.get_diff_files()]
            result.omitted = provider.get_filtered_diff_file_names()
            result.system = settings.pr_review_prompt.system
            if not result.paths:
                asyncio.run(reviewer.run())
                return
            if len(responses) > 1:
                reviewer.prediction_data = native.merge_review_chunks(responses, max_findings=10)
            provider.publish_persistent_comment_full(reviewer._prepare_pr_review())

        filters = {
            "pr_agent.algo.comment_identity": SimpleNamespace(format_pr_review_header=lambda: "## PR Reviewer Guide 🔍"),
            "pr_agent.algo.file_filter": SimpleNamespace(filter_ignored=lambda patches: [
                file for file in patches if not file.filename.startswith("vendor/")]),
            "pr_agent.algo.language_handler": SimpleNamespace(partition_files_by_language_filter=lambda patches: (
                [file for file in patches if file.filename != "pnpm-lock.yaml"],
                [file.filename for file in patches if file.filename == "pnpm-lock.yaml"],
            )),
        }
        with patch.dict(sys.modules, filters):
            coverage["run_with_review_context"](run, native, context, SimpleNamespace,
                                                SimpleNamespace(ADDED="added", MODIFIED="modified"))
        return result

    @staticmethod
    def response(headers=(), recheck=None):
        review = {"risk_level": "low", "security_concerns": "No",
                  "key_issues_to_review": [{"issue_header": header} for header in headers]}
        if recheck is not None:
            review["history_recheck"] = recheck
        return {"review": review}

    @staticmethod
    def thread(thread_id, resolved=False):
        return {"id": thread_id, "priority": "P1", "resolved": resolved, "path": "src/example.py", "end": 2,
                "lastReply": ""}

    def test_chunked_structured_result_and_summary_keep_later_blockers_before_optional_items(self):
        early = self.response([f"[P{3 - index % 2}] Optional {index}" for index in range(10)])
        late = self.response(["[P1] Blocking regression", "[P0] Data loss"])
        result = self.run_review([early, late])
        headings = [item["issue_header"] for item in result.structured["review"]["key_issues_to_review"]]
        self.assertEqual(headings[:3], ["[P0] Data loss", "[P1] Blocking regression", "[P2] Optional 1"])
        self.assertEqual(headings[-1], "[P3] Optional 4")
        self.assertEqual(len(headings), 10)
        self.assertIn("[P1] Blocking regression", result.body.split("<details>", 1)[0])
        self.assertEqual(result.structured["review"]["risk_level"], "low")

    def test_incremental_prompt_declares_history_and_summary_uses_only_captured_blockers(self):
        result = self.run_review([self.response(recheck=[
            {"thread_id": 11, "status": "fix_evidence_found", "evidence": "Was fixed in <hunk> by @author."},
            {"thread_id": 99, "status": "still_present", "evidence": "Uncaptured finding"},
            {"thread_id": 44, "status": "still_present", "evidence": "Resolved finding"},
        ])], pending=[self.thread(11), self.thread(22), self.thread(44, resolved=True)])
        self.assertIn("history_recheck: List[HistoricalReviewCheck]", result.system)
        self.assertIn("discussion_r11) · 模型发现修复证据", result.body)
        self.assertIn("Was fixed in &lt;hunk&gt; by &#64;author.", result.body)
        self.assertIn("discussion_r22) · 待人工复核", result.body)
        self.assertNotIn("Uncaptured finding", result.body)
        self.assertNotIn("Resolved finding", result.body)

    def test_history_combines_visible_evidence_and_withholds_conflicting_or_incomplete_results(self):
        pending = [self.thread(11), self.thread(22)]
        first = self.response(recheck=[{"thread_id": 11, "status": "insufficient_evidence", "evidence": ""},
                                       {"thread_id": 22, "status": "still_present", "evidence": "Still occurs."}])
        second = self.response(recheck=[{"thread_id": 11, "status": "fix_evidence_found", "evidence": "Guard added."},
                                        {"thread_id": 22, "status": "fix_evidence_found", "evidence": "Guard added."}])
        result = self.run_review([first, second], pending=pending)
        self.assertIn("discussion_r11) · 模型发现修复证据", result.body)
        self.assertIn("discussion_r22) · 待人工复核", result.body)
        partial = self.run_review([first, second], pending=pending, failed_chunks=1)
        self.assertIn("discussion_r11) · 待人工复核", partial.body)

    def test_incremental_excludes_ignored_and_generated_files_and_discloses_both(self):
        result = self.run_review([self.response()], files=("src/example.py", "pnpm-lock.yaml", "vendor/generated.py"))
        self.assertEqual(result.paths, ["src/example.py"])
        self.assertEqual(result.omitted, ["pnpm-lock.yaml", "vendor/generated.py"])
        self.assertIn("本轮未评审", result.body)
        self.assertIn("pnpm-lock.yaml", result.body)
        self.assertIn("vendor/generated.py", result.body)

    def test_all_filtered_publishes_only_scope_without_creating_a_verdict(self):
        result = self.run_review([self.response()], files=("pnpm-lock.yaml", "vendor/generated.py"))
        self.assertEqual(result.paths, [])
        self.assertIsNone(result.structured)
        self.assertIn("本轮增量文件均被过滤，未启动模型评审", result.body or "")
        self.assertTrue(result.body.endswith("\n\n<!-- heluo-forge-pr-agent-review-scope-only:v1 -->\n\n<!-- captured review -->"))


if __name__ == "__main__":
    unittest.main()
