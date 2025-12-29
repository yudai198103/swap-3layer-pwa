/* MXNJPY Swap 3-Layer PWA
   Layers:
     A: Principal (safe rules)
     B: Defense compounding (same rules as A)
     C: Attack (swap 50% pool, leverage 10). No ATR/push add rules. Only Half/AllClose. Add signal when min lot affordable.
*/

const STORAGE_KEY = "mxnjpy_swap_3layer_v1";

const fmtJPY = (n) => {
  if (!isFinite(n)) return "-";
  return Math.round(n).toLocaleString("ja-JP") + "円";
};
const fmtNum = (n, d=2) => (isFinite(n) ? n.toFixed(d) : "-");
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

function parseISODate(s) {
  const m = String(s || "").trim().match(/^(\d{4})[-\/]?(\d{2})[-\/]?(\d{2})$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}
function toISO(dt) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function daysBetween(aISO, bISO) {
  const a = parseISODate(aISO), b = parseISODate(bISO);
  if (!a || !b) return 99999;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function splitSmart(line) {
  const s = String(line).trim();
  if (!s) return [];
  if (s.includes("\t")) return s.split("\t").map(x => x.trim());
  if (s.includes(",")) return s.split(",").map(x => x.trim());
  return s.split(/\s+/).map(x => x.trim());
}

function safeFloat(x) {
  const v = parseFloat(String(x).replace(/,/g,"").trim());
  return isFinite(v) ? v : NaN;
}

function movingMax(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  for (let i=0;i<arr.length;i++) {
    if (i < n-1) continue;
    let mx = -Infinity;
    for (let k=i-n+1;k<=i;k++) mx = Math.max(mx, arr[k]);
    out[i]=mx;
  }
  return out;
}

// Wilder ATR (TR-based), length = n
function atrWilderTR(highs, lows, closes, n=14) {
  const tr = highs.map((h,i)=>{
    if (i===0) return (h-lows[i]);
    const prevC = closes[i-1];
    const a = h-lows[i];
    const b = Math.abs(h - prevC);
    const c = Math.abs(lows[i] - prevC);
    return Math.max(a,b,c);
  });
  const out = new Array(tr.length).fill(NaN);
  if (tr.length < n) return out;
  // first ATR = SMA of first n TR values
  let sum = 0;
  for (let i=0;i<n;i++) sum += tr[i];
  out[n-1] = sum / n;
  for (let i=n;i<tr.length;i++) {
    out[i] = (out[i-1]*(n-1) + tr[i]) / n;
  }
  return out;
}

function pctChange20(closes) {
  // chg20 at i: closes[i]/closes[i-20]-1
  return closes.map((c,i)=> (i>=20 ? (c / closes[i-20] - 1) : NaN));
}

function computeIndicators(bars) {
  const highs = bars.map(b=>b.high);
  const lows  = bars.map(b=>b.low);
  const closes= bars.map(b=>b.close);

  const high20 = movingMax(highs, 20);
  const atr14  = atrWilderTR(highs,lows,closes,14);
  const chg20  = pctChange20(closes);

  const pushRate = bars.map((b,i)=>{
    if (!isFinite(high20[i]) || high20[i] === 0) return NaN;
    return (high20[i] - b.close) / high20[i];
  });

  return { high20, atr14, chg20, pushRate };
}

function defaultState() {
  const today = new Date();
  const iso = toISO(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())));
  return {
    bars: [],
    params: {
      atrAll: 0.30,
      atrHalf: 0.22,
      atrAdd: 0.18,
      pushTh: 0.05,
      shock: 0.20,
      gapDays: 7,
      equityJPY: 500000,
      levAB: 7.2,
      useAB: 0.95,
      minLotC_10k: 1, // 1 = 1万通貨
      goalMonthlyJPY: 100000
    },
    layers: {
      A: { lots10k: 15, lastAddDate: null }, // 15 = 15万通貨
      B: { lots10k: 0,  lastAddDate: null },
      C: { lots10k: 0,  lastAddDate: null, halted: false }
    },
    pools: {
      swapTotalJPY: 0,
      defenseJPY: 0,
      attackJPY: 0,
    },
    logs: []
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const st = JSON.parse(raw);
    // very light validation / migration
    if (!st.params || !st.layers || !st.pools) return defaultState();
    return st;
  } catch {
    return defaultState();
  }
}

function saveState(st) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
  const el = document.getElementById("saveState");
  if (el) { el.textContent = "Saved"; setTimeout(()=> el.textContent="Saved", 300); }
}

function addLog(st, msg) {
  const dt = new Date();
  const stamp = dt.toISOString().slice(0,19).replace("T"," ");
  st.logs.push(`${stamp}  ${msg}`);
  if (st.logs.length > 2000) st.logs = st.logs.slice(-2000);
}

function sortBars(st) {
  st.bars.sort((a,b)=> a.date.localeCompare(b.date));
}

function upsertBar(st, bar) {
  const idx = st.bars.findIndex(x => x.date === bar.date);
  if (idx >= 0) st.bars[idx] = bar;
  else st.bars.push(bar);
  sortBars(st);
}

function lastBar(st) {
  if (!st.bars.length) return null;
  return st.bars[st.bars.length - 1];
}

function getLatestMetrics(st) {
  if (st.bars.length < 21) {
    return { ok:false, msg:"データ不足（最低21営業日相当）", metrics:null };
  }
  const ind = computeIndicators(st.bars);
  const i = st.bars.length - 1;
  const b = st.bars[i];
  const metrics = {
    date: b.date,
    close: b.close,
    atr14: ind.atr14[i],
    chg20: ind.chg20[i],
    pushRate: ind.pushRate[i],
    high20: ind.high20[i],
    swapPer10k: b.swapPer10k
  };
  const ok = isFinite(metrics.atr14) && isFinite(metrics.chg20) && isFinite(metrics.pushRate);
  return { ok, msg: ok ? "OK" : "指標がNaN（データ不足の可能性）", metrics };
}

function maxLotsAB_10k(params, close) {
  // lots in 10k units
  // approximate formula: floor(equity * lev * use / (close*10000))
  const denom = close * 10000;
  if (!isFinite(denom) || denom <= 0) return 0;
  return Math.floor((params.equityJPY * params.levAB * params.useAB) / denom);
}

function calcDailySwapJPY(totalLots10k, swapPer10k) {
  return totalLots10k * swapPer10k;
}

function updateSwapPoolsOnNewDay(st, bar) {
  // When a bar is added, we also want to accrue swap for existing lots based on that day's swapPer10k.
  // To avoid double-counting when updating an existing date, we only accrue when date is NEW (not overwrite).
  // We implement accrual in upsert step: caller will handle whether it was new or update.
}

function decisionEngine(st) {
  const { params, layers } = st;
  const latest = getLatestMetrics(st);
  if (!latest.ok) {
    return {
      status: "DATA_INSUFFICIENT",
      badge: "warn",
      title: "データ不足：判断保留",
      reason: latest.msg,
      flags: { allClose:false, half:false, addAB:false, signalC:false },
      computed: null
    };
  }
  const m = latest.metrics;
  const atr = m.atr14;
  const shockAbs = Math.abs(m.chg20);

  const allClose = (atr > params.atrAll) || (shockAbs >= params.shock);
  const half = (!allClose) && (atr > params.atrHalf);

  // A/B add
  const gapOK_A = !layers.A.lastAddDate || daysBetween(layers.A.lastAddDate, m.date) >= params.gapDays;
  const gapOK_B = !layers.B.lastAddDate || daysBetween(layers.B.lastAddDate, m.date) >= params.gapDays;

  const maxLots = maxLotsAB_10k(params, m.close);
  const lotsNowAB = layers.A.lots10k + layers.B.lots10k;

  const addAB =
    (!allClose) && (!half) &&
    (m.pushRate >= params.pushTh) &&
    (atr <= params.atrAdd) &&
    (gapOK_A && gapOK_B) &&
    (maxLots > lotsNowAB);

  // C signal: no ATR/push. Only "min lot affordable"
  // Attack pool in JPY defines max notional: attackJPY * 10
  const minLot = Math.max(1, Math.floor(params.minLotC_10k));
  const maxLotsC = Math.floor((st.pools.attackJPY * 10) / (m.close * 10000));
  const signalC = (!allClose) && (maxLotsC >= (layers.C.lots10k + minLot));

  let status = "HOLD";
  let badge = "ok";
  let title = "何もしない（最適）";
  let reason = `ATR=${fmtNum(atr,4)} / 20日変動率=${fmtNum(m.chg20*100,2)}% / 押し率=${fmtNum(m.pushRate*100,2)}%`;

  if (allClose) {
    status = "ALL_CLOSE";
    badge = "bad";
    title = "全決済（A/B/C）";
    reason = `トリガー：${atr > params.atrAll ? "ATR>All" : ""}${(atr > params.atrAll && shockAbs >= params.shock) ? " + " : ""}${shockAbs >= params.shock ? "|20日変動率|>=Shock" : ""}  / ATR=${fmtNum(atr,4)}, |chg20|=${fmtNum(shockAbs*100,2)}%`;
  } else if (half) {
    status = "HALF";
    badge = "warn";
    title = "半減（A/B/C）";
    reason = `トリガー：ATR>Half  / ATR=${fmtNum(atr,4)} > ${fmtNum(params.atrHalf,4)}`;
  } else if (addAB) {
    status = "ADD_AB";
    badge = "ok";
    title = "追加（A/B）候補";
    reason = `押し率>=${fmtNum(params.pushTh*100,2)}% かつ ATR<=${fmtNum(params.atrAdd,4)} かつ gap>=${params.gapDays}日 かつ maxLots(${maxLots})>現状(${lotsNowAB})`;
  } else if (signalC) {
    status = "SIGNAL_C";
    badge = "ok";
    title = "攻め（C）追加シグナル：最低ロット到達";
    reason = `攻めプール=${fmtJPY(st.pools.attackJPY)} → C最大Lots=${maxLotsC}（10k単位） / 現状C=${layers.C.lots10k} / 最低追加=${minLot}`;
  }

  return {
    status, badge, title, reason,
    flags: { allClose, half, addAB, signalC },
    computed: { m, maxLots, maxLotsC }
  };
}

function applyAllClose(st, date) {
  const a = st.layers.A.lots10k, b = st.layers.B.lots10k, c = st.layers.C.lots10k;
  st.layers.A.lots10k = 0;
  st.layers.B.lots10k = 0;
  st.layers.C.lots10k = 0;
  st.layers.A.lastAddDate = null;
  st.layers.B.lastAddDate = null;
  st.layers.C.lastAddDate = null;
  addLog(st, `[${date}] ALL_CLOSE: A=${a} B=${b} C=${c} -> 0`);
}

function applyHalf(st, date) {
  const halve = (x) => Math.floor(x / 2);
  const a0 = st.layers.A.lots10k, b0 = st.layers.B.lots10k, c0 = st.layers.C.lots10k;
  st.layers.A.lots10k = halve(st.layers.A.lots10k);
  st.layers.B.lots10k = halve(st.layers.B.lots10k);
  st.layers.C.lots10k = halve(st.layers.C.lots10k);
  addLog(st, `[${date}] HALF: A ${a0}->${st.layers.A.lots10k}, B ${b0}->${st.layers.B.lots10k}, C ${c0}->${st.layers.C.lots10k}`);
}

function applyAddAB(st, date) {
  const latest = getLatestMetrics(st);
  if (!latest.ok) return false;
  const m = latest.metrics;
  const maxLots = maxLotsAB_10k(st.params, m.close);
  const cur = st.layers.A.lots10k + st.layers.B.lots10k;
  if (maxLots <= cur) return false;

  // Add policy: add 1 unit (1=1万通貨) to A and B proportionally:
  // Since B is "swap 50%" compounding, we keep A and B equal growth. Minimal add: 1 each if room, else 1 to A only.
  // You can adjust later.
  let addA = 1, addB = 1;
  if (cur + addA + addB > maxLots) {
    addB = 0;
    if (cur + addA > maxLots) return false;
  }
  st.layers.A.lots10k += addA;
  st.layers.B.lots10k += addB;
  st.layers.A.lastAddDate = date;
  st.layers.B.lastAddDate = date;
  addLog(st, `[${date}] ADD_AB: +A=${addA}, +B=${addB} (maxLots=${maxLots}, before=${cur})`);
  return true;
}

function accrueSwapForDate(st, date) {
  // accrue swap pools based on that day's swap per 10k and current lots held at start of day.
  // simple assumption: use lots from previous state before any actions of the same day.
  const bar = st.bars.find(b => b.date === date);
  if (!bar) return;

  const totalLots10k = st.layers.A.lots10k + st.layers.B.lots10k + st.layers.C.lots10k;
  const daily = calcDailySwapJPY(totalLots10k, bar.swapPer10k);

  // Split into pools 50/50
  const addDefense = daily * 0.5;
  const addAttack  = daily * 0.5;

  st.pools.swapTotalJPY += daily;
  st.pools.defenseJPY += addDefense;
  st.pools.attackJPY  += addAttack;

  addLog(st, `[${date}] SWAP_ACCRUE: total=${Math.round(daily)} / defense+=${Math.round(addDefense)} / attack+=${Math.round(addAttack)} (lots10k=${totalLots10k}, swap/10k=${bar.swapPer10k})`);
}

function render(st) {
  // latest decision
  const dec = decisionEngine(st);
  document.getElementById("todayAction").textContent = dec.title;
  document.getElementById("todayReason").textContent = dec.reason;

  // KPI
  const lb = lastBar(st);
  let dailySwap = NaN, monthlySwap = NaN, statusText = "-";
  if (lb) {
    const totalLots10k = st.layers.A.lots10k + st.layers.B.lots10k + st.layers.C.lots10k;
    dailySwap = calcDailySwapJPY(totalLots10k, lb.swapPer10k);
    monthlySwap = dailySwap * 30;
  }
  document.getElementById("kpiDailySwap").textContent = fmtJPY(dailySwap);
  document.getElementById("kpiMonthlySwap").textContent = fmtJPY(monthlySwap);
  const goal = st.params.goalMonthlyJPY || 100000;
  const goalPct = isFinite(monthlySwap) ? (monthlySwap / goal * 100) : NaN;
  document.getElementById("kpiGoal").textContent = isFinite(goalPct) ? `${goalPct.toFixed(1)}%` : "-";

  const kStatus = document.getElementById("kpiStatus");
  if (dec.badge === "bad") { kStatus.textContent = "停止（全決済）"; kStatus.style.color = "var(--bad)"; }
  else if (dec.badge === "warn") { kStatus.textContent = "注意（半減）"; kStatus.style.color = "var(--warn)"; }
  else { kStatus.textContent = "通常"; kStatus.style.color = "var(--ok)"; }

  // layer rows
  const tbody = document.getElementById("layerRows");
  tbody.innerHTML = "";
  const swapPer10k = lb ? lb.swapPer10k : NaN;

  const layerStatus = (layer) => {
    if (dec.flags.allClose) return { text:"全決済", cls:"bad" };
    if (dec.flags.half) return { text:"半減", cls:"warn" };
    if (layer === "C" && dec.flags.signalC) return { text:"追加シグナル", cls:"ok" };
    if ((layer === "A" || layer === "B") && dec.flags.addAB) return { text:"追加候補", cls:"ok" };
    return { text:"維持", cls:"pill" };
  };

  const row = (name, key) => {
    const lots10k = st.layers[key].lots10k;
    const daily = isFinite(swapPer10k) ? lots10k * swapPer10k : NaN;
    const stt = layerStatus(key);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="left">${name}</td>
      <td>${lots10k}</td>
      <td>${fmtJPY(daily)}</td>
      <td class="left"><span class="pill ${stt.cls}">${stt.text}</span></td>
    `;
    tbody.appendChild(tr);
  };
  row("A 元本", "A");
  row("B 守り複利", "B");
  row("C 攻め", "C");

  // log
  const log = document.getElementById("logArea");
  log.textContent = st.logs.slice(-50).join("\n");

  // data table
  const dbody = document.getElementById("dataRows");
  dbody.innerHTML = "";
  const last60 = st.bars.slice(-60).reverse();
  for (const b of last60) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="left">${b.date}</td>
      <td>${fmtNum(b.open,4)}</td>
      <td>${fmtNum(b.high,4)}</td>
      <td>${fmtNum(b.low,4)}</td>
      <td>${fmtNum(b.close,4)}</td>
      <td>${fmtNum(b.swapPer10k,1)}</td>
    `;
    dbody.appendChild(tr);
  }

  // inputs default date
  if (lb) document.getElementById("inDate").value = lb.date;
}

function bind(st) {
  // input helpers
  const inDate = document.getElementById("inDate");
  const inOpen = document.getElementById("inOpen");
  const inHigh = document.getElementById("inHigh");
  const inLow  = document.getElementById("inLow");
  const inClose= document.getElementById("inClose");
  const inSwap = document.getElementById("inSwap");

  function fillFromBar(b) {
    inDate.value = b.date;
    inOpen.value = b.open;
    inHigh.value = b.high;
    inLow.value  = b.low;
    inClose.value= b.close;
    inSwap.value = b.swapPer10k;
  }

  document.getElementById("btnCopyPrev").addEventListener("click", () => {
    const lb = lastBar(st);
    if (!lb) return;
    fillFromBar(lb);
    addLog(st, `[UI] 前日コピー: ${lb.date}`);
    saveState(st); render(st);
  });

  document.getElementById("btnAddBar").addEventListener("click", () => {
    const dt = parseISODate(inDate.value);
    if (!dt) return alert("日付が不正です（YYYY-MM-DD）");
    const date = toISO(dt);

    const bar = {
      date,
      open: safeFloat(inOpen.value),
      high: safeFloat(inHigh.value),
      low: safeFloat(inLow.value),
      close: safeFloat(inClose.value),
      swapPer10k: safeFloat(inSwap.value)
    };
    if (![bar.open,bar.high,bar.low,bar.close,bar.swapPer10k].every(isFinite)) {
      return alert("数値が不正です（OHLCとスワップを入力）");
    }

    const existed = st.bars.some(b => b.date === date);
    upsertBar(st, bar);
    addLog(st, `[${date}] BAR ${existed ? "UPDATE" : "ADD"}: O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} SW=${bar.swapPer10k}`);

    // accrue swap only if NEW day (not overwrite)
    if (!existed) {
      accrueSwapForDate(st, date);
    } else {
      addLog(st, `[${date}] SWAP_ACCRUE skipped (date overwrite). If needed, adjust pools manually via export/import.`);
    }

    saveState(st); render(st);
  });

  // CSV paste
  const pasteArea = document.getElementById("pasteArea");
  document.getElementById("btnPasteCsv").addEventListener("click", () => pasteArea.classList.remove("hidden"));
  document.getElementById("btnCancelCsv").addEventListener("click", () => pasteArea.classList.add("hidden"));
  document.getElementById("btnImportCsv").addEventListener("click", () => {
    const text = document.getElementById("csvText").value || "";
    const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    if (!lines.length) return;

    let imported = 0;
    for (const line of lines) {
      const parts = splitSmart(line);
      if (parts.length < 6) continue;
      const dt = parseISODate(parts[0]);
      if (!dt) continue;
      const date = toISO(dt);
      const bar = {
        date,
        open: safeFloat(parts[1]),
        high: safeFloat(parts[2]),
        low: safeFloat(parts[3]),
        close: safeFloat(parts[4]),
        swapPer10k: safeFloat(parts[5])
      };
      if (![bar.open,bar.high,bar.low,bar.close,bar.swapPer10k].every(isFinite)) continue;

      const existed = st.bars.some(b => b.date === date);
      upsertBar(st, bar);
      addLog(st, `[${date}] BAR ${existed ? "UPDATE" : "ADD"} (bulk)`);

      if (!existed) accrueSwapForDate(st, date);
      imported++;
    }
    addLog(st, `[UI] CSV import: ${imported} lines processed`);
    pasteArea.classList.add("hidden");
    saveState(st); render(st);
  });

  // params binding
  const p = st.params;
  const map = [
    ["pAtrAll","atrAll"], ["pAtrHalf","atrHalf"], ["pAtrAdd","atrAdd"],
    ["pPushTh","pushTh"], ["pShock","shock"], ["pGap","gapDays"],
    ["pEquity","equityJPY"], ["pLevAB","levAB"], ["pUseAB","useAB"], ["pMinLotC","minLotC_10k"]
  ];
  for (const [id,key] of map) document.getElementById(id).value = p[key];

  document.getElementById("btnSaveParams").addEventListener("click", () => {
    for (const [id,key] of map) {
      const v = safeFloat(document.getElementById(id).value);
      if (!isFinite(v)) return alert(`パラメータ不正: ${key}`);
      st.params[key] = v;
    }
    st.params.gapDays = Math.max(1, Math.floor(st.params.gapDays));
    st.params.minLotC_10k = Math.max(1, Math.floor(st.params.minLotC_10k));
    addLog(st, `[UI] Params saved`);
    saveState(st); render(st);
  });

  // actions
  document.getElementById("btnAllClose").addEventListener("click", () => {
    const lb = lastBar(st);
    const date = lb ? lb.date : "N/A";
    applyAllClose(st, date);
    saveState(st); render(st);
  });

  document.getElementById("btnHalf").addEventListener("click", () => {
    const lb = lastBar(st);
    const date = lb ? lb.date : "N/A";
    applyHalf(st, date);
    saveState(st); render(st);
  });

  document.getElementById("btnAddAB").addEventListener("click", () => {
    const lb = lastBar(st);
    const date = lb ? lb.date : "N/A";
    const dec = decisionEngine(st);
    if (!dec.flags.addAB) {
      return alert("追加条件（A/B）を満たしていません。");
    }
    const ok = applyAddAB(st, date);
    if (!ok) alert("追加できません（maxLots制限等）。");
    saveState(st); render(st);
  });

  document.getElementById("btnAckC").addEventListener("click", () => {
    const lb = lastBar(st);
    const date = lb ? lb.date : "N/A";
    const dec = decisionEngine(st);
    if (!dec.flags.signalC) return alert("C追加シグナルは出ていません。");
    addLog(st, `[${date}] SIGNAL_C acknowledged (manual trade execution outside app).`);
    st.layers.C.lastAddDate = date;
    saveState(st); render(st);
  });

  // export/import/reset
  document.getElementById("btnExport").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(st,null,2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mxnjpy_swap_3layer_export_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById("btnImport").addEventListener("click", () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/json";
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      const txt = await f.text();
      try {
        const obj = JSON.parse(txt);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
        location.reload();
      } catch {
        alert("JSONが不正です");
      }
    };
    inp.click();
  });

  document.getElementById("btnReset").addEventListener("click", () => {
    if (!confirm("全データを初期化します。よろしいですか？")) return;
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });
}

(function main(){
  const st = loadState();
  // if no bars, set date placeholder to today (UTC)
  const today = new Date();
  document.getElementById("inDate").value = toISO(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())));
  bind(st);
  render(st);
})();
