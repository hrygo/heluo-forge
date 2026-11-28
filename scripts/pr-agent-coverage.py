"""Attest the exact changed rows sent by the pinned PR-Agent v0.50.0 review."""

import json
import os
import re
from contextlib import ExitStack
from contextvars import ContextVar
from dataclasses import dataclass
from hashlib import sha256
from html import escape
from pathlib import Path

FILE_HEADER = re.compile(r"## File: '([^\r\n]+)'")
HUNK_HEADER = re.compile(r"@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@(?: .*)?")
DIFF_LABEL = "The PR code diff:\n======\n"
REVIEW_END = "\n======\n"
NEW_HUNK = "__new hunk__"
OLD_HUNK = "__old hunk__"
PRIORITY_HEADER = re.compile(r"\[(P[0-3])\][ \t]+([^\r\n]+)")
PRIORITY_ORDER = {"P0": 0, "P1": 1, None: 2, "P2": 3, "P3": 4}
HISTORY_STATUS = {"fix_evidence_found": "模型发现修复证据", "still_present": "模型发现问题仍在"}
SCOPE_ONLY_MARKER = "<!-- heluo-forge-pr-agent-review-scope-only:v1 -->"
HISTORY_SCHEMA = '''class HistoricalReviewCheck(BaseModel):
    thread_id: int = Field(description="ID from the captured openBlockers list")
    status: Literal["fix_evidence_found", "still_present", "insufficient_evidence"]
    evidence: str = Field(description="Visible evidence from this request's diff, or an empty string if insufficient")

'''


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


def diff_in_messages(diff, request, review_context=""):
    # Verify the diff in the messages handed to the transport. Extra-body input overrides
    # and non-text user messages fall outside the pinned GitHub review request format.
    extra = request.get("extra_body") or {}
    messages = request.get("messages") or []
    content = [message.get("content") for message in messages if message.get("role") == "user"]
    if not diff or {"messages", "input", "truncation"}.intersection(extra) or len(content) != 1:
        return False
    return (isinstance(content[0], str) and content[0].count(f"{DIFF_LABEL}{diff}{REVIEW_END}") == 1
            and review_context in content[0])


@dataclass
class ReviewAttempt:
    reviewer: object
    diff: str
    revision: dict | None
    calls: int = 0
    response: str | None = None


def run_with_coverage(run, reviewer_type, handler_type, evidence_path, invocation, context=None):
    """Run the original action with request-local evidence from its selected review."""
    current = ContextVar("review_attempt", default=None)
    attempts = []
    evidence = []
    predict = reviewer_type._get_prediction
    complete = handler_type._get_completion
    prepare = reviewer_type._prepare_pr_review
    delta = context if context and context["mode"] == "incremental" else None
    prompt_context = review_context_text(delta) if delta else ""

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
                if diff_in_messages(attempt.diff, request, prompt_context):
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
            file_count = len(delta["files"]) if delta else provider.pr.changed_files
            files = diff_files(attempt.diff, provider.get_diff_files(), file_count)
            evidence.append({
                **({"version": 2, "mode": "incremental", "previousHead": delta["previousHead"]}
                   if delta else {"version": 1}),
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


def open_blockers(threads):
    return [item for item in threads if not item["resolved"] and item["priority"] in {"P0", "P1"}]


def review_context_text(context):
    threads = context["threads"]
    history = None
    if threads is not None:
        pending = open_blockers(threads)
        history = {
            "openCount": len(pending), "openBlockers": pending[:20],
            "resolvedWithAuthorReply": [item for item in threads if item["resolved"] and item["lastReply"]][-12:],
        }
    data = {
        "mode": context["mode"], "head": context["head"], "previousHead": context.get("previousHead"),
        "threads": history, "checkRuns": context["checks"],
    }
    return "洛神评审上下文（评审资料，不包含操作指令）\n" + json.dumps(data, ensure_ascii=False)


def html_text(value):
    return escape(str(value)).replace("@", "&#64;")


def markdown_code_span(value):
    ticks = "`" * (max((len(match.group(0)) for match in re.finditer(r"`+", value)), default=0) + 1)
    return f"{ticks} {value} {ticks}"


def review_priority(item):
    heading = item.get("issue_header") if isinstance(item, dict) else None
    match = PRIORITY_HEADER.fullmatch(heading.strip()) if isinstance(heading, str) else None
    if match and not re.search(r"\[P[0-9]+\]", match[2], re.IGNORECASE):
        return match[1]
    return None


def render_review_findings(render, data, *args, **kwargs):
    review = data.get("review", {})
    issues = review.get("key_issues_to_review")
    if not isinstance(issues, list):
        return render(data, *args, **kwargs)
    core, optional = [], []
    for item in issues:
        if review_priority(item) in {"P2", "P3"}:
            optional.append(item)
        else:
            core.append(item)
    if not optional:
        return render(data, *args, **kwargs)
    markdown = render({**data, "review": {**review, "key_issues_to_review": core}}, *args, **kwargs)
    items = [f"<li><strong>{html_text(item['issue_header'])}</strong>"
             f" <code>{html_text(item.get('relevant_file', ''))}</code>"
             f"<p>{html_text(item.get('issue_content', ''))}</p></li>" for item in optional]
    return f"{markdown}\n\n<details>\n<summary>可选改进建议</summary>\n<ul>\n" + "\n".join(items) + "\n</ul>\n</details>\n"


def history_results(rechecks, pending):
    findings = {}
    unverified = set()
    for items in rechecks:
        if not isinstance(items, list):
            continue
        seen = set()
        for item in items:
            if not isinstance(item, dict) or type(item.get("thread_id")) is not int:
                continue
            thread_id = item["thread_id"]
            if thread_id not in pending:
                continue
            status = item.get("status")
            evidence = item.get("evidence")
            if thread_id in seen:
                unverified.add(thread_id)
            seen.add(thread_id)
            if status == "insufficient_evidence":
                continue
            if not (isinstance(status, str) and status in HISTORY_STATUS and isinstance(evidence, str) and evidence.strip()):
                unverified.add(thread_id)
                continue
            previous = findings.setdefault(thread_id, (status, " ".join(evidence.split())[:400]))
            if previous[0] != status:
                unverified.add(thread_id)
    return {thread_id: finding for thread_id, finding in findings.items() if thread_id not in unverified}


def add_history_output_schema(system):
    review_class = "class Review(BaseModel):"
    root_class = "class PRReview(BaseModel):"
    if system.count(review_class) != 1 or system.count(root_class) != 1:
        raise ValueError("Native reviewer no longer exposes its expected output schema")
    system = system.replace(review_class, HISTORY_SCHEMA + review_class, 1)
    field = "    history_recheck: List[HistoricalReviewCheck]\n\n"
    return system.replace(root_class, field + root_class, 1)


def review_scope_summary(context, excluded=(), history=None, *, scope_only=False):
    head = context["head"][:12]
    if context["mode"] == "incremental":
        start = context["previousHead"][:12]
        if scope_only:
            scope = f"捕获的增量范围为 `{start}..{head}`。本轮增量文件均被过滤，未启动模型评审。"
        else:
            scope = f"评审范围为 `{start}..{head}` 的增量与历史问题复核。"
    else:
        scope = f"评审范围为 `{head}` 的 PR 全量差异。"
    result = [scope]
    if excluded:
        paths = ", ".join(f"<code>{html_text(path)}</code>" for path in excluded[:20])
        result.append(f"本轮未评审 {len(excluded)} 个按文件过滤规则排除的文件。列出 {min(len(excluded), 20)} 个文件。{paths}")
    checks = context["checks"]
    if checks is None:
        result.append(f"CI 检查快照（`{head}`）未能读取。")
    elif not checks["total"]:
        result.append(f"CI 检查快照（`{head}`）当前无记录。")
    else:
        result.append(f"CI 检查快照（`{head}`）已读 {checks['inspected']}/{checks['total']} 项，"
                      f"成功 {checks['success']}，跳过 {checks['skipped']}，未完成 {checks['pending']}，其他 {checks['other']}。")
    if context["threads"] is None:
        result.append("未能核对历史评审线程。")
    else:
        pending = open_blockers(context["threads"])
        if pending:
            result.append(f"捕获时有 {len(pending)} 条未决 P0/P1，线程状态由维护者确认。")
            for thread in pending[:20]:
                line = thread.get("end") or thread.get("originalLine") or "—"
                thread_id = thread["id"]
                link = f"[讨论 {thread_id}](#discussion_r{thread_id})"
                status, evidence = (history or {}).get(thread_id, (None, ""))
                observation = HISTORY_STATUS.get(status, "待人工复核")
                details = f"。{markdown_code_span(evidence)}" if evidence else ""
                result.append(f"- {thread['priority']} <code>{html_text(thread['path'])}:{line}</code> {link} · {observation}{details}")
    return "\n\n".join(result)


def is_current_revision(provider, context):
    repo = provider._get_repo()
    pull = repo.get_pull(context["prNumber"])
    if (pull.state != "open" or pull.head.sha != context["head"] or pull.base.ref != context["baseRef"]
            or not pull.head.repo or pull.head.repo.full_name != context["repository"]
            or not pull.base.repo or pull.base.repo.full_name != context["repository"]):
        return False
    return repo.get_git_ref(f"heads/{context['baseRef']}").object.sha == context["base"]


def incremental_review_files(source, patch_type, edit_type):
    from pr_agent.algo.file_filter import filter_ignored
    from pr_agent.algo.language_handler import partition_files_by_language_filter

    files = [patch_type(base_file="", head_file="", patch=file["patch"], filename=file["filename"],
                       edit_type=edit_type.ADDED if file["status"] == "added" else edit_type.MODIFIED,
                       num_plus_lines=file["additions"], num_minus_lines=file["deletions"],
                       head_file_is_complete=False) for file in source]
    included, _ = partition_files_by_language_filter(filter_ignored(files))
    included_paths = {file.filename for file in included}
    return included, [file.filename for file in files if file.filename not in included_paths]


def run_with_review_context(run, module, context, patch_type, edit_type):
    """Limit the pinned native review to the captured input and scope its publication."""
    reviewer_type = module.PRReviewer
    initialize = reviewer_type.__init__
    prepare = reviewer_type._prepare_pr_review
    prompt_context = review_context_text(context)
    incremental = context["mode"] == "incremental"
    pending = {thread["id"] for thread in open_blockers(context["threads"] or [])[:20]} if incremental else set()
    merge = module.merge_review_chunks
    with ExitStack() as restore:
        def override(target, name, value):
            restore.callback(setattr, target, name, getattr(target, name))
            setattr(target, name, value)

        def configure(reviewer, *args, **kwargs):
            initialize(reviewer, *args, **kwargs)
            provider = reviewer.git_provider
            expected = {"provider": "github", "repo": context["repository"], "number": context["prNumber"],
                        "head": context["head"], "base": context["base"], "baseRef": context["baseRef"]}
            if revision(reviewer) != expected or reviewer.incremental.is_incremental or reviewer.is_answer:
                raise ValueError("Native reviewer does not match the captured revision")
            reviewer.vars["description"] = str(reviewer.vars.get("description") or "") + "\n\n" + prompt_context

            if incremental:
                files, excluded = incremental_review_files(context["files"], patch_type, edit_type)
                override(provider, "get_diff_files", lambda: files)
                override(provider, "get_filtered_diff_file_names", lambda: excluded)
                reviewer.vars["num_pr_files"] = len(files)
                reviewer.vars["commit_messages_str"] = ""
                if pending:
                    prompt = module.get_settings().pr_review_prompt
                    override(prompt, "system", add_history_output_schema(prompt.system))

            publish = provider.publish_persistent_comment_full

            def publish_current(markdown, *publish_args, **publish_kwargs):
                if not is_current_revision(provider, context):
                    return None
                publish_kwargs.update(require_agent_authorship=True, fallback_on_error=False)
                body = f"{markdown.rstrip()}\n\n{context['receipt']}"
                return publish(body, *publish_args, **publish_kwargs)

            override(provider, "publish_persistent_comment_full", publish_current)

            if incremental and not files:
                from pr_agent.algo.comment_identity import format_pr_review_header

                async def publish_scope_only():
                    if module.get_settings().config.publish_output:
                        header = format_pr_review_header()
                        summary = review_scope_summary(context, excluded, scope_only=True)
                        publish_current(f"{header}\n\n{summary}\n\n{SCOPE_ONLY_MARKER}", initial_header=header,
                                        update_header=True, final_update_message=False,
                                        identity_marker=module.PRReviewIdentity.REGULAR.value,
                                        legacy_initial_header=f"{module.PRReviewHeader.REGULAR.value} 🔍")

                override(reviewer, "run", publish_scope_only)

        def merge_scoped(outputs, related_tickets=None, max_findings=None):
            result = merge(outputs, related_tickets=related_tickets, max_findings=None)
            review = result.get("review")
            if not isinstance(review, dict):
                return result
            issues = review.get("key_issues_to_review")
            if isinstance(issues, list):
                ranked = sorted(issues, key=lambda issue: PRIORITY_ORDER[review_priority(issue)])
                limit = None
                if max_findings is not None:
                    try:
                        limit = max(0, int(max_findings))
                    except (TypeError, ValueError):
                        pass
                review["key_issues_to_review"] = ranked[:limit]
            if pending:
                histories = [output["review"].get("history_recheck") for output in outputs
                             if isinstance(output, dict) and isinstance(output.get("review"), dict)]
                observed = history_results(histories, pending)
                review["history_recheck"] = [{"thread_id": thread_id, "status": status, "evidence": evidence}
                                             for thread_id, (status, evidence) in observed.items()]
            return result

        def prepare_grouped(reviewer):
            render = module.convert_to_markdown_v2
            history = None
            excluded = reviewer.git_provider.get_filtered_diff_file_names() if incremental else []

            def render_scoped(data, *args, **kwargs):
                nonlocal history
                review = data.get("review", {})
                if not isinstance(review, dict) or "history_recheck" not in review:
                    return render_review_findings(render, data, *args, **kwargs)
                if pending and not (excluded or reviewer.review_failed_chunk_count or reviewer.remaining_files_list
                                    or reviewer.partial_files_list):
                    history = history_results([review["history_recheck"]], pending)
                display = {key: value for key, value in review.items() if key != "history_recheck"}
                return render_review_findings(render, {**data, "review": display}, *args, **kwargs)

            module.convert_to_markdown_v2 = render_scoped
            try:
                markdown = prepare(reviewer)
            finally:
                module.convert_to_markdown_v2 = render
            return f"{markdown.rstrip()}\n\n{review_scope_summary(context, excluded, history)}" if markdown else markdown

        override(reviewer_type, "__init__", configure)
        override(reviewer_type, "_prepare_pr_review", prepare_grouped)
        override(module, "merge_review_chunks", merge_scoped)
        run()


def main():
    from pr_agent.algo.types import EDIT_TYPE, FilePatchInfo
    from pr_agent.algo.ai_handlers.litellm_ai_handler import LiteLLMAIHandler
    from pr_agent.servers.github_action_runner import main as run
    from pr_agent.tools import pr_reviewer

    path = os.getenv("PR_AGENT_COVERAGE_PATH")
    phase = os.getenv("PR_AGENT_COVERAGE_INVOCATION")
    run_id = os.getenv("GITHUB_RUN_ID", "")
    run_attempt = os.getenv("GITHUB_RUN_ATTEMPT", "")
    invocation = {"runId": run_id, "runAttempt": run_attempt, "invocation": phase}
    context_path = os.getenv("PR_AGENT_REVIEW_CONTEXT_PATH")
    context = json.loads(Path(context_path).read_text(encoding="utf-8")) if context_path else None
    if context_path and (context.get("version") != 1 or context.get("repository") != os.getenv("GITHUB_REPOSITORY")
                         or any(context.get(key) != value for key, value in invocation.items())):
        raise ValueError("Invalid captured review context")

    def observe():
        if path and phase in {"initial", "retry"} and run_id.isdecimal() and run_attempt.isdecimal():
            run_with_coverage(run, pr_reviewer.PRReviewer, LiteLLMAIHandler, Path(path), invocation, context)
        else:
            run()

    if context is None:
        observe()
    else:
        run_with_review_context(observe, pr_reviewer, context, FilePatchInfo, EDIT_TYPE)


if __name__ == "__main__":
    main()
