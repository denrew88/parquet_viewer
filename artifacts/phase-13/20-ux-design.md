# Phase 13 UX 설계

## 1. Multi-column sort

Toolbar의 `Sorts (N)`에서 non-modal draft panel을 연다.

```text
Multi-column sort
Drag rows to change sort priority.

:: 1  [group_id  v] [Ascending  v] [remove]
:: 2  [timestamp v] [Descending v] [remove]
:: 3  [category  v] [Ascending  v] [remove]

[+ Add sort level]   Clear all
                         Cancel  Apply
```

컬럼 selector는 검색어가 없으면 전체 logical column을 virtualized list로 표시한다. hidden column은
`Hidden`, 이미 다른 criterion에 사용된 column은 `Already used`를 표시한다. header click은 단일 sort
cycle만 수행하고 Shift에 별도 의미를 주지 않는다.

## 2. 직접 reorder

파일 탭과 컬럼 header 자체가 pointer drag surface다. threshold 전에는 기존 click, close, resize와 sort가
동작하고 threshold 이후 moving item과 insertion line을 표시한다. overflow edge에서는 bounded auto-scroll한다.
reorder `...`와 Move left/right menu는 제거한다. keyboard 사용자는 focused handle의 문서화된 shortcut을
사용하며 screen reader에 현재 위치와 이동 결과를 알린다.

## 3. Transient surface

Copy history, chooser와 action popover는 backdrop 없는 anchored surface다. outside pointer는 surface만 닫고
같은 pointer의 cell selection/button action을 계속 수행한다. Esc는 trigger focus를 복원한다. persistent
Find bar와 draft Settings dialog는 cell click으로 닫지 않는다.

## 4. Value display formats

전체 Settings dialog와 CSV, Copy, Temporary storage section은 유지한다. Value display formats 내부의
control grid를 다음 요약 목록으로 바꾼다.

```text
String       Line breaks, maximum 2 lines       >
Integer      1,234,567                           >
Decimal      1,234.567890                        >
Date         2025-12-18                          >
Timestamp    2025-12-18 01:23:34.111111111       >
Duration     2d 03:04:05.123456789               >
Boolean      true / false                        >
Binary       Hex, 256-byte preview               >
```

상세는 같은 section 내부 view다.

```text
< All formats                              Timestamp

Preview
2025-12-18 01:23:34.111111111

Preset                                [Standard v]
Advanced settings                                v
```

Advanced를 펼쳐야 세부 select가 나타난다. 변경은 실제 formatter Preview에 즉시 반영하고 세부 변경 시
preset은 Custom으로 파생한다. dialog 하단 기존 Cancel/Apply만 사용한다.

## 5. Responsive와 focus

- 1440x900과 1024x768은 label/control 2-column을 사용할 수 있다.
- 800x600은 detail control을 1-column으로 쌓고 section 내부와 dialog footer가 겹치지 않는다.
- sort panel, selector와 transient popover는 viewport 안에서 flip/clamp하고 grid geometry를 이동하지 않는다.
- detail 진입은 heading 또는 첫 control, All formats 복귀는 원래 type row에 focus를 복원한다.

