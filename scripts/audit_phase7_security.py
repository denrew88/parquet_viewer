"""Run deterministic configuration and hostile-input security checks."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def finding(check: str, passed: bool, detail: str) -> dict[str, object]:
    return {"check": check, "status": "PASS" if passed else "FAIL", "detail": detail}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-manifest", type=Path, default=Path("artifacts/phase-7/benchmark-manifest.json"))
    parser.add_argument("--json-output", type=Path, default=Path("artifacts/phase-7/security-audit.json"))
    parser.add_argument("--md-output", type=Path, default=Path("artifacts/phase-7/security-audit.md"))
    args = parser.parse_args()

    config = json.loads(Path("src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    capability = json.loads(Path("src-tauri/capabilities/default.json").read_text(encoding="utf-8"))
    csp = config["app"]["security"]["csp"]
    csp_text = json.dumps(csp)
    permissions = capability["permissions"]
    findings = [
        finding("CSP is non-null", csp is not None, "release CSP must be explicit"),
        finding("CSP blocks unsafe-eval", "unsafe-eval" not in csp_text, csp_text),
        finding("CSP has no wildcard or remote HTTPS", "*" not in csp_text and "https:" not in csp_text, csp_text),
        finding("NSIS is the only bundle target", config["bundle"]["targets"] == ["nsis"], str(config["bundle"]["targets"])),
        finding("CSV and Parquet associations exist", {"csv", "parquet"} == {ext for item in config["bundle"]["fileAssociations"] for ext in item["ext"]}, "extensions audited"),
        finding("No shell/fs/http capability", not any(any(token in permission for token in ("shell", "fs:", "http")) for permission in permissions), str(permissions)),
    ]

    subprocess.run(
        ["cargo", "build", "--release", "--offline", "--manifest-path", "scripts/phase7-runner/Cargo.toml"],
        check=True,
    )
    executable = Path("scripts/phase7-runner/target/release/phase7-data-runner.exe")
    if os.name != "nt":
        executable = executable.with_suffix("")
    manifest = json.loads(args.fixture_manifest.read_text(encoding="utf-8"))
    hostile_dir = Path("fixtures/phase-7/hostile")
    hostile_paths = [str(hostile_dir / case["name"]) for case in manifest["hostile"]]
    completed = subprocess.run(
        [str(executable), "probe", *hostile_paths],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    hostile = json.loads(completed.stdout)
    findings.append(
        finding(
            "Hostile corpus does not panic",
            all(case["outcome"] != "panic" for case in hostile),
            f"{len(hostile)} cases probed",
        )
    )
    findings.append(
        finding(
            "Hostile corpus typed rejection",
            all(case["outcome"] != "rejected" or case["errorCode"] for case in hostile),
            "every rejected case has a stable error code; bounded valid CSV edge cases may be accepted",
        )
    )

    report = {
        "schemaVersion": 1,
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "findings": findings,
        "hostileProbe": hostile,
        "limitations": [
            "Static capability audit does not prove Windows ACL behavior.",
            "CSP violation console evidence requires an installed native WebView run.",
            "Dependency advisories are recorded separately because registry access can be unavailable.",
        ],
    }
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# Phase 7 보안 감사", "", f"- 생성 시각: `{report['generatedAtUtc']}`", ""]
    lines += [f"- **{item['status']}** `{item['check']}`: {item['detail']}" for item in findings]
    lines += ["", "## Hostile corpus", ""]
    lines += [f"- `{item['pathName']}`: `{item['outcome']}` / `{item['errorCode']}`" for item in hostile]
    lines += ["", "## 한계", ""] + [f"- {item}" for item in report["limitations"]]
    args.md_output.write_text("\n".join(lines) + "\n", encoding="utf-8")

    if any(item["status"] == "FAIL" for item in findings):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
