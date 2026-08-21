import { formatClock, shortDownloads, shortDurationSeconds, shortPreview, shortStatus, shortThumbnail } from "./shorts-ui.mjs";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { jobs: [], selectedJobId: null, highlightJobId: null, view: "grid", template: null, createPreview: null, live: {}, sse: null, livePoll: null, poll: null };

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function syncToggleLabels() {
  $$(".toggle-state").forEach((label) => {
    const input = document.getElementById(label.dataset.toggleState);
    label.textContent = input?.checked ? "켜짐" : "꺼짐";
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `요청 실패 (${response.status})`);
  return payload;
}

function showToast(message, type = "") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast visible ${type}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.className = "toast"; }, 4200);
}

function setView(view, options = {}) {
  state.view = ["create", "detail", "template", "settings"].includes(view) ? view : "grid";
  const createOverlay = $("#create-overlay");
  const shortOverlay = $("#short-overlay");
  const templateOverlay = $("#template-overlay");
  const settingsOverlay = $("#settings-overlay");
  if (createOverlay) createOverlay.hidden = state.view !== "create";
  if (shortOverlay) shortOverlay.hidden = state.view !== "detail";
  if (templateOverlay) templateOverlay.hidden = state.view !== "template";
  if (settingsOverlay) settingsOverlay.hidden = state.view !== "settings";
  document.body.classList.toggle("overlay-open", state.view !== "grid");
  if (!options.skipHash) {
    const nextHash = state.view === "create" ? "#create" : state.view === "detail" ? "#short" : state.view === "template" ? "#template" : state.view === "settings" ? "#settings" : "#shorts";
    if (location.hash !== nextHash) history.replaceState(null, "", nextHash);
  }
  if (state.view === "create") {
    window.requestAnimationFrame(() => $("#topic")?.focus());
    void hydrateCreateSlots();
    void hydrateStudioSettings();
  }
  if (state.view === "template") void loadTemplateSurface();
  if (state.view === "settings") void hydrateStudioSettings();
}

function applyHash() {
  const hash = location.hash.replace("#", "");
  if (hash === "create") {
    setView("create", { skipHash: true });
    return;
  }
  if (hash === "template") {
    setView("template", { skipHash: true });
    return;
  }
  if (hash === "settings") {
    setView("settings", { skipHash: true });
    return;
  }
  if (hash === "short" || hash === "generation" || hash === "rendering") {
    if (state.selectedJobId && state.jobs.some((job) => job.id === state.selectedJobId)) {
      setView("detail", { skipHash: true });
      return;
    }
  }
  setView("grid", { skipHash: true });
}

function createTileMarkup() {
  return `<button type="button" class="short-card short-create-tile" id="create-tile"><div class="short-card-thumb create-thumb"><span class="create-plus">+</span></div><div class="short-card-body"><h3>새 쇼츠</h3></div></button>`;
}

function bust(url, token) {
  if (!url) return "";
  return `${url}${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(token || "")}`;
}

function renderShortCard(job) {
  const status = shortStatus(job);
  const thumb = bust(shortThumbnail(job), job.updatedAt);
  const duration = status.key === "draft" ? "—" : formatClock(shortDurationSeconds(job));
  const highlight = job.id === state.highlightJobId ? " just-created" : "";
  const selected = job.id === state.selectedJobId && state.view === "detail" ? " selected" : "";
  const progress = Number(job.progress || 0);
  const fallback = escapeHtml((job.topic || "쇼츠").slice(0, 2));
  const media = thumb
    ? `<img src="${escapeHtml(thumb)}" alt="" />`
    : `<div class="thumb-fallback" aria-hidden="true"><span>${fallback}</span></div>`;
  const generating = status.key === "running"
    ? `<div class="thumb-progress" aria-hidden="true"><i style="width:${progress}%"></i></div>`
    : "";
  return `<button type="button" class="short-card status-${status.key}${highlight}${selected}" data-job-id="${escapeHtml(job.id)}" aria-pressed="${job.id === state.selectedJobId && state.view === "detail"}"><div class="short-card-thumb">${media}<span class="short-status ${status.key}"><i></i>${escapeHtml(status.label)}</span><span class="short-duration">${escapeHtml(duration)}</span>${generating}</div><div class="short-card-body"><h3>${escapeHtml(job.topic)}</h3></div></button>`;
}

function upsertJob(partial) {
  if (!partial?.id) return null;
  const index = state.jobs.findIndex((item) => item.id === partial.id);
  if (index >= 0) {
    state.jobs[index] = { ...state.jobs[index], ...partial };
    return state.jobs[index];
  }
  state.jobs.unshift(partial);
  return state.jobs[0];
}

function bindShortCard(button) {
  button.addEventListener("click", () => {
    state.selectedJobId = button.dataset.jobId;
    setView("detail");
    renderJobs();
  });
}

function patchGridCard(job) {
  if (!job?.id) return;
  const grid = $("#shorts-grid");
  if (!grid) return;
  const card = grid.querySelector(`.short-card[data-job-id="${CSS.escape(job.id)}"]`);
  if (!card) {
    renderJobs();
    return;
  }
  const next = document.createElement("template");
  next.innerHTML = renderShortCard(job);
  const fresh = next.content.firstElementChild;
  card.replaceWith(fresh);
  bindShortCard(fresh);
}

function currentStageText(job = {}) {
  if (Number(job.queuePosition) > 0) return job.message || `대기 ${job.queuePosition}`;
  return job.live?.message || job.stage || job.message || shortStatus(job).label;
}

function currentStillUrl(job = {}) {
  const live = state.live[job.id] || {};
  const shot = [...(live.shots || [])].reverse().find((item) => item.stillUrl || item.clipUrl);
  return bust(shot?.stillUrl || shortThumbnail(job), job.updatedAt);
}

function patchDetailProgress(job) {
  if (!job || state.selectedJobId !== job.id || state.view !== "detail") return;
  const message = document.querySelector("#job-detail .detail-progress span, #live-factory .live-now");
  const percent = document.querySelector("#job-detail .detail-progress b");
  const bar = document.querySelector("#job-detail .progress-track i");
  const stage = currentStageText(job);
  if (message) message.textContent = stage;
  if (percent) percent.textContent = `${job.progress || 0}%`;
  if (bar) bar.style.width = `${job.progress || 0}%`;
  const still = document.querySelector("#job-detail .preview-still, #live-factory .live-still");
  const next = currentStillUrl(job);
  if (still && next) still.src = next;
  else if (!still && next && !document.querySelector("#job-detail video")) {
    const wrap = document.querySelector("#job-detail .preview-wrap, #live-factory .live-still-wrap");
    if (wrap) {
      const img = document.createElement("img");
      img.className = wrap.classList.contains("live-still-wrap") ? "live-still" : "preview-still";
      img.alt = "";
      img.src = next;
      wrap.prepend(img);
    }
  }
}

function renderJobs() {
  const grid = $("#shorts-grid");
  if (grid) {
    grid.innerHTML = `${createTileMarkup()}${state.jobs.map(renderShortCard).join("")}`;
    $("#create-tile")?.addEventListener("click", openCreate);
    $$(".short-card[data-job-id]").forEach(bindShortCard);
  }
  if (state.view === "detail") {
    const selected = state.jobs.find((job) => job.id === state.selectedJobId);
    if (!selected) {
      state.selectedJobId = null;
      setView("grid");
      renderLiveFactory(null);
      return;
    }
    renderJobDetail(selected);
    renderLiveFactory(selected);
    watchJobLive(selected);
  }
}

function defaultFactoryStages() {
  return [
    ["plan", "기획/슬롯"],
    ["hook-lock", "훅 스틸 잠금"],
    ["image-edit", "샷별 image_edit"],
    ["still-qa", "스틸 QA"],
    ["animate", "10초 영상"],
    ["clip-qa", "클립 QA"],
    ["tts-mix", "TTS/믹스"],
    ["captions", "대화 자막"],
    ["compose", "합성"],
    ["parts", "채팅 파트"]
  ].map(([id, label]) => ({ id, label, status: "WAIT", message: "" }));
}

function renderLiveFactory(job) {
  const root = $("#live-factory");
  if (!root) return;
  const running = job && ["queued", "running", "verifying"].includes(job.status);
  if (!job || job.provider !== "grok-imagine" || !running) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  root.hidden = false;
  const still = currentStillUrl(job);
  root.innerHTML = `<p class="live-now">${escapeHtml(currentStageText(job))}</p>${still ? `<div class="live-still-wrap"><img class="live-still" src="${escapeHtml(still)}" alt="" /></div>` : ""}`;
}

function applyLiveSnapshot(jobId, payload) {
  if (!payload || !jobId) return;
  const previous = state.live[jobId] || {};
  state.live[jobId] = {
    events: payload.events || previous.events || [],
    timeline: payload.timeline || previous.timeline || [],
    shots: payload.shots || previous.shots || [],
    proofs: payload.proofs || previous.proofs || []
  };
  const job = upsertJob(payload.job || state.jobs.find((item) => item.id === jobId));
  if (job && payload.job) {
    job.artifacts = payload.job.artifacts || job.artifacts;
    job.live = payload.job.live || job.live;
    job.stage = payload.job.stage || job.stage;
    job.message = payload.job.message || job.message;
    job.progress = payload.job.progress ?? job.progress;
    job.status = payload.job.status || job.status;
    job.updatedAt = payload.job.updatedAt || job.updatedAt;
  }
  const selected = state.jobs.find((item) => item.id === jobId);
  renderLiveFactory(selected);
  patchDetailProgress(selected);
  patchGridCard(selected);
}

function applyFactoryStage(jobId, event) {
  if (!event) return;
  const live = state.live[jobId] || { events: [], timeline: defaultFactoryStages(), shots: Array.from({ length: 7 }, (_, index) => ({ index: index + 1, status: "WAIT" })), proofs: [] };
  live.events = [...(live.events || []), event];
  live.timeline = (live.timeline?.length ? live.timeline : defaultFactoryStages()).map((stage) => (
    stage.id === event.stageId
      ? { ...stage, status: event.status || stage.status, message: event.message || stage.message, prompt: event.prompt || stage.prompt, frozen: Boolean(event.frozen) }
      : stage
  ));
  if (event.shotIndex) {
    live.shots = (live.shots?.length ? live.shots : Array.from({ length: 7 }, (_, index) => ({ index: index + 1, status: "WAIT" }))).map((shot) => {
      if (shot.index !== event.shotIndex) return shot;
      const still = event.artifacts?.find((item) => /\.png$/i.test(item.name || ""))?.url;
      const clip = event.artifacts?.find((item) => /\.mp4$/i.test(item.name || ""))?.url;
      return {
        ...shot,
        status: event.status || shot.status,
        message: event.message || shot.message,
        roleKo: event.roleKo || shot.roleKo,
        prompt: event.prompt || shot.prompt,
        stillUrl: still || shot.stillUrl,
        clipUrl: clip || shot.clipUrl,
        frozen: shot.frozen || Boolean(event.frozen)
      };
    });
  }
  state.live[jobId] = live;
  const job = upsertJob({
    id: jobId,
    live: { stageId: event.stageId, status: event.status, message: event.message, prompt: event.prompt || event.animatePrompt || null, frozen: Boolean(event.frozen), shotIndex: event.shotIndex },
    message: event.message,
    artifacts: [...(state.jobs.find((item) => item.id === jobId)?.artifacts || []), ...(event.artifacts || [])]
  });
  renderLiveFactory(job);
  patchDetailProgress(job);
  patchGridCard(job);
}

function watchJobLive(job) {
  if (!job || job.provider !== "grok-imagine") return;
  const active = ["queued", "running", "verifying"].includes(job.status);
  if (!active) {
    if (state.livePoll) { window.clearInterval(state.livePoll); state.livePoll = null; }
    if (!state.live[job.id]?.timeline?.length) void loadLiveSnapshot(job.id);
    return;
  }
  if (state.sse && state.sse.jobId === job.id) return;
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
  if (state.livePoll) { window.clearInterval(state.livePoll); state.livePoll = null; }
  try {
    const source = new EventSource(`/api/jobs/${encodeURIComponent(job.id)}/events?sse=1`);
    source.jobId = job.id;
    source.addEventListener("factory_stage", (event) => {
      try { applyFactoryStage(job.id, JSON.parse(event.data)); } catch { void loadLiveSnapshot(job.id); }
    });
    source.addEventListener("job", (event) => {
      try { applyLiveSnapshot(job.id, JSON.parse(event.data)); } catch { void loadLiveSnapshot(job.id); }
    });
    source.addEventListener("done", () => {
      source.close();
      if (state.sse === source) state.sse = null;
      void loadLiveSnapshot(job.id);
      void refreshJobs();
    });
    source.onerror = () => {
      source.close();
      if (state.sse === source) state.sse = null;
      if (!state.livePoll) state.livePoll = window.setInterval(() => loadLiveSnapshot(job.id), 1000);
    };
    state.sse = source;
    void loadLiveSnapshot(job.id);
  } catch {
    if (!state.livePoll) state.livePoll = window.setInterval(() => loadLiveSnapshot(job.id), 1000);
    void loadLiveSnapshot(job.id);
  }
}

async function loadLiveSnapshot(jobId) {
  try {
    const payload = await api(`/api/jobs/${encodeURIComponent(jobId)}/live`);
    applyLiveSnapshot(jobId, payload);
  } catch {
    // Keep the last live frame if the snapshot is briefly unavailable.
  }
}

function renderWorldSlotFields(slots = [], { namePrefix = "world-slot", editable = false } = {}) {
  return slots.map((slot) => {
    const canEdit = editable && slot.editable !== false && !slot.locked;
    const value = slot.value || "";
    const field = canEdit
      ? `<textarea id="${escapeHtml(namePrefix)}-${escapeHtml(slot.id)}" name="${escapeHtml(slot.id)}" data-world-slot="${escapeHtml(slot.id)}" rows="2">${escapeHtml(value)}</textarea>`
      : `<p class="slot-value">${escapeHtml(value || slot.placeholder || `{{${slot.id}}}`)}</p>`;
    return `<label class="slot-card ${canEdit ? "editable" : "locked"}"><span><b>${escapeHtml(slot.label)}</b></span><small>${escapeHtml(slot.hint || "")}</small>${field}</label>`;
  }).join("");
}

function renderShotPromptList(shots = []) {
  if (!shots.length) return "";
  return `<div class="shot-prompt-list">${shots.map((shot) => `<article class="shot-prompt"><b>${String(shot.index).padStart(2, "0")} · ${escapeHtml(shot.slotId || shot.role || "샷")}</b><pre>${escapeHtml(shot.prompt || "")}</pre></article>`).join("")}</div>`;
}

function renderLockTable(locks = []) {
  if (!locks.length) return "";
  return `<details class="template-locks"><summary>잠금 규칙</summary><div class="lock-table">${locks.map((lock) => `<div class="lock-row"><b>${escapeHtml(lock.label)}</b><small>${escapeHtml(lock.rule)}</small></div>`).join("")}</div></details>`;
}

async function loadTemplateSurface() {
  const root = $("#template-root");
  if (!root) return;
  try {
    if (!state.template) state.template = await api("/api/grok-imagine/template");
    const template = state.template;
    root.innerHTML = `<h2 id="template-title">${escapeHtml(template.title)}</h2><p>슬롯 값은 새 쇼츠 초안에서만 채울 수 있습니다. 사람·자막 위치·금지 항목은 바꾸지 않습니다.</p><div class="slot-grid">${renderWorldSlotFields(template.slots)}</div>${renderLockTable(template.locks)}`;
  } catch (error) {
    root.innerHTML = `<div class="error-box"><b>템플릿을 불러오지 못했습니다</b><pre>${escapeHtml(error.message)}</pre></div>`;
  }
}

function collectWorldSlots() {
  const slots = {};
  $$("[data-world-slot]").forEach((input) => {
    const value = String(input.value || "").trim();
    if (value) slots[input.dataset.worldSlot] = value;
  });
  return slots;
}

async function refreshCreatePreview() {
  if ($("#provider")?.value !== "grok-imagine") {
    const preview = $("#create-prompt-preview");
    if (preview) preview.innerHTML = "";
    return;
  }
  const topic = $("#topic")?.value || "";
  const facts = $("#facts")?.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) || [];
  const worldSlots = collectWorldSlots();
  if (topic.trim().length < 4 && !facts.length) {
    const preview = $("#create-prompt-preview");
    if (preview) preview.innerHTML = "";
    return;
  }
  try {
    state.createPreview = await api("/api/grok-imagine/template/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: topic.trim() || "빈 현장의 숨은 원리", facts, worldSlots })
    });
    const preview = $("#create-prompt-preview");
    if (preview) preview.innerHTML = `${renderWorldSlotFields(state.createPreview.worldSlots)}<h4 class="prompt-subhead">채워진 샷</h4>${renderShotPromptList(state.createPreview.shots)}`;
  } catch (error) {
    const preview = $("#create-prompt-preview");
    if (preview) preview.innerHTML = `<div class="warning-box"><b>미리보기 실패</b><p>${escapeHtml(error.message)}</p></div>`;
  }
}

async function hydrateCreateSlots() {
  try {
    if (!state.template) state.template = await api("/api/grok-imagine/template");
    const mount = $("#create-world-slots");
    if (mount && !mount.dataset.ready) {
      mount.innerHTML = renderWorldSlotFields(state.template.slots, { editable: true, namePrefix: "create-slot" });
      mount.dataset.ready = "1";
      mount.querySelectorAll("[data-world-slot]").forEach((input) => input.addEventListener("input", () => {
        window.clearTimeout(state.previewTimer);
        state.previewTimer = window.setTimeout(() => refreshCreatePreview().catch((error) => showToast(error.message, "error")), 280);
      }));
    }
    await refreshCreatePreview();
  } catch (error) {
    showToast(`템플릿을 불러오지 못했습니다: ${error.message}`, "error");
  }
}

function renderJobDetail(job) {
  const detail = $("#job-detail");
  if (!job) return;
  const status = shortStatus(job);
  const running = ["queued", "running", "verifying"].includes(job.status);
  const preview = shortPreview(job);
  const still = currentStillUrl(job);
  const previewMedia = preview.videoUrl
    ? `<video controls playsinline preload="metadata" poster="${escapeHtml(preview.poster || still || "")}" src="${escapeHtml(preview.videoUrl)}"></video>`
    : still
      ? `<img class="preview-still" src="${escapeHtml(still)}" alt="" />`
      : `<div class="preview-unavailable">${running ? "화면을 준비하는 중" : "아직 영상이 없습니다"}</div>`;
  const localControls = job.provider === "local" && !["completed", "running", "verifying"].includes(job.status)
    ? `<div class="upload-box"><label for="detail-upload"><span>클립을 올리세요</span><small>MP4, MOV, WebM</small></label><input id="detail-upload" type="file" accept="video/*" multiple /><button class="secondary-button" id="run-local" type="button">업로드한 클립으로 편집</button></div>`
    : "";
  const downloads = shortDownloads(job).map((item) => `<a class="artifact-link" href="${escapeHtml(item.href)}" download>${escapeHtml(item.label)}<b>↓</b></a>`).join("");
  const warnings = (job.warnings || []).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  detail.innerHTML = `<div class="detail-head"><h2 id="short-detail-title">${escapeHtml(job.topic)}</h2><span class="job-status ${status.key}"><i></i>${escapeHtml(status.label)}</span></div>${running ? `<div class="detail-progress"><div><span>${escapeHtml(currentStageText(job))}</span><b>${job.progress || 0}%</b></div><div class="progress-track"><i style="width:${job.progress || 0}%"></i></div></div>` : ""}<div class="preview-wrap">${previewMedia}</div>${localControls}${warnings ? `<div class="warning-box"><ul>${warnings}</ul></div>` : ""}${downloads ? `<div class="download-list artifact-list"><h3>내려받기</h3>${downloads}<p class="download-note">업로드는 나중에</p></div>` : ""}${job.status === "failed" ? `<div class="error-box"><b>실행 오류</b><pre>${escapeHtml(job.error || job.message || "알 수 없는 오류")}</pre><button class="secondary-button" id="retry-job" type="button">다시 실행</button></div>` : ""}`;
  $("#detail-upload")?.addEventListener("change", uploadLocalClips);
  $("#run-local")?.addEventListener("click", runSelectedJob);
  $("#retry-job")?.addEventListener("click", runSelectedJob);
}

async function uploadLocalClips(event) {
  const files = [...event.target.files];
  if (!files.length || !state.selectedJobId) return;
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  try {
    await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/clips`, { method: "POST", body: form });
    showToast(`${files.length}개 클립을 올렸습니다.`);
    await refreshJobs();
  } catch (error) { showToast(error.message, "error"); }
}

async function runSelectedJob() {
  if (!state.selectedJobId) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/run`, { method: "POST" });
    showToast("편집을 시작했습니다.");
    await refreshJobs();
  } catch (error) { showToast(error.message, "error"); }
}

async function pollJobs() {
  try {
    await refreshJobs();
  } catch (error) {
    showToast(`작업 상태 갱신 실패: ${error.message}`, "error");
  }
}

function syncPollTimer() {
  const active = state.jobs.some((job) => ["queued", "running", "verifying"].includes(job.status));
  if (state.poll) { window.clearInterval(state.poll); state.poll = null; }
  if (active) state.poll = window.setInterval(pollJobs, 900);
}

async function refreshJobs() {
  const payload = await api("/api/jobs");
  const previousIds = state.jobs.map((job) => job.id).join("\n");
  const nextIds = payload.jobs.map((job) => job.id).join("\n");
  const selectedId = state.selectedJobId;
  const selectedLive = selectedId ? state.jobs.find((job) => job.id === selectedId) : null;
  state.jobs = [...payload.jobs].sort((left, right) => {
    const leftIndex = Number(left.libraryIndex);
    const rightIndex = Number(right.libraryIndex);
    if (Number.isFinite(leftIndex) && Number.isFinite(rightIndex)) return leftIndex - rightIndex;
    if (Number.isFinite(leftIndex)) return 1;
    if (Number.isFinite(rightIndex)) return -1;
    return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
  }).map((job) => {
    if (job.id === selectedId && selectedLive?.live && ["queued", "running", "verifying"].includes(job.status)) {
      return { ...job, live: job.live || selectedLive.live, artifacts: job.artifacts?.length ? job.artifacts : selectedLive.artifacts };
    }
    return job;
  });
  const structural = previousIds !== nextIds || !document.querySelector("#create-tile");
  if (structural) renderJobs();
  else {
    state.jobs.forEach(patchGridCard);
    const selected = state.jobs.find((job) => job.id === selectedId);
    if (state.view === "detail" && selected) {
      patchDetailProgress(selected);
      renderLiveFactory(selected);
      watchJobLive(selected);
    }
  }
  syncPollTimer();
}

async function createProduction(event) {
  event.preventDefault();
  const provider = $("#provider").value;
  const sources = $("#sources").value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean).map((url) => ({ title: url, url }));
  const facts = $("#facts")?.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) || [];
  const worldSlots = collectWorldSlots();
  const scriptDraft = $("#script-draft")?.value.trim() || "";
  const ttsProvider = $("#create-tts-provider")?.value || "edge";
  const ttsVoice = $("#create-tts-voice")?.value || "";
  const body = { topic: $("#topic").value, format: $("#format").value, clipCount: Number($("#clip-count").value), provider, sources, facts, worldSlots, scriptDraft, ttsProvider, ttsVoice, captions: $("#captions").checked, voiceover: provider === "grok-imagine" ? false : $("#voiceover").checked };
  if (ttsVoice) {
    void api("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttsProvider, ttsVoice })
    }).then((payload) => {
      if (payload?.settings) {
        state.settings = payload.settings;
        applySettingsToForm(payload.settings);
      }
    }).catch(() => {});
  }
  if (provider === "gemini-browser" || provider === "grok-imagine") body.autoStart = true;
  const button = event.submitter;
  button.disabled = true;
  button.querySelector("span").textContent = "시작하는 중…";
  try {
    const payload = await api("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    state.selectedJobId = payload.job.id;
    state.highlightJobId = payload.job.id;
    upsertJob(payload.job);
    window.setTimeout(() => {
      if (state.highlightJobId === payload.job.id) state.highlightJobId = null;
      document.querySelector(`[data-job-id="${CSS.escape(payload.job.id)}"]`)?.classList.remove("just-created");
    }, 4200);
    if (provider === "grok-imagine") {
      setView("detail");
      renderJobs();
      watchJobLive(payload.job);
    } else {
      setView("grid");
    }
    await refreshJobs();
    showToast(provider === "grok-imagine" ? "공장을 시작했습니다." : provider === "gemini-browser" ? "Gemini 작업을 시작했습니다." : provider === "local-video" ? "로컬 영상 작업을 만들었습니다." : "로컬 클립 작업을 만들었습니다.");
  } catch (error) { showToast(error.message, "error"); }
  finally { button.disabled = false; button.querySelector("span").textContent = "시작"; }
}

async function connectBrowser() {
  const button = $("#browser-start");
  if (!button) return;
  button.disabled = true;
  button.textContent = "Chrome 시작 중…";
  try {
    const result = await api("/api/browser/start", { method: "POST" });
    showToast(result.started ? "전용 Chrome을 시작했습니다." : "Chrome 연결을 확인했습니다.");
  } catch (error) { showToast(error.message, "error"); }
  finally { button.disabled = false; button.textContent = "Gemini Chrome 연결"; }
}

function syncProviderForm() {
  const provider = $("#provider")?.value;
  const factsField = $("#facts-field");
  const help = $("#provider-help");
  const voiceover = $("#voiceover");
  const clipCount = $("#clip-count");
  const format = $("#format");
  const browser = $("#browser-start");
  if (factsField) factsField.hidden = provider !== "grok-imagine";
  if (help) {
    help.textContent = provider === "grok-imagine"
      ? "Grok Imagine 공장은 PATH의 grok 또는 ~/.grok/bin/grok와 이미 되어 있는 SuperGrok OAuth만 사용합니다. XAI_API_KEY와 grok login/logout은 쓰지 않으며 Gemini로 대체하지 않습니다."
      : provider === "local-video"
        ? "로컬 영상 모델은 설정된 생성기 명령이 필요합니다."
        : provider === "local"
          ? "업로드한 로컬 클립만 편집합니다."
          : "Gemini는 전용 Chrome 세션을 재사용합니다. 로그인·CAPTCHA는 우회하지 않습니다.";
  }
  if (browser) browser.hidden = provider !== "gemini-browser";
  if (voiceover) {
    if (provider === "grok-imagine") {
      voiceover.checked = false;
      voiceover.disabled = true;
    } else {
      voiceover.disabled = false;
    }
  }
  if (clipCount) {
    clipCount.value = provider === "grok-imagine" ? "7" : clipCount.value;
    clipCount.disabled = provider === "grok-imagine";
  }
  if (format) {
    if (provider === "grok-imagine") format.value = "vertical";
    format.disabled = provider === "grok-imagine";
  }
  syncToggleLabels();
}

function openCreate(event) {
  event?.preventDefault();
  setView("create");
  void hydrateCreateSlots();
}

function openTemplate(event) {
  event?.preventDefault();
  $("#library-more")?.removeAttribute("open");
  setView("template");
}

function openSettings(event) {
  event?.preventDefault();
  $("#library-more")?.removeAttribute("open");
  setView("settings");
}

function applySettingsToForm(settings) {
  const chirp = Boolean(settings?.chirpAvailable);
  ["settings-chirp-option", "create-chirp-option"].forEach((id) => {
    const option = document.getElementById(id);
    if (option) option.hidden = !chirp;
  });
  const provider = settings?.ttsProvider === "chirp" && chirp ? "chirp" : "edge";
  if ($("#settings-tts-provider")) $("#settings-tts-provider").value = provider;
  if ($("#create-tts-provider")) $("#create-tts-provider").value = provider;
  if (settings?.ttsVoice) {
    if ($("#settings-tts-voice")) $("#settings-tts-voice").value = settings.ttsVoice;
    if ($("#create-tts-voice")) $("#create-tts-voice").value = settings.ttsVoice;
  }
  if ($("#settings-bgm-enabled")) $("#settings-bgm-enabled").checked = settings?.bgmEnabled === true;
  if ($("#settings-bgm-volume")) $("#settings-bgm-volume").value = String(settings?.bgmVolume ?? 0.08);
  if ($("#settings-ffmpeg")) $("#settings-ffmpeg").value = settings?.ffmpegPath || "";
  syncToggleLabels();
}

async function hydrateStudioSettings() {
  try {
    const payload = await api("/api/settings");
    state.settings = payload.settings;
    applySettingsToForm(payload.settings);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function saveSettings(event) {
  event?.preventDefault();
  try {
    const payload = await api("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ttsProvider: $("#settings-tts-provider")?.value,
        ttsVoice: $("#settings-tts-voice")?.value,
        bgmEnabled: $("#settings-bgm-enabled")?.checked === true,
        bgmVolume: Number($("#settings-bgm-volume")?.value || 0),
        ffmpegPath: $("#settings-ffmpeg")?.value || ""
      })
    });
    state.settings = payload.settings;
    applySettingsToForm(payload.settings);
    showToast("설정을 저장했습니다.");
    setView("grid");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function previewVoice(buttonId, audioId, providerId, voiceId) {
  const button = $(buttonId);
  if (button) button.disabled = true;
  try {
    const text = $("#script-draft")?.value.trim() || $("#topic")?.value.trim() || "이렇게 설계된 겁니다.";
    const response = await fetch("/api/tts/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        provider: $(providerId)?.value || "edge",
        voice: $(voiceId)?.value
      })
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "미리 듣기에 실패했습니다.");
    }
    const blob = await response.blob();
    const audio = $(audioId);
    if (audio) {
      audio.src = URL.createObjectURL(blob);
      audio.hidden = false;
      await audio.play().catch(() => {});
    }
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function draftScriptFromTopic() {
  const button = $("#draft-script");
  const errorBox = $("#script-draft-error");
  const area = $("#script-draft");
  const label = $("#script-draft-label");
  if (button) button.disabled = true;
  if (errorBox) {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }
  try {
    const facts = $("#facts")?.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) || [];
    const payload = await api("/api/script/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: $("#topic")?.value, facts })
    });
    if (area) {
      area.hidden = false;
      area.value = payload.draft;
    }
    if (label) label.hidden = false;
    showToast("대본 초안을 넣었습니다.");
  } catch (error) {
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = error.message;
    }
    showToast(error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function importLibrary(event) {
  event?.preventDefault();
  $("#library-more")?.removeAttribute("open");
  try {
    const payload = await api("/api/library/import", { method: "POST" });
    await refreshJobs();
    const imported = payload.imported?.length || 0;
    const seeded = payload.seeded?.length || 0;
    showToast(imported ? `${imported}편을 올렸습니다.` : seeded ? "시드 카드가 있습니다." : "라이브러리를 다시 읽었습니다.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function closeOverlays(event) {
  event?.preventDefault();
  state.selectedJobId = state.view === "detail" ? null : state.selectedJobId;
  setView("grid");
  renderJobs();
}

async function refreshQuietly() {
  $("#library-more")?.removeAttribute("open");
  try {
    await refreshJobs();
    showToast("목록을 갱신했습니다.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function bindEvents() {
  $("#create-form").addEventListener("submit", createProduction);
  $("#provider")?.addEventListener("change", syncProviderForm);
  syncProviderForm();
  $("#browser-start")?.addEventListener("click", connectBrowser);
  $("#create-tile")?.addEventListener("click", openCreate);
  $("#open-template")?.addEventListener("click", openTemplate);
  $("#open-settings")?.addEventListener("click", openSettings);
  $("#import-library")?.addEventListener("click", importLibrary);
  $("#close-create")?.addEventListener("click", closeOverlays);
  $("#close-short")?.addEventListener("click", closeOverlays);
  $("#close-template")?.addEventListener("click", closeOverlays);
  $("#close-settings")?.addEventListener("click", closeOverlays);
  $("#settings-form")?.addEventListener("submit", saveSettings);
  $("#draft-script")?.addEventListener("click", () => { void draftScriptFromTopic(); });
  $("#preview-voice")?.addEventListener("click", () => { void previewVoice("#preview-voice", "#voice-preview-audio", "#create-tts-provider", "#create-tts-voice"); });
  $("#settings-preview-voice")?.addEventListener("click", () => { void previewVoice("#settings-preview-voice", "#settings-preview-audio", "#settings-tts-provider", "#settings-tts-voice"); });
  $("#settings-bgm-enabled")?.addEventListener("change", syncToggleLabels);
  $("#topic")?.addEventListener("input", () => {
    window.clearTimeout(state.previewTimer);
    state.previewTimer = window.setTimeout(() => refreshCreatePreview().catch((error) => showToast(error.message, "error")), 280);
  });
  $("#facts")?.addEventListener("input", () => {
    window.clearTimeout(state.previewTimer);
    state.previewTimer = window.setTimeout(() => refreshCreatePreview().catch((error) => showToast(error.message, "error")), 280);
  });
  $$("[data-close-view]").forEach((node) => node.addEventListener("click", closeOverlays));
  window.addEventListener("hashchange", () => { applyHash(); renderJobs(); });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.view !== "grid") closeOverlays();
  });
  $("#refresh-all")?.addEventListener("click", () => { void refreshQuietly(); });
  $$(".toggle-label input").forEach((input) => input.addEventListener("change", syncToggleLabels));
  syncToggleLabels();
}

async function warnIfFactoryToolsMissing() {
  try {
    const health = await api("/api/health");
    if (!health.capabilities?.ffmpeg) showToast("ffmpeg가 없습니다.", "error");
  } catch {
    // Home stays a grid even if health is unreachable.
  }
}

async function init() {
  bindEvents();
  applyHash();
  try {
    await refreshJobs();
    void warnIfFactoryToolsMissing();
  } catch (error) {
    showToast(error.message, "error");
  }
}

init();
