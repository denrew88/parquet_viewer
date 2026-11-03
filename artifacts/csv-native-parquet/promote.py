"""Archive the validated CSV experiment; preserve canonical working paths."""
import hashlib
import json
import shutil
from pathlib import Path

DEST = Path(__file__).resolve().parent
ROOT = DEST.parents[1]
SOURCE = ROOT / 'artifacts/experiments/csv-native-parquet'
SKIP = {'fixtures', 'outputs', '__pycache__', 'gen', 'localappdata', 'native-localappdata'}
EXTENSIONS = {'.md', '.json', '.rs', '.toml', '.lock', '.py', '.cjs', '.mjs', '.ps1', '.log', '.png', '.ico'}

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def copy_verified(source, target):
    expected = digest(source)
    if target.exists() and digest(target) != expected:
        raise RuntimeError(f'Refusing to overwrite different archived content: {target}')
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        shutil.copy2(source, target)
    assert digest(target) == expected
    return {'path': target.relative_to(DEST).as_posix(), 'source': source.relative_to(ROOT).as_posix(),
            'bytes': target.stat().st_size, 'sha256': expected}

records = []
for source in sorted(SOURCE.rglob('*')):
    relative = source.relative_to(SOURCE)
    if not source.is_file() or source.suffix not in EXTENSIONS:
        continue
    if any(part in SKIP or 'webview' in part for part in relative.parts):
        continue
    records.append(copy_verified(source, DEST / 'snapshot' / relative))
for name in ('native-validation.exe', 'csv-native-parquet-validation.exe'):
    records.append(copy_verified(SOURCE / name, DEST / 'bin' / name))
for name in ('timestamp.csv', 'timestamp.README.md'):
    records.append(copy_verified(ROOT / 'fixtures/manual' / name, DEST / 'fixtures' / name))
manifest = {'date': '2026-11-04', 'status': 'ARCHIVED_VALIDATED_EXPERIMENT_NOT_PRODUCT_ADOPTION',
            'canonicalExperimentPath': SOURCE.relative_to(ROOT).as_posix(),
            'binaryPolicy': 'Local verified copies; EXE excluded from Git. Hashes retained.',
            'excluded': ['generated CSV/Parquet/partial outputs', 'browser profiles and app caches', 'Cargo build caches', 'generated Tauri gen directory'],
            'files': records}
(DEST / '10-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'files': len(records), 'bytes': sum(r['bytes'] for r in records), 'verified': True}))
