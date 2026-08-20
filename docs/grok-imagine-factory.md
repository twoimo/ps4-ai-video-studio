# Grok Imagine 공장

웹 스튜디오에서 신비한 건축사전식 한국어 공학 쇼츠를 **같은 잠금 규칙**으로 뽑기 위한 경로입니다. Gemini Chrome, 로컬 영상 모델, 로컬 업로드와는 별도이며, grok가 없으면 Gemini로 넘어가지 않습니다.

## 필요한 기기

- 공식 `grok` CLI가 PATH에 있거나 `~/.grok/bin/grok`에 있을 것
- SuperGrok OAuth가 **이미** 되어 있을 것 (`grok login` / `logout`을 공장이 대신 실행하지 않음)
- `XAI_API_KEY`를 넘기지 말 것. 구독 OAuth만 사용
- `ffmpeg` / `ffprobe` (채우기 합성·고정 스틸·16초 파트)
- 한 번에 grok 프로세스 하나

클라우드 VM이나 OAuth가 없는 서버에서는 작업이 한국어 오류로 끝납니다.

```
공식 grok CLI를 찾지 못했습니다. SuperGrok OAuth가 이미 되어 있는 기기에서
PATH의 grok 또는 ~/.grok/bin/grok로 실행하세요. Gemini로 대체하지 않습니다.
```

## 웹에서 실행

1. 스튜디오를 켭니다: `bun src/server.mjs`
2. 첫 화면은 **9:16 쇼츠 카드 그리드**입니다. `+ 새 쇼츠` 타일이 같은 그리드에 있습니다.
3. 타일을 누르면 기본 경로인 **Grok Imagine 공장** 시트가 열립니다. Gemini·로컬 업로드는 시트의 고급 칸에 있습니다.
4. 주제와, 출처에 적힌 사실만 줄바꿈으로 넣습니다. 없는 SI는 쓰지 않습니다.
5. 검증 출처 URL을 넣습니다.
6. 자동 제작 시작. 작업은 바로 공장 파이프라인을 타고, 화면은 다시 그리드로 돌아갑니다. 생성 중 카드는 `생성중`, 끝나면 `완료` 또는 `실패·프리즈`입니다.
7. 카드를 누르면 플레이어와 훅 잠금·스틸·클립·마스터/파트가 열립니다.
8. **프롬프트 템플릿**에서 2026-08-21 잠금 슬롯·샷 스켈레톤·공장 실패표를 앱 안에서 봅니다. 쇼츠 상세에는 그 편이 실제로 쓴(또는 쓸) 채워진 프롬프트가 있습니다.

잠긴 문장의 출처는 `src/grok-imagine-template.mjs`와 `docs/PROMPT_TEMPLATE.md`입니다. 형제 `video-pipeline` 체크아웃을 읽지 않습니다.

공장 작업은 항상 세로 720×1280, 클립 7개(고유 6 + 홀드 1), 장면당 10초, 대화 자막만, 내레이션 합성 없음으로 고정됩니다.

## 잠금 순서

1. 주제 비의존 슬롯 + 6고유 / 7홀드 샷 목록. 프롬프트에 출처에 없는 SI를 넣지 않음.
2. 공식 grok CLI `image_gen`으로 9:16 훅 스틸 하나. 이 파일이 월드 잠금.
3. 이후 스틸은 잠금(또는 통과한 형제)에서 `image_edit`만. `image_gen` 재호출 없음.
4. 스틸 QA: 같은 현장, 한국 스케일, 사람/실루엣 없음, 물속 신체 없음, 한 사실·한 라벨·한 샷, 면적 m²는 지붕면에만, 잔여 SI·픽셀 문장 없음.
5. 통과한 스틸만 10초 720p `image_to_video`. 프레임 0.3 / 5 / 9.5 검사. 사람 생성 또는 SI 드리프트면 버리고 한 번 더 비우게 재시도한 뒤, 실패하면 스틸 고정(Ken Burns 없음).
6. 합성: `scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280`. ASS Alignment=2, Fontsize=50, Outline=6, **MarginV=450**(중심 y≈805). 대화 자막만. `drawbox`/`drawtext` 스펙 알약 없음. 하드 컷. 채팅 안전 인코드 + 16초 이하 파트.
7. 작업 상세에 훅 잠금, 각 스틸, 각 클립, 마스터, 채팅 파일, 파트를 표시.

완벽을 약속하지 않습니다. 홀드가 나갈 수 있거나 고정될 때까지 돌립니다.

## API

```bash
curl -s -X POST http://localhost:3000/api/jobs \
  -H 'content-type: application/json' \
  -d '{
    "topic": "한강 갑문이 물을 나누는 이유",
    "provider": "grok-imagine",
    "facts": ["갑문은 수위를 나눕니다", "지붕 면적 2만 m²"],
    "sources": [{"title":"한강사업본부","url":"https://hangang.seoul.go.kr/"}]
  }'
```

`provider`는 작업 JSON에 그대로 남습니다. grok가 없으면 작업은 만들어지지만 실행이 위 한국어 오류로 실패합니다.

## 네트워크 없는 검사

```bash
node --test test/grok-imagine-factory.test.mjs
```

프롬프트 작성, QA 게이트, compose vf, ASS MarginV, grok 인자(키/로그인 금지)를 실제 Imagine 호출 없이 검사합니다.
