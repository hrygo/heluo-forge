// Native, offline synthetic CLI contract fixture. Not an enterprise CLI or service.
// The only reads are this executable's adjacent fixture-case.txt selector; the
// only optional write is a caller-selected fixed-argv/case-only fixture call log.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const repository = "gitee.corp.example/demo/repo"
const repoURL = "https://" + repository
const repoFields = "nameWithOwner,url,isPrivate,defaultBranchRef"
const issueFields = "number,title,body,state,url,closedByPullRequestsReferences"
const prFields = "number,title,state,url,headRefOid,baseRefName,mergedAt,commits"

var cases = map[string]bool{
	"success": true, "denied401": true, "denied403": true, "malformed": true,
	"truncated": true, "missing-fields": true, "wrong-target": true,
	"timeout": true, "overflow": true,
}

func fail(message string, code int) {
	// Never print caller input, environment values, paths or underlying errors.
	fmt.Fprintln(os.Stderr, "heluo native fixture: "+message)
	os.Exit(code)
}

func same(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func dispatch(name string, args []string) (string, string) {
	if name == "dop" {
		for _, id := range []string{"ARD123456", "ARD222222"} {
			if same(args, []string{"change", "view", id, "-j"}) {
				return "change", id
			}
		}
	}
	if name == "gh" {
		if same(args, []string{"repo", "view", repository, "--json", repoFields}) {
			return "repo", repository
		}
		for _, number := range []string{"2", "4"} {
			if same(args, []string{"issue", "view", number, "--repo", repository, "--json", issueFields}) {
				return "issue", number
			}
		}
		if same(args, []string{"pr", "view", "3", "--repo", repository, "--json", prFields}) {
			return "pr", "3"
		}
	}
	fail("command refused (fixed read-only argv required)", 64)
	return "", ""
}

func fixtureCase(executable string) string {
	if value, exists := os.LookupEnv("HELUO_CONTRACT_CASE"); exists {
		if !cases[value] {
			fail("invalid fixture case", 64)
		}
		return value
	}
	path := filepath.Join(filepath.Dir(executable), "fixture-case.txt")
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return "success"
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > 64 {
		fail("invalid adjacent fixture selector", 64)
	}
	file, err := os.Open(path)
	if err != nil {
		fail("unreadable adjacent fixture selector", 64)
	}
	defer file.Close()
	// Bound the actual read, not only the pre-open size (the file may change).
	data, err := io.ReadAll(io.LimitReader(file, 65))
	if err != nil || len(data) > 64 {
		fail("invalid adjacent fixture selector", 64)
	}
	value := strings.TrimSpace(string(data))
	if !cases[value] {
		fail("invalid adjacent fixture selector", 64)
	}
	return value
}

func logCall(args []string, mode string) {
	path := os.Getenv("HELUO_CONTRACT_CALLS")
	if path == "" {
		return
	}
	// Dispatch and case validation happen before logging: only constant allowlisted
	// argv and a fixed case name can ever be recorded, not rejected raw input.
	data, err := json.Marshal(struct {
		Argv []string `json:"argv"`
		Case string   `json:"case"`
	}{args, mode})
	if err != nil {
		fail("fixture log failed", 74)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		fail("fixture log failed", 74)
	}
	_, writeErr := file.Write(append(data, '\n'))
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		fail("fixture log failed", 74)
	}
}

func payload(kind, target string) map[string]any {
	provenance := map[string]any{"kind": "fixture", "synthetic": true, "network": false}
	var value map[string]any
	switch kind {
	case "change":
		value = map[string]any{
			"id": target, "title": "Synthetic fixture requirement " + target,
			"status": "open", "description": "Synthetic read-only requirement on corp.example; no enterprise data.",
			"acceptance_criteria": []string{"Display the explicitly selected requirement.", "Keep business writes disabled."},
			"sub_systems":         []any{map[string]any{"code": "OTHER.demo", "name": "Synthetic fixture subsystem"}},
			"user_stories":        []any{map[string]any{"code": "US-FIXTURE-1", "title": "Synthetic first story", "release_info": nil}},
		}
		if target == "ARD222222" {
			value["user_stories"] = []any{
				map[string]any{"code": "US-FIXTURE-2", "title": "Synthetic unscheduled story", "release_info": nil},
				map[string]any{"code": "US-FIXTURE-3", "title": "Synthetic scheduled story", "release_info": map[string]any{"release_num": "R20260620002", "release_name": "Synthetic fixture release"}},
			}
		}
	case "repo":
		value = map[string]any{"nameWithOwner": "demo/repo", "url": repoURL, "isPrivate": true, "defaultBranchRef": map[string]any{"name": "main"}}
	case "issue":
		number, id, state := 2, "ARD123456", "CLOSED"
		refs := []any{map[string]any{"number": 3, "url": repoURL + "/pull/3"}}
		if target == "4" {
			number, id, state = 4, "ARD222222", "OPEN"
			refs = []any{}
		}
		value = map[string]any{
			"number": number, "title": "[" + id + "] Synthetic fixture issue",
			"body":  "## Reference\n- DOP change: " + id + "\n## Acceptance\n- [ ] Synthetic issue acceptance",
			"state": state, "url": fmt.Sprintf("%s/issues/%d", repoURL, number), "closedByPullRequestsReferences": refs,
		}
	case "pr":
		value = map[string]any{"number": 3, "title": "Synthetic fixture merged PR", "state": "MERGED", "url": repoURL + "/pull/3", "headRefOid": strings.Repeat("a", 40), "baseRefName": "main", "mergedAt": "2026-06-20T00:00:00Z", "commits": []any{
			map[string]any{"oid": strings.Repeat("b", 40), "messageHeadline": "[ARD123456] synthetic change commit"},
		}}
	}
	value["_heluo_fixture"] = provenance
	return value
}

func main() {
	executable, err := os.Executable()
	if err != nil {
		fail("fixture executable unavailable", 70)
	}
	name := strings.TrimSuffix(filepath.Base(executable), ".exe")
	args := os.Args[1:]
	kind, target := dispatch(name, args)
	mode := fixtureCase(executable)
	logCall(args, mode)
	switch mode {
	case "denied401":
		fail("401 synthetic access denied", 1)
	case "denied403":
		fail("403 synthetic access denied", 1)
	case "malformed":
		fmt.Fprintln(os.Stdout, "not-json (synthetic fixture)")
		return
	case "truncated":
		fmt.Fprint(os.Stdout, `{"_heluo_fixture":`)
		return
	case "timeout":
		time.Sleep(30 * time.Second)
		fail("synthetic timeout elapsed", 75)
	case "overflow":
		// Finite, deterministic 2 MiB output, above the production default budget.
		chunk := strings.Repeat("x", 8192)
		for i := 0; i < 256; i++ {
			if _, err := io.WriteString(os.Stdout, chunk); err != nil {
				return
			}
		}
		return
	}
	value := payload(kind, target)
	if mode == "missing-fields" {
		switch kind {
		case "change":
			delete(value, "acceptance_criteria")
		case "repo":
			delete(value, "url")
		case "issue":
			delete(value, "state")
		case "pr":
			delete(value, "headRefOid")
		}
	}
	if mode == "wrong-target" {
		switch kind {
		case "change":
			if target == "ARD123456" {
				value["id"] = "ARD222222"
			} else {
				value["id"] = "ARD123456"
			}
		case "repo":
			value["nameWithOwner"] = "demo/other"
		case "issue":
			value["number"] = 99
		case "pr":
			value["number"] = 99
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(value); err != nil {
		fail("fixture output failed", 74)
	}
}
