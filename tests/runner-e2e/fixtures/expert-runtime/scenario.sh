set -eu
target=$1
dir=$(mktemp -d /workspace/scenario.XXXXXXXX)
trap 'rm -rf "$dir"' EXIT
cd "$dir"

case "$target" in
    codex-java-*)
        version=${target#codex-java-}
        cp /fixtures/RuntimeHello.java .
        if test "$version" = 8; then
            javac -source 8 -target 8 -Xlint:-options RuntimeHello.java
            jvm_version=1.8
        else
            javac --release "$version" RuntimeHello.java
            jvm_version=$version
        fi
        test "$(java RuntimeHello)" = JAVA_SMOKE_OK
        java -version 2>&1 | grep -F "version \"$jvm_version."
        mvn --version | grep -F "Java version: $jvm_version."
        ;;
    codex-python)
        python --version | grep -E '^Python 3\.13\.'
        uv --version | grep -F 'uv 0.11.25'
        uv venv --offline --no-python-downloads --python /usr/bin/python3.13 .uv-venv
        python -m venv .venv
        .venv/bin/python -m pip --version
        printf 'name,amount\n研发,23\n测试,19\n' > input.csv
        .uv-venv/bin/python - <<'PY'
import csv
import unittest

class CsvTest(unittest.TestCase):
    def test_total(self):
        with open("input.csv", encoding="utf-8", newline="") as data:
            self.assertEqual(sum(int(row["amount"]) for row in csv.DictReader(data)), 42)

unittest.main()
PY
        ;;
    codex-node)
        test "$(pnpm --version)" = 11.28.5
        test "$(tsc --version)" = 'Version 6.0.3'
        printf 'const result: number = 6 * 7;\nconsole.log(result);\n' > sample.ts
        tsc --target es2022 sample.ts
        test "$(node sample.js)" = 42
        ;;
    codex-go)
        test "$(go version)" = 'go version go1.27.4 linux/arm64'
        test "$(go env GOOS)/$(go env GOARCH)" = linux/arm64
        go mod init example.test/heluo-smoke
        printf 'package smoke\nimport "testing"\nfunc TestCompile(t *testing.T) { if 6*7 != 42 { t.Fatal("product") } }\n' > sample_test.go
        GOPROXY=off go test ./...
        ;;
    codex-sql)
        psql --version
        mysql --version
        sqlite3 --version
        sqlite3 sample.db "CREATE TABLE example(n INTEGER); INSERT INTO example VALUES (23), (19);"
        test "$(sqlite3 sample.db 'SELECT SUM(n) FROM example;')" = 42
        ;;
    codex-dotnet-10)
        dotnet --info | grep -Ei 'RID:.*linux-arm64'
        dotnet --list-sdks | grep -E '^10\.0\.'
        printf '<configuration><packageSources><clear /></packageSources></configuration>\n' > NuGet.Config
        dotnet new console --output sample --framework net10.0 --no-restore
        printf 'System.Console.WriteLine(6 * 7);\n' > sample/Program.cs
        dotnet restore sample --configfile NuGet.Config
        dotnet build sample --no-restore --verbosity quiet
        test "$(dotnet sample/bin/Debug/net10.0/sample.dll)" = 42
        ;;
    codex-test-api)
        test "$(newman --version)" = 6.2.3
        node /fixtures/loopback.mjs newman run /fixtures/api.collection.json \
            --env-var 'base={url}' --reporters cli,junit --reporter-junit-export junit.xml
        grep -q 'response is successful' junit.xml
        grep -q 'body reports failure' junit.xml
        ;;
    codex-test-web)
        test "$(playwright --version)" = 'Version 1.65.1'
        node /fixtures/loopback.mjs node /fixtures/browser.cjs '{url}'
        test -s screenshot.png
        sha256sum screenshot.png
        ;;
    codex-test-load)
        k6 version | grep -F 'k6 v2.4.0'
        node /fixtures/loopback.mjs k6 run -e 'BASE_URL={url}' /fixtures/load.js
        ;;
    codex-ops-diag)
        curl --version | head -n 1
        jq --version
        dig -v
        ip -json address show dev lo | jq -e '.[0].ifname == "lo"'
        ps -p 1 -o comm= | grep -F tini
        openssl req -new -x509 -newkey rsa:2048 -noenc -keyout key.pem \
            -out cert.pem -days 1 -subj /CN=example.test 2>/dev/null
        openssl x509 -in cert.pem -noout -subject | grep -F example.test
        node /fixtures/loopback.mjs curl -fsS '{url}/api' > response.json
        jq -e '.ok' response.json
        ;;
    codex-ops-k8s)
        kubectl version --client -o json > kubectl.json
        jq -e '.clientVersion.gitVersion == "v1.37.2"' kubectl.json
        helm version --short | grep -F 'v4.3.2'
        kubectl kustomize /fixtures/k8s > rendered.yaml
        grep -F 'name: example-config' rendered.yaml
        helm template example /fixtures/chart > template.yaml
        grep -F 'name: example-config' template.yaml
        ;;
    codex-ops-iac)
        tofu version | grep -F 'OpenTofu v1.13.9'
        cp /fixtures/main.tf .
        tofu fmt -check
        tofu init -backend=false -input=false -no-color
        tofu validate -no-color
        ;;
    codex-office-zh)
        locale -a | grep -F 'zh_CN.utf8'
        fc-match -f '%{family}\n' ':lang=zh-cn' | grep -F 'Noto Sans CJK SC'
        pandoc --version | head -n 1
        soffice --version
        pdftotext -v
        pandoc /fixtures/chinese.md -o report.docx
        pandoc /fixtures/chinese.md -t pptx -o slides.pptx
        printf '名称,数量\n河洛样例,42\n' > table.csv
        soffice "-env:UserInstallation=file://$dir/lo" --headless --convert-to xlsx table.csv
        for sample in report.docx table.xlsx slides.pptx; do
            test -s "$sample"
            soffice "-env:UserInstallation=file://$dir/lo" --headless --convert-to pdf "$sample"
            pdf=${sample%.*}.pdf
            test -s "$pdf"
            pdfinfo "$pdf" | grep -E '^Pages: +[1-9]'
            pdftotext "$pdf" - | tr -d '[:space:]' | grep -F '河洛样例'
        done
        ;;
    *)
        echo "Unknown scenario $target" >&2
        exit 2
        ;;
esac

printf '%s %s\n' "$target" SCENARIO_OK
