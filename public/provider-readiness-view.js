function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character]);
}

const PROVIDER_LABELS = Object.freeze({
  gemini: "Gemini Video",
  bfl: "BFL · FLUX 3",
  higgsfield: "Higgsfield",
  veed: "VEED"
});

function safeStatus(value) {
  return ["READY", "CONFIGURED", "BLOCKED", "STALE", "NOT_CONNECTED"].includes(value) ? value : "NOT_CONNECTED";
}

function timeLabel(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/u, "Z");
}

function booleanFact(label, value, trueLabel = "YES", falseLabel = "NO") {
  return `<span><b>${escapeHtml(label)}</b><em class="${value ? "fact-ok" : "fact-missing"}">${value ? trueLabel : falseLabel}</em></span>`;
}

function operationalFacts(provider) {
  if (provider.provider === "bfl") {
    const configuration = provider.configuration || {};
    return [
      booleanFact("API KEY", configuration.apiKeyConfigured, "CONFIGURED", "MISSING"),
      booleanFact("BUDGET CAP", configuration.budgetCapConfigured, "CONFIGURED", "MISSING"),
      booleanFact("COST ESTIMATE", configuration.costEstimateConfigured, "CONFIGURED", "MISSING"),
      booleanFact("GENERATOR", configuration.generatorSelected && configuration.selectedGeneratorExecutable, "SELECTED", "NOT SELECTED"),
      booleanFact(
        "BUNDLED ADAPTER",
        configuration.bundledAdapterAvailable,
        configuration.bundledAdapterSelected ? "AVAILABLE · SELECTED" : "AVAILABLE · NOT SELECTED",
        "NOT AVAILABLE"
      ),
      `<span><b>LIVE CONNECTION</b><em class="fact-muted">${provider.liveConnectionVerified ? "VERIFIED" : "NOT VERIFIED"}</em></span>`
    ].join("");
  }
  if (provider.provider === "gemini") {
    const operational = provider.operational || {};
    const profileCount = Number.isInteger(operational.profileCount) ? operational.profileCount : 0;
    const freshProfileCount = Number.isInteger(operational.freshProfileCount) ? operational.freshProfileCount : 0;
    const availableCount = Number.isInteger(operational.availableCount) ? operational.availableCount : 0;
    const authenticatedCount = Number.isInteger(operational.authenticatedCount) ? operational.authenticatedCount : 0;
    const headlessCount = Number.isInteger(operational.headlessCount) ? operational.headlessCount : 0;
    const videoModeCount = Number.isInteger(operational.videoModeCount) ? operational.videoModeCount : 0;
    const nextCheck = timeLabel(operational.nextCheckAt);
    const reset = timeLabel(operational.quotaResetAt);
    return [
      `<span><b>PROFILES</b><em>${availableCount}/${profileCount} AVAILABLE</em></span>`,
      `<span><b>FRESH</b><em>${freshProfileCount}/${profileCount}</em></span>`,
      `<span><b>AUTHENTICATED</b><em>${authenticatedCount}/${freshProfileCount}</em></span>`,
      `<span><b>HEADLESS</b><em>${headlessCount}/${freshProfileCount}</em></span>`,
      `<span><b>VIDEO MODE</b><em>${videoModeCount}/${freshProfileCount}</em></span>`,
      nextCheck ? `<span><b>NEXT CHECK</b><em>${escapeHtml(nextCheck)}</em></span>` : "",
      reset ? `<span><b>QUOTA RESET</b><em>${escapeHtml(reset)}</em></span>` : ""
    ].join("");
  }
  return "";
}

function providerCard(provider, id) {
  const value = provider && typeof provider === "object" ? provider : { provider: id, status: "NOT_CONNECTED", blockers: [] };
  const status = safeStatus(value.status);
  const observedAt = timeLabel(value.observedAt);
  const blockers = Array.isArray(value.blockers) ? value.blockers : [];
  const blockerMarkup = blockers.length
    ? `<ul class="provider-blockers">${blockers.map((item) => `<li><code>${escapeHtml(item?.code || "unknown")}</code><span>${escapeHtml(item?.message || "준비 조건을 확인하지 못했습니다.")}</span></li>`).join("")}</ul>`
    : `<p class="provider-clear">현재 readiness blocker가 없습니다.</p>`;
  const facts = operationalFacts(value);
  return `<article class="provider-card provider-${status.toLowerCase().replaceAll("_", "-")}"><div class="provider-card-head"><div><span>${escapeHtml(PROVIDER_LABELS[id] || id)}</span><small>${escapeHtml(value.evidence || "none")}</small></div><strong>${status.replaceAll("_", " ")}</strong></div>${facts ? `<div class="provider-facts">${facts}</div>` : ""}${blockerMarkup}<footer>${observedAt ? `OBSERVED ${escapeHtml(observedAt)}` : "NO FRESH OBSERVATION"}</footer></article>`;
}

export function providerReadinessMarkup(payload) {
  const providers = payload?.providers && typeof payload.providers === "object" ? payload.providers : {};
  const ids = ["gemini", "bfl", "higgsfield", "veed"];
  const ready = ids.filter((id) => ["READY", "CONFIGURED"].includes(providers[id]?.status)).length;
  return `<div class="provider-readiness-head"><div><span class="panel-kicker">PROVIDER READINESS · GET-ONLY</span><h3>생성 제공자 준비상태</h3></div><span class="provider-readiness-summary">${ready}/${ids.length} READY OR CONFIGURED</span></div><p class="provider-readiness-note">설정 및 TTL 내 관측 영수증만 표시합니다. BFL CONFIGURED는 로컬 설정 확인이며 라이브 API 연결 증명이 아닙니다.</p><div class="provider-grid">${ids.map((id) => providerCard(providers[id], id)).join("")}</div>`;
}
