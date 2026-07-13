// ============================================================
// ガイア動物病院 過去ログビューア（kakolog.js）
// 販売記録を検索して閲覧するだけの読み取り専用ページ。
// 書き込み系の処理は一切持たない（doPostは呼ばない）。
// GAS側の action=searchRecords（読み取り専用）だけを使用する。
// ============================================================

const GAS_URL = (typeof window !== "undefined" && window.GAS_URL) || "YOUR_GAS_URL_HERE";

let isSearching = false; // 連打防止

// ===== 検索実行 =====
async function doSearch() {
  if (isSearching) return;

  const owner = document.getElementById("qOwner").value.trim();
  const pet   = document.getElementById("qPet").value.trim();
  const from  = document.getElementById("qFrom").value;
  const to    = document.getElementById("qTo").value;

  const resultsEl = document.getElementById("results");

  if (!owner && !pet && !from && !to) {
    resultsEl.innerHTML = `<div class="result-status warn">検索条件を1つ以上入力してください</div>`;
    return;
  }
  if (from && to && from > to) {
    resultsEl.innerHTML = `<div class="result-status warn">期間の開始日が終了日より後になっています</div>`;
    return;
  }

  isSearching = true;
  const btn = document.getElementById("searchBtn");
  btn.disabled = true;
  resultsEl.innerHTML = `<div class="loading"><span class="spinner"></span>検索中…</div>`;

  try {
    const params = new URLSearchParams({ action: "searchRecords" });
    if (owner) params.set("owner", owner);
    if (pet)   params.set("pet", pet);
    if (from)  params.set("from", from);
    if (to)    params.set("to", to);

    const res = await fetch(GAS_URL + "?" + params.toString());
    const data = await res.json();

    if (data.result !== "success") {
      resultsEl.innerHTML = `<div class="result-status warn">エラー：${escapeHtml(data.message || "不明なエラー")}</div>`;
      return;
    }
    renderResults(data);
  } catch (e) {
    resultsEl.innerHTML = `<div class="result-status warn">通信エラー：${escapeHtml(e.message)}</div>`;
  } finally {
    isSearching = false;
    btn.disabled = false;
  }
}

// ===== 結果描画 =====
function renderResults(data) {
  const resultsEl = document.getElementById("results");
  const records = data.records || [];

  if (records.length === 0) {
    resultsEl.innerHTML = `<div class="empty-note">該当する記録はありませんでした</div>`;
    return;
  }

  let statusHtml;
  if (data.truncated) {
    statusHtml = `<div class="result-status warn">該当 ${data.totalHits} 件のうち新しい ${records.length} 件を表示しています。条件を絞ってください</div>`;
  } else {
    statusHtml = `<div class="result-status">${records.length} 件見つかりました（新しい順）</div>`;
  }

  const cards = records.map((r, i) => {
    const names = [r.owner, r.pet].filter(Boolean).join(" / ") || "（名前未入力）";
    return `
    <div class="record-card" id="card-${i}">
      <div class="record-head" onclick="toggleCard(${i})">
        <span class="record-chevron">▶</span>
        <div class="record-main">
          <div class="record-date">${escapeHtml(r.visitDate)}　No.${escapeHtml(r.invoiceNo)}</div>
          <div class="record-names">${escapeHtml(names)}</div>
        </div>
        <div class="record-total">¥${Number(r.total).toLocaleString()}</div>
      </div>
      <div class="record-detail">
        <div class="detail-items">${escapeHtml(r.items)}</div>
        <div class="detail-sums">
          <div class="row"><span>小計</span><span>¥${Number(r.subtotal).toLocaleString()}</span></div>
          <div class="row"><span>消費税</span><span>¥${Number(r.tax).toLocaleString()}</span></div>
          <div class="row total"><span>合計</span><span>¥${Number(r.total).toLocaleString()}</span></div>
        </div>
        <div class="detail-meta">担当：${escapeHtml(r.staff || "—")}　件数：${r.count}件</div>
      </div>
    </div>`;
  }).join("");

  resultsEl.innerHTML = statusHtml + cards;
}

// ===== カード開閉 =====
function toggleCard(i) {
  const card = document.getElementById("card-" + i);
  if (card) card.classList.toggle("open");
}

// ===== フォームクリア =====
function clearForm() {
  document.getElementById("qOwner").value = "";
  document.getElementById("qPet").value = "";
  document.getElementById("qFrom").value = "";
  document.getElementById("qTo").value = "";
  document.getElementById("results").innerHTML =
    `<div class="empty-note">検索条件を入力して「検索」を押してください</div>`;
}

// ===== HTMLエスケープ =====
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Enterキーで検索（テキスト欄）
["qOwner", "qPet"].forEach(id => {
  document.getElementById(id).addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); doSearch(); }
  });
});
