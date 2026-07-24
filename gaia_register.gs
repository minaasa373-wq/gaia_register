/**
 * ガイア動物病院 レジシステム - Google Apps Script
 *
 * 機能：
 * 1. doGet(?action=getMaster)：商品マスタ＋薬品・物品マスタ＋担当者マスタを返す
 * 2. doPost：販売記録＋技術料台帳をスプシに書き込む
 *
 * 使い方：
 * - スプレッドシートに「商品マスタ」「薬品・物品マスタ」「担当者」「販売記録」「技術料台帳」の5シートを用意
 * - このスクリプトをコピペしてWebアプリとしてデプロイ
 * - 取得したURLをHTMLの GAS_URL に貼り付け
 *
 * 【第2弾対応版の要点】
 * - 販売記録を16列に拡張（L〜O:技術料関連 / P:動物種）
 * - 技術料台帳シートを新設（給与計算用・獣医ごとに展開）
 * - doPost内で販売記録と技術料台帳を同時に書き込む
 * - searchRecords：過去ログ検索（動物種検索対応）
 */

// ===== 設定 =====
const SHEET_PRODUCTS    = "商品マスタ";          // 16列（案3共通構成）
const SHEET_DRUGS       = "薬品・物品マスタ";      // 16列（案3共通構成）
const SHEET_STAFF       = "担当者";
const SHEET_RECORDS     = "販売記録";
const SHEET_GIGI_LEDGER = "技術料台帳";          // 【第2弾】新設
const SHEET_VACCINE_LEDGER = "ワクチン台帳";      // 案3b：ワクチン種類別件数

const GROUP_CARE = "診療";
const GROUP_DRUG = "薬・物販";
// 単位はマスタの記入どおりに扱う方針のため、既定値による補完は行わない
// （旧仕様では空欄を "錠" で補完していたが、単位なし表示ができなかったため廃止）
const DEFAULT_UNIT = "";

// A-1：伝票番号サーバ採番
const INVOICE_PROP_KEY = "INVOICE_COUNTER"; // スクリプトプロパティのキー
const INVOICE_PAD = 6;                      // 6桁ゼロ詰め

// 16列共通ヘッダー（案3・両マスタ統一）
const MASTER_HEADERS_16 = [
  "ID", "カテゴリ", "サブカテゴリ", "品名", "モーダルグループ",
  "用量／体重区分", "単位", "数量タイプ", "単価", "技術料",
  "担当者選択フラグ", "お気に入り", "検索キーワード", "メモ／備考", "表示色", "表示順"
];

// ===== マスタ取得（GET） =====
function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || "";

    if (action === "getMaster") {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      return jsonResponse({
        result: "success",
        products: getAllProducts(ss),
        staff:    getStaff(ss)
      });
    }

    // 【過去ログビューア】販売記録の検索（読み取り専用）
    if (action === "searchRecords") {
      return jsonResponse(searchRecords(e.parameter));
    }

    return ContentService
      .createTextOutput("ガイア動物病院 レジ GAS 動作中（action=getMaster でマスタ取得）")
      .setMimeType(ContentService.MimeType.TEXT);

  } catch (err) {
    return jsonResponse({ result: "error", message: err.toString() });
  }
}

// ===== 【過去ログビューア】販売記録の検索（読み取り専用） =====
// パラメータ（すべて任意だが、最低1つは必須）：
//   owner : 飼い主名（部分一致）
//   pet   : ペット名（部分一致）
//   from  : 会計日の開始（yyyy-MM-dd）
//   to    : 会計日の終了（yyyy-MM-dd）
// 返却：新しい順・最大50件。技術料関連（L〜O列）は返さない。
const SEARCH_LIMIT = 50;

function searchRecords(params) {
  const owner  = String(params.owner  || "").trim();
  const pet    = String(params.pet    || "").trim();
  const from   = String(params.from   || "").trim();
  const to     = String(params.to     || "").trim();
  const animal = String(params.animal || "").trim(); // 動物種（完全一致）
  const staff  = String(params.staff  || "").trim(); // 担当者（部分一致・カンマ区切り複数名対応）

  // 条件なしの全件取得は不可（誤操作で全記録を引くのを防止）
  if (!owner && !pet && !from && !to && !animal && !staff) {
    return { result: "error", message: "検索条件を1つ以上指定してください" };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_RECORDS);
  if (!sheet || sheet.getLastRow() < 2) {
    return { result: "success", records: [], truncated: false };
  }

  // A〜K列（記録日時〜合計）＋P列（動物種）を取得。技術料関連（L〜O）は読み込まない
  // ただしgetRangeは連続範囲なのでA〜Pの16列を取得し、L〜Oは使わない
  const lastRow = sheet.getLastRow();
  const rows = sheet.getRange(2, 1, lastRow - 1, 16).getValues();

  // 会計日はyyyy-MM-dd文字列で比較（B列はDate型か文字列の可能性があるため正規化）
  const tz = Session.getScriptTimeZone();
  function normDate(v) {
    if (v instanceof Date) return Utilities.formatDate(v, tz, "yyyy-MM-dd");
    return String(v || "").trim();
  }

  const hits = [];
  for (const r of rows) {
    const visitDate  = normDate(r[1]);      // B: 会計日
    const staffName  = String(r[3] || "");  // D: 担当者
    const ownerName  = String(r[4] || "");  // E: 飼い主名
    const petName    = String(r[5] || "");  // F: ペット名
    const animalType = String(r[15] || ""); // P: 動物種

    if (owner  && ownerName.indexOf(owner) === -1) continue;
    if (pet    && petName.indexOf(pet)     === -1) continue;
    if (staff  && staffName.indexOf(staff) === -1) continue;
    if (from   && visitDate < from) continue;
    if (to     && visitDate > to)   continue;
    if (animal && animalType !== animal) continue;  // 完全一致

    hits.push({
      recordedAt: normDate(r[0]),          // A: 記録日時（日付部分）
      visitDate:  visitDate,               // B: 会計日
      invoiceNo:  String(r[2] || ""),      // C: 伝票番号
      staff:      String(r[3] || ""),      // D: 担当者
      owner:      ownerName,               // E: 飼い主名
      pet:        petName,                 // F: ペット名
      items:      String(r[6] || ""),      // G: 明細（改行区切りテキスト）
      count:      Number(r[7]) || 0,       // H: 件数
      subtotal:   Number(r[8]) || 0,       // I: 小計
      tax:        Number(r[9]) || 0,       // J: 消費税
      total:      Number(r[10]) || 0,      // K: 合計
      animalType: animalType               // P: 動物種
    });
  }

  // 新しい順（会計日降順→伝票番号降順）に並べ、上限で切る
  hits.sort((a, b) => {
    if (a.visitDate !== b.visitDate) return a.visitDate < b.visitDate ? 1 : -1;
    return a.invoiceNo < b.invoiceNo ? 1 : -1;
  });

  const truncated = hits.length > SEARCH_LIMIT;
  return {
    result: "success",
    records: hits.slice(0, SEARCH_LIMIT),
    truncated: truncated,
    totalHits: hits.length
  };
}

// ===== 販売記録の保存（POST） =====// 【A-1：サーバ採番版】＋【第2弾：14列化＋技術料台帳】
//   LockService で「採番→記録」を直列化し、4台同時でも伝票番号が衝突しない。
//   クライアントは伝票番号を送らない。GASが採番し invoiceNo を返す。
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    // 最大10秒待って排他ロック（採番〜書き込みを直列化）
    lock.waitLock(10000);

    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // ---- 販売記録シート ----
    let sheet = ss.getSheetByName(SHEET_RECORDS);

    // シートがなければ作成（16列版）
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_RECORDS);
      sheet.appendRow([
        "記録日時", "会計日", "伝票番号", "担当者", "飼い主名", "ペット名",
        "明細", "件数", "小計", "消費税", "合計",
        "通常技術料", "ワクチン技術料", "担当人数", "技術料明細", "動物種"
      ]);
      const header = sheet.getRange(1, 1, 1, 16);
      header.setBackground("#1a5c3a");
      header.setFontColor("#ffffff");
      header.setFontWeight("bold");
      sheet.setFrozenRows(1);
      sheet.setColumnWidth(7, 400);   // 明細列
      sheet.setColumnWidth(15, 400);  // 技術料明細列
    }

    // ---- 伝票番号を採番（ロック保持中に実行）----
    const invoiceNo = nextInvoiceNo();

    // 明細を1セルに集約（単位はクライアントから来た it.unit を使用）
    const itemsText = (data.items || []).map(it => {
      const unit = it.unit || "";
      const qtyDisp = it.qtyText ? it.qtyText : `${it.qty}${unit}`;
      if (it.isPowder) {
        return `${it.name} ${qtyDisp} = ¥${Number(it.amount).toLocaleString()}`;
      } else {
        return `${it.name} ${qtyDisp} × ¥${Number(it.price).toLocaleString()} = ¥${Number(it.amount).toLocaleString()}`;
      }
    }).join("\n");

    const now = new Date();
    const visitDate      = data.visitDate || "";
    const staffStr       = data.staff || "";
    const gigiNonVaccine = Number(data.gigiNonVaccine)  || 0;
    const gigiVaccine    = Number(data.gigiVaccine)     || 0;
    const staffCount     = Number(data.staffCount)      || 1;
    const gigiSnap       = data.gigiSnapshot || "";

    // 販売記録16列（A〜P）
    sheet.appendRow([
      now,                          // A: 記録日時
      visitDate,                    // B: 会計日
      invoiceNo,                    // C: 伝票番号（サーバ採番）
      staffStr,                     // D: 担当者（カンマ区切り）
      data.ownerName || "",         // E: 飼い主名
      data.petName || "",           // F: ペット名
      itemsText,                    // G: 明細
      (data.items || []).length,    // H: 件数
      data.subtotal || 0,           // I: 小計
      data.tax || 0,                // J: 消費税
      data.total || 0,              // K: 合計
      gigiNonVaccine,               // L: 通常技術料      ← 案B
      gigiVaccine,                  // M: ワクチン技術料  ← 案B
      staffCount,                   // N: 担当人数
      gigiSnap,                     // O: 技術料明細
      data.animalType || ""         // P: 動物種（犬/猫/ウサギ/その他）
    ]);

    // ---- 技術料台帳への書き込み ----
    writeGigiLedger(ss, now, visitDate, invoiceNo, staffStr, gigiNonVaccine, gigiVaccine, staffCount);

    // ---- ワクチン台帳への書き込み（案3b）----
    writeVaccineLedger(ss, now, visitDate, invoiceNo, data.vaccineCounts);

    return jsonResponse({ result: "success", invoiceNo: invoiceNo });

  } catch (err) {
    return jsonResponse({ result: "error", message: err.toString() });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

// ===== 技術料台帳への書き込み =====
// 7列：記録日時 / 会計日 / 伝票番号 / 担当獣医 / 通常技術料 / ワクチン技術料 / 担当人数
// ・1人担当 → 1行（獣医名単独）
// ・複数担当 → 1行（獣医名カンマ区切り、技術料は合計額のまま。配分は手動）
function writeGigiLedger(ss, now, visitDate, invoiceNo, staffStr, gigiNonVaccine, gigiVaccine, staffCount) {
  let ledger = ss.getSheetByName(SHEET_GIGI_LEDGER);

  // シートがなければ作成（7列版）
  if (!ledger) {
    ledger = ss.insertSheet(SHEET_GIGI_LEDGER);
    ledger.appendRow(["記録日時", "会計日", "伝票番号", "担当獣医", "通常技術料", "ワクチン技術料", "担当人数"]);
    const header = ledger.getRange(1, 1, 1, 7);
    header.setBackground("#1a5c3a");
    header.setFontColor("#ffffff");
    header.setFontWeight("bold");
    ledger.setFrozenRows(1);
    ledger.setColumnWidth(4, 120);
  }

  // 常に1行で記録（複数担当でも分割しない）
  ledger.appendRow([now, visitDate, invoiceNo, staffStr, gigiNonVaccine, gigiVaccine, staffCount]);
}

// ===== ワクチン台帳への書き込み（案3b）=====
// 4列：記録日時 / 会計日 / 伝票番号 / ワクチン名 / 件数
// ワクチン種類ごとに1行（縦持ち）。会計にワクチンがなければ何も書かない。
function writeVaccineLedger(ss, now, visitDate, invoiceNo, vaccineCounts) {
  // ワクチンがない会計はスキップ
  if (!vaccineCounts || vaccineCounts.length === 0) return;

  let ledger = ss.getSheetByName(SHEET_VACCINE_LEDGER);

  // シートがなければ作成
  if (!ledger) {
    ledger = ss.insertSheet(SHEET_VACCINE_LEDGER);
    ledger.appendRow(["記録日時", "会計日", "伝票番号", "ワクチン名", "件数"]);
    const header = ledger.getRange(1, 1, 1, 5);
    header.setBackground("#1a5c3a");
    header.setFontColor("#ffffff");
    header.setFontWeight("bold");
    ledger.setFrozenRows(1);
    ledger.setColumnWidth(4, 200);
  }

  // ワクチン種類ごとに1行
  vaccineCounts.forEach(v => {
    const name = String(v.name || "").trim();
    const count = Number(v.count) || 0;
    if (name && count > 0) {
      ledger.appendRow([now, visitDate, invoiceNo, name, count]);
    }
  });
}

// ===== 伝票番号の採番 =====
// スクリプトプロパティのカウンタを +1 して6桁ゼロ詰めで返す。
// 必ず doPost のロック保持中にのみ呼ぶこと。
function nextInvoiceNo() {
  const props = PropertiesService.getScriptProperties();
  const cur = parseInt(props.getProperty(INVOICE_PROP_KEY) || "0", 10);
  const next = cur + 1;
  props.setProperty(INVOICE_PROP_KEY, String(next));
  return String(next).padStart(INVOICE_PAD, "0");
}

// ===== カウンタ初期化（手動実行用） =====
// 既存の通し番号を引き継ぐ場合、START に「最後に発行済みの番号」を入れて一度だけ実行。
// 例：これまで最大 000128 まで発行済みなら START = 128。次回採番は 000129 から。
function initInvoiceCounter() {
  const START = 0; // ←必要に応じて変更して一度だけ実行
  PropertiesService.getScriptProperties().setProperty(INVOICE_PROP_KEY, String(START));
  Logger.log("INVOICE_COUNTER を " + START + " に設定しました（次の採番は " +
    String(START + 1).padStart(INVOICE_PAD, "0") + "）");
}

// ===== 全商品取得（2シート連結） =====
// 診療系（商品マスタ）→ 薬品系（薬品・物品マスタ）の順で返す
// 【第2陣・16列共通版】両マスタとも同じ16列構成（案3）で読み込む
function getAllProducts(ss) {
  const care  = getProductsFromSheet(ss, SHEET_PRODUCTS, GROUP_CARE);
  const drugs = getProductsFromSheet(ss, SHEET_DRUGS,    GROUP_DRUG);
  return care.concat(drugs);
}

// ===== マスタ取得（16列共通） =====
// 列： A:ID  B:カテゴリ  C:サブカテゴリ  D:品名  E:モーダルグループ
//      F:用量／体重区分  G:単位  H:数量タイプ  I:単価  J:技術料
//      K:担当者選択フラグ  L:お気に入り  M:検索キーワード  N:メモ  O:表示色  P:表示順
function getProductsFromSheet(ss, sheetName, group) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const data = sheet.getRange(2, 1, lastRow - 1, 16).getValues();
  return data.filter(r => r[0] !== "" && r[3] !== "").map(r => ({
    id:          r[0],
    group:       group,
    category:    String(r[1]  || ""),
    subcategory: String(r[2]  || ""),
    name:        String(r[3]  || ""),
    modalGroup:  String(r[4]  || ""),   // E: モーダルグループ（束ねキー、空=単独）
    dose:        String(r[5]  || ""),   // F: 用量／体重区分
    unit:        String(r[6]  || ""),   // G: 単位（空欄は空のまま。補完しない）
    qtyType:     String(r[7]  || ""),   // H: 数量タイプ（小数OK/整数固定/空）
    price:       Number(r[8]) || 0,     // I: 単価
    gigi:        Number(r[9]) || 0,     // J: 技術料
    staffPick:   String(r[10] || ""),   // K: 担当者選択フラグ（〇/？/空）
    favorite:    String(r[11] || ""),   // L: お気に入り
    keywords:    String(r[12] || ""),   // M: 検索キーワード
    memo:        String(r[13] || ""),   // N: メモ
    color:       String(r[14] || ""),   // O: 表示色
    order:       Number(r[15]) || 9999  // P: 表示順
  }));
}

// ===== 担当者マスタ取得 =====
function getStaff(ss) {
  const sheet = ss.getSheetByName(SHEET_STAFF);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  // 列：A:ID  B:担当者名  C:歩合率（%、空=0）
  const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  return data.filter(r => r[1] !== "").map(r => ({
    id:   r[0],
    name: String(r[1]),
    rate: Number(r[2]) || 0   // 歩合率（%）。0なら月次集計で非表示
  }));
}

// ===== JSONレスポンス =====
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== 初期セットアップ用：シートを自動生成 =====
// スクリプトエディタから実行すると、5つのシートと雛形ヘッダーを作成します
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 商品マスタ（診療行為・16列／案3共通構成）
  let pSheet = ss.getSheetByName(SHEET_PRODUCTS);
  if (!pSheet) {
    pSheet = ss.insertSheet(SHEET_PRODUCTS);
    pSheet.appendRow(MASTER_HEADERS_16);
    const h = pSheet.getRange(1, 1, 1, 16);
    h.setBackground("#1a5c3a").setFontColor("#fff").setFontWeight("bold");
    pSheet.setFrozenRows(1);
    pSheet.setColumnWidths(1, 16, 100);
    pSheet.setColumnWidth(4, 180);
  }

  // 薬品・物品マスタ（薬/物販・16列／案3共通構成）
  let dSheet = ss.getSheetByName(SHEET_DRUGS);
  if (!dSheet) {
    dSheet = ss.insertSheet(SHEET_DRUGS);
    dSheet.appendRow(MASTER_HEADERS_16);
    const h = dSheet.getRange(1, 1, 1, 16);
    h.setBackground("#1a5c3a").setFontColor("#fff").setFontWeight("bold");
    dSheet.setFrozenRows(1);
    dSheet.setColumnWidths(1, 16, 100);
    dSheet.setColumnWidth(4, 200);
  }

  // 担当者（3列：ID / 担当者名 / 歩合率）
  let sSheet = ss.getSheetByName(SHEET_STAFF);
  if (!sSheet) {
    sSheet = ss.insertSheet(SHEET_STAFF);
    sSheet.appendRow(["ID", "担当者名", "歩合率"]);
    const h = sSheet.getRange(1, 1, 1, 3);
    h.setBackground("#1a5c3a").setFontColor("#fff").setFontWeight("bold");
    sSheet.setFrozenRows(1);
    sSheet.setColumnWidth(1, 60);
    sSheet.setColumnWidth(2, 150);
    sSheet.setColumnWidth(3, 80);
    // サンプル
    sSheet.appendRow([1, "南繁", 0]);
    sSheet.appendRow([2, "辻松淳二", 44]);
    sSheet.appendRow([3, "腰原あすか", 44]);
    sSheet.appendRow([4, "城戸大樹", 40]);
    sSheet.appendRow([5, "中出哲也", 0]);
    sSheet.appendRow([6, "要田正治", 30]);
  }

  // 販売記録（16列版）
  let rSheet = ss.getSheetByName(SHEET_RECORDS);
  if (!rSheet) {
    rSheet = ss.insertSheet(SHEET_RECORDS);
    rSheet.appendRow([
      "記録日時", "会計日", "伝票番号", "担当者", "飼い主名", "ペット名",
      "明細", "件数", "小計", "消費税", "合計",
      "通常技術料", "ワクチン技術料", "担当人数", "技術料明細", "動物種"
    ]);
    const h = rSheet.getRange(1, 1, 1, 16);
    h.setBackground("#1a5c3a").setFontColor("#fff").setFontWeight("bold");
    rSheet.setFrozenRows(1);
    rSheet.setColumnWidth(7, 400);   // 明細列
    rSheet.setColumnWidth(15, 400);  // 技術料明細列
  }

  // 技術料台帳（7列版）
  let gSheet = ss.getSheetByName(SHEET_GIGI_LEDGER);
  if (!gSheet) {
    gSheet = ss.insertSheet(SHEET_GIGI_LEDGER);
    gSheet.appendRow(["記録日時", "会計日", "伝票番号", "担当獣医", "通常技術料", "ワクチン技術料", "担当人数"]);
    const h = gSheet.getRange(1, 1, 1, 7);
    h.setBackground("#1a5c3a").setFontColor("#fff").setFontWeight("bold");
    gSheet.setFrozenRows(1);
    gSheet.setColumnWidth(4, 120);
  }

  // ワクチン台帳（案3b・5列）
  let vSheet = ss.getSheetByName(SHEET_VACCINE_LEDGER);
  if (!vSheet) {
    vSheet = ss.insertSheet(SHEET_VACCINE_LEDGER);
    vSheet.appendRow(["記録日時", "会計日", "伝票番号", "ワクチン名", "件数"]);
    const h = vSheet.getRange(1, 1, 1, 5);
    h.setBackground("#1a5c3a").setFontColor("#fff").setFontWeight("bold");
    vSheet.setFrozenRows(1);
    vSheet.setColumnWidth(4, 200);
  }

  SpreadsheetApp.getUi().alert(
    "6つのシートを準備しました：\n" +
    "・商品マスタ（診療行為）\n" +
    "・薬品・物品マスタ（薬/物販）\n" +
    "・担当者（6名入り）\n" +
    "・販売記録（15列版）\n" +
    "・技術料台帳（7列版）\n" +
    "・ワクチン台帳（5列版）"
  );
}

// ===== 月次集計 =====
// スクリプトエディタから generateMonthlyGigiReport(2026, 6) のように実行。
// または promptMonthlyReport() を実行するとダイアログで年月を入力できる。
//
// 技術料台帳から指定月のデータを抽出し、新規スプレッドシートとしてGoogleドライブに保存。
// 振り分けルール：
//   - 1人担当 ＋ 通常技術料 → その獣医の列
//   - 1人担当 ＋ ワクチン技術料 → ワクチン列（獣医列には入れない）
//   - 複数担当 ＋ 通常技術料 → 複数担当列（獣医列には入れない）
//   - 複数担当 ＋ ワクチン技術料 → ワクチン列
//
// 追加情報：
//   - 合計行の下に歩合率行＋算出金額行（担当者マスタの歩合率で計算）
//   - ワクチン列の合計の下に÷5の値
//   - メイン表の右側にワクチン種類別件数
//
// 保存先：マイドライブ > ガイア動物病院 > 獣医技術料 月次集計
function generateMonthlyGigiReport(year, month) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ---- 1. 担当者マスタから獣医リスト＋歩合率を取得 ----
  const staffData = getStaff(ss);
  if (staffData.length === 0) {
    SpreadsheetApp.getUi().alert("担当者マスタが空です。先にセットアップしてください。");
    return;
  }
  const staffList = staffData.map(s => s.name);
  const staffRates = {};  // 名前 → 歩合率(%)
  staffData.forEach(s => { staffRates[s.name] = s.rate; });

  // ---- 2. 技術料台帳から指定月のデータを抽出 ----
  const ledger = ss.getSheetByName(SHEET_GIGI_LEDGER);
  if (!ledger || ledger.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert("技術料台帳にデータがありません。");
    return;
  }

  const allData = ledger.getRange(2, 1, ledger.getLastRow() - 1, 7).getValues();
  const filtered = allData.filter(row => {
    const d = parseVisitDate(row[1]);
    return d && d.getFullYear() === year && (d.getMonth() + 1) === month;
  });

  if (filtered.length === 0) {
    SpreadsheetApp.getUi().alert(year + "年" + month + "月のデータが技術料台帳にありません。");
    return;
  }

  // ---- 3. ワクチン台帳から指定月のワクチン種類別件数を集計（案3b）----
  // 台帳：A:記録日時 B:会計日 C:伝票番号 D:ワクチン名 E:件数
  const vaccineCounts = {};  // ワクチン名 → 件数合計
  const vLedger = ss.getSheetByName(SHEET_VACCINE_LEDGER);
  if (vLedger && vLedger.getLastRow() >= 2) {
    const vData = vLedger.getRange(2, 1, vLedger.getLastRow() - 1, 5).getValues();
    vData.forEach(row => {
      const d = parseVisitDate(row[1]); // B列：会計日
      if (!d || d.getFullYear() !== year || (d.getMonth() + 1) !== month) return;
      const name = String(row[3] || "").trim();  // D列：ワクチン名
      const count = Number(row[4]) || 0;          // E列：件数
      if (name && count > 0) {
        vaccineCounts[name] = (vaccineCounts[name] || 0) + count;
      }
    });
  }

  // ---- 4. 保存先フォルダを取得（なければ作成） ----
  const newSS = createReportSpreadsheet(year, month);
  const report = newSS.getActiveSheet();
  report.setName("月次集計");

  // ---- 5. ヘッダー行を作成 ----
  const headers = ["伝票番号", "会計日"];
  staffList.forEach(name => headers.push(name));
  headers.push("複数担当");
  headers.push("ワクチン");
  report.appendRow(headers);

  const hRange = report.getRange(1, 1, 1, headers.length);
  hRange.setBackground("#1a5c3a");
  hRange.setFontColor("#ffffff");
  hRange.setFontWeight("bold");
  report.setFrozenRows(1);

  const staffStartCol = 3;
  const multiCol = staffStartCol + staffList.length;
  const vaccineCol = multiCol + 1;

  // ---- 6. データ行を書き込み ----
  let rowNum = 2;

  filtered.forEach(row => {
    const invoiceNo    = row[2] || "";
    const vetName      = String(row[3] || "").trim();
    const normalGigi   = Number(row[4]) || 0;
    const vaccineGigi  = Number(row[5]) || 0;
    const staffCountVal = Number(row[6]) || 1;

    const outRow = new Array(headers.length).fill("");
    outRow[0] = invoiceNo;
    outRow[1] = formatVisitDate(row[1]);

    if (vaccineGigi > 0) {
      outRow[vaccineCol - 1] = vaccineGigi;
    }

    if (normalGigi > 0) {
      if (staffCountVal >= 2) {
        outRow[multiCol - 1] = normalGigi;
      } else {
        const vetIdx = staffList.indexOf(vetName);
        if (vetIdx >= 0) {
          outRow[staffStartCol - 1 + vetIdx] = normalGigi;
        } else {
          outRow[multiCol - 1] = normalGigi;
        }
      }
    }

    report.appendRow(outRow);
    rowNum++;
  });

  // ---- 7. 合計行 ----
  const totalRow = ["合計", ""];
  for (let c = 3; c <= headers.length; c++) {
    const colLetter = columnToLetter(c);
    totalRow.push("=SUM(" + colLetter + "2:" + colLetter + (rowNum - 1) + ")");
  }
  report.appendRow(totalRow);
  const totalRowNum = rowNum;

  const totalRange = report.getRange(totalRowNum, 1, 1, headers.length);
  totalRange.setFontWeight("bold");
  totalRange.setBackground("#e8f5e9");

  // ---- 8. 歩合率行（合計の下） ----
  rowNum++;
  const rateRow = ["", ""];
  for (let i = 0; i < staffList.length; i++) {
    const rate = staffRates[staffList[i]] || 0;
    rateRow.push(rate > 0 ? rate + "%" : "");
  }
  rateRow.push(""); // 複数担当
  rateRow.push("÷5"); // ワクチン
  report.appendRow(rateRow);
  const rateRowNum = rowNum;

  // 歩合率行のスタイル
  const rateRange = report.getRange(rateRowNum, 3, 1, headers.length - 2);
  rateRange.setHorizontalAlignment("center");
  rateRange.setFontWeight("bold");
  rateRange.setBackground("#fff3e0");

  // ---- 9. 算出金額行（歩合率の下） ----
  rowNum++;
  const calcRow = ["", ""];
  for (let i = 0; i < staffList.length; i++) {
    const rate = staffRates[staffList[i]] || 0;
    const colLetter = columnToLetter(staffStartCol + i);
    if (rate > 0) {
      // 合計 × 歩合率%
      calcRow.push("=" + colLetter + totalRowNum + "*" + rate + "/100");
    } else {
      calcRow.push("");
    }
  }
  calcRow.push(""); // 複数担当
  // ワクチン÷5
  const vaccineColLetter = columnToLetter(vaccineCol);
  calcRow.push("=" + vaccineColLetter + totalRowNum + "/5");
  report.appendRow(calcRow);
  const calcRowNum = rowNum;

  // 算出金額行のスタイル
  const calcRange = report.getRange(calcRowNum, 3, 1, headers.length - 2);
  calcRange.setFontWeight("bold");
  calcRange.setBackground("#fff3e0");
  calcRange.setNumberFormat("#,##0");

  // ---- 10. ワクチン種類別件数（メイン表の右側） ----
  const vaccStartCol = headers.length + 2; // 1列空けて右に配置
  report.getRange(1, vaccStartCol).setValue("ワクチン種類");
  report.getRange(1, vaccStartCol + 1).setValue("件数");
  const vaccHeaderRange = report.getRange(1, vaccStartCol, 1, 2);
  vaccHeaderRange.setBackground("#1a5c3a");
  vaccHeaderRange.setFontColor("#ffffff");
  vaccHeaderRange.setFontWeight("bold");

  let vaccRow = 2;
  let totalVaccCount = 0;
  // 表示順を安定させるため、定番の並び順で出力（台帳にある種類だけ）
  const vaccineDisplayOrder = [
    "犬5種ワクチン", "犬10種ワクチン", "猫3種ワクチン", "猫4種ワクチン",
    "犬5種ワクチン（団体割引）", "犬10種ワクチン（団体割引）",
    "猫3種ワクチン（団体割引）", "猫4種ワクチン（団体割引）",
    "狂犬病ワクチン"
  ];
  // 定番リストにない名前が台帳にあれば末尾に追加
  Object.keys(vaccineCounts).forEach(n => {
    if (vaccineDisplayOrder.indexOf(n) === -1) vaccineDisplayOrder.push(n);
  });
  vaccineDisplayOrder.forEach(vn => {
    const cnt = vaccineCounts[vn] || 0;
    if (cnt > 0) {  // 0件のワクチンは省略
      report.getRange(vaccRow, vaccStartCol).setValue(vn);
      report.getRange(vaccRow, vaccStartCol + 1).setValue(cnt);
      totalVaccCount += cnt;
      vaccRow++;
    }
  });
  // 合計行
  report.getRange(vaccRow, vaccStartCol).setValue("合計").setFontWeight("bold");
  report.getRange(vaccRow, vaccStartCol + 1).setValue(totalVaccCount).setFontWeight("bold");
  report.getRange(vaccRow, vaccStartCol, 1, 2).setBackground("#e8f5e9");

  // ワクチン表の列幅
  report.setColumnWidth(vaccStartCol, 200);
  report.setColumnWidth(vaccStartCol + 1, 60);

  // ---- 11. メイン表の列幅・書式 ----
  report.setColumnWidth(1, 90);
  report.setColumnWidth(2, 90);
  for (let c = 3; c <= headers.length; c++) {
    report.setColumnWidth(c, 100);
  }
  if (totalRowNum > 2) {
    report.getRange(2, 3, totalRowNum - 1, headers.length - 2).setNumberFormat("#,##0");
  }

  SpreadsheetApp.getUi().alert(
    "月次集計を新規ファイルとして保存しました。\n" +
    "ファイル名: 技術料月次集計_" + year + "年" + String(month).padStart(2, "0") + "月\n" +
    "保存先: マイドライブ > ガイア動物病院 > 獣医技術料 月次集計\n" +
    "データ行数: " + filtered.length + "行"
  );
}

// ===== 月次集計ファイルをGoogleドライブの指定フォルダに作成 =====
// マイドライブ > ガイア動物病院 > 獣医技術料 月次集計
function createReportSpreadsheet(year, month) {
  const fileName = "技術料月次集計_" + year + "年" + String(month).padStart(2, "0") + "月";

  // フォルダ階層を取得 or 作成
  const root = DriveApp.getRootFolder();
  let gaiaFolder = getOrCreateFolder(root, "ガイア動物病院");
  let reportFolder = getOrCreateFolder(gaiaFolder, "獣医技術料 月次集計");

  // 同名ファイルがあれば削除（再実行対応）
  const existing = reportFolder.getFilesByName(fileName);
  while (existing.hasNext()) {
    existing.next().setTrashed(true);
  }

  // 新規スプレッドシートを作成してフォルダに移動
  const newSS = SpreadsheetApp.create(fileName);
  const file = DriveApp.getFileById(newSS.getId());
  reportFolder.addFile(file);
  // ルートから除去（createだとルートにも残るため）
  DriveApp.getRootFolder().removeFile(file);

  return newSS;
}

// フォルダがなければ作成
function getOrCreateFolder(parent, name) {
  const iter = parent.getFoldersByName(name);
  if (iter.hasNext()) return iter.next();
  return parent.createFolder(name);
}

// ===== ダイアログで年月を入力して月次集計を実行 =====
function promptMonthlyReport() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(
    "月次集計",
    "対象年月を入力してください（例: 2026-06）",
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;

  const input = res.getResponseText().trim();
  const m = input.match(/^(\d{4})-(\d{1,2})$/);
  if (!m) {
    ui.alert("形式が正しくありません。例: 2026-06");
    return;
  }
  generateMonthlyGigiReport(parseInt(m[1], 10), parseInt(m[2], 10));
}

// ===== ユーティリティ =====
// 会計日（文字列 or Date）をDateに変換
function parseVisitDate(val) {
  if (val instanceof Date) return val;
  if (!val) return null;
  const s = String(val).trim();
  // "2026-06-15" 形式
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  // Date文字列のparse
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// 会計日を "6/15" 形式で表示
function formatVisitDate(val) {
  const d = parseVisitDate(val);
  if (!d) return String(val || "");
  return (d.getMonth() + 1) + "/" + d.getDate();
}

// 列番号→アルファベット（1=A, 2=B, ..., 27=AA）
function columnToLetter(col) {
  let letter = "";
  while (col > 0) {
    const mod = (col - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}
