export function studioOpenApi() {
  return {
    openapi: "3.0.3",
    info: {
      title: "PS4 AI Video Studio",
      version: "0.1.0",
      description: "공장 작업 생성, 가져오기, SSE, 산출물, 음성 미리 듣기. Grok Imagine은 공식 grok CLI만 쓰며 Gemini로 대체하지 않습니다."
    },
    paths: {
      "/api/jobs": {
        get: {
          summary: "작업 목록",
          operationId: "listJobs",
          responses: { 200: { description: "작업과 공장 대기열" } }
        },
        post: {
          summary: "공장 작업 만들기",
          operationId: "createJob",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["topic"],
                  properties: {
                    topic: { type: "string" },
                    facts: { type: "array", items: { type: "string" } },
                    scriptDraft: { type: "string" },
                    ttsProvider: { type: "string", enum: ["edge", "chirp"] },
                    ttsVoice: { type: "string", description: "고급에서 고른 Edge/Chirp 목소리. 작업에 저장하고 합성에 씁니다." },
                    provider: { type: "string", enum: ["grok-imagine", "gemini-browser", "local-video", "local"] },
                    draftOnly: { type: "boolean", description: "초안만 저장하고 Imagine을 시작하지 않습니다." },
                    autoStart: { type: "boolean" }
                  }
                }
              }
            }
          },
          responses: { 201: { description: "생성된 작업" }, 400: { description: "잘못된 요청" } }
        }
      },
      "/api/library/import": {
        post: {
          summary: "이미 만든 편 가져오기",
          operationId: "importLibrary",
          responses: { 200: { description: "시드·가져온 작업" } }
        }
      },
      "/api/jobs/{id}": {
        get: {
          summary: "작업 상세",
          operationId: "getJob",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "작업" } }
        },
        patch: {
          summary: "초안 저장",
          operationId: "saveJobDraft",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "작업과 프롬프트" }, 409: { description: "실행 중" } }
        }
      },
      "/api/jobs/{id}/draft": {
        post: {
          summary: "초안 저장",
          operationId: "saveJobDraftPost",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "작업과 프롬프트" }, 409: { description: "실행 중" } }
        }
      },
      "/api/jobs/{id}/events": {
        get: {
          summary: "공장 SSE / 이벤트 스냅샷",
          operationId: "jobEvents",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "sse", in: "query", schema: { type: "string" } }
          ],
          responses: { 200: { description: "JSON 스냅샷 또는 text/event-stream" } }
        }
      },
      "/api/jobs/{id}/artifacts/{name}": {
        get: {
          summary: "산출물 다운로드",
          operationId: "jobArtifact",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" } },
            { name: "download", in: "query", schema: { type: "string" } }
          ],
          responses: { 200: { description: "파일" } }
        }
      },
      "/api/tts/preview": {
        post: {
          summary: "음성 미리 듣기",
          operationId: "ttsPreview",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    voice: { type: "string" },
                    provider: { type: "string", enum: ["edge", "chirp"] }
                  }
                }
              }
            }
          },
          responses: { 200: { description: "audio/mpeg" }, 400: { description: "실패" } }
        }
      },
      "/api/tts/voices": {
        get: {
          summary: "TTS 목소리 목록",
          operationId: "ttsVoices",
          responses: { 200: { description: "Edge 기본 목소리와 Chirp 가능 여부" } }
        }
      },
      "/api/settings": {
        get: { summary: "설정", operationId: "getSettings", responses: { 200: { description: "워크스페이스 설정" } } },
        put: { summary: "설정 저장", operationId: "putSettings", responses: { 200: { description: "저장된 설정" } } }
      },
      "/api/script/draft": {
        post: {
          summary: "주제에서 한국어 대본 초안",
          operationId: "scriptDraft",
          description: "공식 grok CLI 텍스트만. Gemini로 대체하지 않습니다. 마지막 문장 「이렇게 설계된 겁니다.」",
          responses: { 200: { description: "대본" }, 400: { description: "grok 텍스트 실패" } }
        }
      },
      "/api/grok-imagine/template": {
        get: { summary: "잠긴 공장 템플릿", operationId: "factoryTemplate", responses: { 200: { description: "슬롯과 잠금" } } }
      },
      "/api/grok-imagine/template/preview": {
        post: { summary: "공장 프롬프트 미리보기", operationId: "factoryPreview", responses: { 200: { description: "채워진 샷" } } }
      },
      "/api/openapi.json": {
        get: { summary: "OpenAPI", operationId: "openapi", responses: { 200: { description: "이 문서" } } }
      }
    }
  };
}

export function studioDocsHtml() {
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <title>공장 API</title>
    <style>
      body { margin: 24px; font: 15px/1.5 -apple-system, "Apple SD Gothic Neo", sans-serif; background: #0b0e14; color: #f2f4f8; }
      a { color: #7de4d2; }
      pre { overflow: auto; padding: 12px; background: #171c27; border-radius: 8px; }
    </style>
  </head>
  <body>
    <h1>공장 API</h1>
    <p>실제 경로만 적습니다. 작업 만들기, 가져오기, SSE, 산출물, 음성 미리 듣기.</p>
    <p><a href="/api/openapi.json">/api/openapi.json</a></p>
    <pre id="spec">불러오는 중</pre>
    <script>
      fetch("/api/openapi.json").then((response) => response.json()).then((spec) => {
        document.getElementById("spec").textContent = JSON.stringify(spec, null, 2);
      }).catch((error) => { document.getElementById("spec").textContent = error.message; });
    </script>
  </body>
</html>`;
}
