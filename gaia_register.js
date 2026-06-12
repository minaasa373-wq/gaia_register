/* ========================================
   ガイア動物病院 レジシステム
   メインロジック
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
  lastInvoiceNo: null   // 直近の印刷でサーバ採番された伝票番号
};

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
  // 担当者プルダウン
  const sel = document.getElementById("staffSelect");
  sel.innerHTML = state.staff.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join("");

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

// ===== 商品グリッドの表示 =====
function renderProducts() {
  const grid = document.getElementById("productGrid");

  // 用量違いの商品を「品名」でグループ化（同じ品名で用量が複数あるものは1タイルにまとめる）
  const q = state.searchQuery ? normalizeSearch(state.searchQuery) : "";
  let filtered = state.products.filter(p => {
    if (q) {
      // 検索中は常に全カテゴリ横断（タブ選択を無視）
      const target = normalizeSearch(
        (p.name || "") + " " + (p.keywords || "") + " " + (p.subcategory || "")
      );
      return target.includes(q);
    }
    // 非検索時はタブで絞り込み
    if (state.activeCategory !== "全て" && p.category !== state.activeCategory) return false;
    return true;
  });

  // グループ化：同じカテゴリ＆品名のものは1タイルにまとめる
  const groups = new Map();
  filtered.forEach(p => {
    const key = p.category + "|" + p.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });

  if (groups.size === 0) {
    grid.innerHTML = `<div class="empty-products">該当する商品がありません</div>`;
    return;
  }

  grid.innerHTML = Array.from(groups.values())
    .sort((a, b) => (a[0].order || 9999) - (b[0].order || 9999))
    .map(group => {
      const p = group[0];
      const color = getCategoryColor(p.category, p.color);
      const hasMulti = group.length > 1 || (p.dose && p.dose !== "");

      // 用量1種類だけ＆用量空欄の場合：通常タイル
      if (!hasMulti) {
        return `<div class="product-tile" style="--tile-color:${color}" data-product-id="${p.id}" onclick="addToCartById(${p.id})">
          <div class="tile-name">${escapeHtml(p.name)}</div>
          <div class="tile-price">¥${p.price.toLocaleString()}${unitSuffix(p.unit)}</div>
        </div>`;
      }

      // 用量が1つだけ（用量あり）：通常タイル＋用量表示
      if (group.length === 1 && p.dose) {
        return `<div class="product-tile" style="--tile-color:${color}" data-product-id="${p.id}" onclick="addToCartById(${p.id})">
          <div class="tile-name">${escapeHtml(p.name)}</div>
          <div class="tile-dose">${escapeHtml(p.dose)}</div>
          <div class="tile-price">¥${p.price.toLocaleString()}${unitSuffix(p.unit)}</div>
        </div>`;
      }

      // 用量複数：モーダルで選択
      return `<div class="product-tile" style="--tile-color:${color}" onclick="openDoseModal('${escapeHtml(p.category)}','${escapeHtml(p.name)}')">
        <span class="tile-multidose">▾</span>
        <div class="tile-name">${escapeHtml(p.name)}</div>
        <div class="tile-dose">${group.length}種類の用量</div>
      </div>`;
    }).join("");
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

// 既存の同じ商品IDがあれば数量加算、なければ新規追加
function addToCart(product, qty) {
  const existing = state.cart.find(c => !c.isPowder && c.productId === product.id);
  if (existing) {
    existing.qty = Math.round((existing.qty + qty) * 100) / 100;
  } else {
    state.cart.push({
      itemId: itemIdCounter++,
      productId: product.id,
      isPowder: false,
      group: product.group || "診療",
      name: product.name,
      dose: product.dose || "",
      category: product.category,
      qty: qty,
      price: product.price,
      unit: product.unit || "錠"
    });
  }
  renderCart();
}

// ===== 用量モーダル =====
let doseGroup = [];
function openDoseModal(category, name) {
  doseGroup = state.products.filter(p => p.category === category && p.name === name);
  if (doseGroup.length === 0) return;

  document.getElementById("doseProductName").textContent = name;
  state.currentDose = doseGroup[0];

  const opts = doseGroup.map(p => `
    <div class="dose-opt${p === state.currentDose ? " selected" : ""}" data-id="${p.id}" onclick="selectDose(${p.id})">
      <div class="dose-value">${escapeHtml(p.dose || "—")}</div>
      <div class="dose-price">¥${p.price.toLocaleString()}${p.unit && p.unit !== "錠" ? " /" + escapeHtml(p.unit) : ""}</div>
    </div>
  `).join("");
  document.getElementById("doseOptions").innerHTML = opts;
  document.getElementById("doseQty").value = 1;
  const u = state.currentDose.unit || "錠";
  document.getElementById("doseQtyLabel").textContent = `${u}数（小数OK：例 6.5）`;
  updateDoseTotal();
  document.getElementById("doseModal").classList.remove("hidden");
}
function selectDose(id) {
  state.currentDose = doseGroup.find(p => p.id == id);
  document.querySelectorAll("#doseOptions .dose-opt").forEach(el => {
    el.classList.toggle("selected", el.dataset.id == id);
  });
  const u = state.currentDose.unit || "錠";
  document.getElementById("doseQtyLabel").textContent = `${u}数（小数OK：例 6.5）`;
  updateDoseTotal();
}
function updateDoseTotal() {
  if (!state.currentDose) return;
  const qty = parseFloat(document.getElementById("doseQty").value) || 0;
  const total = Math.round(state.currentDose.price * qty);
  document.getElementById("doseTotalAmount").textContent = "¥" + total.toLocaleString();
}
function confirmDose() {
  const qty = parseFloat(document.getElementById("doseQty").value) || 0;
  if (qty <= 0) {
    const u = (state.currentDose && state.currentDose.unit) || "錠";
    showToast(`${u}数を入力してください`, "error");
    return;
  }
  addToCart(state.currentDose, qty);
  closeDoseModal();
}
function closeDoseModal() {
  document.getElementById("doseModal").classList.add("hidden");
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
  state.cart.push({
    itemId: itemIdCounter++,
    productId: null,
    isPowder: true,
    name: "処方薬（粉薬）",
    dose: "",
    category: "処方薬",
    qty: packs,
    price: unitPrice,   // 1包あたり単価
    unit: "包"
  });
  closePowderModal();
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
      const dispName = item.dose ? `${item.name} ${item.dose}` : item.name;
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
  document.getElementById("cartCount").textContent = state.cart.length + " 件";
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
  const dispName = item.dose ? `${item.name} ${item.dose}` : item.name;
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
  const qty = parseFloat(document.getElementById("editQty").value) || 0;
  const priceInput = parseFloat(document.getElementById("editPrice").value) || 0;
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
  const tax = Math.floor(subtotal * 0.1);
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
  const staff = document.getElementById("staffSelect").value;
  const date = document.getElementById("visitDate").value;
  const dateDisp = formatDate(date);
  const invoiceDisp = invoiceNo ? invoiceNo : "（印刷時に採番）";

  const items = state.cart.map(item => {
    const amount = Math.round(item.qty * item.price);
    const dispName = item.dose ? `${item.name} ${item.dose}` : item.name;
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
    staff: document.getElementById("staffSelect").value,
    ownerName: document.getElementById("ownerName").value.trim(),
    petName: document.getElementById("petName").value.trim(),
    items: state.cart.map(item => ({
      name: item.dose ? `${item.name} ${item.dose}` : item.name,
      qty: item.qty,
      unit: (item.group === "診療" && !item.isPowder) ? "" : item.unit,
      price: item.price,
      amount: Math.round(item.qty * item.price),
      isPowder: item.isPowder
    })),
    subtotal: subtotal,
    tax: tax,
    total: total
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
    { id: 1, name: "佐藤 院長" },
    { id: 2, name: "鈴木 看護師" },
    { id: 3, name: "高橋 受付" }
  ];
}
function getDemoProducts() {
  return [
    // ===== 診療系（商品マスタ）=====
    { id: 1, group: "診療", category: "診察", subcategory: "診察料", name: "初診", dose: "", price: 1000, gigi: 1000, keywords: "ｼｮｼﾝ", unit: "錠", order: 10 },
    { id: 4, group: "診療", category: "診察", subcategory: "診察料", name: "再診", dose: "", price: 500, gigi: 500, keywords: "ｻｲｼﾝ", unit: "錠", order: 13 },
    { id: 8, group: "診療", category: "診察", subcategory: "入院料", name: "入院料（小〜中型犬・猫）", dose: "〜15kg", price: 1500, gigi: 0, keywords: "ﾆｭｳｲﾝ", unit: "錠", order: 20 },
    { id: 21, group: "診療", category: "注射", subcategory: "注射料（皮下・筋注）", name: "皮下・筋注", dose: "〜10kg", price: 1000, gigi: 1000, keywords: "ﾋｶ ｷﾝﾁｭｳ", unit: "錠", order: 111 },
    { id: 44, group: "診療", category: "注射", subcategory: "特別注射", name: "セフォベクリア", dose: "", price: 0, gigi: 0, keywords: "ｾﾌｫﾍﾞｸﾘｱ", unit: "錠", order: 152 },
    { id: 100, group: "診療", category: "検査", subcategory: "血液検査", name: "血液検査Aセット", dose: "", price: 4500, gigi: 2000, keywords: "ｹﾂｴｷ", unit: "錠", order: 250 },
    { id: 150, group: "診療", category: "処置", subcategory: "", name: "つめ切り", dose: "", price: 500, gigi: 500, keywords: "ﾂﾒｷﾘ", unit: "錠", order: 410 },
    { id: 200, group: "診療", category: "手術", subcategory: "不妊手術", name: "犬雌 卵巣子宮全摘出", dose: "〜10kg", price: 17000, gigi: 7000, keywords: "ﾌﾆﾝ ﾒｽ", unit: "錠", order: 620 },
    { id: 300, group: "診療", category: "民宿・トリミング", subcategory: "", name: "シャンプー（小）", dose: "", price: 2000, gigi: 2000, keywords: "ｼｬﾝﾌﾟｰ", unit: "錠", order: 720 },
    { id: 350, group: "診療", category: "その他", subcategory: "文書料", name: "診断書", dose: "", price: 1000, gigi: 1000, keywords: "ｼﾝﾀﾞﾝｼｮ", unit: "錠", order: 730 },

    // ===== 薬・物販系（薬品・物品マスタ）=====
    // 用量違い（mgが品名に入るので別タイル）
    { id: 535, group: "薬・物販", category: "処方薬（錠剤・カプセル）", subcategory: "心臓", name: "ビクタス錠10㎎", dose: "", price: 70, gigi: 0, keywords: "ﾋﾞｸﾀｽ", unit: "錠", order: 535 },
    { id: 536, group: "薬・物販", category: "処方薬（錠剤・カプセル）", subcategory: "心臓", name: "ビクタス錠20㎎", dose: "", price: 100, gigi: 0, keywords: "ﾋﾞｸﾀｽ", unit: "錠", order: 536 },
    // カプセル単位
    { id: 521, group: "薬・物販", category: "処方薬（錠剤・カプセル）", subcategory: "抗生剤", name: "ケフレックスカプセル", dose: "", price: 110, gigi: 0, keywords: "ｹﾌﾚｯｸｽ", unit: "Cap", order: 521 },
    // ml単位（液剤）
    { id: 600, group: "薬・物販", category: "処方薬（液剤・シロップ）", subcategory: "", name: "ネオドパゾール液", dose: "", price: 15, gigi: 0, keywords: "ﾈｵﾄﾞﾊﾟ", unit: "㎖", order: 600 },
    // 本単位（外用）
    { id: 650, group: "薬・物販", category: "処方薬（外用・軟膏）", subcategory: "", name: "ヒビクス軟膏", dose: "", price: 1200, gigi: 0, keywords: "ﾋﾋﾞｸｽ", unit: "本", order: 650 },
    // ワクチン（本）
    { id: 700, group: "薬・物販", category: "ワクチン・駆虫薬", subcategory: "", name: "犬5種混合ワクチン", dose: "", price: 5000, gigi: 0, keywords: "ﾜｸﾁﾝ ｲﾇ5", unit: "本", order: 700 },
    // フード（袋）
    { id: 750, group: "薬・物販", category: "フード・サプリ", subcategory: "", name: "腎臓サポート（ドライ）", dose: "", price: 2800, gigi: 0, keywords: "ｼﾞﾝｿﾞｳ ﾌｰﾄﾞ", unit: "袋", order: 750 },
    // 消耗品（個）
    { id: 800, group: "薬・物販", category: "消耗品・医療材料", subcategory: "", name: "エリザベスカラー", dose: "", price: 800, gigi: 0, keywords: "ｴﾘｶﾗ", unit: "個", order: 800 },
    // 計算式必要（単価0）
    { id: 1100, group: "薬・物販", category: "計算式必要", subcategory: "", name: "コンベニア注", dose: "", price: 0, gigi: 0, keywords: "ｺﾝﾍﾞﾆｱ", unit: "本", order: 1100, memo: "体重×400+1000" }
  ];
}
