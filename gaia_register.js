/* ========================================
   ガイア動物病院 レジシステム
   メインロジック
   ── 第2弾（記録・会計系）反映済み
   ======================================== */

// ===== 設定 =====
// GAS のWebアプリURLは config.js（window.GAS_URL）で設定します。
// 本体を差し替えてもURLが消えないよう、設定はこのファイルから分離しています。
const GAS_URL = (typeof window !== "undefined" && window.GAS_URL) ? window.GAS_URL : "YOUR_GAS_URL_HERE";

// ===== 状態 =====
const state = {
  products: [],         // 商品マスタ
  staff: [],            // 担当者マスタ
  cart: [],             // 注文リスト
  selectedItemId: null, // 選択中の注文行ID
  activeCategory: "全て",
  searchQuery: "",
  currentDose: null,    // 用量モーダル選択中
  showFavoritesOnly: false, // お気に入りのみ表示
  lastInvoiceNo: null   // 直近の印刷でサーバ採番された伝票番号
};

const MAX_CART_ITEMS = 11; // 印刷の都合上、1会計の明細は11件まで
const MAX_STAFF = 4;       // 【第2弾】担当獣医は最大4人

let itemIdCounter = 1;

// ===== 初期化 =====
window.addEventListener("DOMContentLoaded", async () => {
  // 日付を今日に
  document.getElementById("visitDate").value = new Date().toISOString().slice(0, 10);

  // 検索バー
  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.searchQuery = e.target.value.trim();
    updateSearchClearBtn();
    renderProducts();
  });

  // 編集パネルの数量ショートカット
  document.getElementById("qtyShortcut").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    e.preventDefault();
    const add = btn.dataset.add;
    const qtyInput = document.getElementById("editQty");
    if (add === "clear") {
      qtyInput.value = "0";
      applyEdit();
      qtyInput.focus();
      qtyInput.select();
      return;
    }
    const cur = parseFloat(qtyInput.value) || 0;
    const next = Math.max(0, Math.round((cur + parseFloat(add)) * 100) / 100);
    qtyInput.value = next;
    applyEdit();
  });

  // 編集パネルの入力
  document.getElementById("editQty").addEventListener("input", applyEdit);
  document.getElementById("editPrice").addEventListener("input", applyEdit);

  // モーダル外クリックで閉じる
  document.querySelectorAll(".modal-overlay").forEach(o => {
    o.addEventListener("click", (e) => {
      if (e.target === o) o.classList.add("hidden");
    });
  });

  // データ読み込み
  await loadMasterData();
});

// ===== マスタデータ読み込み =====
async function loadMasterData() {
  showLoading("商品マスタを読み込み中…");

  // GAS URL未設定時：デモデータで動作
  if (GAS_URL === "YOUR_GAS_URL_HERE") {
    setConnStatus("error", "未接続（デモモード）");
    state.products = getDemoProducts();
    state.staff = getDemoStaff();
    setupUI();
    hideLoading();
    showToast("デモモード：GAS_URLを設定してください", "error");
    return;
  }

  try {
    const res = await fetch(GAS_URL + "?action=getMaster");
    const data = await res.json();
    if (data.result === "success") {
      state.products = data.products || [];
      state.staff = data.staff || [];
      setConnStatus("ok", "接続済み");
      setupUI();
    } else {
      throw new Error(data.message || "読み込み失敗");
    }
  } catch (e) {
    setConnStatus("error", "接続エラー");
    state.products = getDemoProducts();
    state.staff = getDemoStaff();
    setupUI();
    showToast("マスタ読み込みエラー：" + e.message, "error");
  } finally {
    hideLoading();
  }
}

// ===== UI初期化 =====
function setupUI() {
  // 【第2弾】担当者を複数追加UIとして初期化（1行目）
  initStaffArea();

  // カテゴリタブ（各タブにカテゴリ色を適用）
  const cats = ["全て", ...new Set(state.products.map(p => p.category).filter(Boolean))];
  const tabs = document.getElementById("categoryTabs");
  tabs.innerHTML = cats.map(c => {
    const col = (c === "全て") ? "#1a5c3a" : getCategoryColor(c, "");
    const active = c === state.activeCategory;
    return `<button class="cat-tab${active ? " active" : ""}" data-cat="${escapeHtml(c)}" data-color="${col}" style="--tab-color:${col}">${escapeHtml(c)}</button>`;
  }).join("");
  const applyTabStyle = (btn) => {
    const col = btn.dataset.color;
    if (btn.classList.contains("active")) {
      btn.style.background = col;
      btn.style.borderColor = col;
      btn.style.color = "#fff";
    } else {
      btn.style.background = "var(--surface)";
      btn.style.borderColor = col;
      btn.style.color = col;
    }
  };
  tabs.querySelectorAll(".cat-tab").forEach(t => {
    applyTabStyle(t);
    t.addEventListener("click", () => {
      state.activeCategory = t.dataset.cat;
      tabs.querySelectorAll(".cat-tab").forEach(x => {
        x.classList.toggle("active", x === t);
        applyTabStyle(x);
      });
      renderProducts();
    });
  });

  renderProducts();
}

// ===== 【第2弾】担当獣医 複数追加UI =====
// staffArea に select を動的に追加/削除。最大4人。1人目は×ボタンなし。
function initStaffArea() {
  const area = document.getElementById("staffArea");
  area.innerHTML = "";
  buildStaffRow(area, 0, false); // 1人目（削除不可）
  updateAddStaffBtn();
}

function buildStaffRow(container, idx, removable) {
  const row = document.createElement("div");
  row.className = "staff-row";
  row.dataset.idx = idx;

  const sel = document.createElement("select");
  sel.className = "staff-select";
  sel.innerHTML = state.staff.map(s =>
    `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`
  ).join("");
  row.appendChild(sel);

  if (removable) {
    const delBtn = document.createElement("button");
    delBtn.className = "btn-remove-staff";
    delBtn.textContent = "×";
    delBtn.title = "この担当を削除";
    delBtn.onclick = () => {
      row.remove();
      updateAddStaffBtn();
    };
    row.appendChild(delBtn);
  }

  container.appendChild(row);
}

function addStaffRow() {
  const area = document.getElementById("staffArea");
  const currentCount = area.querySelectorAll(".staff-row").length;
  if (currentCount >= MAX_STAFF) return;
  buildStaffRow(area, currentCount, true); // 2人目以降は削除可
  updateAddStaffBtn();
}

function updateAddStaffBtn() {
  const area = document.getElementById("staffArea");
  const btn = document.getElementById("addStaffBtn");
  if (!btn) return;
  const currentCount = area.querySelectorAll(".staff-row").length;
  btn.style.display = currentCount >= MAX_STAFF ? "none" : "";
}

// 全担当獣医の名前をカンマ区切りで返す（1人なら名前だけ）
function getSelectedStaff() {
  const area = document.getElementById("staffArea");
  const selects = area.querySelectorAll(".staff-select");
  const names = [];
  selects.forEach(sel => {
    const v = sel.value.trim();
    if (v) names.push(v);
  });
  return names.join(",");
}

// 担当人数を返す
function getStaffCount() {
  const area = document.getElementById("staffArea");
  return area.querySelectorAll(".staff-row").length;
}

// 担当者UIを1人にリセット（会計確定後）
function resetStaffArea() {
  initStaffArea();
}

// ===== 商品グリッドの表示 =====
function renderProducts() {
  const grid = document.getElementById("productGrid");

  const q = state.searchQuery ? normalizeSearch(state.searchQuery) : "";
  let filtered = state.products.filter(p => {
    if (state.showFavoritesOnly && !isFavorite(p)) return false;
    if (q) {
      // 検索中は常に全カテゴリ横断（タブ選択を無視）
      const target = normalizeSearch(
        (p.name || "") + " " + (p.keywords || "") + " " + (p.subcategory || "") + " " + (p.modalGroup || "")
      );
      return target.includes(q);
    }
    // 非検索時はタブで絞り込み
    if (state.activeCategory !== "全て" && p.category !== state.activeCategory) return false;
    return true;
  });

  // グループ化：モーダルグループ列が同じものを1タイルに束ねる（一本化）
  // モーダルグループが空欄の行はそれぞれ単独タイル
  const groups = new Map();
  filtered.forEach(p => {
    const mg = (p.modalGroup || "").trim();
    const key = mg ? ("MG:" + mg) : ("SOLO:" + p.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });

  if (groups.size === 0) {
    grid.innerHTML = `<div class="empty-products">該当する商品がありません</div>`;
    return;
  }

  grid.innerHTML = Array.from(groups.values())
    .sort((a, b) => {
      // 第一キー：group（診療を先、薬・物販を後）
      const ga = a[0].group === "診療" ? 0 : 1;
      const gb = b[0].group === "診療" ? 0 : 1;
      if (ga !== gb) return ga - gb;
      // 第二キー：表示順
      return (a[0].order || 9999) - (b[0].order || 9999);
    })
    .map(group => {
      const p = group[0];
      const color = getCategoryColor(p.category, p.color);
      const fav = group.some(isFavorite) ? `<span class="tile-fav">★</span>` : "";
      const isMG = (p.modalGroup || "").trim() !== "";

      // モーダルグループで束ねられている（複数行）：区分選択モーダル
      if (isMG && group.length > 1) {
        return `<div class="product-tile" style="--tile-color:${color}" onclick="openDoseModalByGroup('${escapeHtml(p.modalGroup)}')">
          ${fav}
          <span class="tile-multidose">▾</span>
          <div class="tile-name">${escapeHtml(p.modalGroup)}</div>
          <div class="tile-dose">${group.length}種類</div>
        </div>`;
      }

      // 単独行：計算式 > 担当者選択 > 薬・物販数量入力 > 通常 の優先で分岐
      const needFormula = hasFormula(p);
      const needStaffPick = !needFormula && isStaffPick(p);
      const needDrugQty = !needFormula && !needStaffPick && p.group === "薬・物販";
      const clickAction = needFormula ? `openFormulaModal(${p.id})`
                        : needStaffPick ? `openStaffPickModal(${p.id})`
                        : needDrugQty ? `openDrugQtyModal(${p.id})`
                        : `addToCartById(${p.id})`;
      const pickMark = needStaffPick ? `<span class="tile-staffpick">担</span>` : "";
      const formulaMark = needFormula ? `<span class="tile-formula">計</span>` : "";  // 【第3弾】
      const doseLine = p.dose ? `<div class="tile-dose">${escapeHtml(p.dose)}</div>` : "";

      return `<div class="product-tile" style="--tile-color:${color}" data-product-id="${p.id}" onclick="${clickAction}">
        ${fav}${pickMark}${formulaMark}
        <div class="tile-name">${escapeHtml(p.name)}</div>
        ${doseLine}
        <div class="tile-price">¥${p.price.toLocaleString()}${unitSuffix(p.unit)}</div>
      </div>`;
    }).join("");
}

// お気に入り判定（L列に何か入っていればお気に入り）
function isFavorite(p) {
  const v = (p.favorite || "").toString().trim();
  return v !== "" && v !== "0" && v.toLowerCase() !== "false";
}
// 担当者選択フラグ判定（〇 のときのみ。？ は保留なので対象外）
function isStaffPick(p) {
  return (p.staffPick || "").toString().trim() === "〇";
}
// 整数固定かどうか
function isIntegerOnly(p) {
  return (p.qtyType || "").toString().trim() === "整数固定";
}
// 【第3弾】計算式判定（メモ列に formula: で始まる文字列があれば対象）
function hasFormula(p) {
  return (p.memo || "").includes("formula:");
}
// メモ列から計算パラメータを抽出
// 例: "formula:weight*400+1000" → { varName:"weight", coeff:400, base:1000 }
// 例: "formula:ml*100+5000"     → { varName:"ml", coeff:100, base:5000 }
function parseFormula(p) {
  const memo = (p.memo || "");
  const m = memo.match(/formula:(\w+)\*(\d+)\+(\d+)/);
  if (!m) return null;
  return { varName: m[1], coeff: Number(m[2]), base: Number(m[3]) };
}
// 計算式の入力ラベルを返す
function formulaInputLabel(varName) {
  if (varName === "weight") return "体重（kg）";
  if (varName === "ml") return "使用量（ml）";
  return varName;
}
// お気に入りのみ表示の切り替え
function toggleFavorites() {
  state.showFavoritesOnly = !state.showFavoritesOnly;
  const btn = document.getElementById("favToggleBtn");
  if (btn) btn.classList.toggle("active", state.showFavoritesOnly);
  renderProducts();
}

// ===== 検索クリア（×ボタン） =====
function clearSearch() {
  const input = document.getElementById("searchInput");
  input.value = "";
  state.searchQuery = "";
  updateSearchClearBtn();
  renderProducts();
  input.focus();
}

// 入力があるときだけ×ボタンを表示
function updateSearchClearBtn() {
  const box = document.getElementById("searchBox");
  if (!box) return;
  box.classList.toggle("has-text", !!state.searchQuery);
}

// ===== 検索文字列の正規化（大小文字・半角/全角カナを吸収） =====
function normalizeSearch(s) {
  if (!s) return "";
  let t = String(s).toLowerCase();
  // NFKC で半角カナ→全角カナ・全角英数→半角英数に正規化
  try { t = t.normalize("NFKC"); } catch (e) {}
  // カタカナ→ひらがな（読み仮名のゆれを吸収）
  t = t.replace(/[\u30A1-\u30F6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  // 空白除去
  return t.replace(/\s+/g, "");
}

// ===== 単位サフィックス（錠は省略、それ以外は「 /本」のように表示） =====
function unitSuffix(unit) {
  if (!unit || unit === "錠") return "";
  return ` <span style="font-size:10px;color:var(--muted);font-weight:400;">/${escapeHtml(unit)}</span>`;
}

// ===== 数量＋単位の文字列（診療行為は単位を出さない、薬・物販は単位を出す） =====
// 例）診療：「1」 / 薬・物販：「1錠」「2本」「20包」
function qtyUnitText(item) {
  const isCare = item.group === "診療";
  if (isCare && !item.isPowder) return `${item.qty}`;
  return `${item.qty}${item.unit || ""}`;
}

// ===== カテゴリ色の自動配色 =====
function getCategoryColor(category, override) {
  if (override) return override;
  const colors = {
    // 診療系（商品マスタ）
    "診察": "#7F77DD",
    "注射": "#D4537E",
    "検査": "#378ADD",
    "処置": "#1D9E75",
    "手術": "#993C1D",
    "民宿・トリミング": "#3FA796",
    "その他": "#888780",
    "スタッフ割引": "#B0A030",
    // 薬・物販系（薬品・物品マスタ）
    "処方薬（錠剤・カプセル）": "#2E9E75",
    "処方薬（液剤・シロップ）": "#378ADD",
    "処方薬（外用・軟膏）": "#EF9F27",
    "処方薬（点眼薬）": "#7F77DD",
    "処方薬（注射）": "#D4537E",
    "ワクチン・駆虫薬": "#1D9E75",
    "フード・サプリ": "#C08A2E",
    "消耗品・医療材料": "#888780",
    "計算式必要": "#C8553D"
  };
  return colors[category] || "#1a5c3a";
}

// ===== 商品をカートに追加（IDから） =====
function addToCartById(productId) {
  const p = state.products.find(x => x.id == productId);
  if (!p) return;
  addToCart(p, 1);
}

// 11件上限チェック
function canAddItem() {
  if (state.cart.length >= MAX_CART_ITEMS) {
    showToast(`印刷の都合上、1会計の明細は${MAX_CART_ITEMS}件までです`, "error");
    return false;
  }
  return true;
}

// 表示用の品名（用量＋看護師＊印を反映）
function cartDispName(item) {
  let n = item.dose ? `${item.name} ${item.dose}` : item.name;
  if (item.isNurseMark) n += "＊";
  return n;
}

// 既存の同じ商品IDがあれば数量加算、なければ新規追加
// staffRole: null（担当者選択なし）/ "vet"（獣医）/ "nurse"（看護師＝技術料0＋＊印）
function addToCart(product, qty, staffRole) {
  staffRole = staffRole || null;
  // 整数固定なら数量を整数に丸める
  if (isIntegerOnly(product)) {
    qty = Math.max(1, Math.round(qty));
  }
  // 担当者種別が異なる場合は別行扱い（同じ商品でも獣医分/看護師分を分ける）
  const existing = state.cart.find(c =>
    !c.isPowder && c.productId === product.id && c.staffRole === staffRole
  );
  if (existing) {
    existing.qty = Math.round((existing.qty + qty) * 100) / 100;
  } else {
    if (!canAddItem()) return;
    state.cart.push({
      itemId: itemIdCounter++,
      productId: product.id,
      isPowder: false,
      group: product.group || "診療",
      name: product.name,
      dose: product.dose || "",
      category: product.category,
      subcategory: product.subcategory || "",  // ワクチン判定用
      qty: qty,
      price: product.price,
      unit: product.unit || "錠",
      qtyType: product.qtyType || "",
      staffRole: staffRole,
      isNurseMark: staffRole === "nurse",
      // 【第2弾】技術料計算に必要なマスタ元値を保持
      masterPrice: product.price,  // 編集で変わらない元単価
      gigi: product.gigi || 0      // マスタの技術料
    });
  }
  renderCart();
}

// ===== 【第2弾】技術料の計算 =====
// 行ごとの技術料（設計確定式）
function calcItemGigi(item) {
  if (item.isNurseMark) return 0;                          // 看護師＊印は技術料0
  if (!item.gigi || item.gigi === 0) return 0;             // 技術料なし
  if (!item.masterPrice || item.masterPrice === 0) return 0; // ゼロ除算回避（体重連動式等）
  return Math.floor(item.gigi * item.qty * (item.price / item.masterPrice));
}

// 会計全体の技術料合計
function calcTotalGigi() {
  let total = 0;
  state.cart.forEach(item => { total += calcItemGigi(item); });
  return total;
}

// 技術料スナップショットテキスト（行ごとの算出根拠を改行区切りで集約）
function buildGigiSnapshot() {
  return state.cart.map(item => {
    const g = calcItemGigi(item);
    return `${cartDispName(item)} | qty:${item.qty} | 単価:${item.price} | 元単価:${item.masterPrice || 0} | 元技:${item.gigi || 0} | 技:${g}`;
  }).join("\n");
}

// ワクチン判定（サブカテゴリが「ワクチン」or「狂犬病ワクチン」かつ技術料>0）
function isVaccineItem(item) {
  const sub = (item.subcategory || "").trim();
  return (sub === "ワクチン" || sub === "狂犬病ワクチン") && (item.gigi || 0) > 0;
}

// ワクチン技術料の合計
function calcVaccineGigi() {
  let total = 0;
  state.cart.forEach(item => {
    if (isVaccineItem(item)) total += calcItemGigi(item);
  });
  return total;
}

// 通常技術料の合計（ワクチン分を除外）
function calcNonVaccineGigi() {
  return calcTotalGigi() - calcVaccineGigi();
}

// ワクチン種類別の件数を集計
// 戻り値：[{ name: "犬5種ワクチン", count: 4 }, ...]（ワクチン品目があるものだけ）
// 品名はマスタの品名（item.name）を使う。用量（dose）は含めない。
function buildVaccineCounts() {
  const counts = {};
  state.cart.forEach(item => {
    if (!isVaccineItem(item)) return;
    const name = item.name;  // マスタ品名（「犬5種ワクチン」など）
    const qty = item.qty || 0;
    if (qty <= 0) return;
    counts[name] = (counts[name] || 0) + qty;
  });
  return Object.keys(counts).map(name => ({ name: name, count: counts[name] }));
}

// ===== 用量モーダル（モーダルグループ基準） =====
let doseGroup = [];
let pendingStaffPickProduct = null; // 担当者選択待ちの商品（2段階目用）
let pendingQty = 1;

function openDoseModalByGroup(modalGroup) {
  doseGroup = state.products.filter(p => (p.modalGroup || "").trim() === modalGroup.trim());
  if (doseGroup.length === 0) return;

  document.getElementById("doseProductName").textContent = modalGroup;
  state.currentDose = doseGroup[0];

  const opts = doseGroup.map(p => `
    <div class="dose-opt${p === state.currentDose ? " selected" : ""}" data-id="${p.id}" onclick="selectDose(${p.id})">
      <div class="dose-value">${escapeHtml(p.dose || p.name || "—")}</div>
      <div class="dose-price">¥${p.price.toLocaleString()}${p.unit && p.unit !== "錠" ? " /" + escapeHtml(p.unit) : ""}</div>
    </div>
  `).join("");
  document.getElementById("doseOptions").innerHTML = opts;
  document.getElementById("doseQty").value = 1;
  updateDoseQtyLabel();
  updateDoseTotal();
  document.getElementById("doseModal").classList.remove("hidden");
}

// 旧API互換（カテゴリ＋品名）。モーダルグループ経由に委譲
function openDoseModal(category, name) {
  const grp = state.products.filter(p => p.category === category && p.name === name);
  if (grp.length && grp[0].modalGroup) openDoseModalByGroup(grp[0].modalGroup);
}

function selectDose(id) {
  state.currentDose = doseGroup.find(p => p.id == id);
  document.querySelectorAll("#doseOptions .dose-opt").forEach(el => {
    el.classList.toggle("selected", el.dataset.id == id);
  });
  updateDoseQtyLabel();
  updateDoseTotal();
}
function updateDoseQtyLabel() {
  const u = state.currentDose.unit || "錠";
  const intOnly = isIntegerOnly(state.currentDose);
  document.getElementById("doseQtyLabel").textContent = `${u}数${intOnly ? "（整数のみ）" : "（小数OK：例 6.5）"}`;
  const qtyEl = document.getElementById("doseQty");
  qtyEl.step = intOnly ? "1" : "0.25";
}
function updateDoseTotal() {
  if (!state.currentDose) return;
  let qty = parseFloat(document.getElementById("doseQty").value) || 0;
  if (isIntegerOnly(state.currentDose)) qty = Math.round(qty);
  const total = Math.round(state.currentDose.price * qty);
  document.getElementById("doseTotalAmount").textContent = "¥" + total.toLocaleString();
}
function confirmDose() {
  let qty = parseFloat(document.getElementById("doseQty").value) || 0;
  if (isIntegerOnly(state.currentDose)) qty = Math.round(qty);
  if (qty <= 0) {
    const u = (state.currentDose && state.currentDose.unit) || "錠";
    showToast(`${u}数を入力してください`, "error");
    return;
  }
  const prod = state.currentDose;
  // 1段階目で選んだ商品に担当者選択フラグがあれば、2段階目へ
  if (isStaffPick(prod)) {
    closeDoseModal();
    openStaffPickModalForProduct(prod, qty);
    return;
  }
  addToCart(prod, qty);
  closeDoseModal();
}
function closeDoseModal() {
  document.getElementById("doseModal").classList.add("hidden");
}

// ===== 担当者選択モーダル（獣医/看護師） =====
// 単独タイル（担当者選択フラグあり）から直接
function openStaffPickModal(productId) {
  const p = state.products.find(x => x.id == productId);
  if (!p) return;
  openStaffPickModalForProduct(p, 1);
}
// 商品＋数量を確定したうえで担当者種別を選ばせる
function openStaffPickModalForProduct(product, qty) {
  if (!canAddItem()) return;
  pendingStaffPickProduct = product;
  pendingQty = qty;
  document.getElementById("staffPickProductName").textContent =
    product.dose ? `${product.name}（${product.dose}）` : product.name;
  document.getElementById("staffPickModal").classList.remove("hidden");
}
function selectStaffRole(role) {
  if (!pendingStaffPickProduct) return;
  addToCart(pendingStaffPickProduct, pendingQty, role);
  closeStaffPickModal();
}
function closeStaffPickModal() {
  document.getElementById("staffPickModal").classList.add("hidden");
  pendingStaffPickProduct = null;
  pendingQty = 1;
}

// ===== 【第3弾】計算補助モーダル =====
// メモ列に formula: がある商品をタップすると開く
let formulaProduct = null;  // 計算補助対象の商品
let formulaParams = null;   // { varName, coeff, base }

function openFormulaModal(productId) {
  const p = state.products.find(x => x.id == productId);
  if (!p) return;
  const params = parseFormula(p);
  if (!params) {
    // パース失敗→通常のカート追加にフォールバック
    addToCartById(productId);
    return;
  }
  formulaProduct = p;
  formulaParams = params;

  // モーダルの表示を設定
  document.getElementById("formulaProductName").textContent =
    p.dose ? `${p.name}（${p.dose}）` : p.name;
  document.getElementById("formulaInputLabel").textContent = formulaInputLabel(params.varName);
  document.getElementById("formulaInput").value = "";
  document.getElementById("formulaInput").placeholder = params.varName === "weight" ? "例：8" : "例：3.5";
  document.getElementById("formulaQty").value = "";
  document.getElementById("formulaCalcPrice").textContent = "¥0";
  document.getElementById("formulaBreakdown").textContent = "";
  document.getElementById("formulaModal").classList.remove("hidden");
  setTimeout(() => document.getElementById("formulaInput").focus(), 100);
}

// 入力値が変わったら推奨量と料金を自動計算
function updateFormulaCalc() {
  if (!formulaParams) return;
  const inputVal = parseFloat(document.getElementById("formulaInput").value) || 0;
  const { varName, coeff, base } = formulaParams;

  // 推奨量 = 入力値そのまま（体重kgならkg分、mlならml分）
  const recommendedQty = inputVal;
  document.getElementById("formulaQty").value = recommendedQty || "";

  recalcFormulaPrice();
}

// 量の手動調整でも料金を再計算
function updateFormulaPrice() {
  recalcFormulaPrice();
}

function recalcFormulaPrice() {
  if (!formulaParams) return;
  const qty = parseFloat(document.getElementById("formulaQty").value) || 0;
  const { coeff, base } = formulaParams;
  const price = Math.round(qty * coeff + base);

  document.getElementById("formulaCalcPrice").textContent = "¥" + price.toLocaleString();
  // 内訳表示
  if (qty > 0) {
    document.getElementById("formulaBreakdown").textContent =
      `${qty} × ¥${coeff.toLocaleString()} + ¥${base.toLocaleString()} = ¥${price.toLocaleString()}`;
  } else {
    document.getElementById("formulaBreakdown").textContent = "";
  }
}

function confirmFormula() {
  if (!formulaProduct || !formulaParams) return;
  const qty = parseFloat(document.getElementById("formulaQty").value) || 0;
  if (qty <= 0) {
    showToast("数量を入力してください", "error");
    return;
  }
  const { coeff, base } = formulaParams;
  const calcPrice = Math.round(qty * coeff + base);

  if (!canAddItem()) return;

  // カートに数量1×算出料金で追加（priceを算出値に差し替え）
  state.cart.push({
    itemId: itemIdCounter++,
    productId: formulaProduct.id,
    isPowder: false,
    group: formulaProduct.group || "診療",
    name: formulaProduct.name,
    dose: formulaProduct.dose || "",
    category: formulaProduct.category,
    subcategory: formulaProduct.subcategory || "",
    qty: 1,
    price: calcPrice,
    unit: formulaProduct.unit || "錠",
    qtyType: formulaProduct.qtyType || "",
    staffRole: null,
    isNurseMark: false,
    masterPrice: formulaProduct.price,
    gigi: formulaProduct.gigi || 0
  });

  closeFormulaModal();
  renderCart();
}

function closeFormulaModal() {
  document.getElementById("formulaModal").classList.add("hidden");
  formulaProduct = null;
  formulaParams = null;
}

// ===== 薬・物販 数量入力モーダル =====
let drugQtyProduct = null;

function openDrugQtyModal(productId) {
  const p = state.products.find(x => x.id == productId);
  if (!p) return;
  drugQtyProduct = p;

  const intOnly = isIntegerOnly(p);
  document.getElementById("drugQtyProductName").textContent = p.name;
  document.getElementById("drugQtyUnitPrice").textContent =
    "¥" + p.price.toLocaleString() + (p.unit && p.unit !== "錠" ? " / " + p.unit : "");
  document.getElementById("drugQtyLabel").textContent =
    "数量" + (intOnly ? "（整数のみ）" : "（小数OK：例 6.5）");
  const input = document.getElementById("drugQtyInput");
  input.value = "";
  input.step = intOnly ? "1" : "0.25";
  input.placeholder = intOnly ? "例：3" : "例：6.5";
  document.getElementById("drugQtyUnit").textContent = p.unit || "錠";
  document.getElementById("drugQtyModal").classList.remove("hidden");
  setTimeout(() => input.focus(), 100);
}

function confirmDrugQty() {
  if (!drugQtyProduct) return;
  let qty = parseFloat(document.getElementById("drugQtyInput").value) || 0;
  if (isIntegerOnly(drugQtyProduct)) qty = Math.round(qty);
  if (qty <= 0) {
    showToast("数量を入力してください", "error");
    return;
  }
  addToCart(drugQtyProduct, qty);
  closeDrugQtyModal();
}

function closeDrugQtyModal() {
  document.getElementById("drugQtyModal").classList.add("hidden");
  drugQtyProduct = null;
}

// ===== 粉薬モーダル =====
function openPowderModal() {
  document.getElementById("powderPacks").value = "";
  document.getElementById("powderUnitPrice").value = "";
  document.getElementById("powderTotalDisp").textContent = "¥0";
  document.getElementById("powderModal").classList.remove("hidden");
  setTimeout(() => document.getElementById("powderPacks").focus(), 100);
}
function closePowderModal() {
  document.getElementById("powderModal").classList.add("hidden");
}
function updatePowderTotal() {
  const packs = parseInt(document.getElementById("powderPacks").value) || 0;
  const unitPrice = parseFloat(document.getElementById("powderUnitPrice").value) || 0;
  const total = Math.round(packs * unitPrice);
  document.getElementById("powderTotalDisp").textContent = "¥" + total.toLocaleString();
}
function confirmPowder() {
  const packs = parseInt(document.getElementById("powderPacks").value);
  const unitPrice = parseFloat(document.getElementById("powderUnitPrice").value);
  if (!packs || packs <= 0) {
    showToast("分包数を入力してください", "error");
    return;
  }
  if (!unitPrice || unitPrice <= 0) {
    showToast("1包あたり単価を入力してください", "error");
    return;
  }
  if (!canAddItem()) return;
  state.cart.push({
    itemId: itemIdCounter++,
    productId: null,
    isPowder: true,
    name: "処方薬（粉薬）",
    dose: "",
    category: "処方薬",
    qty: packs,
    price: unitPrice,   // 1包あたり単価
    unit: "包",
    qtyType: "整数固定",
    staffRole: null,
    isNurseMark: false,
    // 【第2弾】粉薬は技術料なし
    masterPrice: 0,
    gigi: 0
  });
  closePowderModal();
  renderCart();
}

// ===== 自由入力モーダル（マスタにない項目を追加） =====
function openFreeModal() {
  document.getElementById("freeName").value = "";
  document.getElementById("freePrice").value = "";
  document.getElementById("freeQty").value = "1";
  document.getElementById("freeTotalDisp").textContent = "¥0";
  document.getElementById("freeModal").classList.remove("hidden");
  setTimeout(() => document.getElementById("freeName").focus(), 100);
}
function closeFreeModal() {
  document.getElementById("freeModal").classList.add("hidden");
}
function updateFreeTotal() {
  const price = parseFloat(document.getElementById("freePrice").value) || 0;
  const qty = parseFloat(document.getElementById("freeQty").value) || 0;
  const total = Math.round(price * qty);
  document.getElementById("freeTotalDisp").textContent = "¥" + total.toLocaleString();
}
function confirmFree() {
  const name = document.getElementById("freeName").value.trim();
  const price = parseFloat(document.getElementById("freePrice").value);
  const qty = parseFloat(document.getElementById("freeQty").value) || 1;
  if (!name) {
    showToast("品名を入力してください", "error");
    return;
  }
  if (!price || price <= 0) {
    showToast("単価を入力してください", "error");
    return;
  }
  if (!canAddItem()) return;
  state.cart.push({
    itemId: itemIdCounter++,
    productId: null,
    isPowder: false,
    isFree: true,
    group: "診療",
    name: name,
    dose: "",
    category: "その他",
    subcategory: "",
    qty: qty,
    price: price,
    unit: "",
    qtyType: "",
    staffRole: null,
    isNurseMark: false,
    masterPrice: 0,
    gigi: 0
  });
  closeFreeModal();
  renderCart();
}

// ===== カートの表示 =====
function renderCart() {
  const list = document.getElementById("cartList");
  if (state.cart.length === 0) {
    list.innerHTML = `<div class="cart-empty">商品タイルをタップして<br>診療内容を追加してください</div>`;
    // ※ここで closeEdit() を呼ぶと closeEdit→renderCart→closeEdit... の無限再帰になる。
    //   そのため編集パネルは直接閉じる（renderCart は呼ばない）。
    state.selectedItemId = null;
    document.getElementById("editPanel").classList.add("hidden");
  } else {
    list.innerHTML = state.cart.map(item => {
      const amount = Math.round(item.qty * item.price);
      const dispName = cartDispName(item);
      const cls = (item.isPowder ? "powder" : "") + (item.itemId === state.selectedItemId ? " selected" : "");
      const detailLine = `${qtyUnitText(item)} × ¥${item.price.toLocaleString()}`;
      return `
        <div class="cart-item ${cls}" onclick="selectCartItem(${item.itemId})">
          <button class="cart-item-del" onclick="event.stopPropagation();removeCartItem(${item.itemId})" title="削除">×</button>
          <div class="cart-item-name">${escapeHtml(dispName)}</div>
          <div class="cart-item-detail">
            <span>${detailLine}</span>
            <span class="cart-item-amount">¥${amount.toLocaleString()}</span>
          </div>
        </div>
      `;
    }).join("");
  }
  document.getElementById("cartCount").textContent = state.cart.length + ` 件 / ${MAX_CART_ITEMS}`;
  recalc();
}

function selectCartItem(itemId) {
  if (state.selectedItemId === itemId) {
    closeEdit();
    return;
  }
  state.selectedItemId = itemId;
  const item = state.cart.find(c => c.itemId === itemId);
  if (!item) return;
  const dispName = cartDispName(item);
  document.getElementById("editPanelTitle").textContent = "編集中：" + dispName;
  document.getElementById("editQty").value = item.qty;
  document.getElementById("editQtyUnit").textContent = (item.group === "診療" && !item.isPowder) ? "" : item.unit;
  document.getElementById("editPrice").value = item.price;
  // 単価ラベル：粉薬の場合は「1包単価」、それ以外は「単価」
  const priceLabel = document.querySelectorAll("#editPanel .edit-row label")[1];
  if (priceLabel) priceLabel.textContent = item.isPowder ? "1包単価" : "単価";
  document.getElementById("editPanel").classList.remove("hidden");
  renderCart();
}

function closeEdit() {
  state.selectedItemId = null;
  document.getElementById("editPanel").classList.add("hidden");
  renderCart();
}

function applyEdit() {
  if (!state.selectedItemId) return;
  const item = state.cart.find(c => c.itemId === state.selectedItemId);
  if (!item) return;
  let qty = parseFloat(document.getElementById("editQty").value) || 0;
  const priceInput = parseFloat(document.getElementById("editPrice").value) || 0;
  if ((item.qtyType || "") === "整数固定") {
    qty = Math.max(0, Math.round(qty));
    document.getElementById("editQty").value = qty;
  }
  item.qty = qty;
  item.price = priceInput;
  renderCart();
}

function deleteSelected() {
  if (!state.selectedItemId) return;
  removeCartItem(state.selectedItemId);
}

// 行の×ボタンから即削除（確認ダイアログなし）
function removeCartItem(itemId) {
  state.cart = state.cart.filter(c => c.itemId !== itemId);
  if (state.selectedItemId === itemId) {
    state.selectedItemId = null;
    document.getElementById("editPanel").classList.add("hidden");
  }
  renderCart();
}

// ===== 合計計算 =====
function recalc() {
  let subtotal = 0;
  state.cart.forEach(item => {
    subtotal += Math.round(item.qty * item.price);
  });
  const tax = Math.ceil(subtotal * 0.1);
  const total = subtotal + tax;
  document.getElementById("subtotalDisp").textContent = "¥" + subtotal.toLocaleString();
  document.getElementById("taxDisp").textContent = "¥" + tax.toLocaleString();
  document.getElementById("totalDisp").textContent = "¥" + total.toLocaleString();
  document.getElementById("checkoutBtn").disabled = state.cart.length === 0;
  const clearBtn = document.getElementById("clearAllBtn");
  if (clearBtn) clearBtn.disabled = state.cart.length === 0;
  return { subtotal, tax, total };
}

// ===== 仕切書プレビュー =====
function openReceipt() {
  if (state.cart.length === 0) return;

  // 【第2弾】担当獣医の未選択チェック
  const staffStr = getSelectedStaff();
  if (!staffStr) {
    showToast("担当獣医を選択してください", "error");
    return;
  }

  const ownerName = document.getElementById("ownerName").value.trim();
  const petName = document.getElementById("petName").value.trim();
  if (!ownerName) {
    showToast("飼い主名を入力してください", "error");
    document.getElementById("ownerName").focus();
    return;
  }
  // プレビュー段階では伝票番号は未確定（印刷時にサーバが採番する）
  document.getElementById("receiptPreview").innerHTML = renderReceiptHtml(false, null);
  document.getElementById("receiptModal").classList.remove("hidden");
}
function closeReceipt() {
  document.getElementById("receiptModal").classList.add("hidden");
}

// invoiceNo: サーバ採番された確定番号。null のときは「印刷時に採番」と表示（プレビュー用）
function renderReceiptHtml(forPrint, invoiceNo) {
  const { subtotal, tax, total } = recalc();
  const owner = document.getElementById("ownerName").value.trim();
  const pet = document.getElementById("petName").value.trim();
  // 【第2弾】担当表示を getSelectedStaff() に差し替え（カンマ区切り→スペース区切りで表示）
  const staff = getSelectedStaff().replace(/,/g, ", ");
  const date = document.getElementById("visitDate").value;
  const dateDisp = formatDate(date);
  const invoiceDisp = invoiceNo ? invoiceNo : "（印刷時に採番）";

  const items = state.cart.map(item => {
    const amount = Math.round(item.qty * item.price);
    const dispName = cartDispName(item);
    // 粉薬も通常薬と同じく「数量＋単位 × 単価」を表示する
    return `<div class="${forPrint ? 'print-item-line' : 'receipt-item-line'}">
      <div class="${forPrint ? 'print-item-name' : 'receipt-item-name'}">
        <span>${escapeHtml(dispName)}</span>
        <span>¥${amount.toLocaleString()}</span>
      </div>
      <div class="${forPrint ? 'print-item-detail' : 'receipt-item-detail'}">
        ${qtyUnitText(item)} × ¥${item.price.toLocaleString()}
      </div>
    </div>`;
  }).join("");

  if (forPrint) {
    return `
      <div class="print-title">明　細　書</div>
      <div class="print-meta">
        <span>発行日：${dateDisp}</span>
        <span>No. ${invoiceDisp}</span>
      </div>
      <div class="print-meta">
        <span>担当：${escapeHtml(staff)}</span>
        <span>　</span>
      </div>
      <div class="print-customer">${escapeHtml(owner)} 様${pet ? `（${escapeHtml(pet)} ちゃん）` : ""}</div>
      <div class="print-divider"></div>
      ${items}
      <div class="print-divider"></div>
      <div class="print-totals-row"><span>小計</span><span>¥${subtotal.toLocaleString()}</span></div>
      <div class="print-totals-row"><span>消費税(10%)</span><span>¥${tax.toLocaleString()}</span></div>
      <div class="print-totals-row grand"><span>合　計</span><span>¥${total.toLocaleString()}</span></div>
      <div class="print-thanks">
        この度はご来院いただきありがとうございました。<br>
        またのご来院を心よりお待ちしております。
      </div>
      <div class="print-hospital-block">
        <div class="print-divider-solid"></div>
        <div class="print-hospital-name">ガイア動物病院</div>
        <div class="print-hospital-info">〒069-1182 千歳市協和1914<br>Tel：0123-21-2552</div>
      </div>
    `;
  } else {
    return `
      <div class="receipt-title">明　細　書</div>
      <div class="receipt-meta">
        <div class="receipt-meta-row"><span>発行日：${dateDisp}</span><span>No. ${invoiceDisp}</span></div>
        <div class="receipt-meta-row"><span>担当：${escapeHtml(staff)}</span><span></span></div>
      </div>
      <div class="receipt-customer">${escapeHtml(owner)} 様${pet ? `（${escapeHtml(pet)} ちゃん）` : ""}</div>
      <div class="receipt-divider"></div>
      <div class="receipt-items">${items}</div>
      <div class="receipt-divider"></div>
      <div class="receipt-totals">
        <div class="receipt-totals-row"><span>小計</span><span>¥${subtotal.toLocaleString()}</span></div>
        <div class="receipt-totals-row"><span>消費税(10%)</span><span>¥${tax.toLocaleString()}</span></div>
        <div class="receipt-totals-row grand"><span>合　計</span><span>¥${total.toLocaleString()}</span></div>
      </div>
      <div class="receipt-footer">
        この度はご来院いただきありがとうございました。<br>
        またのご来院を心よりお待ちしております。
      </div>
      <div class="receipt-hospital-bottom">
        <div class="receipt-divider-solid"></div>
        <div class="receipt-hospital-name">ガイア動物病院</div>
        <div class="receipt-hospital-info">〒069-1182 千歳市協和1914 / Tel：0123-21-2552</div>
      </div>
    `;
  }
}

// ===== 印刷＋記録 =====
// 【サーバ採番版の流れ】
//   1. まずGASに記録 → サーバが伝票番号を採番して返す
//   2. 記録成功 → 返ってきた番号で明細書（2枚）を組み立て → 印刷 → 会計確定（カートクリア）
//   3. 記録失敗 → 印刷しない（番号なし伝票・記録漏れを防ぐ）。内容は保持してやり直せる
//
// ※二度押し防止のためにボタンを disabled にする処理は入れない。
//   disabled が解除されずボタンが固まる事故のほうが現場で困るため。
//   二重記録の本対策は A-2（client_id をGAS側で重複検出）に委ねる。
async function doPrint() {
  // ---- 1. 先にGASへ記録（採番してもらう） ----
  let result;
  try {
    result = await sendToGAS();
  } catch (e) {
    showToast("記録処理でエラー：" + e.message, "error");
    return;
  }

  if (!result.ok) {
    // 記録できなかった → 印刷しない。内容は残す
    showToast("記録できませんでした。印刷を中止しました（内容は保持）", "error");
    return;
  }

  // ---- 2. 採番された番号で明細書（A5×2枚）を組み立て ----
  const invoiceNo = result.invoiceNo;
  state.lastInvoiceNo = invoiceNo;
  const html1 = renderReceiptHtml(true, invoiceNo);
  const html2 = renderReceiptHtml(true, invoiceNo);
  document.getElementById("printArea").innerHTML = `
    <div class="print-page">${html1}</div>
    <div class="print-page">
      <div class="print-watermark">控　え</div>
      ${html2}
    </div>
  `;

  showToast("スプシに記録しました（No. " + invoiceNo + "）");

  // ---- 3. 印刷 ----
  // 印刷内容は既に printArea に書き込み済みなので、
  // この後にカートをクリアしても印刷物には影響しない。
  window.print();

  // ---- 4. 会計確定（カートクリア） ----
  // 印刷ダイアログを閉じた後に実行されるよう、わずかに遅延させる。
  setTimeout(() => {
    clearCart();
    closeReceipt();
  }, 300);
}

// ===== GASに送信 =====
// 戻り値： { ok: true, invoiceNo: "000123" } / { ok: false }
// 伝票番号はサーバが採番するので、送信データには含めない。
async function sendToGAS() {
  if (GAS_URL === "YOUR_GAS_URL_HERE") {
    showToast("デモモード：記録は保存されません", "error");
    return { ok: false };
  }

  const { subtotal, tax, total } = recalc();
  const data = {
    action: "record",
    visitDate: document.getElementById("visitDate").value,
    // 【第2弾】担当者をgetSelectedStaff()に差し替え（カンマ区切り）
    staff: getSelectedStaff(),
    ownerName: document.getElementById("ownerName").value.trim(),
    petName: document.getElementById("petName").value.trim(),
    items: state.cart.map(item => ({
      name: cartDispName(item),
      qty: item.qty,
      unit: (item.group === "診療" && !item.isPowder) ? "" : item.unit,
      price: item.price,
      amount: Math.round(item.qty * item.price),
      isPowder: item.isPowder
    })),
    subtotal: subtotal,
    tax: tax,
    total: total,
    // 【第2弾】技術料データを追加
    staffCount: getStaffCount(),
    gigiTotal: calcTotalGigi(),
    gigiNonVaccine: calcNonVaccineGigi(),
    gigiVaccine: calcVaccineGigi(),
    gigiSnapshot: buildGigiSnapshot(),
    // ワクチン種類別件数（案3b）
    vaccineCounts: buildVaccineCounts()
  };

  try {
    const res = await fetch(GAS_URL, {
      method: "POST",
      body: JSON.stringify(data)
    });
    const json = await res.json();
    if (json.result === "success") {
      return { ok: true, invoiceNo: json.invoiceNo || "" };
    }
    throw new Error(json.message || "保存失敗");
  } catch (e) {
    showToast("記録エラー：" + e.message, "error");
    return { ok: false };
  }
}

// ===== カートクリア =====
// 全消去ボタン（破壊的なので確認あり）
function clearAll() {
  if (state.cart.length === 0) return;
  if (!confirm("入力中の診療内容をすべて消去しますか？")) return;
  clearCart();
}

function clearCart() {
  state.cart = [];
  state.selectedItemId = null;
  document.getElementById("ownerName").value = "";
  document.getElementById("petName").value = "";
  document.getElementById("editPanel").classList.add("hidden");
  // 【第2弾】担当者プルダウンを1人にリセット
  resetStaffArea();
  renderCart();
}

// ===== 共通ユーティリティ =====
function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${y}年${parseInt(m)}月${parseInt(d)}日`;
}

function setConnStatus(level, text) {
  document.getElementById("connStatus").className = "status-dot " + level;
  document.getElementById("connText").textContent = text;
}
function showLoading(text) {
  document.getElementById("loadingText").textContent = text || "読み込み中…";
  document.getElementById("loading").classList.remove("hidden");
}
function hideLoading() {
  document.getElementById("loading").classList.add("hidden");
}
function showToast(msg, type) {
  const t = document.createElement("div");
  t.className = "toast" + (type === "error" ? " error" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ===== デモデータ（GAS未接続時の動作確認用） =====
function getDemoStaff() {
  return [
    { id: 1, name: "南繁" },
    { id: 2, name: "辻松淳二" },
    { id: 3, name: "腰原あすか" },
    { id: 4, name: "城戸大樹" },
    { id: 5, name: "中出哲也" },
    { id: 6, name: "要田正治" }
  ];
}
function _dp(o) {
  return Object.assign({
    group: "診療", subcategory: "", modalGroup: "", dose: "",
    unit: "錠", qtyType: "", gigi: 0, staffPick: "", favorite: "",
    keywords: "", memo: "", color: ""
  }, o);
}
function getDemoProducts() {
  return [
    // 初診料：モーダルグループで束ね（区分で単価が変わる）
    _dp({ id: 1, category: "診察", subcategory: "診察料", name: "初診料", modalGroup: "初診料", dose: "昼", price: 1000, gigi: 1000, keywords: "ｼｮｼﾝ", favorite: "1", order: 10 }),
    _dp({ id: 2, category: "診察", subcategory: "診察料", name: "初診料（夜間）", modalGroup: "初診料", dose: "夜間", price: 2000, gigi: 2000, keywords: "ﾔｶﾝ ｼｮｼﾝ", order: 11 }),
    _dp({ id: 3, category: "診察", subcategory: "診察料", name: "初診料（深夜）", modalGroup: "初診料", dose: "深夜", price: 4000, gigi: 4000, keywords: "ｼﾝﾔ ｼｮｼﾝ", order: 12 }),
    _dp({ id: 4, category: "診察", subcategory: "診察料", name: "再診", price: 500, gigi: 500, keywords: "ｻｲｼﾝ", favorite: "1", order: 13 }),

    // 爪切り：モーダルグループ＋担当者選択フラグ（2段階モーダル）
    _dp({ id: 130, category: "処置", name: "爪切り", modalGroup: "爪切り", dose: "通常", price: 500, gigi: 500, staffPick: "〇", keywords: "ﾂﾒｷﾘ", favorite: "1", order: 410 }),
    _dp({ id: 131, category: "処置", name: "爪切り", modalGroup: "爪切り", dose: "中型犬以上・難しい", price: 1000, gigi: 1000, staffPick: "〇", keywords: "ﾂﾒｷﾘ", order: 411 }),

    // 投薬・ダニ除去：単独＋担当者選択フラグ（1段階で担当者モーダル）
    _dp({ id: 134, category: "処置", name: "投薬", price: 500, gigi: 500, staffPick: "〇", keywords: "ﾄｳﾔｸ", order: 420 }),
    _dp({ id: 189, category: "処置", name: "ダニ除去", price: 500, gigi: 500, staffPick: "〇", keywords: "ﾀﾞﾆ", order: 430 }),

    // 通常の単独項目
    _dp({ id: 100, category: "検査", subcategory: "血液検査", name: "血液検査Aセット", price: 4500, gigi: 2000, keywords: "ｹﾂｴｷ", order: 250 }),
    _dp({ id: 350, category: "その他", subcategory: "文書料", name: "診断書", price: 1000, gigi: 1000, keywords: "ｼﾝﾀﾞﾝｼｮ", order: 730 }),

    // 薬・物販（数量タイプ確認用）
    _dp({ id: 521, group: "薬・物販", category: "処方薬（錠剤・カプセル）", subcategory: "抗生剤", name: "ケフレックスカプセル", unit: "Cap", qtyType: "小数OK", price: 110, keywords: "ｹﾌﾚｯｸｽ", order: 521 }),
    _dp({ id: 600, group: "薬・物販", category: "処方薬（液剤・シロップ）", name: "ネオドパゾール液", unit: "㎖", qtyType: "小数OK", price: 15, keywords: "ﾈｵﾄﾞﾊﾟ", order: 600 }),
    _dp({ id: 650, group: "薬・物販", category: "処方薬（外用・軟膏）", name: "ヒビクス軟膏", unit: "本", qtyType: "整数固定", price: 1200, keywords: "ﾋﾋﾞｸｽ", favorite: "1", order: 650 }),
    _dp({ id: 800, group: "薬・物販", category: "消耗品・医療材料", name: "エリザベスカラー", unit: "個", qtyType: "整数固定", price: 800, keywords: "ｴﾘｶﾗ", order: 800 }),

    // 【第3弾】計算補助（formula）デモ
    _dp({ id: 901, category: "注射", name: "セフォベクリア", price: 0, gigi: 0, memo: "formula:weight*400+1000", keywords: "ｾﾌｫﾍﾞｸﾘｱ", order: 901 }),
    _dp({ id: 905, category: "手術", name: "プロポフォール", price: 0, gigi: 0, memo: "formula:ml*100+5000", keywords: "ﾌﾟﾛﾎﾟﾌｫｰﾙ", order: 905 })
  ];
}
