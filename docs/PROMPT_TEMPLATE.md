# Grok Imagine 공장 잠금 프롬프트

잠금 날짜: 2026-08-21
식별자: `grok-imagine-2026-08-21`

웹 앱은 형제 `video-pipeline` 체크아웃을 읽지 않습니다. 잠긴 문장은 `src/grok-imagine-template.mjs`가 단일 출처입니다. 슬롯 값은 채워도 되지만 FORBIDDEN, 자막 Y, 사람 없음 규칙은 바꾸지 않습니다.

## 월드 슬롯

- `site` — 현장. 이 주제의 빈 현장 하나. 실제 한국 스케일.
- `weather` — 날씨. 같은 날의 기록된 날씨. 출처 없는 노을은 만들지 않음.
- `everyday_thing` — 일상 사물. 이미 현장에 있는 보통 물건 하나.
- `hidden_thing` — 숨은 것. 이 편이 드러내는 장치·층. 사람이 아님.
- `materials` — 재료. 출처 사실에 적힌 재료만.
- `wear` — 마모. 같은 현장의 나이·얼룩·녹·젖은 자국.
- `trace` — 흔적. 물때, 신축줄눈, 볼트 그림자, 퇴적.
- `palette` — 팔레트. 흐린 한국 공공·기반시설 다큐멘터리 색.
- `sourced_si` — 출처 SI. 사실에 적힌 수량만. 없는 숫자는 만들지 않음. (잠금·읽기 전용)
- `avoid` — 피할 것. 사람·실루엣·물속 신체·잔여 SI·픽셀 문장. (잠금·읽기 전용)

## 샷 스켈레톤

- 9:16 still. Type: {{type}}. Camera: {{camera}}.
- World lock — site: {{site}}. weather: {{weather}}. palette: {{palette}}.
- everyday_thing: {{everyday_thing}}. hidden_thing: {{hidden_thing}}.
- materials: {{materials}}. wear: {{wear}}. trace: {{trace}}.
- Red graphics only as pin / measures / SI. Never a sentence. Never a spec pill.
- sourced_si: {{sourced_si}}.
- FORBIDDEN: people; silhouette; body in water; leftover SI; invented SI; sentences in pixels; second label; image_gen after hook; Ken Burns; drawbox / drawtext.

## 공장 잠금

- **사람 없음** (`no-people`): No people, no silhouettes.
- **물속 신체 없음** (`no-body-in-water`): No body in water.
- **한 사실 · 한 라벨 · 한 샷** (`one-fact-one-label-one-shot`): One fact → one label → one shot. No sentences in pixels.
- **면적은 지붕면에만** (`area-on-roof`): Area m² only on a roof plane, and only when sourced.
- **훅 잠금 후 image_edit만** (`hook-lock-then-edit`): image_gen once for the hook lock. Every later still is image_edit. Never call image_gen after the hook.
- **자막 Y** (`caption-y`): ASS Alignment=2, Fontsize=50, Outline=6, MarginV=450 (center y≈805). Dialogue captions only.
- **채우기 720×1280** (`fill-720-1280`): Fill 720×1280: `scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280`.
- **Ken Burns 없음** (`no-ken-burns`): Failed animate retries freeze the still. No Ken Burns.
- **클립 QA 시각** (`qa-frames`): Inspect frames at 0.3 / 5 / 9.5.
- **발명 SI 없음** (`no-invented-si`): Legal quantities come from sourced facts only. Numberize those tokens. Do not invent SI.
