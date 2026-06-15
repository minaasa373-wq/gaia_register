/* ========================================
   ガイア動物病院 レジシステム
   メインロジック
   ======================================== */

// ===== 設定 =====
const GAS_URL = "https://script.google.com/macros/s/AKfycbyhM8ddjir1GJdKhmYzuCW1879ZiEJAPlKRkM2aTGUc96NatJgpklfmF58CdxRvA050/exec"; // ← ここにGASのWebアプリURLを貼り付け

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
  todaySales: 0,
  todayCount: 0,
  todayItems: []
};

const MAX_CART_ITEMS = 11; // 印刷の都合上、1会計の明細は11件まで

let itemIdCounter = 1;

// ===== 初期化 =====
window.addEventListener("DOMContentLoaded", async () => {
  // 日付を今日に
  document.getElementById("visitDate").value = new Date().toISOString().slice(0, 10);

  // 検索バー
  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.searchQuery = e.target.value.trim();
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
  loadTodayStats();
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

  // カテゴリタブ
  const cats = ["全て", ...new Set(state.products.map(p => p.category).filter(Boolean))];
  const tabs = document.getElementById("categoryTabs");
  tabs.innerHTML = cats.map(c =>
    `<button class="cat-tab${c === state.activeCategory ? " active" : ""}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`
  ).join("");
  tabs.querySelectorAll(".cat-tab").forEach(t => {
    t.addEventListener("click", () => {
      state.activeCategory = t.dataset.cat;
      tabs.querySelectorAll(".cat-tab").forEach(x => x.classList.toggle("active", x === t));
      renderProducts();
    });
  });

  renderProducts();
}

// お気に入りのみ表示の切り替え
function toggleFavorites() {
  state.showFavoritesOnly = !state.showFavoritesOnly;
  const btn = document.getElementById("favToggleBtn");
  if (btn) btn.classList.toggle("active", state.showFavoritesOnly);
  renderProducts();
}
function renderProducts() {
  const grid = document.getElementById("productGrid");

  let filtered = state.products.filter(p => {
    if (state.activeCategory !== "全て" && p.category !== state.activeCategory) return false;
    if (state.showFavoritesOnly && !isFavorite(p)) return false;
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      const target = (p.name + " " + (p.keywords || "") + " " + (p.subcategory || "") + " " + (p.modalGroup || "")).toLowerCase();
      if (!target.includes(q)) return false;
    }
    return true;
  });

  // グループ化：モーダルグループ列が同じものを1タイルに束ねる（一本化）
  // モーダルグループが空欄の行は、それぞれ単独タイル（キーをユニークにする）
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
    .sort((a, b) => (a[0].order || 9999) - (b[0].order || 9999))
    .map(group => {
      const p = group[0];
      const color = getCategoryColor(p.category, p.color);
      const fav = group.some(isFavorite) ? `<span class="tile-fav">★</span>` : "";
      const isMG = (p.modalGroup || "").trim() !== "";

      // モーダルグループで束ねられている（複数行）：モーダルで区分選択
      if (isMG && group.length > 1) {
        return `<div class="product-tile" style="--tile-color:${color}" onclick="openDoseModalByGroup('${escapeHtml(p.modalGroup)}')">
          ${fav}
          <span class="tile-multidose">▾</span>
          <div class="tile-name">${escapeHtml(p.modalGroup)}</div>
          <div class="tile-dose">${group.length}種類</div>
        </div>`;
      }

      // 単独行（モーダルグループなし、または束ね対象が1件のみ）
      // 担当者選択フラグがあれば、タップで担当者モーダル → カート
      const needStaffPick = isStaffPick(p);
      const clickAction = needStaffPick
        ? `openStaffPickModal(${p.id})`
        : `addToCartById(${p.id})`;

      const doseLine = p.dose ? `<div class="tile-dose">${escapeHtml(p.dose)}</div>` : "";
      const priceLine = `<div class="tile-price">¥${p.price.toLocaleString()}${unitSuffix(p.unit)}</div>`;
      const pickMark = needStaffPick ? `<span class="tile-staffpick">担</span>` : "";

      return `<div class="product-tile" style="--tile-color:${color}" onclick="${clickAction}">
        ${fav}${pickMark}
        <div class="tile-name">${escapeHtml(p.name)}</div>
        ${doseLine}${priceLine}
      </div>`;
    }).join("");
}

// お気に入り判定（L列に何か入っていればお気に入り）
function isFavorite(p) {
  const v = (p.favorite || "").toString().trim();
  return v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

// 担当者選択フラグ判定（〇 のときのみ。？ は判断保留なので対象外）
function isStaffPick(p) {
  return (p.staffPick || "").toString().trim() === "〇";
}

// 整数固定かどうか
function isIntegerOnly(p) {
  return (p.qtyType || "").toString().trim() === "整数固定";
}

// ===== 単位サフィックス（錠は省略、それ以外は「 /本」のように表示） =====
function unitSuffix(unit) {
  if (!unit || unit === "錠") return "";
  return ` <span style="font-size:10px;color:var(--muted);font-weight:400;">/${escapeHtml(unit)}</span>`;
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
// staffRole: null（担当者選択なし）/ "vet"（獣医）/ "nurse"（看護師＝技術料0＋＊印）
function addToCart(product, qty, staffRole) {
  if (!canAddItem()) return;

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
    state.cart.push({
      itemId: itemIdCounter++,
      productId: product.id,
      isPowder: false,
      name: product.name,
      dose: product.dose || "",
      category: product.category,
      qty: qty,
      price: product.price,
      unit: product.unit || "錠",
      qtyType: product.qtyType || "",
      staffRole: staffRole,           // null/"vet"/"nurse"
      isNurseMark: staffRole === "nurse" // ＊印フラグ
    });
  }
  renderCart();
}

// 11件上限チェック
function canAddItem() {
  if (state.cart.length >= MAX_CART_ITEMS) {
    showToast(`印刷の都合上、1会計の明細は${MAX_CART_ITEMS}件までです`, "error");
    return false;
  }
  return true;
}

// ===== 用量モーダル（モーダルグループ基準） =====
let doseGroup = [];
let pendingStaffPickProduct = null; // 担当者選択待ちの商品（2段階目用）

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

// 旧API互換（カテゴリ＋品名）。今後は使わないが念のため残す
function openDoseModal(category, name) {
  const grp = state.products.filter(p => p.category === category && p.name === name);
  if (grp.length && grp[0].modalGroup) {
    openDoseModalByGroup(grp[0].modalGroup);
  }
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
  const hint = intOnly ? "（整数のみ）" : "（小数OK：例 6.5）";
  document.getElementById("doseQtyLabel").textContent = `${u}数${hint}`;
  // 整数固定なら入力欄のstepを1に
  const qtyEl = document.getElementById("doseQty");
  qtyEl.step = intOnly ? "1" : "0.5";
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

// ===== 担当者選択モーダル（2段階目／単独タイルからの1段階） =====
let pendingQty = 1;

// 単独タイル（担当者選択フラグあり）から直接呼ぶ
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
    isNurseMark: false
  });
  closePowderModal();
  renderCart();
}

// 表示用の品名（用量＋看護師＊印を反映）
function cartDispName(item) {
  let n = item.dose ? `${item.name} ${item.dose}` : item.name;
  if (item.isNurseMark) n += "＊";
  return n;
}

// ===== カートの表示 =====
function renderCart() {
  const list = document.getElementById("cartList");
  if (state.cart.length === 0) {
    list.innerHTML = `<div class="cart-empty">商品タイルをタップして<br>注文を追加してください</div>`;
    closeEdit();
  } else {
    list.innerHTML = state.cart.map(item => {
      const amount = Math.round(item.qty * item.price);
      const dispName = cartDispName(item);
      const cls = (item.isPowder ? "powder" : "") + (item.itemId === state.selectedItemId ? " selected" : "");
      const detailLine = `${item.qty}${item.unit} × ¥${item.price.toLocaleString()}`;
      return `
        <div class="cart-item ${cls}" onclick="selectCartItem(${item.itemId})">
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
  document.getElementById("editQtyUnit").textContent = item.unit;
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
  // 整数固定の品目は整数に丸める
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
  if (!confirm("この行を削除しますか？")) return;
  state.cart = state.cart.filter(c => c.itemId !== state.selectedItemId);
  state.selectedItemId = null;
  document.getElementById("editPanel").classList.add("hidden");
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
  document.getElementById("receiptPreview").innerHTML = renderReceiptHtml(false);
  document.getElementById("receiptModal").classList.remove("hidden");
}
function closeReceipt() {
  document.getElementById("receiptModal").classList.add("hidden");
}

function renderReceiptHtml(forPrint) {
  const { subtotal, tax, total } = recalc();
  const owner = document.getElementById("ownerName").value.trim();
  const pet = document.getElementById("petName").value.trim();
  const staff = document.getElementById("staffSelect").value;
  const date = document.getElementById("visitDate").value;
  const dateDisp = formatDate(date);
  const invoiceNo = generateInvoiceNo(date);

  const items = state.cart.map(item => {
    const amount = Math.round(item.qty * item.price);
    const dispName = cartDispName(item);
    if (item.isPowder) {
      return `<div class="${forPrint ? 'print-item-line' : 'receipt-item-line'}">
        <div class="${forPrint ? 'print-item-name' : 'receipt-item-name'}">
          <span>${escapeHtml(dispName)}</span>
          <span>¥${amount.toLocaleString()}</span>
        </div>
        <div class="${forPrint ? 'print-item-detail' : 'receipt-item-detail'}">
          ${item.qty}${item.unit}
        </div>
      </div>`;
    } else {
      return `<div class="${forPrint ? 'print-item-line' : 'receipt-item-line'}">
        <div class="${forPrint ? 'print-item-name' : 'receipt-item-name'}">
          <span>${escapeHtml(dispName)}</span>
          <span>¥${amount.toLocaleString()}</span>
        </div>
        <div class="${forPrint ? 'print-item-detail' : 'receipt-item-detail'}">
          ${item.qty}${item.unit} × ¥${item.price.toLocaleString()}
        </div>
      </div>`;
    }
  }).join("");

  if (forPrint) {
    return `
      <div class="print-title">明　細　書</div>
      <div class="print-meta">
        <span>発行日：${dateDisp}</span>
        <span>No. ${invoiceNo}</span>
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
        <div class="receipt-meta-row"><span>発行日：${dateDisp}</span><span>No. ${invoiceNo}</span></div>
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
async function doPrint() {
  // 印刷エリアを2枚分組み立て
  const html1 = renderReceiptHtml(true);
  const html2 = renderReceiptHtml(true);
  document.getElementById("printArea").innerHTML = `
    <div class="print-page">${html1}</div>
    <div class="print-page">
      <div class="print-watermark">控　え</div>
      ${html2}
    </div>
  `;

  // GASに記録（送信失敗してもプリントは進める）
  const recordResult = await sendToGAS();

  // 印刷
  setTimeout(() => {
    window.print();
    // 印刷後にカートクリア
    setTimeout(() => {
      if (recordResult) {
        showToast("印刷＆スプシに記録しました");
        addToTodayStats();
      }
      clearCart();
      closeReceipt();
    }, 500);
  }, 200);
}

// ===== GASに送信 =====
async function sendToGAS() {
  if (GAS_URL === "YOUR_GAS_URL_HERE") {
    showToast("デモモード：記録は保存されません", "error");
    return false;
  }

  const { subtotal, tax, total } = recalc();
  const data = {
    action: "record",
    visitDate: document.getElementById("visitDate").value,
    invoiceNo: generateInvoiceNo(document.getElementById("visitDate").value),
    staff: document.getElementById("staffSelect").value,
    ownerName: document.getElementById("ownerName").value.trim(),
    petName: document.getElementById("petName").value.trim(),
    items: state.cart.map(item => ({
      name: item.dose ? `${item.name} ${item.dose}` : item.name,
      qty: item.qty,
      unit: item.unit,
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
    if (json.result === "success") return true;
    throw new Error(json.message || "保存失敗");
  } catch (e) {
    showToast("記録エラー：" + e.message, "error");
    return false;
  }
}

// ===== 日計 =====
function addToTodayStats() {
  const { total } = recalc();
  state.todaySales += total;
  state.todayCount++;
  state.todayItems.push({
    time: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
    owner: document.getElementById("ownerName").value.trim(),
    pet: document.getElementById("petName").value.trim(),
    total: total
  });
  saveTodayStats();
  renderTodayStats();
}

function loadTodayStats() {
  // localStorageは禁止なので、起動ごとに0スタート（運用上、1日1端末1セッションを想定）
  // 必要なら GAS から本日分を取得する処理に拡張可
  renderTodayStats();
}

function saveTodayStats() {
  // 同上
}

function renderTodayStats() {
  document.getElementById("todaySales").textContent = "¥" + state.todaySales.toLocaleString();
  document.getElementById("todayCount").textContent = state.todayCount;
}

function showSummary() {
  const body = document.getElementById("summaryBody");
  if (state.todayItems.length === 0) {
    body.innerHTML = `<div style="text-align:center;color:var(--hint);padding:30px;">本日の売上記録はまだありません</div>`;
  } else {
    body.innerHTML = `
      <div style="margin-bottom:14px;display:flex;justify-content:space-around;text-align:center;">
        <div>
          <div style="font-size:11px;color:var(--muted);">売上合計</div>
          <div style="font-size:22px;font-weight:700;color:var(--green-dark);">¥${state.todaySales.toLocaleString()}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);">件数</div>
          <div style="font-size:22px;font-weight:700;color:var(--green-dark);">${state.todayCount} 件</div>
        </div>
      </div>
      <div style="border-top:1px solid var(--border-soft);padding-top:10px;">
        ${state.todayItems.map(it => `
          <div style="padding:6px 0;border-bottom:1px solid var(--border-soft);font-size:12px;display:flex;justify-content:space-between;">
            <span>${it.time}　${escapeHtml(it.owner)}様${it.pet ? `（${escapeHtml(it.pet)}）` : ""}</span>
            <strong>¥${it.total.toLocaleString()}</strong>
          </div>
        `).join("")}
      </div>
    `;
  }
  document.getElementById("summaryModal").classList.remove("hidden");
}
function closeSummary() {
  document.getElementById("summaryModal").classList.add("hidden");
}

// ===== カートクリア =====
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
function generateInvoiceNo(dateStr) {
  if (!dateStr) dateStr = new Date().toISOString().slice(0, 10);
  const ymd = dateStr.replace(/-/g, "").slice(2);
  const seq = String(state.todayCount + 1).padStart(3, "0");
  return ymd + "-" + seq;
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

// ===== デモデータ（GAS未接続時の動作確認用・16列新構造） =====
function getDemoStaff() {
  return [
    { id: 1, name: "佐藤 院長" },
    { id: 2, name: "田中 副院長" },
    { id: 3, name: "山本 獣医師" }
  ];
}
function P(o) {
  // デモ用の補完ヘルパ（不足キーをデフォルトで埋める）
  return Object.assign({
    group: "診療", subcategory: "", modalGroup: "", dose: "",
    unit: "錠", qtyType: "", gigi: 0, staffPick: "", favorite: "",
    keywords: "", memo: "", color: ""
  }, o);
}
function getDemoProducts() {
  return [
    // 初診料：モーダルグループ「初診料」で束ね（区分で単価が変わる・パターンX）
    P({ id: 1, category: "診察", subcategory: "診察料", name: "初診料", modalGroup: "初診料", dose: "昼", price: 1000, gigi: 1000, keywords: "ｼｮｼﾝ", favorite: "1", order: 10 }),
    P({ id: 2, category: "診察", subcategory: "診察料", name: "初診料（夜間）", modalGroup: "初診料", dose: "夜間", price: 2000, gigi: 2000, keywords: "ﾔｶﾝ ｼｮｼﾝ", order: 11 }),
    P({ id: 3, category: "診察", subcategory: "診察料", name: "初診料（深夜）", modalGroup: "初診料", dose: "深夜", price: 4000, gigi: 4000, keywords: "ｼﾝﾔ ｼｮｼﾝ", order: 12 }),
    P({ id: 4, category: "診察", subcategory: "診察料", name: "再診", price: 500, gigi: 500, keywords: "ｻｲｼﾝ", favorite: "1", order: 13 }),

    // 爪切り：モーダルグループ「爪切り」＋担当者選択フラグ（2段階モーダル・パターンX×Y）
    P({ id: 130, category: "処置", name: "爪切り", modalGroup: "爪切り", dose: "通常", price: 500, gigi: 500, staffPick: "〇", keywords: "ﾂﾒｷﾘ", favorite: "1", order: 410 }),
    P({ id: 131, category: "処置", name: "爪切り", modalGroup: "爪切り", dose: "中型犬以上・難しい", price: 1000, gigi: 1000, staffPick: "〇", keywords: "ﾂﾒｷﾘ", order: 411 }),

    // 投薬：単独タイル＋担当者選択フラグ（1段階で担当者モーダル・パターンYのみ）
    P({ id: 134, category: "処置", name: "投薬", price: 500, gigi: 500, staffPick: "〇", keywords: "ﾄｳﾔｸ", order: 420 }),

    // ダニ除去：単独＋担当者選択
    P({ id: 189, category: "処置", name: "ダニ除去", price: 500, gigi: 500, staffPick: "〇", keywords: "ﾀﾞﾆ", order: 430 }),

    // 通常の単独項目
    P({ id: 100, category: "検査", subcategory: "血液検査", name: "血液検査Aセット", price: 4500, gigi: 2000, keywords: "ｹﾂｴｷ", order: 250 }),
    P({ id: 350, category: "その他", subcategory: "文書料", name: "診断書", price: 1000, gigi: 1000, keywords: "ｼﾝﾀﾞﾝｼｮ", order: 730 }),

    // 薬・物販系（数量タイプの確認用）
    P({ id: 521, group: "薬・物販", category: "処方薬（錠剤・カプセル）", subcategory: "抗生剤", name: "ケフレックスカプセル", unit: "Cap", qtyType: "小数OK", price: 110, keywords: "ｹﾌﾚｯｸｽ", order: 521 }),
    P({ id: 600, group: "薬・物販", category: "処方薬（液剤・シロップ）", name: "ネオドパゾール液", unit: "㎖", qtyType: "小数OK", price: 15, keywords: "ﾈｵﾄﾞﾊﾟ", order: 600 }),
    P({ id: 650, group: "薬・物販", category: "処方薬（外用・軟膏）", name: "ヒビクス軟膏", unit: "本", qtyType: "整数固定", price: 1200, keywords: "ﾋﾋﾞｸｽ", favorite: "1", order: 650 }),
    P({ id: 800, group: "薬・物販", category: "消耗品・医療材料", name: "エリザベスカラー", unit: "個", qtyType: "整数固定", price: 800, keywords: "ｴﾘｶﾗ", order: 800 })
  ];
}
