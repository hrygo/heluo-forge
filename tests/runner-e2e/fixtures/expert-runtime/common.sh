set -eu
python_version=$1
uv_version=$2
shift 2
test "$(uname -m)" = aarch64
test "$(id -u):$(id -g)" = 1000:1000
test "$PWD" = /workspace
test -w "$HOME" && test -w "$CODEX_HOME" && test -w "$XDG_CACHE_HOME"
test ! -w /usr/local/bin && test ! -w /opt/expert-codex

for tool in "$@" find grep sed awk diff tar; do
    command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done
test "$(python --version)" = "Python $python_version"
test "$(python3 --version)" = "Python $python_version"
test "$(readlink -f "$(command -v python)")" = "$(readlink -f "$(command -v python3)")"
test "$(uv --version | cut -d ' ' -f 2)" = "$uv_version"
test "$(uvx --version | cut -d ' ' -f 2)" = "$uv_version"
test -r /usr/share/doc/uv/LICENSE-MIT
test "$(node --version)" = v24.21.0
test "$(codex --version)" = 'codex-cli 0.160.0'

codex_elf=$(find /opt/expert-codex -name codex -type f | head -n 1)
paperclip-runnerd --build-metadata | node -e '
const fs = require("node:fs")
const assert = require("node:assert/strict")
const metadata = JSON.parse(fs.readFileSync(0, "utf8"))
assert.equal(metadata.binaryContractVersion, 2)
for (const mode of ["dial_ws_loopback", "dial_wss", "listen_ws"]) {
  assert.ok(JSON.stringify(metadata).includes(JSON.stringify(mode)), mode)
}
for (const path of process.argv.slice(1)) {
  const file = fs.openSync(path, "r")
  const hdr = Buffer.alloc(20)
  fs.readSync(file, hdr)
  fs.closeSync(file)
  assert.equal(hdr.subarray(0, 4).toString("hex"), "7f454c46", path)
  assert.equal(hdr[4], 2, "64-bit ELF " + path)
  assert.equal(hdr[5], 1, "little-endian ELF " + path)
  assert.equal(hdr.readUInt16LE(18), 183, "AArch64 ELF " + path)
}
' "$(command -v node)" "$(command -v python3)" "$(command -v uv)" "$(command -v uvx)" \
  "$(command -v paperclip-runnerd)" "$codex_elf"

workspace=$(mktemp -d /workspace/smoke.XXXXXXXX)
trap 'rm -rf "$workspace"' EXIT
cd "$workspace"
python -m venv .venv
.venv/bin/python -c 'import csv, sys; assert sys.prefix != sys.base_prefix'
.venv/bin/python -m pip --version >/dev/null
uv venv --offline --no-python-downloads --python "$(command -v python3)" .uv-venv
test "$(.uv-venv/bin/python --version)" = "Python $python_version"
printf 'name,amount\n研发,23\n测试,19\n' > input.csv
.uv-venv/bin/python - <<'PY'
import csv
import sys
import unittest

assert sys.prefix != sys.base_prefix

class CsvTest(unittest.TestCase):
    def test_total(self):
        with open("input.csv", encoding="utf-8", newline="") as data:
            self.assertEqual(sum(int(row["amount"]) for row in csv.DictReader(data)), 42)

unittest.main()
PY
git init -q
printf '%s\n' 'before 样例' > 河洛.txt
git add 河洛.txt
printf '%s\n' 'after 样例' > 河洛.txt
git --no-pager diff -- 河洛.txt | grep -q '^+after 样例'
test "$(find . -name '河洛.txt')" = './河洛.txt'
test "$(rg 'after' 河洛.txt | sed 's/after //' | awk '{print $1}')" = 样例
tar -cf snapshot.tar 河洛.txt
mkdir extracted
tar -xf snapshot.tar -C extracted
diff 河洛.txt extracted/河洛.txt
printf '%s\n' COMMON_OK
