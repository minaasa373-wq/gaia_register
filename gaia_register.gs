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
const SHEET_CARD_LEDGER = "カード決済台帳";      // カード・電子決済分の控え

// ===== 販売記録の列定義 =====
// 列は「名前」で参照する（添字直書きをやめた）。
// これにより、スプレッドシート上で列を入れ替えても・途中に列を挿しても
// コードを直さずに動く。逆に、ヘッダー名を変えると読めなくなるので注意。
// ※ 下の並びは「新規にシートを作るときの順序」。既存シートは実際のヘッダー順に従う。
const REC_COLS = [
  "記録日時", "会計日", "伝票番号", "担当者", "飼い主名", "ペット名",
  "通常技術料", "ワクチン技術料", "確認済み", "カード決済",
  "明細", "技術料明細", "件数", "小計", "消費税", "合計",
  "担当人数", "動物種"
];
// 手動チェック用の列（Googleのチェックボックスを入れる）
const REC_CHECK_COLS = ["確認済み", "カード決済"];
// 幅を広げる列
const WIDE_COLS = ["明細", "技術料明細"];

// 技術料台帳の列（販売記録と同じく名前で参照する）
const GIGI_COLS = ["記録日時", "会計日", "伝票番号", "担当獣医", "通常技術料", "ワクチン技術料", "担当人数"];

// 整合チェックで塗る色
const FIX_COLOR     = "#f8bbd0";  // ピンク：販売記録の値に修正した
const RESTORE_COLOR = "#fff2b2";  // 黄　　：台帳に無かった行を復元した
const ORPHAN_COLOR  = "#dcdcdc";  // グレー：販売記録に対応が無い（自動修正しない）

// ===== 販売記録に付ける印の色 =====
// どちらも「人が判断するための目印」であって、自動で消したり直したりはしない。
// 塗る列を分けてあるので、同じ行に両方付いても潰し合わない。
const FREE_INPUT_COLOR = "#ffe0b2";  // 薄オレンジ：明細セル。自由入力を使った会計
const DUP_COLOR        = "#ffcdd2";  // 薄赤　　　：伝票番号セル。二重送信の疑い

// ===== 二重送信の判定条件 =====
// 飼い主名・ペット名・合計・明細が完全に一致し、かつ記録日時がこの分数以内に
// 並んでいるものを「同じ会計が二度送られた」とみなす。
// 実データ（2,534件）で窓を5分・30分・120分と変えても検出数は38組で動かず、
// 窓を外すと56組に増えた。増えた18組は別日の同一処置＝正当な会計だったので、
// 5分で十分に分離できている。
const DUP_WINDOW_MINUTES = 5;

// カード決済台帳の列
const CARD_LEDGER_COLS = [
  "記録日時", "会計日", "伝票番号", "担当者", "飼い主名", "ペット名",
  "明細", "合計", "通常技術料", "ワクチン技術料", "担当人数", "技術料明細", "精算済", "集計済み"
];
const SHEET_VACCINE_LEDGER = "ワクチン台帳";      // 案3b：ワクチン種類別件数

// 特定の飼い主だけを抜き出す月次明細（メニュー「しっぽの会 明細を出力」）
// 飼い主名にこの文字が含まれる伝票を対象にする。
// 「しっぽの会」「しっぽ」「しっぽの会預かり」のような表記ゆれをまとめて拾うため、
// 完全一致ではなく部分一致で判定する。
const OWNER_REPORT_KEYWORD = "しっぽ";
const OWNER_REPORT_LABEL   = "しっぽの会";

// 未チェック伝票のダイアログに並べる最大件数（超えた分は「ほか◯件」とまとめる）
const UNCHECKED_LIST_MAX = 20;

// 月次集計に用意する「手動配分」の入力行数
// 複数担当の技術料を獣医ごとに割り振って記入する欄。
// 足りなければシート上で行を挿入すればよい（合計のSUM範囲は自動で広がる）。
// 月次集計に用意する「手動配分」ブロックの行数。
// 最終行は自動でワクチン技術料の頭割りが入るので、手入力できるのは
// (MANUAL_ALLOC_ROWS - 1) 行になる。
const MANUAL_ALLOC_ROWS = 6;

// ワクチン技術料を頭割りする人数（獣医の人数）。
// 月次集計の「÷5」表示と、手動配分ブロック最終行の自動転記で使う。
const VACCINE_SPLIT_COUNT = 5;

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
        // cols＋配列形式で返す（転送量を約半分に減らすため）。
        // 旧いクライアントは cols を見ないので、移行中は productsObjects も併送する
        // …ということはせず、クライアント側で cols の有無を見て両対応にしている。
        cols:     PRODUCT_FIELDS,
        products: packProducts(getAllProducts(ss)),
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

  // 列は名前で引く（並べ替え・列追加に強い）
  const cm = buildColMap(sheet, REC_COLS);
  const C = cm.idx;
  const lastRow = sheet.getLastRow();
  const rows = sheet.getRange(2, 1, lastRow - 1, cm.count).getValues();

  // 会計日はyyyy-MM-dd文字列で比較（B列はDate型か文字列の可能性があるため正規化）
  const tz = Session.getScriptTimeZone();
  function normDate(v) {
    if (v instanceof Date) return Utilities.formatDate(v, tz, "yyyy-MM-dd");
    return String(v || "").trim();
  }

  const hits = [];
  for (const r of rows) {
    const visitDate  = normDate(r[C["会計日"]]);
    const staffName  = String(r[C["担当者"]]   || "");
    const ownerName  = String(r[C["飼い主名"]] || "");
    const petName    = String(r[C["ペット名"]] || "");
    const animalType = String(r[C["動物種"]]   || "");

    if (owner  && ownerName.indexOf(owner) === -1) continue;
    if (pet    && petName.indexOf(pet)     === -1) continue;
    if (staff  && staffName.indexOf(staff) === -1) continue;
    if (from   && visitDate < from) continue;
    if (to     && visitDate > to)   continue;
    // 動物種：複数ペット対応でP列は「犬,猫」のようにカンマ区切りになりうるため、
    // 分割していずれかに一致すればヒット扱いにする（単独ペットの既存データも従来通り動く）。
    if (animal) {
      const types = animalType.split(",").map(function(s){ return s.trim(); }).filter(String);
      if (types.indexOf(animal) === -1) continue;
    }

    hits.push({
      recordedAt: normDate(r[C["記録日時"]]),
      visitDate:  visitDate,
      invoiceNo:  String(r[C["伝票番号"]] || ""),
      staff:      staffName,
      owner:      ownerName,
      pet:        petName,
      items:      String(r[C["明細"]] || ""),   // 改行区切りテキスト
      count:      Number(r[C["件数"]]) || 0,
      subtotal:   Number(r[C["小計"]]) || 0,
      tax:        Number(r[C["消費税"]]) || 0,
      total:      Number(r[C["合計"]]) || 0,
      // 明細書「控え」の再印刷で技術料を表示するために返す（給与計算のダブルチェック用）
      // REC_COLS の必須列なので buildColMap で存在は保証されている
      gigiNonVaccine: Number(r[C["通常技術料"]])     || 0,
      gigiVaccine:    Number(r[C["ワクチン技術料"]]) || 0,
      staffCount:     Number(r[C["担当人数"]])       || 1,  // 未記録の古い行は1扱い
      animalType: animalType
    });
  }

  // 新しい順（会計日降順→伝票番号降順）に並べ、上限で切る
  // 伝票番号は書式次第で "000009"（文字列）にも 9（数値）にもなりうる。
  // 文字列のまま比較すると "9" > "100" となり同一日の並びが崩れるため、
  // 数値として比較する（数値にできないものは末尾へ）。
  hits.sort((a, b) => {
    if (a.visitDate !== b.visitDate) return a.visitDate < b.visitDate ? 1 : -1;
    const na = Number(normInvoice(a.invoiceNo));
    const nb = Number(normInvoice(b.invoiceNo));
    const aNum = !isNaN(na), bNum = !isNaN(nb);
    if (aNum && bNum) return nb - na;
    if (aNum) return -1;
    if (bNum) return 1;
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

// 技術料台帳の「担当獣医」に含めない担当者名（歩合の対象外）
// 販売記録の「担当者」列には残すが、技術料の配分対象からは外す。
// フロント側（gaia_register.js の NON_VET_NAMES）と揃えること。
const NON_VET_NAMES = ["看護師"];

// カンマ区切りの担当者名から非獣医を取り除く
// 例）"看護師,南繁" → "南繁"　／　"看護師" → ""
function stripNonVets(staffStr) {
  return String(staffStr || "")
    .split(",")
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s && NON_VET_NAMES.indexOf(s) === -1; })
    .join(",");
}

// 技術料台帳の「担当獣医」に書く名前を決める
// 獣医が1人でもいれば獣医だけを書く（従来通り）。
// 獣医が1人もいない会計（看護師のみ）は空欄になって転記漏れに見えてしまうため、
// 選ばれた担当者名をそのまま残す。
// 例）"南繁" → "南繁" ／ "看護師,南繁" → "南繁" ／ "看護師" → "看護師"
function vetStaffForLedger(vetsStr, staffStr) {
  const vets = String(vetsStr || "").trim();
  if (vets) return vets;
  return String(staffStr || "")
    .split(",")
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s; })
    .join(",");
}

// ===== 列名 → 位置 の対応表を作る =====
// 1行目のヘッダーを読んで { "会計日": 1, ... }（0始まり）を返す。
// required を渡すと、欠けている列があった時点で分かりやすいエラーを投げる。
function buildColMap(sheet, required) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) {
    throw new Error("「" + sheet.getName() + "」シートにヘッダー行がありません。");
  }
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const idx = {};
  header.forEach(function (h, i) {
    const key = String(h || "").trim();
    if (key && !(key in idx)) idx[key] = i;  // 同名が複数あれば左側を優先
  });
  if (required && required.length) {
    const missing = required.filter(function (n) { return !(n in idx); });
    if (missing.length) {
      throw new Error(
        "「" + sheet.getName() + "」シートに次の列が見つかりません：" + missing.join("、") + "\n" +
        "1行目のヘッダー名が正確か確認してください（全角・半角、スペースの有無も一致が必要です）。"
      );
    }
  }
  return { idx: idx, count: lastCol };
}

// ===== チェック判定 =====
// Googleのチェックボックス（真偽値）でも、手打ちの ✅ や 〇 でもONとみなす。
// 「×」「-」「FALSE」「0」や空欄はOFF。
function isChecked(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  const s = String(v).trim().toLowerCase();
  if (!s) return false;
  const off = ["false", "0", "-", "×", "x", "未", "no"];
  if (off.indexOf(s) !== -1) return false;
  const on = ["true", "1", "✅", "✔", "✓", "レ", "○", "〇", "◯", "y", "yes", "済", "v", "*"];
  return on.indexOf(s) !== -1;
}

// ===== 販売記録シートを取得（無ければ作成） =====
function ensureRecordSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_RECORDS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_RECORDS);
    sheet.appendRow(REC_COLS);
    const header = sheet.getRange(1, 1, 1, REC_COLS.length);
    header.setBackground("#1a5c3a");
    header.setFontColor("#ffffff");
    header.setFontWeight("bold");
    sheet.setFrozenRows(1);
    WIDE_COLS.forEach(function (name) {
      const i = REC_COLS.indexOf(name);
      if (i >= 0) sheet.setColumnWidth(i + 1, 400);
    });
  }
  return sheet;
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
    const sheet = ensureRecordSheet(ss);
    const cm = buildColMap(sheet, REC_COLS);
    const C = cm.idx;

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
    // 技術料台帳に書く担当獣医。看護師を除いた獣医のみ（クライアントで除外済み）。
    // 古いクライアントからは vetStaff が来ないので、その場合は担当者から取り除く。
    const vetStaffStr    = vetStaffForLedger(
                             (data.vetStaff !== undefined && data.vetStaff !== null)
                               ? String(data.vetStaff)
                               : stripNonVets(staffStr),
                             staffStr);

    // 販売記録へ1行追加（列は名前で位置を引くので、並べ替えても壊れない）
    const row = new Array(cm.count).fill("");
    row[C["記録日時"]]        = now;
    row[C["会計日"]]          = visitDate;
    row[C["伝票番号"]]        = invoiceNo;          // サーバ採番
    row[C["担当者"]]          = staffStr;           // カンマ区切り
    row[C["飼い主名"]]        = data.ownerName || "";
    row[C["ペット名"]]        = data.petName || "";
    row[C["通常技術料"]]      = gigiNonVaccine;
    row[C["ワクチン技術料"]]  = gigiVaccine;
    row[C["確認済み"]]        = false;              // 手動チェック用（未確認で開始）
    row[C["カード決済"]]      = false;              // 手動チェック用（未チェックで開始）
    row[C["明細"]]            = itemsText;
    row[C["技術料明細"]]      = gigiSnap;
    row[C["件数"]]            = (data.items || []).length;
    row[C["小計"]]            = data.subtotal || 0;
    row[C["消費税"]]          = data.tax || 0;
    row[C["合計"]]            = data.total || 0;
    row[C["担当人数"]]        = staffCount;
    row[C["動物種"]]          = data.animalType || "";
    sheet.appendRow(row);

    // 追加した行の手動チェック列をチェックボックスにする
    const newRow = sheet.getLastRow();
    REC_CHECK_COLS.forEach(function (name) {
      if (name in C) sheet.getRange(newRow, C[name] + 1).insertCheckboxes();
    });

    // 自由入力を使った会計は「明細」セルに色を付ける。
    // 月末の突合で「技術料の追記が要る項目か」を拾うための目印。
    // 列が無い・古いクライアントで hasFreeInput が来ない場合は何もしない。
    if (data.hasFreeInput === true && ("明細" in C)) {
      try {
        sheet.getRange(newRow, C["明細"] + 1).setBackground(FREE_INPUT_COLOR);
      } catch (eColor) {
        // 色は目印にすぎない。ここで失敗しても会計は成立させる。
      }
    }

    // ---- 台帳への書き込み ----
    // 販売記録への追加は既に終わっている。ここで例外を投げてクライアントに
    // 失敗を返すと、スタッフが会計をやり直して同じ内容が別番号で二度記録される。
    // 販売記録さえ残っていれば台帳は「整合チェック」で復元できるので、
    // 台帳の失敗は警告として持ち帰り、会計自体は成功として返す。
    const ledgerErrors = [];
    try {
      writeGigiLedger(ss, now, visitDate, invoiceNo, vetStaffStr, gigiNonVaccine, gigiVaccine, staffCount);
    } catch (e1) {
      ledgerErrors.push("技術料台帳: " + e1.message);
    }
    try {
      writeVaccineLedger(ss, now, visitDate, invoiceNo, data.vaccineCounts);
    } catch (e2) {
      ledgerErrors.push("ワクチン台帳: " + e2.message);
    }

    const res = { result: "success", invoiceNo: invoiceNo };
    if (ledgerErrors.length) {
      // クライアントは記録成功として扱いつつ、この警告をトーストで出す
      res.warning = "台帳への記録に失敗しました（会計は記録済み）。整合チェックで復元してください。／ "
                    + ledgerErrors.join(" / ");
    }
    return jsonResponse(res);

  } catch (err) {
    return jsonResponse({ result: "error", message: err.toString() });
  } finally {
    try { lock.releaseLock(); } catch (eLock) {}
  }
}

// ===== 技術料台帳への書き込み =====
// 7列：記録日時 / 会計日 / 伝票番号 / 担当獣医 / 通常技術料 / ワクチン技術料 / 担当人数
// ・1人担当 → 1行（獣医名単独）
// ・複数担当 → 1行（獣医名カンマ区切り、技術料は合計額のまま。配分は手動）
function writeGigiLedger(ss, now, visitDate, invoiceNo, staffStr, gigiNonVaccine, gigiVaccine, staffCount) {
  let ledger = ss.getSheetByName(SHEET_GIGI_LEDGER);

  // シートがなければ作成
  if (!ledger) {
    ledger = ss.insertSheet(SHEET_GIGI_LEDGER);
    ledger.appendRow(GIGI_COLS);
    const header = ledger.getRange(1, 1, 1, GIGI_COLS.length);
    header.setBackground("#1a5c3a");
    header.setFontColor("#ffffff");
    header.setFontWeight("bold");
    ledger.setFrozenRows(1);
    ledger.setColumnWidth(GIGI_COLS.indexOf("担当獣医") + 1, 120);
  }

  // 常に1行で記録（複数担当でも分割しない）
  // 列は名前で位置を引くので、台帳の列を並べ替えても壊れない
  const lcm = buildColMap(ledger, GIGI_COLS);
  const LC = lcm.idx;
  const row = new Array(lcm.count).fill("");
  row[LC["記録日時"]]       = now;
  row[LC["会計日"]]         = visitDate;
  row[LC["伝票番号"]]       = invoiceNo;
  row[LC["担当獣医"]]       = staffStr;
  row[LC["通常技術料"]]     = gigiNonVaccine;
  row[LC["ワクチン技術料"]] = gigiVaccine;
  row[LC["担当人数"]]       = staffCount;
  ledger.appendRow(row);
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

// マスタ送信時の項目の並び。クライアント側で元のオブジェクトに戻すのに使う。
// ここを変更したら、必ず cols も一緒に送られるので追従は不要。
const PRODUCT_FIELDS = [
  "id", "group", "category", "subcategory", "name", "modalGroup", "dose",
  "unit", "qtyType", "price", "gigi", "staffPick", "favorite", "keywords",
  "memo", "color", "order"
];

// 商品マスタを「列名1回＋値の配列」の形にする。
// 1300件を超えると、項目名の繰り返しだけで全体の4割ほどを占める。
// キーを捨てて配列で送ることで転送量がほぼ半減し、読み込みが安定・高速になる。
// 例）{"id":1,"name":"初診",...} が 1300回 → ["id","name",...] ＋ [1,"初診",...]×1300
function packProducts(products) {
  return products.map(function (p) {
    return PRODUCT_FIELDS.map(function (k) { return p[k]; });
  });
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

  // 販売記録（列定義は REC_COLS を正とする）
  ensureRecordSheet(ss);

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

// ===== スプレッドシートのメニュー =====
// ファイルを開いたときに「ガイア」メニューを追加する。
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("🏥 ガイア")
    .addItem("技術料台帳の整合チェック", "checkGigiLedger")
    .addItem("未チェック伝票の確認", "promptUncheckedRecords")
    .addItem("二重送信チェック", "promptDuplicateCheck")
    .addSeparator()
    .addItem("月次集計を実行", "promptMonthlyReport")
    .addItem(OWNER_REPORT_LABEL + " 明細を出力", "promptOwnerReport")
    .addSeparator()
    .addItem("初期セットアップ", "setupSheets")
    .addToUi();
}

// ===== 伝票番号の正規化 =====
// セルの書式次第で "000101"（文字列）にも 101（数値）にもなりうるため、
// 先頭ゼロを落とした形に揃えてから突き合わせる。
function normInvoice(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  return /^\d+$/.test(s) ? s.replace(/^0+/, "") || "0" : s;
}

// ===== 技術料台帳の整合チェック =====
// 販売記録を正として、技術料台帳の技術料（通常・ワクチン）を照合する。
//   1. 値が違う      → 販売記録の値に修正し、ピンクで塗ってメモに修正前の値を残す
//   2. 台帳に行が無い → 販売記録から復元して追加し、黄色で塗る
//   3. 販売記録に無い → グレーで印を付けるだけ（削除はしない。人が判断する）
//   4. 伝票番号の重複 → 報告のみ（自動修正はしない）
function checkGigiLedger() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const rec = ss.getSheetByName(SHEET_RECORDS);
  if (!rec || rec.getLastRow() < 2) {
    ui.alert("販売記録にデータがありません。");
    return;
  }
  const ledger = ss.getSheetByName(SHEET_GIGI_LEDGER);
  if (!ledger) {
    ui.alert("技術料台帳が見つかりません。");
    return;
  }

  let rcm, lcm;
  try {
    rcm = buildColMap(rec, ["伝票番号", "会計日", "記録日時", "担当者", "通常技術料", "ワクチン技術料", "担当人数"]);
    lcm = buildColMap(ledger, GIGI_COLS);
  } catch (e) {
    ui.alert("列の確認でエラーが発生しました：\n" + e.message);
    return;
  }
  const RC = rcm.idx, LC = lcm.idx;

  // ---- 販売記録を伝票番号で索引化 ----
  const recRows = rec.getRange(2, 1, rec.getLastRow() - 1, rcm.count).getValues();
  const recMap = {};
  const recDup = [];
  recRows.forEach(function (r) {
    const no = normInvoice(r[RC["伝票番号"]]);
    if (!no) return;
    if (recMap[no]) { recDup.push(no); return; }
    recMap[no] = {
      recordedAt: r[RC["記録日時"]],
      visitDate:  r[RC["会計日"]],
      invoiceRaw: r[RC["伝票番号"]],
      staff:      r[RC["担当者"]],
      gigiNon:    Number(r[RC["通常技術料"]])     || 0,
      gigiVac:    Number(r[RC["ワクチン技術料"]]) || 0,
      staffCount: Number(r[RC["担当人数"]])       || 1
    };
  });

  // ---- 技術料台帳を走査して修正計画を立てる ----
  const hasLedgerRows = ledger.getLastRow() >= 2;
  const ledRows = hasLedgerRows
    ? ledger.getRange(2, 1, ledger.getLastRow() - 1, lcm.count).getValues()
    : [];

  const fixes = [];    // {row, col, before, after, label}
  const orphans = [];  // 行番号
  const ledDup = [];
  const seen = {};

  ledRows.forEach(function (r, i) {
    const rowNo = i + 2;
    const no = normInvoice(r[LC["伝票番号"]]);
    if (!no) return;
    if (seen[no]) { ledDup.push(no); return; }
    seen[no] = true;

    const src = recMap[no];
    if (!src) { orphans.push(rowNo); return; }

    const pairs = [
      { name: "通常技術料",     cur: Number(r[LC["通常技術料"]])     || 0, exp: src.gigiNon },
      { name: "ワクチン技術料", cur: Number(r[LC["ワクチン技術料"]]) || 0, exp: src.gigiVac }
    ];
    pairs.forEach(function (p) {
      if (p.cur !== p.exp) {
        fixes.push({ row: rowNo, col: LC[p.name] + 1, before: p.cur, after: p.exp, label: p.name });
      }
    });
  });

  // ---- 台帳に存在しない伝票（＝技術料が丸ごと欠落）----
  const missing = [];
  Object.keys(recMap).forEach(function (no) {
    if (!seen[no]) missing.push(no);
  });
  // 伝票番号順に並べる
  missing.sort(function (a, b) { return Number(a) - Number(b) || (a < b ? -1 : 1); });

  // ---- 何もなければ終了 ----
  if (fixes.length === 0 && missing.length === 0 && orphans.length === 0 &&
      recDup.length === 0 && ledDup.length === 0) {
    ui.alert("整合チェック完了\n\n技術料台帳は販売記録と一致しています。修正はありません。");
    return;
  }

  // ---- 確認ダイアログ ----
  let msg = "次の内容で技術料台帳を修正します。\n\n";
  msg += "・技術料の修正：" + fixes.length + "件\n";
  msg += "・欠落行の復元：" + missing.length + "件\n";
  msg += "・販売記録に無い行：" + orphans.length + "件（印を付けるだけ）\n";
  if (recDup.length) msg += "・販売記録の伝票番号重複：" + recDup.length + "件（修正しません）\n";
  if (ledDup.length) msg += "・技術料台帳の伝票番号重複：" + ledDup.length + "件（修正しません）\n";
  if (fixes.length) {
    msg += "\n【修正内容（先頭10件）】\n";
    fixes.slice(0, 10).forEach(function (f) {
      msg += "  " + f.row + "行目 " + f.label + "：" + f.before + " → " + f.after + "\n";
    });
    if (fixes.length > 10) msg += "  ほか " + (fixes.length - 10) + "件\n";
  }
  msg += "\n実行しますか？";

  if (ui.alert("整合チェック", msg, ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

  // ---- 修正を適用 ----
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm");

  fixes.forEach(function (f) {
    const cell = ledger.getRange(f.row, f.col);
    cell.setValue(f.after);
    cell.setBackground(FIX_COLOR);
    const prev = cell.getNote();
    cell.setNote((prev ? prev + "\n" : "") +
      "修正前: " + f.before + " → " + f.after + "（" + stamp + " 整合チェック）");
  });

  orphans.forEach(function (rowNo) {
    ledger.getRange(rowNo, 1, 1, lcm.count).setBackground(ORPHAN_COLOR);
    const cell = ledger.getRange(rowNo, LC["伝票番号"] + 1);
    const prev = cell.getNote();
    cell.setNote((prev ? prev + "\n" : "") +
      "販売記録に対応する伝票がありません（" + stamp + " 整合チェック）");
  });

  if (missing.length) {
    const rows = missing.map(function (no) {
      const s = recMap[no];
      const out = new Array(lcm.count).fill("");
      out[LC["記録日時"]]       = s.recordedAt;
      out[LC["会計日"]]         = s.visitDate;
      out[LC["伝票番号"]]       = s.invoiceRaw;
      out[LC["担当獣医"]]       = vetStaffForLedger(stripNonVets(s.staff), s.staff);
      out[LC["通常技術料"]]     = s.gigiNon;
      out[LC["ワクチン技術料"]] = s.gigiVac;
      out[LC["担当人数"]]       = s.staffCount;
      return out;
    });
    const start = ledger.getLastRow() + 1;
    const range = ledger.getRange(start, 1, rows.length, lcm.count);
    range.setValues(rows);
    range.setBackground(RESTORE_COLOR);
    ledger.getRange(start, LC["伝票番号"] + 1, rows.length, 1)
      .setNote("販売記録から復元（" + stamp + " 整合チェック）");
  }

  // ---- 結果報告 ----
  let done = "整合チェックが完了しました。\n\n";
  done += "・技術料を修正：" + fixes.length + "件（ピンク）\n";
  done += "・欠落行を復元：" + missing.length + "件（黄色）\n";
  done += "・販売記録に無い行：" + orphans.length + "件（グレー）\n";
  if (recDup.length) done += "\n販売記録で伝票番号が重複：" + recDup.slice(0, 5).join(", ") +
    (recDup.length > 5 ? " ほか" : "") + "\n";
  if (ledDup.length) done += "技術料台帳で伝票番号が重複：" + ledDup.slice(0, 5).join(", ") +
    (ledDup.length > 5 ? " ほか" : "") + "\n";
  if (orphans.length) done += "\nグレーの行は自動削除していません。内容を確認して手動で対応してください。";
  ui.alert(done);
}

// ===== カード決済の伝票番号を集める =====
// 販売記録で「カード決済」にチェックが付いている行の伝票番号を集合で返す。
// 月次集計で技術料を当月から除外するために使う。
function getCardInvoiceNos(ss) {
  const set = {};
  const sheet = ss.getSheetByName(SHEET_RECORDS);
  if (!sheet || sheet.getLastRow() < 2) return set;
  const cm = buildColMap(sheet, null);
  const C = cm.idx;
  if (!("カード決済" in C) || !("伝票番号" in C)) return set;  // 列が未追加なら何もしない
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, cm.count).getValues();
  rows.forEach(function (r) {
    if (!isChecked(r[C["カード決済"]])) return;
    const no = String(r[C["伝票番号"]] || "").trim();
    if (no) set[no] = true;
  });
  return set;
}

// ===== 未チェックの会計を集める =====
// 販売記録のうち、指定月の会計日で「確認済み」にも「カード決済」にも
// チェックが付いていない行を返す。
//   - カード決済✅  → 技術料は台帳へ回し、入金確認後に繰越で加算する（従来通り）
//   - 確認済み✅    → その月の技術料として集計する
//   - どちらも無し  → 会計の確認がまだ終わっていないとみなし、集計から外す
// 戻り値：{ nos: {伝票番号: true}, rows: [{no, date}], count }
function getUncheckedRecords(ss, year, month) {
  const empty = { nos: {}, rows: [], count: 0 };
  const sheet = ss.getSheetByName(SHEET_RECORDS);
  if (!sheet || sheet.getLastRow() < 2) return empty;

  const cm = buildColMap(sheet, null);
  const C = cm.idx;
  // 列が未追加の環境では従来通り（何も除外しない）
  if (!("確認済み" in C) || !("カード決済" in C) ||
      !("伝票番号" in C) || !("会計日" in C)) return empty;

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, cm.count).getValues();
  const nos = {};
  const list = [];
  rows.forEach(function (r) {
    const d = parseVisitDate(r[C["会計日"]]);
    if (!d || d.getFullYear() !== year || (d.getMonth() + 1) !== month) return;
    if (isChecked(r[C["カード決済"]])) return;   // カードは別ルートで処理される
    if (isChecked(r[C["確認済み"]])) return;     // 確認済みなら対象外

    // 照合は正規化した番号で行うが、画面に出すのはシート上の見た目のまま
    // （normInvoice は先頭ゼロを落とすので "0004" が "4" と表示されてしまう）
    const raw = String(r[C["伝票番号"]] || "").trim();
    const key = normInvoice(raw);
    if (!key) return;                            // 伝票番号が無い行は照合できない
    if (nos[key]) return;                        // 同一伝票の複数行は1件として数える
    nos[key] = true;
    list.push({ no: raw, key: key, date: formatVisitDate(d) });
  });
  return { nos: nos, rows: list, count: list.length };
}

// 未チェック件数をダイアログで知らせる（メニューから実行。修正はしない）
function promptUncheckedRecords() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(
    "未チェック伝票の確認",
    "対象年月を入力してください（例: 2026-07）",
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;

  const m = res.getResponseText().trim().match(/^(\d{4})-(\d{1,2})$/);
  if (!m) {
    ui.alert("形式が正しくありません。例: 2026-07");
    return;
  }
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);

  const un = getUncheckedRecords(SpreadsheetApp.getActiveSpreadsheet(), year, month);
  if (un.count === 0) {
    ui.alert("未チェック伝票の確認",
      year + "年" + month + "月の会計は、すべて「確認済み」か「カード決済」に\n" +
      "チェックが入っています。", ui.ButtonSet.OK);
    return;
  }

  const shown = un.rows.slice(0, UNCHECKED_LIST_MAX);
  let msg =
    year + "年" + month + "月の会計のうち、「確認済み」にも「カード決済」にも\n" +
    "チェックが無い伝票が " + un.count + "件 あります。\n\n" +
    "このまま月次集計を実行すると、これらは集計に含まれません。\n\n" +
    shown.map(function (r) { return "  " + r.date + "  伝票 " + r.no; }).join("\n");
  if (un.count > shown.length) {
    msg += "\n  … ほか " + (un.count - shown.length) + "件";
  }
  ui.alert("未チェック伝票の確認", msg, ui.ButtonSet.OK);
}

// ===== カード台帳から「繰越分」を集める =====
// 精算済（振込確認済み）にチェックがあり、まだどの月の給与にも乗せていない行を返す。
// 会計日ではなく「入金が確認できたか」で拾うので、7月の会計でも8月に振り込まれれば
// 8月の給与に乗る。二重計上は「集計済み」列で防ぐ（記入済みの行は拾わない）。
// 戻り値：{ rows: [{sheetRow, invoiceNo, visitDate, vet, gigiNon, gigiVac, staffCount}], count }
function getCardCarryover(ss) {
  const empty = { rows: [], count: 0 };
  const ledger = ss.getSheetByName(SHEET_CARD_LEDGER);
  if (!ledger || ledger.getLastRow() < 2) return empty;

  const lcm = buildColMap(ledger, null);
  const LC = lcm.idx;
  // 「集計済み」列が無い古い台帳では繰越を扱えない（誤集計を避けるため何もしない）
  if (!("精算済" in LC) || !("集計済み" in LC)) return empty;

  const data = ledger.getRange(2, 1, ledger.getLastRow() - 1, lcm.count).getValues();
  const rows = [];
  data.forEach(function (r, i) {
    if (!isChecked(r[LC["精算済"]])) return;                       // 未入金は対象外
    if (String(r[LC["集計済み"]] || "").trim() !== "") return;      // 既に給与へ反映済み
    rows.push({
      sheetRow:   i + 2,                                          // 実際の行番号（ヘッダー分+2）
      invoiceNo:  String(r[LC["伝票番号"]] || "").trim(),
      visitDate:  r[LC["会計日"]],
      // カード台帳の「担当者」は販売記録からのコピーなので看護師を含む。
      // 技術料台帳の「担当獣医」と揃えないと、獣医1名でも名前が一致せず
      // 「複数担当」列へ落ちてしまうため、ここで非獣医を取り除く。
      vet:        vetStaffForLedger(stripNonVets(r[LC["担当者"]]), r[LC["担当者"]]),
      gigiNon:    Number(r[LC["通常技術料"]]) || 0,
      gigiVac:    Number(r[LC["ワクチン技術料"]]) || 0,
      staffCount: Number(r[LC["担当人数"]]) || 1
    });
  });
  return { rows: rows, count: rows.length };
}

// 繰越として給与に乗せた行に、その年月を書き込む（次回以降は拾われなくなる）
function markCardCarryover(ss, carryRows, year, month) {
  if (!carryRows.length) return;
  const ledger = ss.getSheetByName(SHEET_CARD_LEDGER);
  if (!ledger) return;
  const lcm = buildColMap(ledger, null);
  const LC = lcm.idx;
  if (!("集計済み" in LC)) return;

  const tag = year + "-" + ("0" + month).slice(-2);   // 例：2026-08
  carryRows.forEach(function (c) {
    ledger.getRange(c.sheetRow, LC["集計済み"] + 1).setValue(tag);
  });
}

// ===== カード決済台帳への転記 =====
// 指定月のカード決済✅付きレコードを台帳へコピーする。
// 伝票番号で重複チェックするので、月次集計を何度実行しても二重に増えない。
// 戻り値：今回追加した件数
function writeCardLedger(ss, year, month) {
  const rec = ss.getSheetByName(SHEET_RECORDS);
  if (!rec || rec.getLastRow() < 2) return 0;
  const cm = buildColMap(rec, null);
  const C = cm.idx;
  if (!("カード決済" in C)) return 0;
  const rows = rec.getRange(2, 1, rec.getLastRow() - 1, cm.count).getValues();

  // 台帳シート（無ければ作成）
  let ledger = ss.getSheetByName(SHEET_CARD_LEDGER);
  if (!ledger) {
    ledger = ss.insertSheet(SHEET_CARD_LEDGER);
    ledger.appendRow(CARD_LEDGER_COLS);
    const h = ledger.getRange(1, 1, 1, CARD_LEDGER_COLS.length);
    h.setBackground("#1a5c3a").setFontColor("#ffffff").setFontWeight("bold");
    ledger.setFrozenRows(1);
    WIDE_COLS.forEach(function (name) {
      const i = CARD_LEDGER_COLS.indexOf(name);
      if (i >= 0) ledger.setColumnWidth(i + 1, 400);
    });
  }
  const lcm = buildColMap(ledger, null);
  const LC = lcm.idx;

  // 既に転記済みの伝票番号（重複防止）
  const already = {};
  if (ledger.getLastRow() >= 2 && ("伝票番号" in LC)) {
    const ex = ledger.getRange(2, 1, ledger.getLastRow() - 1, lcm.count).getValues();
    ex.forEach(function (r) {
      const no = String(r[LC["伝票番号"]] || "").trim();
      if (no) already[no] = true;
    });
  }

  const toAdd = [];
  rows.forEach(function (r) {
    if (!isChecked(r[C["カード決済"]])) return;
    const d = parseVisitDate(r[C["会計日"]]);
    if (!d || d.getFullYear() !== year || (d.getMonth() + 1) !== month) return;
    const no = String(r[C["伝票番号"]] || "").trim();
    if (!no || already[no]) return;
    already[no] = true;

    const out = new Array(lcm.count).fill("");
    CARD_LEDGER_COLS.forEach(function (name) {
      if (!(name in LC)) return;
      if (name === "精算済") { out[LC[name]] = false; return; }  // 振込確認後に手動チェック
      if (name === "集計済み") { out[LC[name]] = ""; return; }   // 給与に乗せた月を後から記入する
      if (name in C) out[LC[name]] = r[C[name]];
    });
    toAdd.push(out);
  });

  if (toAdd.length) {
    const start = ledger.getLastRow() + 1;
    ledger.getRange(start, 1, toAdd.length, lcm.count).setValues(toAdd);
    if ("精算済" in LC) {
      ledger.getRange(start, LC["精算済"] + 1, toAdd.length, 1).insertCheckboxes();
    }
  }
  return toAdd.length;
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

  // カード・電子決済分は振込後に給与加算するルールのため、当月の技術料からは除外する。
  // （売上は販売記録側に残るので、そちらには影響しない）
  const cardNos = getCardInvoiceNos(ss);

  // 「確認済み」にも「カード決済」にもチェックが無い会計は、確認作業が
  // 終わっていないものとして当月の集計から外す。
  // 販売記録に見つからない伝票（孤立行）はここに入らないため従来通り集計される。
  // そちらは整合チェックのグレー行で検出する。
  const unchecked = getUncheckedRecords(ss, year, month);

  const allData = ledger.getRange(2, 1, ledger.getLastRow() - 1, 7).getValues();
  let cardExcluded = 0;
  let uncheckedExcluded = 0;
  const filtered = allData.filter(row => {
    const d = parseVisitDate(row[1]);
    if (!d || d.getFullYear() !== year || (d.getMonth() + 1) !== month) return false;
    const no = String(row[2] || "").trim();   // C列：伝票番号
    if (no && cardNos[no]) { cardExcluded++; return false; }
    if (no && unchecked.nos[normInvoice(no)]) { uncheckedExcluded++; return false; }
    return true;
  });

  // カード台帳の繰越分（入金確認済みで、まだ給与に乗せていない過去の会計）
  const carry = getCardCarryover(ss);

  if (filtered.length === 0 && carry.count === 0) {
    SpreadsheetApp.getUi().alert(
      year + "年" + month + "月の集計対象データがありません。" +
      (cardExcluded > 0 ? "\n（カード決済として除外：" + cardExcluded + "件）" : "") +
      (uncheckedExcluded > 0 ? "\n（確認済みチェックが無く除外：" + uncheckedExcluded + "件）" : "")
    );
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
  headers.push("担当者");     // 複数担当に入った分だけ、誰の分かを表示する
  headers.push("ワクチン");
  report.appendRow(headers);

  const hRange = report.getRange(1, 1, 1, headers.length);
  hRange.setBackground("#1a5c3a");
  hRange.setFontColor("#ffffff");
  hRange.setFontWeight("bold");
  report.setFrozenRows(1);

  const staffStartCol = 3;
  const multiCol   = staffStartCol + staffList.length;
  const ownerCol   = multiCol + 1;    // 「担当者」列（文字列。集計対象外）
  const vaccineCol = multiCol + 2;

  // ---- 6. データ行を書き込み ----
  let rowNum = 2;

  // 1件分の技術料を、担当獣医の列（複数担当なら「複数担当」列）へ振り分ける。
  // 当月分と繰越分で同じルールを使うため関数化している。
  function fillGigiCells(outRow, vetName, normalGigi, vaccineGigi, staffCountVal) {
    if (vaccineGigi > 0) {
      outRow[vaccineCol - 1] = vaccineGigi;
    }
    if (normalGigi > 0) {
      if (staffCountVal >= 2) {
        outRow[multiCol - 1] = normalGigi;
        outRow[ownerCol - 1] = vetName;     // 誰と誰の分かを手配分の手がかりに
      } else {
        const vetIdx = staffList.indexOf(vetName);
        if (vetIdx >= 0) {
          outRow[staffStartCol - 1 + vetIdx] = normalGigi;
        } else {
          // 担当者マスタに無い名前（退職者など）も複数担当へ寄せる。
          // 名前を出しておかないと、なぜここに入ったのか分からなくなる。
          outRow[multiCol - 1] = normalGigi;
          outRow[ownerCol - 1] = vetName;
        }
      }
    }
  }

  filtered.forEach(row => {
    const invoiceNo    = row[2] || "";
    const vetName      = String(row[3] || "").trim();
    const normalGigi   = Number(row[4]) || 0;
    const vaccineGigi  = Number(row[5]) || 0;
    const staffCountVal = Number(row[6]) || 1;

    const outRow = new Array(headers.length).fill("");
    outRow[0] = invoiceNo;
    outRow[1] = formatVisitDate(row[1]);

    fillGigiCells(outRow, vetName, normalGigi, vaccineGigi, staffCountVal);

    report.appendRow(outRow);
    rowNum++;
  });

  const currentEndRow = rowNum - 1;   // 当月分の最終行

  // ---- 6b. 繰越分（カード決済で入金確認できた過去の会計）----
  // 当月の稼働と混ざらないよう、区切り行を挟んで下にまとめて出す。
  let carryStartRow = 0, carryEndRow = 0;
  if (carry.count > 0) {
    const sepRow = new Array(headers.length).fill("");
    sepRow[0] = "繰越（カード入金分）";
    report.appendRow(sepRow);
    const sepRange = report.getRange(rowNum, 1, 1, headers.length);
    sepRange.setFontWeight("bold");
    sepRange.setBackground("#e3f2fd");
    rowNum++;

    carryStartRow = rowNum;
    carry.rows.forEach(function (c) {
      const outRow = new Array(headers.length).fill("");
      outRow[0] = c.invoiceNo;
      outRow[1] = formatVisitDate(c.visitDate);
      fillGigiCells(outRow, c.vet, c.gigiNon, c.gigiVac, c.staffCount);
      report.appendRow(outRow);
      rowNum++;
    });
    carryEndRow = rowNum - 1;

    // 繰越行は薄い青で塗り、当月分と見分けられるようにする
    report.getRange(carryStartRow, 1, carry.count, headers.length)
      .setBackground("#f3f9ff");
  }

  // ---- 7. 小計・合計行 ----
  // 繰越がある場合は「当月分」「繰越分」を分けて出し、その和を合計とする。
  // どの数字が今月の稼働で、どれが過去分の入金かを一目で分かるようにするため。
  let currentSubRowNum = 0, carrySubRowNum = 0;

  if (carry.count > 0) {
    // 当月分の小計
    const curRow = ["当月分 小計", ""];
    for (let c = 3; c <= headers.length; c++) {
      if (c === ownerCol) { curRow.push(""); continue; }   // 文字列の列は集計しない
      const cl = columnToLetter(c);
      curRow.push(filtered.length ? "=SUM(" + cl + "2:" + cl + currentEndRow + ")" : 0);
    }
    report.appendRow(curRow);
    currentSubRowNum = rowNum;
    report.getRange(rowNum, 1, 1, headers.length).setBackground("#f1f8e9");
    rowNum++;

    // 繰越分の小計
    const carRow = ["繰越分 小計", ""];
    for (let c = 3; c <= headers.length; c++) {
      if (c === ownerCol) { carRow.push(""); continue; }
      const cl = columnToLetter(c);
      carRow.push("=SUM(" + cl + carryStartRow + ":" + cl + carryEndRow + ")");
    }
    report.appendRow(carRow);
    carrySubRowNum = rowNum;
    report.getRange(rowNum, 1, 1, headers.length).setBackground("#e3f2fd");
    rowNum++;
  }

  // ---- 7b. 手動配分の入力行 ----
  // 複数担当の技術料は1行にまとまっているので、獣医ごとの配分は手作業になる。
  // その入力欄をここに用意し、合計へ自動で足し込む。
  // 「複数担当」列の金額は歩合計算に使っていないため、二重計上にはならない。
  const beforeManualRow = rowNum - 1;   // 明細（＋小計）の最終行

  report.appendRow(new Array(headers.length).fill(""));   // 明細と切り離す空行
  rowNum++;

  const manualStartRow = rowNum;
  for (let i = 0; i < MANUAL_ALLOC_ROWS; i++) {
    const mRow = new Array(headers.length).fill("");
    if (i === 0) mRow[0] = "手動配分";
    report.appendRow(mRow);
    rowNum++;
  }
  const manualEndRow = rowNum - 1;      // このブロックの最終行＝ワクチン頭割りの行
  const vaccineSplitRow = manualEndRow;
  const totalRowNumAhead = manualEndRow + 1;   // 直後に合計行が来る

  const manualRange = report.getRange(manualStartRow, 1, MANUAL_ALLOC_ROWS, headers.length);
  manualRange.setBorder(true, true, true, true, true, true);
  // 手入力する行だけを薄い黄色にする（最終行は自動計算なので色を変える）
  report.getRange(manualStartRow, 1, MANUAL_ALLOC_ROWS - 1, headers.length)
        .setBackground("#fffde7");
  report.getRange(manualStartRow, 1, MANUAL_ALLOC_ROWS, 1).setFontWeight("bold");

  // ---- 最終行：ワクチン技術料の頭割りを各獣医へ自動転記 ----
  // 合計行のワクチン列を VACCINE_SPLIT_COUNT で割った額を、獣医の列に入れる。
  // 看護師など非獣医の列は空のまま（歩合の対象外のため）。
  // 参照先は合計行のワクチン列だけなので循環参照にはならない。
  const vacColLetter = columnToLetter(vaccineCol);
  report.getRange(vaccineSplitRow, 1).setValue("ワクチン ÷" + VACCINE_SPLIT_COUNT);
  staffList.forEach(function (name, i) {
    if (NON_VET_NAMES.indexOf(name) !== -1) return;   // 看護師には配らない
    report.getRange(vaccineSplitRow, staffStartCol + i)
          .setValue("=" + vacColLetter + totalRowNumAhead + "/" + VACCINE_SPLIT_COUNT);
  });
  report.getRange(vaccineSplitRow, 1, 1, headers.length).setBackground("#e8f5e9");

  // ---- 7c. 合計行 ----
  const totalRow = ["合計", ""];
  for (let c = 3; c <= headers.length; c++) {
    if (c === ownerCol) { totalRow.push(""); continue; }
    const colLetter = columnToLetter(c);
    const manualSum = "SUM(" + colLetter + manualStartRow + ":" + colLetter + manualEndRow + ")";
    if (carry.count > 0) {
      // 当月小計＋繰越小計＋手動配分（明細を二重に足さないよう小計同士を足す）
      totalRow.push("=" + colLetter + currentSubRowNum + "+" + colLetter + carrySubRowNum + "+" + manualSum);
    } else {
      totalRow.push("=SUM(" + colLetter + "2:" + colLetter + beforeManualRow + ")+" + manualSum);
    }
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
  rateRow.push(""); // 担当者
  rateRow.push("÷" + VACCINE_SPLIT_COUNT); // ワクチン
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
  calcRow.push(""); // 担当者
  // ワクチン÷5
  const vaccineColLetter = columnToLetter(vaccineCol);
  calcRow.push("=" + vaccineColLetter + totalRowNum + "/" + VACCINE_SPLIT_COUNT);
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
    report.setColumnWidth(c, c === ownerCol ? 160 : 100);
  }
  if (totalRowNum > 2) {
    report.getRange(2, 3, totalRowNum - 1, headers.length - 2).setNumberFormat("#,##0");
  }

  // ---- 12. カード決済台帳へ転記（伝票番号で重複チェック済み） ----
  let cardCopied = 0;
  try {
    cardCopied = writeCardLedger(ss, year, month);
  } catch (e) {
    SpreadsheetApp.getUi().alert("カード決済台帳への転記でエラーが発生しました：\n" + e.message);
  }

  // ---- 13. 繰越に使った行へ「集計済み」を記入（次回以降は拾わない）----
  // レポート作成が完全に終わってから記入する。途中で失敗した場合に
  // 「集計済みなのにレポートが無い」状態を作らないため。
  let carryMarked = 0;
  if (carry.count > 0) {
    try {
      markCardCarryover(ss, carry.rows, year, month);
      carryMarked = carry.count;
    } catch (e) {
      SpreadsheetApp.getUi().alert(
        "繰越分の「集計済み」記入でエラーが発生しました：\n" + e.message +
        "\n\n集計表には繰越分が含まれています。カード決済台帳の「集計済み」列に " +
        year + "-" + ("0" + month).slice(-2) + " を手動で記入してください" +
        "（記入しないと来月も同じ分が繰越として計上されます）。"
      );
    }
  }

  SpreadsheetApp.getUi().alert(
    "月次集計を新規ファイルとして保存しました。\n" +
    "ファイル名: 技術料月次集計_" + year + "年" + String(month).padStart(2, "0") + "月\n" +
    "保存先: マイドライブ > ガイア動物病院 > 獣医技術料 月次集計\n" +
    "データ行数: " + filtered.length + "行\n" +
    "\n" +
    "カード決済（当月の技術料から除外）: " + cardExcluded + "件\n" +
    "確認済みチェックが無く除外: " + uncheckedExcluded + "件\n" +
    "カード決済台帳へ新たに転記: " + cardCopied + "件\n" +
    "繰越として今回の給与に加算: " + carryMarked + "件"
  );
}

// ===== 月次集計ファイルをGoogleドライブの指定フォルダに作成 =====
// マイドライブ > ガイア動物病院 > 獣医技術料 月次集計
// ===== 特定の飼い主の明細を月単位で書き出す =====
// 販売記録は1伝票1行で、品目は「技術料明細」列に改行区切りで入っている。
//   例）フェノバール錠30㎎ | qty:90 | 単価:50 | 元単価:50 | 元技:0 | 技:0
// これを1品目1行に展開して、金額を集計する。
function parseGigiSnapshot(text) {
  const out = [];
  String(text || "").split("\n").forEach(function (line) {
    const t = line.trim();
    if (!t) return;
    const parts = t.split("|").map(function (x) { return x.trim(); });
    const name = parts[0];
    if (!name) return;
    // "qty:90" のような key:value を拾う（順序が変わっても壊れないように）
    const kv = {};
    parts.slice(1).forEach(function (seg) {
      const i = seg.indexOf(":");
      if (i > 0) kv[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
    });
    const qty   = Number(kv["qty"]);
    const price = Number(kv["単価"]);
    out.push({
      name:  name,
      qty:   isNaN(qty) ? 0 : qty,
      price: isNaN(price) ? 0 : price,
      gigi:  Number(kv["技"]) || 0,
      amount: (isNaN(qty) ? 0 : qty) * (isNaN(price) ? 0 : price)
    });
  });
  return out;
}

// メニュー：対象年月を聞いて明細ファイルを作る
function promptOwnerReport() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(
    OWNER_REPORT_LABEL + " 明細の出力",
    "対象年月を入力してください（例: 2026-07）",
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;

  const m = res.getResponseText().trim().match(/^(\d{4})-(\d{1,2})$/);
  if (!m) {
    ui.alert("形式が正しくありません。例: 2026-07");
    return;
  }
  generateOwnerReport(parseInt(m[1], 10), parseInt(m[2], 10));
}

function generateOwnerReport(year, month) {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rec = ss.getSheetByName(SHEET_RECORDS);
  if (!rec || rec.getLastRow() < 2) {
    ui.alert("販売記録がありません。");
    return;
  }

  const cm = buildColMap(rec, ["会計日", "伝票番号", "飼い主名", "ペット名", "技術料明細"]);
  const C = cm.idx;
  const rows = rec.getRange(2, 1, rec.getLastRow() - 1, cm.count).getValues();

  // 対象月かつ飼い主名にキーワードを含む伝票を集める
  const slips = [];
  rows.forEach(function (r) {
    const d = parseVisitDate(r[C["会計日"]]);
    if (!d || d.getFullYear() !== year || (d.getMonth() + 1) !== month) return;
    const owner = String(r[C["飼い主名"]] || "").trim();
    if (owner.indexOf(OWNER_REPORT_KEYWORD) === -1) return;

    slips.push({
      date:  formatVisitDate(d),
      no:    String(r[C["伝票番号"]] || "").trim(),
      owner: owner,
      pet:   String(r[C["ペット名"]] || "").trim(),
      staff: "担当者" in C ? String(r[C["担当者"]] || "").trim() : "",
      card:  "カード決済" in C ? isChecked(r[C["カード決済"]]) : false,
      total: "合計" in C ? (Number(r[C["合計"]]) || 0) : 0,
      items: parseGigiSnapshot(r[C["技術料明細"]])
    });
  });

  if (!slips.length) {
    ui.alert(year + "年" + month + "月に " + OWNER_REPORT_LABEL + " の会計はありません。");
    return;
  }

  // 伝票番号順に並べる（数値として比較。数字以外は末尾へ）
  slips.sort(function (a, b) {
    const na = Number(normInvoice(a.no)), nb = Number(normInvoice(b.no));
    if (isNaN(na) && isNaN(nb)) return 0;
    if (isNaN(na)) return 1;
    if (isNaN(nb)) return -1;
    return na - nb;
  });

  const newSS = createOwnerReportSpreadsheet(year, month);
  const sheet = newSS.getActiveSheet();
  sheet.setName(year + "年" + String(month).padStart(2, "0") + "月");

  const headers = ["会計日", "伝票番号", "飼い主名", "ペット名", "担当者",
                   "品名", "数量", "単価", "金額", "カード"];
  sheet.appendRow(headers);
  sheet.getRange(1, 1, 1, headers.length)
       .setFontWeight("bold").setBackground("#1a5c3a").setFontColor("#ffffff");
  sheet.setFrozenRows(1);

  let rowNum = 2;
  let itemCount = 0;
  const out = [];
  slips.forEach(function (s) {
    if (!s.items.length) {
      // 明細が空の伝票も、存在が分かるよう1行だけ残す
      out.push([s.date, s.no, s.owner, s.pet, s.staff, "（明細なし）", "", "", "", s.card ? "✓" : ""]);
      itemCount++;
      return;
    }
    s.items.forEach(function (it, i) {
      out.push([
        i === 0 ? s.date : "",      // 同じ伝票の2行目以降は日付などを省いて見やすくする
        i === 0 ? s.no : "",
        i === 0 ? s.owner : "",
        i === 0 ? s.pet : "",
        i === 0 ? s.staff : "",
        it.name, it.qty, it.price, it.amount,
        (i === 0 && s.card) ? "✓" : ""
      ]);
      itemCount++;
    });
  });
  sheet.getRange(rowNum, 1, out.length, headers.length).setValues(out);
  const lastItemRow = rowNum + out.length - 1;
  rowNum = lastItemRow + 1;

  // ---- 合計 ----
  sheet.appendRow(new Array(headers.length).fill(""));
  rowNum++;
  const sumRow = rowNum;
  const amountCol = headers.indexOf("金額") + 1;
  const cl = columnToLetter(amountCol);
  const totalLine = new Array(headers.length).fill("");
  totalLine[0] = "合計（税抜）";
  totalLine[amountCol - 1] = "=SUM(" + cl + "2:" + cl + lastItemRow + ")";
  sheet.appendRow(totalLine);
  rowNum++;

  // 販売記録の「合計」は税込。突き合わせできるよう並べて出す。
  let cardTotal = 0, cashTotal = 0;
  slips.forEach(function (s) { s.card ? (cardTotal += s.total) : (cashTotal += s.total); });
  const grand = cardTotal + cashTotal;

  [["合計（税込）", grand],
   ["　うちカード決済", cardTotal],
   ["　うち現金など", cashTotal]].forEach(function (pair) {
    const line = new Array(headers.length).fill("");
    line[0] = pair[0];
    line[amountCol - 1] = pair[1];
    sheet.appendRow(line);
    rowNum++;
  });

  sheet.getRange(sumRow, 1, 4, headers.length).setFontWeight("bold");
  sheet.getRange(sumRow, 1, 4, headers.length).setBackground("#e8f5e9");
  sheet.getRange(2, amountCol, rowNum - 2, 1).setNumberFormat("#,##0");
  sheet.getRange(2, headers.indexOf("単価") + 1, rowNum - 2, 1).setNumberFormat("#,##0");

  sheet.setColumnWidth(1, 80);
  sheet.setColumnWidth(2, 80);
  sheet.setColumnWidth(3, 120);
  sheet.setColumnWidth(4, 100);
  sheet.setColumnWidth(5, 100);
  sheet.setColumnWidth(6, 240);

  ui.alert(
    OWNER_REPORT_LABEL + " 明細を出力しました",
    year + "年" + month + "月\n\n" +
    "伝票数: " + slips.length + "件\n" +
    "明細行: " + itemCount + "行\n" +
    "合計（税込）: ¥" + grand.toLocaleString() + "\n" +
    "　うちカード決済: ¥" + cardTotal.toLocaleString() + "\n\n" +
    "マイドライブ > ガイア動物病院 > " + OWNER_REPORT_LABEL + " 明細",
    ui.ButtonSet.OK
  );
}

function createOwnerReportSpreadsheet(year, month) {
  const fileName = OWNER_REPORT_LABEL + "_明細_" + year + "年" + String(month).padStart(2, "0") + "月";
  const root = DriveApp.getRootFolder();
  const gaiaFolder = getOrCreateFolder(root, "ガイア動物病院");
  const folder = getOrCreateFolder(gaiaFolder, OWNER_REPORT_LABEL + " 明細");

  const existing = folder.getFilesByName(fileName);
  while (existing.hasNext()) existing.next().setTrashed(true);

  const newSS = SpreadsheetApp.create(fileName);
  const file = DriveApp.getFileById(newSS.getId());
  folder.addFile(file);
  DriveApp.getRootFolder().removeFile(file);
  return newSS;
}

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
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);

  // 繰越がある場合は事前に知らせる。集計を実行すると「集計済み」が記入され、
  // 次回以降は拾われなくなるので、実行前に件数を確認できるようにしている。
  const carry = getCardCarryover(SpreadsheetApp.getActiveSpreadsheet());
  if (carry.count > 0) {
    let sum = 0;
    carry.rows.forEach(function (c) { sum += c.gigiNon + c.gigiVac; });
    const msg =
      "カード決済台帳に、入金確認済みでまだ給与に反映していない会計が " +
      carry.count + "件（技術料 合計 ¥" + sum.toLocaleString() + "）あります。\n\n" +
      "これらを " + year + "年" + month + "月分の給与に繰越として加算し、\n" +
      "台帳の「集計済み」列に " + year + "-" + ("0" + month).slice(-2) + " を記入します。\n\n" +
      "続行しますか？";
    if (ui.alert("繰越分の確認", msg, ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  }

  generateMonthlyGigiReport(year, month);
}

// ===== 二重送信チェック =====
// 指定した月の販売記録を走査し、同じ会計が二度記録されたと思われる行の
// 「伝票番号」セルを薄赤で塗る。行の削除は一切しない（人が判断する）。
//
// 判定は「飼い主名・ペット名・合計・明細がすべて一致し、記録日時が
// DUP_WINDOW_MINUTES 以内に並んでいる」こと。明細まで一致を要求しているので、
// 同じ患者が同日に別内容で二度会計しても引っかからない。
//
// 疑いのある組は両方の行を塗る。どちらを消すかは2行を見比べないと決められないため。
function promptDuplicateCheck() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(
    "二重送信チェック",
    "対象年月を入力してください（例: 2026-08）",
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;

  const input = res.getResponseText().trim();
  const m = input.match(/^(\d{4})-(\d{1,2})$/);
  if (!m) {
    ui.alert("形式が正しくありません。例: 2026-08");
    return;
  }
  checkDuplicateRecords(parseInt(m[1], 10), parseInt(m[2], 10));
}

function checkDuplicateRecords(year, month) {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const rec = ss.getSheetByName(SHEET_RECORDS);
  if (!rec || rec.getLastRow() < 2) {
    ui.alert("販売記録にデータがありません。");
    return;
  }
  const cm = buildColMap(rec, ["記録日時", "会計日", "伝票番号", "飼い主名", "ペット名", "明細", "合計"]);
  const C = cm.idx;

  const values = rec.getRange(2, 1, rec.getLastRow() - 1, cm.count).getValues();

  // 判定は全件で行う。対象月だけを切り出してから比較すると、月をまたいだ
  // 二重送信を取りこぼすため。
  //   例）同じ晩に2分以内で3連続送信された伝票1353/1354/1355 のうち、
  //       1353 だけ会計日が翌月になっていた（日付ピッカーの入れ間違い）。
  //       月で切ると 1353↔1354 の組が別々の月に分かれて検出できない。
  // シート全体は元々1回で読み込んでいるので、読み取り回数は増えない。
  const all = [];
  let targetCount = 0;
  values.forEach(function (row, i) {
    const vd = parseVisitDate(row[C["会計日"]]);
    if (!vd) return;
    const inMonth = (vd.getFullYear() === year && vd.getMonth() + 1 === month);
    if (inMonth) targetCount++;
    all.push({
      rowNo: i + 2,                                   // シート上の行番号
      inMonth: inMonth,
      visit: vd,
      stamp: row[C["記録日時"]],
      invoice: normInvoice(row[C["伝票番号"]]),
      owner: String(row[C["飼い主名"]] || "").trim(),
      pet: String(row[C["ペット名"]] || "").trim(),
      detail: String(row[C["明細"]] || "").trim(),
      total: Number(row[C["合計"]]) || 0
    });
  });

  if (targetCount === 0) {
    ui.alert(year + "年" + month + "月の記録が見つかりませんでした。");
    return;
  }

  // 飼い主・ペット・合計・明細が同じものをまとめる
  const groups = {};
  all.forEach(function (r) {
    const key = [r.owner, r.pet, r.total, r.detail].join("\u0001");
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });

  const hitRows = {};   // 塗る行番号（重複して塗らないよう連想配列で持つ）
  const pairs = [];     // 報告用

  Object.keys(groups).forEach(function (key) {
    const list = groups[key];
    if (list.length < 2) return;

    // 記録日時の昇順に並べ、隣り合うものだけ比較する
    list.sort(function (a, b) {
      const ta = (a.stamp instanceof Date) ? a.stamp.getTime() : 0;
      const tb = (b.stamp instanceof Date) ? b.stamp.getTime() : 0;
      return ta - tb;
    });

    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur  = list[i];
      if (!(prev.stamp instanceof Date) || !(cur.stamp instanceof Date)) continue;

      const diffMin = Math.abs(cur.stamp.getTime() - prev.stamp.getTime()) / 60000;
      if (diffMin > DUP_WINDOW_MINUTES) continue;

      // どちらか一方でも対象月にあれば取り上げる。
      // 相方が別の月にいても両方塗る（片方だけ赤いと判断できないため）。
      if (!prev.inMonth && !cur.inMonth) continue;

      hitRows[prev.rowNo] = true;
      hitRows[cur.rowNo]  = true;
      pairs.push({
        a: prev.invoice, b: cur.invoice,
        owner: prev.owner, pet: prev.pet,
        total: prev.total, diff: diffMin,
        // 二重送信なのに会計日が違う＝日付の入れ間違いも同時に起きている
        crossMonth: (prev.visit.getMonth() !== cur.visit.getMonth() ||
                     prev.visit.getFullYear() !== cur.visit.getFullYear())
      });
    }
  });

  if (pairs.length === 0) {
    ui.alert(
      "二重送信チェック",
      year + "年" + month + "月：" + targetCount + "件を確認しました。\n" +
      "二重送信の疑いがある会計は見つかりませんでした。",
      ui.ButtonSet.OK
    );
    return;
  }

  // 該当行の伝票番号セルを塗る
  const invCol = C["伝票番号"] + 1;
  Object.keys(hitRows).forEach(function (rowNo) {
    rec.getRange(Number(rowNo), invCol).setBackground(DUP_COLOR);
  });

  // 報告（件数が多いときは先頭だけ出す）
  let msg = year + "年" + month + "月：" + targetCount + "件を確認しました。\n\n" +
            "二重送信の疑い " + pairs.length + "組（" + Object.keys(hitRows).length + "行）を\n" +
            "伝票番号セルの薄赤で塗りました。\n\n";
  const shown = pairs.slice(0, UNCHECKED_LIST_MAX);
  shown.forEach(function (p) {
    msg += "・伝票 " + p.a + " / " + p.b + "　" + p.owner + " " + p.pet +
           "　¥" + p.total.toLocaleString() + "（差 " + p.diff.toFixed(1) + "分）" +
           (p.crossMonth ? " ※会計日が違います" : "") + "\n";
  });
  if (pairs.length > shown.length) {
    msg += "…ほか " + (pairs.length - shown.length) + "組\n";
  }
  msg += "\n内容は自動で消していません。紙の控えと突き合わせて、\n" +
         "不要な行はご自身で削除してください。\n" +
         "削除後は「技術料台帳の整合チェック」を実行してください。";

  ui.alert("二重送信チェック", msg, ui.ButtonSet.OK);
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
