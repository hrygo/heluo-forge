"""Attest the exact changed rows sent by the pinned PR-Agent v0.50.0 review."""

import json
import os
import re
from contextvars import ContextVar
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

FILE_HEADER = re.compile(r"## File: '([^\r\n]+)'")
HUNK_HEADER = re.compile(r"@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@(?: .*)?")
DIFF_LABEL = "The PR code diff:\n======\n"
REVIEW_END = "\n======\n"
NEW_HUNK = "__new hunk__"
OLD_HUNK = "__old hunk__"


def changed_hunk(lines, index, header, left, right):
    old_line, old_size, new_line, new_size = (int(value or 1) for value in header.groups())
    if (
        (old_line == 0 and old_size) or (new_line == 0 and new_size)
        or index >= len(lines) or lines[index] != NEW_HUNK
        or index + new_size >= len(lines)
    ):
        raise ValueError("Invalid new hunk")
    index += 1
    added = removed = 0
    for line in range(new_line, new_line + new_size):
        prefix = f"{line} "
        row = lines[index]
        index += 1
        if not row.startswith((prefix + " ", prefix + "+")):
            raise ValueError("Invalid new row")
        if row[len(prefix)] == "+":
            if line in right:
                raise ValueError("Duplicate new row")
            right[line] = row[len(prefix) + 1:]
            added += 1

    if index < len(lines) and lines[index] == OLD_HUNK:
        index += 1
        if index + old_size > len(lines):
            raise ValueError("Truncated old hunk")
        for line in range(old_line, old_line + old_size):
            row = lines[index]
            index += 1
            if not row.startswith((" ", "-")):
                raise ValueError("Invalid old row")
            if row.startswith("-"):
                if line in left:
                    raise ValueError("Duplicate old row")
                left[line] = row[1:]
                removed += 1

    if not (added or removed) or old_size - removed != new_size - added:
        raise ValueError("Incomplete hunk")
    return index


def digest_rows(rows):
    digest = sha256()
    for line, text in sorted(rows.items()):
        digest.update(f"{line}\t{text}\n".encode())
    return digest.hexdigest()


def diff_files(diff, source_files, changed_files):
    """Read the pinned review prompt's line-numbered patch format without trimming code."""
    source = {file.filename: file for file in source_files}
    if (
        type(changed_files) is not int or changed_files < 1
        or len(source) != len(source_files) or len(source) != changed_files
    ):
        raise ValueError("Incomplete source file list")

    lines = diff.split("\n")
    files = []
    covered = set()
    index = 0
    while index < len(lines):
        header = FILE_HEADER.fullmatch(lines[index])
        if header is None:
            if lines[index] != "":
                raise ValueError("Unexpected diff section")
            index += 1
            continue
        path = header[1]
        if path not in source or path in covered or path != path.strip():
            raise ValueError("Unexpected path")
        covered.add(path)
        index += 1
        left = {}
        right = {}
        while index < len(lines) and not lines[index].startswith("## File"):
            row = lines[index]
            index += 1
            if not row:
                continue
            hunk = HUNK_HEADER.fullmatch(row)
            if not hunk:
                raise ValueError("Unexpected hunk section")
            index = changed_hunk(lines, index, hunk, left, right)

        file = source[path]
        if (
            not (left or right)
            or len(left) != file.num_minus_lines or len(right) != file.num_plus_lines
        ):
            raise ValueError("Incomplete changed rows")
        files.append({"path": path, "left": digest_rows(left), "right": digest_rows(right)})

    if covered != source.keys():
        raise ValueError("Missing changed files")
    return files


def revision(reviewer):
    provider = reviewer.git_provider
    identity = provider.get_pr_identity()
    base = provider.pr.base
    return {
        "provider": identity["provider"],
        "repo": identity["repo"],
        "number": int(identity["number"]),
        "head": identity["head_sha"],
        "base": base.sha,
        "baseRef": base.ref,
    }


def diff_in_messages(diff, request):
    # Verify the diff in the messages handed to the transport. Extra-body input overrides
    # and non-text user messages fall outside the pinned GitHub review request format.
    extra = request.get("extra_body") or {}
    messages = request.get("messages") or []
    content = [message.get("content") for message in messages if message.get("role") == "user"]
    if not diff or {"messages", "input", "truncation"}.intersection(extra) or len(content) != 1:
        return False
    return isinstance(content[0], str) and content[0].count(f"{DIFF_LABEL}{diff}{REVIEW_END}") == 1


@dataclass
class ReviewAttempt:
    reviewer: object
    diff: str
    revision: dict | None
    calls: int = 0
    response: str | None = None


def run_with_coverage(run, reviewer_type, handler_type, evidence_path, invocation):
    """Run the original action with request-local evidence from its selected review."""
    current = ContextVar("review_attempt", default=None)
    attempts = []
    evidence = []
    predict = reviewer_type._get_prediction
    complete = handler_type._get_completion
    prepare = reviewer_type._prepare_pr_review

    async def observe_prediction(reviewer, model, patches_diff=None):
        diff = reviewer.patches_diff if patches_diff is None else patches_diff
        try:
            pr = revision(reviewer)
        except (AttributeError, KeyError, TypeError, ValueError):
            pr = None
        attempt = ReviewAttempt(reviewer, diff, pr)
        attempts.append(attempt)
        reset = current.set(attempt)
        try:
            return await predict(reviewer, model, patches_diff)
        finally:
            current.reset(reset)

    async def observe_completion(handler, **request):
        attempt = current.get()
        if attempt is not None:
            attempt.calls += 1
        result = await complete(handler, **request)
        if attempt is not None and attempt.reviewer.ai_handler is handler and result[1] == "stop":
            try:
                if diff_in_messages(attempt.diff, request):
                    attempt.response = result[0]
            except (AttributeError, TypeError):
                pass
        return result

    def observe_review(reviewer):
        markdown = prepare(reviewer)
        if len(attempts) != 1 or not markdown:
            return markdown
        attempt = attempts[0]
        try:
            if (
                attempt.reviewer is not reviewer or attempt.calls != 1 or not attempt.response
                or reviewer.prediction is not attempt.response or reviewer.prediction_data is not None
                or reviewer.review_chunk_count != 1 or reviewer.review_failed_chunk_count
                or reviewer.remaining_files_list or reviewer.partial_files_list
                or reviewer.incremental.is_incremental or reviewer.is_answer
            ):
                return markdown
            pr = revision(reviewer)
            if attempt.revision != pr or pr["provider"] != "github":
                return markdown
            kind, review, _ = reviewer._pending_sink_output
            if kind != "review" or not isinstance(review, dict):
                return markdown
            provider = reviewer.git_provider
            files = diff_files(attempt.diff, provider.get_diff_files(), provider.pr.changed_files)
            evidence.append({
                "version": 1,
                "runId": invocation["runId"],
                "runAttempt": invocation["runAttempt"],
                "invocation": invocation["invocation"],
                "pr": pr,
                "review": review,
                "files": files,
            })
        except Exception:
            # This observer is outside the ordinary review path. Any unknown
            # upstream shape or inability to confirm coverage withholds proof.
            pass
        return markdown

    reviewer_type._get_prediction = observe_prediction
    handler_type._get_completion = observe_completion
    reviewer_type._prepare_pr_review = observe_review
    try:
        run()
    finally:
        reviewer_type._get_prediction = predict
        handler_type._get_completion = complete
        reviewer_type._prepare_pr_review = prepare
    if len(attempts) == 1 and len(evidence) == 1:
        try:
            payload = json.dumps(evidence[0], ensure_ascii=True, allow_nan=False)
            with evidence_path.open("x", encoding="utf-8") as output:
                output.write(payload + "\n")
        except (OSError, TypeError, ValueError):
            # The review is already published. Missing evidence leaves approval disabled.
            pass


def main():
    from pr_agent.algo.ai_handlers.litellm_ai_handler import LiteLLMAIHandler
    from pr_agent.servers.github_action_runner import main as run
    from pr_agent.tools.pr_reviewer import PRReviewer

    path = os.getenv("PR_AGENT_COVERAGE_PATH")
    phase = os.getenv("PR_AGENT_COVERAGE_INVOCATION")
    run_id = os.getenv("GITHUB_RUN_ID", "")
    run_attempt = os.getenv("GITHUB_RUN_ATTEMPT", "")
    if not path or phase not in {"initial", "retry"} or not run_id.isdecimal() or not run_attempt.isdecimal():
        run()
        return
    run_with_coverage(run, PRReviewer, LiteLLMAIHandler, Path(path), {
        "runId": run_id,
        "runAttempt": run_attempt,
        "invocation": phase,
    })


if __name__ == "__main__":
    main()
