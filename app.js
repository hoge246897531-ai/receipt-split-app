'use strict';

/* ==========================================================
   IndexedDB layer
   ========================================================== */
const DB_NAME = 'receipt-split-db';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('receipts')) {
        const store = db.createObjectStore('receipts', { keyPath: 'id' });
        store.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function dbGetAllReceipts() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('receipts', 'readonly');
    const req = tx.objectStore('receipts').getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt));
    req.onerror = () => reject(req.error);
  });
}

async function dbPutReceipt(receipt) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('receipts', 'readwrite');
    tx.objectStore('receipts').put(receipt);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDeleteReceipt(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('receipts', 'readwrite');
    tx.objectStore('receipts').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetSetting(key, fallback) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readonly');
    const req = tx.objectStore('settings').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
    req.onerror = () => reject(req.error);
  });
}

async function dbSetSetting(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbClearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['receipts', 'settings'], 'readwrite');
    tx.objectStore('receipts').clear();
    tx.objectStore('settings').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ==========================================================
   App state
   ========================================================== */
const state = {
  settings: { nameA: 'A', nameB: 'B', rentAmount: 50000, rentPayer: 'A' },
  receipts: [],
  historyMonth: monthKey(new Date()),
  summaryMonth: monthKey(new Date()),
  pendingImageBlob: null,
};

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKey(d);
}
function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${y}年${m}月`;
}
function formatYen(n) {
  const sign = n < 0 ? '-' : '';
  return sign + '¥' + Math.abs(Math.round(n)).toLocaleString('ja-JP');
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ==========================================================
   Receipt text parsing (best-effort heuristics)
   ========================================================== */
function parseAmount(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const numRe = /[¥￥]?\s?([0-9][0-9,]{2,})\s?円?/;

  const priorityKeywords = ['合計', 'ご請求', 'お会計', '合計金額', 'total', 'TOTAL'];
  const excludeKeywords = ['小計', '内税', '外税', '消費税', 'お預り', 'おつり', 'お釣り', 'カード', 'ポイント'];

  let candidates = [];
  for (const line of lines) {
    const hasPriority = priorityKeywords.some(k => line.includes(k));
    const hasExclude = excludeKeywords.some(k => line.includes(k));
    const m = line.match(numRe);
    if (m) {
      const val = parseInt(m[1].replace(/,/g, ''), 10);
      if (!isNaN(val) && val > 0) {
        candidates.push({ val, priority: hasPriority && !hasExclude });
      }
    }
  }
  const prioritized = candidates.filter(c => c.priority);
  if (prioritized.length) return Math.max(...prioritized.map(c => c.val));
  if (candidates.length) return Math.max(...candidates.map(c => c.val));
  return null;
}

function parseDate(text) {
  // yyyy/mm/dd or yyyy-mm-dd or yyyy年mm月dd日
  const m = text.match(/(20\d{2})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (m) {
    const y = m[1], mo = String(m[2]).padStart(2, '0'), da = String(m[3]).padStart(2, '0');
    return `${y}-${mo}-${da}`;
  }
  return null;
}

/* ==========================================================
   DOM refs
   ========================================================== */
const el = (id) => document.getElementById(id);

const photoInput = el('photo-input');
const previewArea = el('preview-area');
const previewImg = el('preview-img');
const ocrStatus = el('ocr-status');
const receiptForm = el('receipt-form');
const fieldPerson = el('field-person');
const fieldAmount = el('field-amount');
const fieldDate = el('field-date');
const fieldNote = el('field-note');
const fieldRawtext = el('field-rawtext');

/* ==========================================================
   Tabs
   ========================================================== */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    el(btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'tab-history') renderHistory();
    if (btn.dataset.tab === 'tab-summary') renderSummary();
  });
});

/* ==========================================================
   Capture flow
   ========================================================== */
photoInput.addEventListener('change', async () => {
  const file = photoInput.files[0];
  if (!file) return;
  state.pendingImageBlob = file;

  previewArea.hidden = false;
  receiptForm.hidden = true;
  previewImg.src = URL.createObjectURL(file);
  ocrStatus.textContent = 'テキストを読み取り中…（初回は言語データのダウンロードに時間がかかります）';

  try {
    const result = await Tesseract.recognize(file, 'jpn', {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          ocrStatus.textContent = `読み取り中… ${Math.round(m.progress * 100)}%`;
        }
      },
    });
    const text = result.data.text || '';
    ocrStatus.textContent = '読み取り完了。内容を確認してください。';

    const amount = parseAmount(text);
    const date = parseDate(text);

    fieldAmount.value = amount ?? '';
    fieldDate.value = date ?? todayISO();
    fieldNote.value = '';
    fieldRawtext.textContent = text.trim() || '(テキストを検出できませんでした)';
    receiptForm.hidden = false;
  } catch (err) {
    console.error(err);
    ocrStatus.textContent = '自動読み取りに失敗しました。金額を手入力してください。';
    fieldAmount.value = '';
    fieldDate.value = todayISO();
    fieldNote.value = '';
    fieldRawtext.textContent = '(読み取りエラー)';
    receiptForm.hidden = false;
  }
});

el('btn-cancel').addEventListener('click', resetCaptureForm);

function resetCaptureForm() {
  photoInput.value = '';
  previewArea.hidden = true;
  receiptForm.hidden = true;
  state.pendingImageBlob = null;
}

receiptForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const amount = parseFloat(fieldAmount.value);
  if (isNaN(amount) || amount <= 0) {
    alert('金額を正しく入力してください');
    return;
  }
  const receipt = {
    id: uid(),
    person: fieldPerson.value,
    amount,
    date: fieldDate.value || todayISO(),
    note: fieldNote.value.trim(),
    rawText: fieldRawtext.textContent,
    imageBlob: state.pendingImageBlob || null,
    createdAt: Date.now(),
  };
  await dbPutReceipt(receipt);
  state.receipts = await dbGetAllReceipts();
  resetCaptureForm();
  alert('保存しました');
});

/* ==========================================================
   History
   ========================================================== */
el('month-prev').addEventListener('click', () => {
  state.historyMonth = shiftMonth(state.historyMonth, -1);
  renderHistory();
});
el('month-next').addEventListener('click', () => {
  state.historyMonth = shiftMonth(state.historyMonth, 1);
  renderHistory();
});

function renderHistory() {
  el('month-label').textContent = monthLabel(state.historyMonth);
  const list = el('history-list');
  const emptyHint = el('history-empty');
  list.innerHTML = '';

  const items = state.receipts.filter(r => r.date.startsWith(state.historyMonth));
  emptyHint.hidden = items.length > 0;

  for (const r of items) {
    const li = document.createElement('li');
    li.className = 'history-item';

    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    if (r.imageBlob) {
      thumb.src = URL.createObjectURL(r.imageBlob);
    }

    const info = document.createElement('div');
    info.className = 'info';
    const personName = r.person === 'A' ? state.settings.nameA : state.settings.nameB;
    info.innerHTML = `
      <div class="top"><span>${personName}</span><span>${formatYen(r.amount)}</span></div>
      <div class="sub">${r.date}${r.note ? ' ・ ' + escapeHtml(r.note) : ''}</div>
    `;

    const delBtn = document.createElement('button');
    delBtn.className = 'del-btn';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', async () => {
      if (confirm('このレシートを削除しますか？')) {
        await dbDeleteReceipt(r.id);
        state.receipts = await dbGetAllReceipts();
        renderHistory();
      }
    });

    li.appendChild(thumb);
    li.appendChild(info);
    li.appendChild(delBtn);
    list.appendChild(li);
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ==========================================================
   Summary
   ========================================================== */
el('summary-month-prev').addEventListener('click', () => {
  state.summaryMonth = shiftMonth(state.summaryMonth, -1);
  renderSummary();
});
el('summary-month-next').addEventListener('click', () => {
  state.summaryMonth = shiftMonth(state.summaryMonth, 1);
  renderSummary();
});

el('rent-amount').addEventListener('change', async () => {
  const v = parseFloat(el('rent-amount').value) || 0;
  state.settings.rentAmount = v;
  await dbSetSetting('rentAmount', v);
  renderSummary();
});
el('rent-payer').addEventListener('change', async () => {
  state.settings.rentPayer = el('rent-payer').value;
  await dbSetSetting('rentPayer', state.settings.rentPayer);
  renderSummary();
});

function renderSummary() {
  el('summary-month-label').textContent = monthLabel(state.summaryMonth);

  const nameA = state.settings.nameA, nameB = state.settings.nameB;
  const items = state.receipts.filter(r => r.date.startsWith(state.summaryMonth));
  const totalA = items.filter(r => r.person === 'A').reduce((s, r) => s + r.amount, 0);
  const totalB = items.filter(r => r.person === 'B').reduce((s, r) => s + r.amount, 0);
  const total = totalA + totalB;

  el('summary-nameA-label').textContent = nameA + 'の生活費支払額';
  el('summary-nameB-label').textContent = nameB + 'の生活費支払額';
  el('summary-totalA').textContent = formatYen(totalA);
  el('summary-totalB').textContent = formatYen(totalB);
  el('summary-total').textContent = formatYen(total);

  const diffAminusB = totalA - totalB; // positive: A spent more
  const half = diffAminusB / 2;

  let splitExplain;
  if (Math.abs(half) < 0.5) {
    splitExplain = `${nameA}と${nameB}の生活費負担額はほぼ同じです（差額 ${formatYen(0)}）。`;
  } else if (half > 0) {
    splitExplain = `${nameA}の方が生活費を多く払っています。折半するには${nameB}が${nameA}に ${formatYen(half)} 支払う必要があります。`;
  } else {
    splitExplain = `${nameB}の方が生活費を多く払っています。折半するには${nameA}が${nameB}に ${formatYen(-half)} 支払う必要があります。`;
  }
  el('summary-split-explain').textContent = splitExplain;

  // rent settlement
  el('rent-amount').value = state.settings.rentAmount;
  const payerSelect = el('rent-payer');
  payerSelect.innerHTML = `<option value="A">${nameA}</option><option value="B">${nameB}</option>`;
  payerSelect.value = state.settings.rentPayer;

  const payer = state.settings.rentPayer;
  const payee = payer === 'A' ? 'B' : 'A';
  const payerName = payer === 'A' ? nameA : nameB;
  const payeeName = payer === 'A' ? nameB : nameA;
  const payerTotal = payer === 'A' ? totalA : totalB;
  const payeeTotal = payer === 'A' ? totalB : totalA;
  const halfOwedToPayer = (payerTotal - payeeTotal) / 2; // payee owes payer this much for shared costs

  const rent = state.settings.rentAmount;
  const net = rent - halfOwedToPayer; // amount payer should pay payee after adjustment

  let finalText, detailText;
  if (net >= 0) {
    finalText = `${payerName} → ${payeeName} へ ${formatYen(net)} 支払う`;
  } else {
    finalText = `${payeeName} → ${payerName} へ ${formatYen(-net)} 支払う`;
  }
  detailText = `家賃 ${formatYen(rent)} − 生活費調整分 ${formatYen(halfOwedToPayer)} = ${formatYen(net)}`;
  el('summary-final').textContent = finalText;
  el('summary-final-detail').textContent = detailText;
}

/* ==========================================================
   Settings
   ========================================================== */
el('btn-save-names').addEventListener('click', async () => {
  const nameA = el('setting-nameA').value.trim() || 'A';
  const nameB = el('setting-nameB').value.trim() || 'B';
  state.settings.nameA = nameA;
  state.settings.nameB = nameB;
  await dbSetSetting('nameA', nameA);
  await dbSetSetting('nameB', nameB);
  populatePersonSelect();
  alert('保存しました');
});

el('btn-export').addEventListener('click', async () => {
  const data = state.receipts.map(r => ({
    person: r.person, amount: r.amount, date: r.date, note: r.note, rawText: r.rawText,
  }));
  const blob = new Blob([JSON.stringify({ settings: state.settings, receipts: data }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `receipts-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

el('btn-clear-all').addEventListener('click', async () => {
  if (confirm('本当にすべてのデータを削除しますか？この操作は取り消せません。')) {
    await dbClearAll();
    location.reload();
  }
});

function populatePersonSelect() {
  fieldPerson.innerHTML = `<option value="A">${state.settings.nameA}</option><option value="B">${state.settings.nameB}</option>`;
}

/* ==========================================================
   Init
   ========================================================== */
async function init() {
  state.settings.nameA = await dbGetSetting('nameA', 'A');
  state.settings.nameB = await dbGetSetting('nameB', 'B');
  state.settings.rentAmount = await dbGetSetting('rentAmount', 50000);
  state.settings.rentPayer = await dbGetSetting('rentPayer', 'A');

  el('setting-nameA').value = state.settings.nameA;
  el('setting-nameB').value = state.settings.nameB;

  populatePersonSelect();
  fieldDate.value = todayISO();

  state.receipts = await dbGetAllReceipts();
  renderHistory();
  renderSummary();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

init();
