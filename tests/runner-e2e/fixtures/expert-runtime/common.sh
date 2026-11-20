set -eu
test "$(uname -m)" = aarch64
test "$(id -u):$(id -g)" = 1000:1000
test "$PWD" = /workspace
test -w "$HOME" && test -w "$CODEX_HOME" && test -w "$XDG_CACHE_HOME"
test ! -w /usr/local/bin && test ! -w /opt/expert-codex

for tool in "$@" find grep sed awk diff tar; do
    command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done
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
' "$(command -v node)" "$(command -v paperclip-runnerd)" "$codex_elf"

workspace=$(mktemp -d /workspace/smoke.XXXXXXXX)
trap 'rm -rf "$workspace"' EXIT
cd "$workspace"
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
