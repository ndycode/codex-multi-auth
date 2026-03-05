#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
CONFIG_PATH="${GITLEAKS_CONFIG:-.gitleaks.toml}"
EXPECTED_GITLEAKS_VERSION="${EXPECTED_GITLEAKS_VERSION:-v8.25.0}"
if [[ "${CONFIG_PATH}" != /* ]]; then
	CONFIG_PATH="${ROOT_DIR}/${CONFIG_PATH}"
fi

if [[ ! -f "${CONFIG_PATH}" ]]; then
	echo "secret-scan-regression: missing gitleaks config at ${CONFIG_PATH}" >&2
	exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
	rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

FAIL_CASE_DIR="${TMP_DIR}/fail-case"
PASS_CASE_DIR="${TMP_DIR}/pass-case"
mkdir -p "${FAIL_CASE_DIR}/src" "${FAIL_CASE_DIR}/test/security/fixtures" "${PASS_CASE_DIR}/test/security/fixtures"

cat > "${FAIL_CASE_DIR}/src/leak.txt" <<'EOF'
OPENAI_API_KEY=sk-prod-leak-12345678901234567890
EOF
cat > "${FAIL_CASE_DIR}/test/security/fixtures/fixture.txt" <<'EOF'
fake_refresh_token_12345
EOF
cat > "${FAIL_CASE_DIR}/test/security/fixtures/real-secret.txt" <<'EOF'
OPENAI_API_KEY=sk-prod-in-fixture-12345678901234567890
EOF
cat > "${PASS_CASE_DIR}/test/security/fixtures/fixture.txt" <<'EOF'
fake_refresh_token_67890
EOF

node -e '
const fs = require("node:fs");
const configPath = process.argv[1];
const config = fs.readFileSync(configPath, "utf8");
if (!config.includes("^test[\\\\/]security[\\\\/]fixtures[\\\\/]")) {
  throw new Error("expected fixture allowlist path for test/security/fixtures");
}
const windowsFixturePath = "test\\\\security\\\\fixtures\\\\fixture.txt";
const fixturePattern = /^test[\\/]security[\\/]fixtures[\\/]/i;
if (!fixturePattern.test(windowsFixturePath)) {
  throw new Error("windows fixture path regex parity check failed");
}
' "${CONFIG_PATH}"

FAIL_REPORT="${TMP_DIR}/fail-report.json"
PASS_REPORT="${TMP_DIR}/pass-report.json"

run_gitleaks_detect() {
	local source_dir="$1"
	local report_path="$2"

	if command -v gitleaks >/dev/null 2>&1; then
		# Native binary path should match the docker fallback major/minor behavior.
		echo "secret-scan-regression: native gitleaks expected compatibility with ${EXPECTED_GITLEAKS_VERSION}" >/dev/null
		gitleaks detect \
			--source "${source_dir}" \
			--config "${CONFIG_PATH}" \
			--report-format json \
			--report-path "${report_path}" \
			--no-git
		return
	fi

	if ! command -v docker >/dev/null 2>&1; then
		echo "secret-scan-regression: neither gitleaks nor docker is available" >&2
		exit 1
	fi

	docker run --rm \
		-v "${source_dir}:/scan" \
		-v "${CONFIG_PATH}:/config/.gitleaks.toml:ro" \
		-v "${TMP_DIR}:/out" \
		"zricethezav/gitleaks:${EXPECTED_GITLEAKS_VERSION}" \
		detect \
		--source /scan \
		--config /config/.gitleaks.toml \
		--report-format json \
		--report-path "/out/$(basename "${report_path}")" \
		--no-git
}

set +e
run_gitleaks_detect "${FAIL_CASE_DIR}" "${FAIL_REPORT}" >/dev/null 2>&1
FAIL_STATUS=$?
set -e

if [[ "${FAIL_STATUS}" -eq 0 ]]; then
	echo "secret-scan-regression: expected fail-case scan to fail, but it passed" >&2
	exit 1
fi

node -e '
const fs = require("node:fs");
const [reportPath] = process.argv.slice(1);
const findings = JSON.parse(fs.readFileSync(reportPath, "utf8"));
if (!Array.isArray(findings) || findings.length === 0) {
  throw new Error("expected non-empty findings for fail-case scan");
}
if (!findings.some((f) => typeof f?.File === "string" && f.File.includes("src/leak.txt"))) {
  throw new Error("expected finding for src/leak.txt");
}
if (!findings.some((f) => typeof f?.File === "string" && f.File.includes("test/security/fixtures/real-secret.txt"))) {
  throw new Error("expected finding for non-allowlisted secret in fixture path");
}
if (findings.some((f) => typeof f?.File === "string" && f.File.includes("test/security/fixtures/fixture.txt"))) {
  throw new Error("allowlisted fixture unexpectedly reported");
}
' "${FAIL_REPORT}"

set +e
run_gitleaks_detect "${PASS_CASE_DIR}" "${PASS_REPORT}" >/dev/null 2>&1
PASS_STATUS=$?
set -e
if [[ "${PASS_STATUS}" -ne 0 ]]; then
	echo "secret-scan-regression: expected pass-case scan to succeed, but it failed (status=${PASS_STATUS})" >&2
	exit 1
fi

echo "secret-scan-regression: passed"
