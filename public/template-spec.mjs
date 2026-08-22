export function escapeSpecHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

export function renderWorldSlotFields(slots = [], { editable = false, namePrefix = "world-slot" } = {}) {
  return slots.map((slot) => {
    const canEdit = editable && slot.editable !== false && !slot.locked;
    const value = slot.value || "";
    const field = canEdit
      ? `<textarea id="${escapeSpecHtml(namePrefix)}-${escapeSpecHtml(slot.id)}" name="${escapeSpecHtml(slot.id)}" data-world-slot="${escapeSpecHtml(slot.id)}" rows="2">${escapeSpecHtml(value)}</textarea>`
      : `<p class="slot-value">${escapeSpecHtml(value || slot.placeholder || `{{${slot.id}}}`)}</p>`;
    return `<label class="slot-card ${canEdit ? "editable" : "locked"}"><span><b>${escapeSpecHtml(slot.label)}</b></span><small>${escapeSpecHtml(slot.hint || "")}</small>${field}</label>`;
  }).join("");
}

export function renderLockTable(locks = []) {
  if (!locks.length) return "";
  return `<div class="lock-table">${locks.map((lock) => `<div class="lock-row"><b>${escapeSpecHtml(lock.label)}</b> <code>${escapeSpecHtml(lock.id || "")}</code><small>${escapeSpecHtml(lock.rule)}</small></div>`).join("")}</div>`;
}

function specKv(label, value) {
  return `<div class="spec-kv"><b>${escapeSpecHtml(value)}</b><span>${escapeSpecHtml(label)}</span></div>`;
}

function factoryClass(flag = "") {
  if (flag === "yes") return "factory-yes";
  if (flag === "optional") return "factory-optional";
  return "factory-no";
}

export function renderSpecTable(headers, rows) {
  return `<table class="spec-table"><thead><tr>${headers.map((header) => `<th>${escapeSpecHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

export function renderLockedSpec(spec = {}) {
  const tally = spec.tally || {};
  const eraRows = Object.entries(tally.eras || spec.eras || {}).map(([key, value]) => [escapeSpecHtml(key), escapeSpecHtml(value)]);
  const typeRows = (spec.types || []).map((type) => [
    `<b>${escapeSpecHtml(type.id)}</b>`,
    escapeSpecHtml(type.meaning || ""),
    `<span class="${factoryClass(type.factory)}">${escapeSpecHtml(type.factory || "")}</span>`,
    escapeSpecHtml(type.videos ?? ""),
    escapeSpecHtml(type.hits ?? "")
  ]);
  const skeleton = (spec.skeleton?.lines || []).map((line) => `<li>${escapeSpecHtml(line)}</li>`).join("");
  const forbidden = (spec.skeleton?.forbidden || spec.skeletonForbidden || []).map((item) => `<li>${escapeSpecHtml(item)}</li>`).join("");
  const situation = (spec.situation || []).map((item) => `<li>${escapeSpecHtml(item)}</li>`).join("");
  const fails = (spec.hardFails || []).map((item) => `<li>${escapeSpecHtml(item)}</li>`).join("");
  const loop = (spec.loop || []).map((item) => `<li>${escapeSpecHtml(item)}</li>`).join("");
  const captions = spec.captions || {};
  const setups = tally.setups || {};
  return `
      <header class="spec-section" style="border-top:0">
        <h2>잠긴 프롬프트</h2>
        <p class="spec-lede">${escapeSpecHtml(spec.id)} · ${escapeSpecHtml(spec.date)}. 슬롯 값은 새 쇼츠 초안에서만 채울 수 있습니다. 잠금·코퍼스·스켈레톤은 읽기 전용입니다.</p>
      </header>
      <section class="spec-section" id="spec-corpus">
        <h3>코퍼스 ${escapeSpecHtml(tally.N ?? 288)}</h3>
        <div class="spec-kvs">
          ${specKv("N", tally.N ?? 288)}
          ${specKv("mature_explainer", tally.eras?.mature_explainer ?? "")}
          ${specKv("offtopic", tally.eras?.offtopic ?? "")}
          ${specKv("early_if", tally.eras?.early_if ?? "")}
          ${specKv("같은 현장", `${tally.site?.yes ?? ""}/${tally.N ?? 288}`)}
          ${specKv("실제 크기", `${tally.scale?.real ?? ""}/${tally.N ?? 288}`)}
          ${specKv("장난감", tally.scale?.toy ?? "")}
          ${specKv("막대 없음", `${(tally[`${"letter"}box`] || {}).no ?? ""}/${tally.N ?? 288}`)}
          ${specKv("홀드 속 움직임", `${tally.motion?.yes ?? ""}/${tally.N ?? 288}`)}
          ${specKv("세팅 중앙값", setups.median ?? 13)}
          ${specKv("세팅 평균", setups.mean ?? 13.89)}
          ${specKv("세팅 최빈값", setups.mode ?? 13)}
          ${specKv("세팅 범위", `${setups.min ?? 5}–${setups.max ?? 29}`)}
        </div>
        ${renderSpecTable(["era", "count"], eraRows)}
      </section>
      <section class="spec-section" id="spec-types">
        <h3>샷 타입 13</h3>
        ${renderSpecTable(["type", "meaning", "factory", "videos", "hits"], typeRows)}
      </section>
      <section class="spec-section" id="spec-graphics">
        <h3>그래픽 문법</h3>
        <div class="spec-kvs">
          ${specKv("red mixed", tally.reds?.mixed ?? "")}
          ${specKv("numbers on the line", tally.nums?.yes ?? "")}
          ${specKv("park/sand box", tally.park?.yes ?? "")}
          ${specKv("lid aligned", tally.lid?.yes ?? "")}
          ${specKv("captions", captions.rule ? "MarginV=450" : "Alignment=2")}
        </div>
      </section>
      <section class="spec-section" id="spec-slots">
        <h3>월드 슬롯 10</h3>
        <p class="spec-lede">sourced_si와 avoid는 잠금입니다. 값은 초안 만들기에서만 편집합니다.</p>
        <div class="slot-grid">${renderWorldSlotFields(spec.slots)}</div>
      </section>
      <section class="spec-section" id="spec-skeleton">
        <h3>샷 스켈레톤</h3>
        <ol class="spec-list">${skeleton}</ol>
        <h3>FORBIDDEN</h3>
        <ul class="spec-list">${forbidden}</ul>
      </section>
      <section class="spec-section" id="spec-locks">
        <h3>잠금</h3>
        ${renderLockTable(spec.locks)}
      </section>
      <section class="spec-section" id="spec-situation">
        <h3>상황 체크리스트</h3>
        <ol class="spec-list">${situation}</ol>
        <h3>Hard fails</h3>
        <ul class="spec-list">${fails}</ul>
      </section>
      <section class="spec-section" id="spec-loop">
        <h3>Reference-first loop</h3>
        <ol class="spec-list">${loop}</ol>
        <pre class="spec-pre">${escapeSpecHtml((spec.styleSheet && JSON.stringify(spec.styleSheet, null, 2)) || "")}</pre>
      </section>
      <section class="spec-section" id="spec-documents">
        <h3>문서</h3>
        <pre class="spec-pre">${escapeSpecHtml(spec.documents?.spec || spec.document || "")}</pre>
        <pre class="spec-pre">${escapeSpecHtml(spec.documents?.template || "")}</pre>
      </section>`;
}
