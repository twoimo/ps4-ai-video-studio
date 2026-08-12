const RIGHTS = Object.freeze({
  "mit-adaptable": "MIT adaptable",
  "reference-only": "reference only",
  mixed: "MIT adaptable · reference only"
});

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function safeOfficialUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    const officialHiggsfield = parsed.protocol === "https:" && parsed.hostname === "higgsfield.ai";
    const officialSkills = parsed.protocol === "https:" && parsed.hostname === "github.com" && parsed.pathname.startsWith("/higgsfield-ai/skills/");
    return officialHiggsfield || officialSkills ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function shotPatternsMarkup(payload) {
  if (payload?.error) return `<span class="health-error">shot pattern 카탈로그를 확인하지 못했습니다: ${escapeHtml(payload.error)}</span>`;
  const patterns = Array.isArray(payload?.patterns) ? payload.patterns : [];
  if (!patterns.length) return `<span class="muted">표시할 shot pattern이 없습니다.</span>`;
  return patterns.map((pattern) => {
    const rightsCode = Object.hasOwn(RIGHTS, pattern?.rights?.code) ? pattern.rights.code : "reference-only";
    const sourceLinks = (Array.isArray(pattern?.sources) ? pattern.sources : []).map((source) => {
      const href = safeOfficialUrl(source?.url);
      if (!href) return "";
      const license = source?.license === "MIT" ? "MIT" : "reference only";
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">Higgsfield AI · ${license}</a>`;
    }).join("");
    const role = pattern?.role === "continuity"
      ? "CONTINUITY PROMPT PATTERN · ELIGIBLE"
      : pattern?.role === "assembly"
        ? "REFERENCE ASSEMBLY · NOT SENT TO PROVIDER"
        : "CAMERA PROMPT PATTERN · ELIGIBLE";
    return `<article class="shot-pattern-card"><div class="shot-pattern-card-head"><span>${role}</span><b class="rights-badge rights-${rightsCode}">${RIGHTS[rightsCode]}</b></div><h4>${escapeHtml(pattern?.labelKo || "이름 없는 패턴")}</h4><p>${escapeHtml(pattern?.goal || "설명 없음")}</p><div class="shot-pattern-sources">${sourceLinks}</div></article>`;
  }).join("");
}

export { safeOfficialUrl as safeShotPatternSourceUrl };
