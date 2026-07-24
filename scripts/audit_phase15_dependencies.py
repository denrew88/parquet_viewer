from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "src-tauri" / "Cargo.toml"


def metadata(*feature_args: str) -> dict:
    command = [
        "cargo",
        "+1.97.1",
        "metadata",
        "--manifest-path",
        str(MANIFEST),
        "--format-version",
        "1",
        *feature_args,
    ]
    return json.loads(subprocess.check_output(command, cwd=ROOT))


def main() -> None:
    feature_off = metadata("--no-default-features")
    feature_on = metadata("--features", "polars-csv-provider")
    off_ids = {package["id"] for package in feature_off["packages"]}
    added = sorted(
        (package for package in feature_on["packages"] if package["id"] not in off_ids),
        key=lambda package: (package["name"], package["version"]),
    )
    print(f"addedPackages={len(added)}")
    for package in added:
        print(f"{package['name']} {package['version']} | {package.get('license')}")


if __name__ == "__main__":
    main()
