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

  const owner  = document.getElementById("qOwner").value.trim();
  const pet    = document.getElementById("qPet").value.trim();
  const animal = document.getElementById("qAnimal").value;
  const staff  = document.getElementById("qStaff").value;
  const from   = document.getElementById("qFrom").value;
  const to     = document.getElementById("qTo").value;

  const resultsEl = document.getElementById("results");

  if (!owner && !pet && !animal && !staff && !from && !to) {
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
    if (owner)  params.set("owner", owner);
    if (pet)    params.set("pet", pet);
    if (animal) params.set("animal", animal);
    if (staff)  params.set("staff", staff);
    if (from)   params.set("from", from);
    if (to)     params.set("to", to);

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
let lastRecords = []; // 再印刷用に検索結果を保持

function renderResults(data) {
  const resultsEl = document.getElementById("results");
  const records = data.records || [];
  lastRecords = records;

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
    const animalBadge = r.animalType ? `【${r.animalType}】` : "";
    const names = [r.owner, r.pet].filter(Boolean).join(" / ") || "（名前未入力）";
    return `
    <div class="record-card" id="card-${i}">
      <div class="record-head" onclick="toggleCard(${i})">
        <span class="record-chevron">▶</span>
        <div class="record-main">
          <div class="record-date">${escapeHtml(r.visitDate)}　No.${escapeHtml(r.invoiceNo)}</div>
          <div class="record-names">${escapeHtml(animalBadge + names)}</div>
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
        <button class="btn-reprint" onclick="event.stopPropagation();reprintRecord(${i})">🖨 明細書を再印刷</button>
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

// ===== 明細書の再印刷（再発行） =====
// 記録済みデータをそのまま明細書レイアウトに流し込んで1枚印刷する。
// 金額の再計算は一切しない（記録された小計・消費税・合計をそのまま使う）。

// 動物種→イニシャル（レジ側と同じマッピング）
function animalInitial(type) {
  const map = { "犬": "D", "猫": "C", "ウサギ": "R", "その他": "O" };
  return map[type] || "";
}

// 日付をYYYY年M月D日表示に（yyyy-MM-dd想定・失敗時はそのまま返す）
function formatDateJp(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(s || "");
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

function reprintRecord(i) {
  const r = lastRecords[i];
  if (!r) return;

  // ペット名＋動物種の表示（レジ側と同じルール）
  const animalIn = animalInitial(r.animalType);
  let petDisp = "";
  if (r.pet && animalIn) {
    petDisp = `（${escapeHtml(r.pet)} ちゃん（${animalIn}））`;
  } else if (r.pet) {
    petDisp = `（${escapeHtml(r.pet)} ちゃん）`;
  } else if (animalIn) {
    petDisp = `（${animalIn}）`;
  }

  // 明細テキスト（改行区切り）を行ごとに描画。
  // 各行は「品名 数量 × ¥単価 = ¥金額」形式なので、末尾の「 = ¥金額」だけ右寄せに分離する。
  const itemLines = String(r.items || "").split("\n").filter(Boolean).map(line => {
    const idx = line.lastIndexOf(" = ");
    if (idx === -1) {
      return `<div class="print-item-line"><span class="item-left">${escapeHtml(line)}</span></div>`;
    }
    const left = line.slice(0, idx);
    const right = line.slice(idx + 3); // " = " の後ろ（¥金額）
    return `<div class="print-item-line">
      <span class="item-left">${escapeHtml(left)}</span>
      <span class="item-right">${escapeHtml(right)}</span>
    </div>`;
  }).join("");

  // 再発行日（今日）
  const now = new Date();
  const todayDisp = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;

  const staffDisp = String(r.staff || "").replace(/,/g, ", ");

  document.getElementById("reprintArea").innerHTML = `
    <div class="print-page">
      <div class="print-watermark">再　発　行</div>
      <div class="print-title">明　細　書</div>
      <div class="print-meta">
        <span>発行日：${escapeHtml(formatDateJp(r.visitDate))}</span>
        <span>No. ${escapeHtml(r.invoiceNo)}</span>
      </div>
      <div class="print-meta">
        <span>担当：${escapeHtml(staffDisp)}</span>
        <span>再発行日：${todayDisp}</span>
      </div>
      <div class="print-customer">${escapeHtml(r.owner)} 様${petDisp}</div>
      <div class="print-divider"></div>
      ${itemLines}
      <div class="print-divider"></div>
      <div class="print-totals-row"><span>小計</span><span>¥${Number(r.subtotal).toLocaleString()}</span></div>
      <div class="print-totals-row"><span>消費税(10%)</span><span>¥${Number(r.tax).toLocaleString()}</span></div>
      <div class="print-totals-row grand"><span>合　計</span><span>¥${Number(r.total).toLocaleString()}</span></div>
      <div class="print-thanks">
        お大事にしてください。
      </div>
      <div class="print-hospital-block">
        <div class="print-divider-solid"></div>
        <div class="print-hospital-name">ガイア動物病院</div>
        <div class="print-hospital-info">〒069-1182 千歳市協和1914<br>Tel：0123-21-2552<br>登録番号：T9430002048507</div>
      </div>
    </div>
  `;
  window.print();
}

// ===== フォームクリア =====
function clearForm() {
  document.getElementById("qOwner").value = "";
  document.getElementById("qPet").value = "";
  document.getElementById("qAnimal").value = "";
  document.getElementById("qStaff").value = "";
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
