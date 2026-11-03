"""Consolidate existing evidence without rerunning conversions or builds."""
import csv
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
EXP = HERE.parent
sys.path.insert(0, str(ROOT / '.tmp/hdf5-fixture-python'))
import pyarrow.parquet as pq

def read(p):
    return json.loads(p.read_text(encoding='utf-8-sig'))

def sha(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()

quality = read(HERE / 'quality/runs/final/results.json')
adjudications = []
for case in quality['cases']:
    if case['status'] != 'FAIL':
        continue
    assert case['id'] in ('cr-only', 'blank-lines')
    directory = Path(case['directory'])
    with (directory / 'input.csv').open(newline='', encoding='utf-8') as f:
        records = [row for row in csv.reader(f) if row]
    expected = records[1:]
    values = pq.read_table(directory / 'native.parquet').to_pydict()
    assert values['__dv_row_id'] == list(range(len(expected)))
    for i in range(len(records[0])):
        assert values[f'__dv_base_raw_{i}'] == [row[i] for row in expected]
    assert all(v == 0 for k, vs in values.items() if k.startswith('__dv_state_word_') for v in vs)
    adjudications.append({'id': case['id'], 'rawStatus': 'FAIL', 'adjudication': 'BASELINE_DIFFERENCE',
                         'independentCsvOracle': 'PASS', 'expectedRows': expected,
                         'note': 'csv CR/LF/CRLF handling and empty-record skipping; raw comparison retained.'})
(HERE / 'quality/90-final-adjudication.json').write_text(json.dumps(adjudications, indent=2) + '\n')

original = read(EXP / '20-provenance.json')
provenance = {name: {'sha256': sha(ROOT / name), 'unchanged': sha(ROOT / name) == meta['sha256']}
              for name, meta in original['product'].items()}
assert all(v['unchanged'] for v in provenance.values())
assert sha(ROOT / 'src-tauri/src/data/csv_polars.rs') == original['productSinkSha256']
perf = read(HERE / 'performance/final/results.json')
assert perf['status'] == 'PASS'
size = read(HERE / '60-size-corrected.json')
assert size['optimized']['sha256'] == read(HERE / 'build-app.json')['sha256'].lower()
groups = {}
table = []
for w in perf['workloads']:
    a = w['aggregate']
    groups[w['id']] = {}
    for engine in ('polars', 'native'):
        first = next(r for r in w['runs'] if r['engine'] == engine)
        groups[w['id']][engine] = pq.ParquetFile(first['output']).metadata.num_row_groups
    table.append(f"| {w['id']} | {a['polars']['converterMs']['median']:.2f} | {a['native']['converterMs']['median']:.2f} | {a['polars']['cpuSeconds']['median']:.3f} → {a['native']['cpuSeconds']['median']:.3f} |")
summary = {'productInputs': provenance, 'originalProductSinkUnchanged': True,
           'candidateAppSha256': size['optimized']['sha256'], 'candidateCoreSha256': sha(EXP / 'csv-native-parquet-validation.exe'),
           'sizeMiB': size['optimized']['bytes'] / 1048576, 'reductionPercent': size['reductionPercent'],
           'rowGroups': groups, 'qualityAdjudications': adjudications,
           'review': 'Independent initial review; root ran final validation after agents hit provider usage limit. No independent post-fix signoff.'}
(HERE / '80-final-evidence.json').write_text(json.dumps(summary, indent=2) + '\n')
report = '''# Native CSV → Parquet 확대 검증 결과

2026-11-04. 원제품에는 반영하지 않은 비교 구현이다. Rust csv + polars-arrow/polars-parquet를 사용하며 전체 Polars 실행 엔진을 제거했다. DuckDB는 조회용으로 유지한다.

## 결론과 크기 정정

데이터 무결성, 실제 앱 경로, 취소·재시도, worker 경계 및 기존 백엔드 회귀를 검증했다. 979MB CSV의 최신 변환 속도는 기존 Polars와 동급이며 CPU 시간은 약 18% 적었다.

이전 55.85MiB 수치는 무효다. 비교본의 Windows 절대 frontendDist가 URL로 해석되어 UI가 EXE에 포함되지 않았다. 상대 경로로 수정하고 실제 Tauri UI를 확인한 EXE는 **58,757,632 bytes = 56.0356MiB**다. 동일 Cargo 비교 기준 **108,707,328 bytes = 103.6714MiB**보다 **49,949,696 bytes, 45.9488% 감소**했다. 이전 잘못된 EXE와 실패 증거도 보존했다.

수정본은 별도 앱 identifier로 캐시·설정을 격리했다. 실제 http://tauri.localhost UI 및 CSV/Parquet/HDF5 표시를 검증했다. PE는 모두 AMD64다. 후보에 새 DLL import는 없고 기존 pdh/powrprof/psapi/bcrypt/crypt32 import가 없어졌다. 원본 manifest·lock·프런트 dist·csv_polars.rs 해시는 그대로다. 상세: [크기](60-size-corrected.json), [출처](80-final-evidence.json).

## 검증 범위와 결과

- 독립 Python/PyArrow oracle 데이터 행렬 **79 PASS**: 0/1/65535/65536/65537행, 1~256열 경계, 상태 word 경계, no-header, UTF-8, quoted CR/LF, 정수 범위·Decimal, seeded random.
- 집중 품질 행렬 원시 결과 **37 PASS / 2 FAIL**. 두 불일치는 CR-only와 빈 줄에 대한 기존 Polars의 동작 차이다. 새 결과는 독립 Python csv oracle 및 Rust csv의 CR/LF/CRLF·빈 레코드 생략 계약과 일치했다. FAIL 원시 기록을 덮어쓰지 않았다. [판정](quality/90-final-adjudication.json).
- 파일 충돌·잘못된 출력 경로 **6 PASS**, 큰/종료되지 않은 레코드 제한 **4 PASS**, worker wire·snapshot·실행 중 source mutation **14 PASS**. 공유 원본은 변경하지 않았다.
- 기존 Rust 백엔드: 전체 첫 실행 **296 PASS**, fixture 경로 누락으로 실패한 9개는 fixture 준비 후 해당 테스트 재실행 **9 PASS**. 합계 **305개 확인**. 기존 ignored 16개는 유지하고 대용량 취소 spike 1개를 별도 실행해 PASS. 테스트 단언을 낮추지 않았다. Polars API 전용 두 테스트는 실제 Parquet schema/기존 DuckDB 결과 단언으로 이식했다.
- 독립 변환기 단위 테스트 **8 PASS**. format, standalone Clippy 및 실제 앱 all-targets/custom-protocol Clippy `-D warnings` 완료. 로그: test.log, fmt.log, clippy.log, size-clippy.log 및 validation/app-rust-*.log.
- 실제 Tauri 앱: CSV fallback·Parquet·HDF5, Schema/Metadata, 마지막 행, 정렬·필터, Windows clipboard TSV 확인. 작은 CSV 검증은 fallback 경로이며 native 성능 증거로 사용하지 않았다.
- 실제 Auto native 경로: **5,850,000행 × 27개 물리 열 = 157,950,000셀 전체 비교 PASS**. 실제 게시 캐시를 동일 resolved profile의 기존 변환 결과와 비교했다. creator `Polars`는 polars-parquet writer임을 뜻하며 전체 Polars 엔진이 필요하다는 뜻이 아니다. [캐시 검증](native/cache-audit-result.json).
- 앱 Auto 첫 준비 11,498ms, 캐시 재열기 66ms/원본 read 0B. 각 1회 기능 관찰이며 과거 앱 준비 시간과의 통계적 성능 비교가 아니다.
- 실제 worker가 partial을 쓰는 중 취소 **43ms**, 앱이 열린 상태에서 잔여 staging 없음, 같은 문서 재시도 585만 행 READY. [취소](native/cancel-result.json).

## 최신 성능

34회 독립 프로세스 변환, 5개 입력 형태. main 5쌍, 나머지 각 3쌍, 순서 교대, 출력 전체 논리 값 검증 및 반복별 파일 해시 확인. 아래는 중앙값이다.

| 입력 | Polars 변환 ms | 새 변환기 ms | CPU seconds Polars → 새 구현 |
|---|---:|---:|---:|
''' + '\n'.join(table) + '''

main 979,427,914 bytes에서 시간 범위는 Polars 5.678~6.226초, 새 구현 5.871~6.149초로 겹친다. **유의미한 속도 향상으로 주장하지 않는다.** CPU 중앙값은 25.047→20.578초다. peak commit 중앙값은 206.31→98.58MiB, peak working set은 1123.90→76.54MiB다. Polars mmap 영향이 있어 working set 감소율을 전체 시스템 RAM 절감률로 해석하면 안 된다. 출력 크기는 449,566,163→450,268,295 bytes다.

OS cache는 비우지 않았다. 양쪽 thread 설정은 8이나 새 구현의 parser/writer가 추가되므로 총 OS thread 수를 동일하게 맞춘 실험은 아니다. 모든 원시 값과 CPU·메모리 계측은 [성능 JSON](performance/final/results.json)에 보존했다. 논리 데이터는 같아도 row-group 구성과 파일 bytes는 다를 수 있다. row-group 수는 80-final-evidence.json에 기록했다. 과거 약 16% 속도 향상 수치보다 이 최신 수정본 결과를 우선한다.

## 발견해 고친 결함

1. 실제 Auto 프로필이 worker에서 거절되던 문제: source Auto 수용, resolved Auto/Skip 거절 유지.
2. BOM 뒤 첫 quoted multiline/escaped 필드 파싱 오류 및 double-BOM 보존.
3. 지원하지 않는 프로필 옵션을 묵살하던 문제: 전체 옵션을 검증해 명시적으로 거절.
4. 종료되지 않은 큰 CSV 레코드의 조기 메모리 제한: encoded 레코드 약 16MiB 제한과 decoded 8MiB 제한. 128MiB 악성 입력도 전체 할당 전에 중단.
5. 부모 cleanup이 추적하지 못하던 중첩 partial 제거: 부모 소유 partial로 직접 작성해 강제 취소 시 정리.
6. frontendDist의 잘못된 절대 경로 및 앱 검증 namespace 격리 문제.

## 남은 제한

native 지원 범위는 최대 256열, decoded 단일 레코드 8MiB, 기본 옵션 및 지원 타입이다. 지원 밖 프로필은 기존 fallback을 사용한다. 32MiB 배치 목표와 bounded queue는 프로세스 RSS의 절대 상한이 아니다. 독립 CLI에는 앱 worker의 source fingerprint 경계 전체가 없으며, 앱 worker 경계는 별도로 검증했다.

초기 독립 Quality review는 수행했다. 수정 후 최종 검증은 agent provider 사용량 제한으로 루트가 수행했으며 독립 재승인으로 표시하지 않는다. 초기 harness navigation/watch 경로 오류와 누락 fixture 실패도 기록을 보존했다. 초기 잘못된 빌드의 GUI 실패는 수정본 PASS와 구분한다. installer 설치·파일 연결·Excel 실제 붙여넣기·DPI·전체 UI viewport gate를 완료했다고 주장하지 않는다. UI 제품 코드는 변경하지 않았고 Phase 상태도 바꾸지 않았다.

재현용 release 도구·캐시 및 결과 파일은 보존했다. 공유 캐시를 지우는 전역 cleanup은 실행하지 않았다. 이 실험 결과가 원제품 반영이나 배포 완료를 뜻하지 않는다.
'''
(HERE / '90-results.md').write_text(report, encoding='utf-8')
print(json.dumps({'report': str(HERE / '90-results.md'), 'productUnchanged': True, 'sizeMiB': summary['sizeMiB'], 'adjudicated': len(adjudications)}))

if __name__ == '__main__':
    pass
