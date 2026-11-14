/**
 * 處置股回測：處置新制（2026-08-10 起，5 個營業日、約每 2 分鐘撮合）上路後，各種買點的勝率／報酬
 * 執行：GitHub Actions 每個交易日 19:40 自動跑（.github/workflows/backtest.yml）；本機可用 node backtest.mjs
 * 注意：資料在收盤後才更新，所以「要看當天收盤才成立」的訊號（收黑、跌破均線）一律以隔天開盤價回測，
 *      公告日收盤因公告在收盤後才出來，只當參考、不列入最佳買點。
 * 輸出：data.js（index.html 讀取；GitHub Pages 發佈成網頁，本機雙擊 index.html 也能看）
 *
 * 資料來源（皆為公開資料）：
 *   證交所 announcement/punish   上市處置公告
 *   櫃買   bulletin/disposal      上櫃處置公告
 *   證交所 STOCK_DAY／櫃買 tradingStock   個股日成交資訊（日 K）
 * 日 K 依「股票×月份」快取在 cache/（已收完的月份不重抓），第一次執行約 15~25 分鐘，之後每天約 2~4 分鐘。
 * 需求：Node.js 18 以上，不需安裝其他套件。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(ROOT, "data.js");
const CACHE_DIR = path.join(ROOT, "cache");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36";

const RULE_START = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]) ? process.argv[2] : "2026-08-10";
const COST = 0.006;            // 手續費買賣 0.1425%×2 + 證交稅 0.3%，取整 0.6%
const HOLDS = [3, 5, 10, 20];
const MIN_N = 15;              // 「最佳買點」至少要有的樣本數

const ENTRIES = [ // [key, 名稱, 說明, 盤後看得到訊號後還來得及做（列入最佳買點）]
  ["A", "公告日收盤", "處置公告當天收盤買。公告在收盤後才出來，只能靠處置股雷達的觸發價盤中預判，不列入最佳", false],
  ["B", "處置D1開盤", "前一晚看到公告，處置第 1 天開盤買", true],
  ["D1", "處置D1收盤", "處置第 1 天收盤買", true],
  ["D2", "處置D2收盤", "處置第 2 天收盤買", true],
  ["D3", "處置D3收盤", "處置第 3 天收盤買", true],
  ["D4", "處置D4收盤", "處置第 4 天收盤買", true],
  ["D5", "處置D5收盤", "處置第 5 天收盤買", true],
  ["X0", "出關首日開盤", "處置結束後第 1 個交易日開盤買", true],
  ["X1", "出關首日收盤", "處置結束後第 1 個交易日收盤買", true],
  ["X3", "出關第3日收盤", "處置結束後第 3 個交易日收盤買", true],
  ["F", "首根收黑→隔日開盤", "處置期間第一次收盤下跌，盤後確認後隔天開盤買", true],
  ["M5", "破5日線→隔日開盤", "處置開始後首次收盤 < 5MA（觀察到出關後 10 天），隔天開盤買", true],
  ["M10", "破10日線→隔日開盤", "處置開始後首次收盤 < 10MA，隔天開盤買", true],
  ["M20", "破月線→隔日開盤", "處置開始後首次收盤 < 20MA，隔天開盤買", true],
  ["L5", "掛低接−5%", "處置期間掛限價買單在『公告日收盤×0.95』，盤中碰到就成交（開盤就更低則以開盤價成交）", true],
  ["L7", "掛低接−7%", "處置期間掛限價買單在『公告日收盤×0.93』，盤中碰到就成交", true],
  ["L10", "掛低接−10%", "處置期間掛限價買單在『公告日收盤×0.90』，盤中碰到就成交", true],
  ["VC", "量縮收斂→隔日開盤", "處置期間某天成交量 < 處置前 5 日均量的一半、振幅比前一天小、而且收紅（收盤 > 前一天），隔天開盤買", true],
  ["S5", "D5收盤放空", "處置第 5 天收盤融券／借券賣出，抱 N 天回補（報酬已換算成做空的賺賠；回檔＝持有期間最大反向漲幅）", true],
];
const KIND = { VC: "open", B: "open", X0: "open", F: "open", M5: "open", M10: "open", M20: "open", L5: "limit", L7: "limit", L10: "limit", S5: "short" }; // 其餘為收盤買
const LIMITS = { L5: 0.05, L7: 0.07, L10: 0.10 };
const GROUPS = [
  ["all", "全部", () => true],
  ["k1", "第一次處置", (e) => e.k === 1],
  ["k2", "第二次處置", (e) => e.k === 2],
  ["hb", "乖離月線>25%", (e) => e.bias20 != null && e.bias20 > 0.25],
  ["lb", "乖離月線≤25%", (e) => e.bias20 != null && e.bias20 <= 0.25],
  ["市", "上市", (e) => e.mkt === "市"],
  ["櫃", "上櫃", (e) => e.mkt === "櫃"],
  ["k1p", "第一次・股價≥100", (e) => e.k === 1 && e.px0 >= 100],
  ["k1pg", "第一次・股價≥100＋開盤≤3%", (e) => e.k === 1 && e.px0 >= 100 && e.gap != null && e.gap <= 0.03],
  ["k1l", "第一次・股價<100", (e) => e.k === 1 && e.px0 < 100],
  ["k2p", "第二次・股價≥100", (e) => e.k === 2 && e.px0 >= 100],
  ["k2l", "第二次・股價<100", (e) => e.k === 2 && e.px0 < 100],
  ["fast", "2分鐘撮合", (e) => e.min != null && e.min <= 5],
  ["slow", "慢撮合≥10分", (e) => e.min != null && e.min >= 10],
  ["mkUp", "大盤在月線上", (e) => e.mk20 === 1],
  ["mkDn", "大盤在月線下", (e) => e.mk20 === 0],
  ["k2mkUp", "第二次・大盤月線上", (e) => e.k === 2 && e.mk20 === 1],
  ["k2mkDn", "第二次・大盤月線下", (e) => e.k === 2 && e.mk20 === 0],
  ["instBuy", "處置前法人買超", (e) => e.inst3 != null && e.inst3 > 0],
  ["instSell", "處置前法人賣超", (e) => e.inst3 != null && e.inst3 < 0],
  ["volDry", "處置期間量縮<5成", (e) => e.volRatio != null && e.volRatio < 0.5],
];
const GROUP_FN = Object.fromEntries(GROUPS.map(([k, , f]) => [k, f]));

/* ---------------- 小工具 ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const num = (s) => {
  const t = String(s ?? "").replace(/<[^>]*>/g, "").replace(/[,\s]/g, "");
  if (t === "" || /^-+$/.test(t) || t === "X") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};
const rocToIso = (s) => {
  const [y, m, d] = String(s).trim().split("/").map(Number);
  return `${y + 1911}-${pad(m)}-${pad(d)}`;
};
const twNow = () => new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000);

/** 下載：先用 Node fetch，失敗時（例如櫃買憑證鏈）Windows 改用系統 curl.exe */
async function download(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json,text/plain,*/*" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    const reason = e.cause?.code || e.cause?.message || e.message;
    const { stdout } = await execFileP(process.platform === "win32" ? "curl.exe" : "curl",
      ["-s", "-S", "-L", "--max-time", "60", "-A", UA, url], { maxBuffer: 64 * 1024 * 1024 });
    if (!stdout || !stdout.trim()) throw new Error(`${reason}；curl 回應空白`);
    return stdout;
  }
}
async function getJSON(url) {
  let last;
  for (let i = 1; i <= 4; i++) {
    try {
      const t = await download(url);
      return JSON.parse(t);
    } catch (e) { last = e; await sleep(4000 * i); }
  }
  throw new Error(`下載失敗 ${url}：${last?.message}`);
}

/* ---------------- 處置公告 ---------------- */
async function fetchDisposals(from, to) {
  const out = [];
  const ymd = (s) => s.replace(/-/g, "");
  const slash = (s) => s.replace(/-/g, "/");
  try {
    const j = await getJSON(`https://www.twse.com.tw/rwd/zh/announcement/punish?startDate=${ymd(from)}&endDate=${ymd(to)}&queryType=3&response=json`);
    for (const r of j.data || []) {
      const rng = String(r[6]).split(/[～~]/);
      if (rng.length !== 2) continue;
      out.push({ mkt: "市", code: String(r[2]).trim(), name: String(r[3]).trim(), pub: rocToIso(r[1]), start: rocToIso(rng[0]), end: rocToIso(rng[1]), kind: String(r[7]).trim(), min: minOf(r[8]) });
    }
  } catch (e) { console.log(`❌ 上市處置公告：${e.message}`); }
  try {
    const j = await getJSON(`https://www.tpex.org.tw/www/zh-tw/bulletin/disposal?startDate=${slash(from)}&endDate=${slash(to)}&response=json`);
    for (const r of (j.tables?.[0]?.data) || []) {
      const rng = String(r[5]).split(/[～~]/);
      if (rng.length !== 2) continue;
      out.push({ mkt: "櫃", code: String(r[2]).trim(), name: String(r[3]).replace(/\(.*$/, "").trim(), pub: rocToIso(r[1]), start: rocToIso(rng[0]), end: rocToIso(rng[1]), kind: String(r[7]).trim(), min: minOf(r[8]) });
    }
  } catch (e) { console.log(`❌ 上櫃處置公告：${e.message}`); }
  return out;
}
// 撮合間隔（分鐘）：證交所寫國字「約每二十五分鐘」、櫃買寫數字「約每25分鐘」
function minOf(text) {
  const m = String(text || "").match(/約每\s*([0-9一二三四五六七八九十]+)\s*分鐘/);
  if (!m) return null;
  if (/^\d+$/.test(m[1])) return +m[1];
  const d = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const t = m[1];
  if (t === "十") return 10;
  if (t.includes("十")) { const [a, b] = t.split("十"); return (a ? d[a] : 1) * 10 + (b ? d[b] : 0); }
  return d[t] ?? null;
}
const kindOf = (k) => (/人工/.test(k) ? null : /第一次/.test(k) ? 1 : /第二次|再次/.test(k) ? 2 : null);

/* ---------------- 日 K（快取） ---------------- */
async function fetchMonth(mkt, code, y, m) {
  let rows;
  if (mkt === "市") {
    const j = await getJSON(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${y}${pad(m)}01&stockNo=${code}&response=json`);
    rows = j.data || [];
    await sleep(2000); // 證交所限流：太快會被暫時封鎖
  } else {
    const j = await getJSON(`https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${y}/${pad(m)}/01&response=json`);
    rows = j.tables?.[0]?.data || [];
    await sleep(1200);
  }
  // 日期, 成交量（上市＝股、上櫃＝張）, 成交金額, 開, 高, 低, 收, 漲跌, 筆數 → 統一存成「張」
  return rows.map((r) => [rocToIso(r[0]), num(r[3]), num(r[4]), num(r[5]), num(r[6]), mkt === "市" ? Math.round((num(r[1]) || 0) / 1000) : num(r[1])]);
}

async function getBars(mkt, code, fromIso, today) {
  const file = path.join(CACHE_DIR, `${mkt === "市" ? "twse" : "tpex"}_${code}.json`);
  let c = { months: {} };
  try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 新檔 */ }
  let changed = false;
  let y = +fromIso.slice(0, 4), m = +fromIso.slice(5, 7);
  const ty = today.getFullYear(), tm = today.getMonth() + 1;
  while (y < ty || (y === ty && m <= tm)) {
    const key = `${y}-${pad(m)}`;
    const mo = c.months[key];
    if (!mo?.complete || (mo.rows.length && mo.rows[0].length < 6)) { // 舊快取沒有成交量 → 重抓一次
      try {
        const rows = await fetchMonth(mkt, code, y, m);
        c.months[key] = { complete: y < ty || m < tm, rows };
        changed = true;
      } catch (e) { console.log(`   ⚠ ${code} ${key} 日K：${e.message}`); }
    }
    if (++m === 13) { y++; m = 1; }
  }
  if (changed) { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(c)); }
  const map = new Map();
  for (const v of Object.values(c.months)) for (const r of v.rows) map.set(r[0], r);
  const bars = [];
  for (const d of [...map.keys()].sort()) {
    let [, o, h, l, cl, v] = map.get(d);
    if (cl == null) { if (!bars.length) continue; cl = bars[bars.length - 1].c; o = h = l = cl; v = 0; } // 無成交沿用前收
    bars.push({ d, o: o ?? cl, h: h ?? cl, l: l ?? cl, c: cl, v: v ?? null });
  }
  return bars;
}

/* ---------------- 回測 ---------------- */
const sma = (C, n, i) => (i < n - 1 ? null : C.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);

function analyse(ev, bars, ctx = {}) {
  const D = bars.map((b) => b.d), C = bars.map((b) => b.c);
  const s = D.findIndex((d) => d >= ev.start);
  if (s < 21) return null;
  let e = -1;
  D.forEach((d, i) => { if (d <= ev.end) e = i; });
  if (e < s) return null;
  const firstBelow = (n) => { for (let i = s; i <= Math.min(e + 10, bars.length - 1); i++) { const m = sma(C, n, i); if (m != null && C[i] < m) return i; } return null; };
  const firstDown = () => { for (let i = s; i <= e; i++) if (C[i] < C[i - 1]) return i; return null; };
  const nx = (i) => (i == null ? null : i + 1); // 收盤才確認的訊號 → 隔天開盤買
  const ent = { A: [s - 1, 0], B: [s, 1] };
  const P0 = C[s - 1];
  for (const [k, x] of Object.entries(LIMITS)) { // 掛低接：盤中碰到就成交
    const P = P0 * (1 - x);
    for (let i = s; i <= e; i++) if (bars[i].l <= P) { ent[k] = [i, 1, Math.min(P, bars[i].o)]; break; }
  }
  if (s + 4 <= e) ent.S5 = [s + 4, 0, null, -1];
  // 量縮收斂往上：成交量 < 處置前 5 日均量一半、振幅縮小、收紅
  const preV = bars.slice(Math.max(0, s - 5), s).map((b) => b.v).filter((v) => v != null);
  const preAvg = preV.length ? preV.reduce((a, b) => a + b, 0) / preV.length : null;
  const rngOf = (j) => (bars[j].h - bars[j].l) / bars[j - 1].c;
  const vcAt = (j) => preAvg > 0 && bars[j].v != null && bars[j].v < preAvg * 0.5 && rngOf(j) < rngOf(j - 1) && C[j] > C[j - 1];
  let vc = null;
  for (let j = s + 1; j <= Math.min(e, bars.length - 1); j++) if (vcAt(j)) { vc = j; break; }
  ent.VC = [nx(vc), 1];
  for (let k = 1; k <= 5; k++) if (s + k - 1 <= e) ent[`D${k}`] = [s + k - 1, 0];
  Object.assign(ent, { X0: [e + 1, 1], X1: [e + 1, 0], X3: [e + 3, 0], F: [nx(firstDown()), 1], M5: [nx(firstBelow(5)), 1], M10: [nx(firstBelow(10)), 1], M20: [nx(firstBelow(20)), 1] });
  const r = {};
  for (const [k, [idx, open, pxo, dir = 1]] of Object.entries(ent)) {
    if (idx == null || idx < 0 || idx >= bars.length) continue;
    const px = pxo || (open ? bars[idx].o : bars[idx].c);
    if (!px) continue;
    const o = { d: D[idx] };
    for (const H of HOLDS) {
      const x = open ? idx + H - 1 : idx + H;
      if (x >= bars.length) continue;
      const seg = bars.slice(open ? idx : idx + 1, x + 1);
      o[H] = dir > 0
        ? [r4(C[x] / px - 1), r4(Math.min(...seg.map((b) => b.l)) / px - 1)]
        : [r4(1 - C[x] / px), r4(1 - Math.max(...seg.map((b) => b.h)) / px)];
    }
    r[k] = o;
  }
  // 明天可以執行的買點（資料是收盤後更新，所以只列「明天」來得及做的）
  const i = bars.length - 1, next = [];
  const eEnd = D[i] < ev.end ? Infinity : e; // 處置還沒結束（迄日在資料之後）
  if (i < s - 1) { /* 尚未公告到處置 */ }
  else if (i === s - 1) next.push("B", "D1");                 // 今天公告，明天處置第 1 天
  else if (i < eEnd) { if (i - s + 2 <= 5) next.push(`D${i - s + 2}`); }             // 處置中，明天第 k+1 天收盤
  else if (i === eEnd) next.push("X0", "X1");                  // 今天處置最後一天，明天出關
  if (i === e + 2) next.push("X3");
  if (i === s + 3 && eEnd >= s + 4) next.push("S5");                   // 明天處置第 5 天收盤空
  if (i >= s - 1 && i < eEnd) {                                         // 處置期間（含明天開始）還可以掛低接
    for (const [k, x] of Object.entries(LIMITS)) {
      let filled = false;
      for (let j = s; j <= i; j++) if (bars[j].l <= P0 * (1 - x)) filled = true;
      if (!filled) next.push(k);
    }
  }
  if (firstDown() === i) next.push("F");
  if (vc === i) next.push("VC");
  if (s <= i && i <= e + 10) for (const n of [5, 10, 20]) if (firstBelow(n) === i) next.push(`M${n}`);
  const m20 = sma(C, 20, s - 1);
  const dispV = bars.slice(s, Math.min(e, i) + 1).map((b) => b.v).filter((v) => v != null);
  const volRatio = preAvg > 0 && dispV.length ? r4(dispV.reduce((a, b) => a + b, 0) / dispV.length / preAvg) : null;
  const mk = ctx.market && ctx.market[D[s - 1]];
  const inst3 = ctx.inst ? ctx.inst(ev.mkt, ev.code, [D[s - 3], D[s - 2], D[s - 1]]) : null;
  return {
    code: ev.code, name: ev.name, mkt: ev.mkt, k: ev.k, pub: ev.pub, start: ev.start, end: ev.end, min: ev.min ?? null,
    bias20: m20 ? r4(C[s - 1] / m20 - 1) : null,
    px0: P0, gap: bars[s] ? r4(bars[s].o / P0 - 1) : null,
    volRatio, mk20: mk ? mk.above : null, inst3, preVol: preAvg ? Math.round(preAvg) : null,
    status: i < s ? "pre" : i <= eEnd ? `d${i - s + 1}` : i <= e + 10 ? "post" : "done",
    close: C[i], next, r,
    // 逐日：[漲跌幅, 開收差, 振幅]，順序＝處前2、處前1、處置1~5、出關1~3（沒有的為 null）
    days: [s - 2, s - 1, s, s + 1, s + 2, s + 3, s + 4, e + 1, e + 2, e + 3].map((j, n) => {
      if (j < 1 || j >= bars.length || (n >= 2 && n <= 6 && j > e)) return null;
      const b = bars[j], p = bars[j - 1].c;
      return [r4(b.c / p - 1), r4(b.c / b.o - 1), r4((b.h - b.l) / p)];
    }),
  };
}

function aggregate(events) {
  const stats = {};
  for (const [g, , f] of GROUPS) {
    const evs = events.filter(f);
    stats[g] = {};
    for (const [k] of ENTRIES) {
      stats[g][k] = {};
      for (const H of HOLDS) {
        const rs = evs.map((e) => e.r[k]?.[H]).filter(Boolean);
        if (!rs.length) continue;
        const net = rs.map((x) => x[0] - COST).sort((a, b) => a - b);
        const mid = net.length >> 1;
        stats[g][k][H] = {
          n: net.length,
          win: r4(net.filter((x) => x > 0).length / net.length),
          mean: r4(net.reduce((a, b) => a + b, 0) / net.length),
          median: r4(net.length % 2 ? net[mid] : (net[mid - 1] + net[mid]) / 2),
          dd: r4(rs.reduce((a, x) => a + x[1], 0) / rs.length),
          dd30: r4(rs.map((x) => x[1]).sort((a, b) => a - b)[Math.floor(rs.length * 0.3)]), // 3 成案例比這更差（停損參考）
        };
      }
    }
  }
  return stats;
}
function bestOf(stats, H) {
  const best = {};
  for (const [g] of GROUPS) {
    let b = null;
    for (const [k, v] of Object.entries(stats[g])) {
      if (!ENTRIES.find((x) => x[0] === k)?.[3] || KIND[k] === "short") continue; // 來不及做的、做空的不列入最佳買點
      const s = v[H];
      if (!s || s.n < MIN_N) continue;
      if (!b || s.win > b.win || (s.win === b.win && s.median > b.median)) b = { entry: k, ...s };
    }
    if (b) best[g] = b;
  }
  return best;
}


/* ---------------- 公告日預判（自己抓注意股資料，算「明天再 1 次即處置」） ---------------- */
// 規則：證交所／櫃買「公布或通知注意交易資訊暨處置作業要點」第 6 條（邏輯與台股盤後戰情室「處置股雷達」相同）
const KUAN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14 };
function parseKuan(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/第([一二三四五六七八九十]+)款/g)) if (KUAN_NUM[m[1]]) out.add(KUAN_NUM[m[1]]);
  return [...out].sort((a, b) => a - b);
}
const rocAny = (s) => { const m = String(s ?? "").trim().match(/^(\d{2,3})[./](\d{1,2})[./](\d{1,2})$/); return m ? `${+m[1] + 1911}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };
function tick(p) { return p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5; }
const round2 = (v) => Math.round(v * 100) / 100;
function limitUpPrice(prev) { const raw = prev * 1.1; let t = tick(raw); let lim = Math.floor(raw / t + 1e-9) * t; if (tick(lim) !== t) { t = tick(lim); lim = Math.floor(raw / t + 1e-9) * t; } return round2(lim); }
function limitDownPrice(prev) { const raw = prev * 0.9; let t = tick(raw); let lim = Math.ceil(raw / t - 1e-9) * t; if (tick(lim) !== t) { t = tick(lim); lim = Math.ceil(raw / t - 1e-9) * t; } return round2(lim); }
const trunc2 = (v) => (v >= 0 ? Math.floor(v * 100 + 1e-7) : -Math.floor(-v * 100 + 1e-7)) / 100;

/** 注意次數累計（只計「最近一次處置生效日之後」的注意）；days＝交易日（舊→新，最後一天＝今天） */
function dispositionWatch(notices, disposals, days) {
  const today = days[days.length - 1];
  const idx = new Set(days);
  const by = new Map();
  for (const n of notices) {
    if (!idx.has(n.date)) continue;
    const m = by.get(n.code) || new Map();
    const k = m.get(n.date) || new Set();
    n.kuan.forEach((x) => k.add(x));
    m.set(n.date, k); by.set(n.code, m);
  }
  const lastDisp = new Map();
  for (const d of disposals) if (d.pub <= today && (!lastDisp.get(d.code) || d.pub > lastDisp.get(d.code).pub)) lastDisp.set(d.code, d);
  const out = {};
  const T = days.length - 1;
  const k1 = (x) => x === 1, k18 = (x) => x >= 1 && x <= 8;
  for (const [code, m] of by) {
    const ld = lastDisp.get(code);
    const reset = ld ? ld.start || ld.pub : "";
    const inDisp = !!(ld && ld.start && ld.end && ld.start <= today && today <= ld.end);
    const counted = (d) => !!d && (!reset || d >= reset);
    const has = (i, f) => { const d = days[i]; if (!counted(d)) return false; const k = m.get(d); return !!k && [...k].some(f); };
    const consec = (f) => { let c = 0; for (let i = T; i >= 0 && has(i, f); i--) c++; return c; };
    const count = (f, w) => { let c = 0; for (let i = T; i > T - w && i >= 0; i--) if (has(i, f)) c++; return c; };
    const c1 = consec(k1), c18 = consec(k18), n9 = count(k18, 9), n29 = count(k18, 29);
    const rules = [
      { label: "連續3日第一款", need: 3 - c1, c1: true },
      { label: "連續5日", need: 5 - c18 },
      { label: "10日內6日", need: 6 - n9 },
      { label: "30日內12日", need: 12 - n29 },
    ];
    const needs = Math.max(1, Math.min(...rules.map((r) => r.need)));
    if (needs !== 1) continue;
    const near = rules.filter((r) => r.need <= 1);
    const todayK = m.get(today) && counted(today) ? [...m.get(today)].sort((a, b) => a - b) : [];
    out[code] = { near: near.map((r) => r.label), onlyC1: near.every((r) => r.c1), todayK, inDisp };
  }
  return out;
}

/** 明日第一款觸發價（估）：6 日累積＝各日漲跌幅（截至小數 2 位）加總；另有「價差」條件 */
function kuan1Trigger(mkt, c) { // c＝最近 6 個交易日收盤（舊→新）
  if (!c || c.length < 6 || c.some((x) => !x)) return null;
  const last = c[5];
  if (last < 5) return { ex: "收盤價未滿5元，不適用第一款" };
  let S5 = 0;
  for (let i = 1; i <= 5; i++) S5 += trunc2(((c[i] - c[i - 1]) / c[i - 1]) * 100);
  const base = c[1];
  const [hi, lo, gap] = mkt === "櫃" ? [30, 23, 40] : [32, 25, 50];
  const ok = (p) => { const s = S5 + trunc2(((p - last) / last) * 100); return Math.abs(s) > hi || (Math.abs(s) >= lo && Math.abs(p - base) >= gap); };
  const up = limitUpPrice(last), dn = limitDownPrice(last);
  const pct = (p) => (p == null ? null : round2(((p - last) / last) * 100));
  const always = ok(last);
  let upPx = null, dnPx = null;
  for (let p = round2(last + tick(last)); p <= up + 1e-9; p = round2(p + tick(p))) if (ok(p) !== always) { upPx = p; break; }
  for (let p = round2(last - tick(last - 1e-9)); p >= dn - 1e-9; p = round2(p - tick(p - 1e-9))) if (ok(p) !== always) { dnPx = p; break; }
  return { s5: round2(S5), always: always ? 1 : 0, upPx, upPct: pct(upPx), dnPx, dnPct: pct(dnPx), lim: [up, dn] };
}

async function fetchNotices(from, to) {
  const out = [];
  const ymd = (s) => s.replace(/-/g, ""), slash = (s) => s.replace(/-/g, "/");
  const isStock = (c) => /^[1-9]\d{3}$/.test(c);
  let ok = 0;
  try {
    const j = await getJSON(`https://www.twse.com.tw/rwd/zh/announcement/notice?querytype=1&stockNo=&selectType=&startDate=${ymd(from)}&endDate=${ymd(to)}&sortKind=STKNO&response=json`);
    for (const r of j.data || []) if (isStock(String(r[1]).trim())) out.push({ code: String(r[1]).trim(), name: String(r[2]).trim(), mkt: "市", date: rocAny(r[5]), kuan: parseKuan(r[4]) });
    ok++;
  } catch (e) { console.log(`   ⚠ 上市注意股：${e.message}`); }
  await sleep(2500);
  try {
    const j = await getJSON(`https://www.tpex.org.tw/www/zh-tw/bulletin/attention?startDate=${slash(from)}&endDate=${slash(to)}&response=json`);
    for (const r of (j.tables?.[0]?.data) || []) if (isStock(String(r[1]).trim())) out.push({ code: String(r[1]).trim(), name: String(r[2]).trim(), mkt: "櫃", date: rocAny(r[5]), kuan: parseKuan(r[4]) });
    ok++;
  } catch (e) { console.log(`   ⚠ 上櫃注意股：${e.message}`); }
  return { notices: out, ok };
}

async function tradingDaysUpTo(today) {
  // 交易日：證交所每月成交統計（FMTQIK），抓最近 6 個月；下個交易日用休市日表推算
  const days = new Set(), taiex = new Map();
  const t = new Date(`${today}T12:00:00`);
  for (let k = 5; k >= 0; k--) {
    const m = new Date(t.getFullYear(), t.getMonth() - k, 1);
    try {
      const j = await getJSON(`https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${m.getFullYear()}${pad(m.getMonth() + 1)}01&response=json`);
      for (const r of j.data || []) { const iso = rocAny(r[0]); if (iso && iso <= today) { days.add(iso); const v = num(r[4]); if (v) taiex.set(iso, v); } }
    } catch { /* 略過 */ }
    await sleep(2000);
  }
  let holidays = new Set();
  try {
    const h = await getJSON("https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json");
    holidays = new Set((h.data || []).filter((r) => !/交易/.test(r[1] || "")).map((r) => String(r[0]).trim()));
  } catch { /* 沒有就只排除週末 */ }
  const addD = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return isoOf(d); };
  const isTrading = (iso) => { const w = new Date(`${iso}T12:00:00`).getDay(); return w !== 0 && w !== 6 && !holidays.has(iso); };
  const nextTrading = (iso) => { let x = addD(iso, 1); while (!isTrading(x)) x = addD(x, 1); return x; };
  // 大盤（加權指數）與月線
  const sorted = [...days].sort();
  const market = {};
  const tx = sorted.map((d) => taiex.get(d));
  for (let i = 0; i < sorted.length; i++) {
    if (i < 19 || tx.slice(i - 19, i + 1).some((v) => !v)) continue;
    const ma20 = tx.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
    market[sorted[i]] = { c: Math.round(tx[i] * 100) / 100, ma20: Math.round(ma20 * 100) / 100, above: tx[i] >= ma20 ? 1 : 0 };
  }
  return { days: sorted, nextTrading, market };
}

async function predictions(disposals, events, today, listFrom, cal) {
  if (cal.days.length < 40) return { ok: false, note: "抓不到交易日曆" };
  const { notices, ok } = await fetchNotices(listFrom, today);
  if (!ok) return { ok: false, note: "抓不到注意股資料" };
  const asOf = cal.days[cal.days.length - 1];
  const next = cal.nextTrading(asOf);
  const nameOf = new Map(notices.map((n) => [n.code, [n.name, n.mkt]]));
  const disp = disposals.map((d) => ({ code: d.code, pub: d.pub, start: d.start, end: d.end }));

  // 今天的候選
  const W = dispositionWatch(notices, disp, cal.days.slice(-40));
  const cands = [];
  for (const [code, w] of Object.entries(W)) {
    const [name, mkt] = nameOf.get(code) || [code, ""];
    let bars = [];
    try { bars = await getBars(mkt, code, isoOf(new Date(new Date(`${asOf}T12:00:00`).getTime() - 40 * 86400000)).slice(0, 8) + "01", new Date(`${asOf}T12:00:00`)); } catch { /* 沒價格就不算觸發價 */ }
    const C = bars.filter((b) => b.d <= asOf).map((b) => b.c);
    const last = C[C.length - 1], prev = C[C.length - 2];
    const tr = w.onlyC1 ? kuan1Trigger(mkt, C.slice(-6)) : null;
    cands.push({ code, name, mkt, close: last ?? null, pct: last && prev ? round2((last / prev - 1) * 100) : null,
      k: w.inDisp || disposals.some((d) => d.code === code && d.pub <= asOf && d.pub >= cal.days[Math.max(0, cal.days.length - 31)]) ? 2 : 1,
      inDisp: w.inDisp, cat: !w.onlyC1 ? "other" : tr && tr.always ? "always" : "price", rule: w.near.join("、"), todayK: w.todayK, tr: tr || {} });
  }
  // 命中率：倒回去每一天算一次候選名單，看下一個交易日有沒有真的被公告處置
  const pubs = new Set(disposals.map((d) => `${d.code}|${d.pub}`));
  const hit = {};
  let ndays = 0;
  const D = cal.days;
  for (let i = 40; i < D.length - 1; i++) {
    if (D[i] < RULE_START) continue;
    ndays++;
    const Wi = dispositionWatch(notices, disp, D.slice(i - 39, i + 1));
    for (const [code, w] of Object.entries(Wi)) {
      const key = (w.onlyC1 ? "c1" : "other") + (w.inDisp ? "_in" : "");
      const h = (hit[key] = hit[key] || { n: 0, hit: 0 });
      h.n++;
      if (pubs.has(`${code}|${D[i + 1]}`)) h.hit++;
    }
  }
  return { ok: true, asOf, next, cands, hit, days: ndays, src: "注意股公告" };
}

/* ---------------- 融券資格（可不可以放空） ---------------- */
// 證交所 MI_MARGN「融資融券彙總」：融券「次一營業日限額」> 0 才能融券；註記含 X＝停止融券
// 櫃買 margin/balance：「券限額」> 0 才能融券
async function marginInfo(codes, tradeDays) {
  const want = new Set(codes);
  const res = { map: {}, twse: null, tpex: null };
  const ymd = (d) => d.replace(/-/g, "");
  for (const d of tradeDays.slice(-5).reverse()) {
    if (res.twse) break;
    try {
      const j = await getJSON(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${ymd(d)}&selectType=ALL&response=json`);
      const t = (j.tables || []).find((x) => /融資融券彙總/.test(x.title || "") && (x.data || []).length);
      if (!t) continue;
      res.twse = d;
      for (const r of t.data) {
        const c = String(r[0]).trim(); if (!want.has(c)) continue;
        const lim = num(r[13]), note = String(r[15] || "").trim();
        res.map[c] = [lim > 0 && !/X/i.test(note) ? 1 : 0, note];
      }
    } catch { /* 試前一天 */ }
    await sleep(1500);
  }
  for (const d of tradeDays.slice(-5).reverse()) {
    if (res.tpex) break;
    try {
      const j = await getJSON(`https://www.tpex.org.tw/www/zh-tw/margin/balance?date=${d.replace(/-/g, "/")}&response=json`);
      const t = (j.tables || []).find((x) => (x.data || []).length);
      if (!t) continue;
      res.tpex = d;
      for (const r of t.data) {
        const c = String(r[0]).trim(); if (!want.has(c)) continue;
        const lim = num(r[17]), note = String(r[19] || "").trim();
        res.map[c] = [lim > 0 ? 1 : 0, note];
      }
    } catch { /* 試前一天 */ }
    await sleep(1200);
  }
  for (const c of want) if (!res.map[c] && (res.twse || res.tpex)) res.map[c] = [0, "非信用交易標的"];
  return res;
}

/* ---------------- 法人買賣超（處置前 3 天，外資＋投信，張） ---------------- */
const INST_DIR = path.join(CACHE_DIR, "inst");
async function instDay(date) {
  const file = path.join(INST_DIR, `${date}.json`);
  let c = {};
  try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 新檔 */ }
  let changed = false;
  const col = (F, ...keys) => F.map((x) => String(x).replace(/\s/g, "")).findIndex((n) => keys.every((k) => n.includes(k)));
  if (!c.twse) {
    try {
      const j = await getJSON(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${date.replace(/-/g, "")}&selectType=ALLBUT0999&response=json`);
      const F = j.fields || [];
      const iC = col(F, "證券代號"), iF = col(F, "外陸資買賣超股數", "不含外資自營商"), iFD = col(F, "外資自營商買賣超股數"), iT = col(F, "投信買賣超股數");
      if ((j.data || []).length && iC >= 0) {
        c.twse = {};
        for (const r of j.data) { const code = String(r[iC]).trim(); if (!/^[1-9]\d{3}$/.test(code)) continue; c.twse[code] = Math.round(((num(r[iF]) || 0) + (iFD >= 0 ? num(r[iFD]) || 0 : 0) + (num(r[iT]) || 0)) / 1000); }
        changed = true;
      }
    } catch { /* 下次再試 */ }
    await sleep(2000);
  }
  if (!c.tpex) {
    try {
      const j = await getJSON(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${date.replace(/-/g, "/")}&response=json`);
      const t = (j.tables || [])[0];
      if (t && (t.data || []).length) {
        const F = (t.fields || []).map((x) => String(x).replace(/\s/g, ""));
        let iF = F.findIndex((x, i) => i > 1 && x.includes("外資及陸資") && x.includes("買賣超") && !x.includes("不含") && !x.includes("自營商")); if (iF < 0) iF = 10;
        let iT = F.findIndex((x) => x.includes("投信") && x.includes("買賣超")); if (iT < 0) iT = 13;
        c.tpex = {};
        for (const r of t.data) { const code = String(r[0]).trim(); if (!/^[1-9]\d{3}$/.test(code)) continue; c.tpex[code] = Math.round(((num(r[iF]) || 0) + (num(r[iT]) || 0)) / 1000); }
        changed = true;
      }
    } catch { /* 下次再試 */ }
    await sleep(1200);
  }
  if (changed) { fs.mkdirSync(INST_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(c)); }
  return c;
}
async function instLoader(dates) {
  const by = {};
  let n = 0;
  for (const d of [...new Set(dates)].filter(Boolean).sort()) {
    by[d] = await instDay(d);
    if (++n % 20 === 0) console.log(`   … 法人資料 ${n} 天`);
  }
  return (mkt, code, ds) => {
    let sum = 0, got = 0;
    for (const d of ds) { const m = by[d] && by[d][mkt === "市" ? "twse" : "tpex"]; if (!m) continue; got++; sum += m[code] || 0; }
    return got ? sum : null;
  };
}

/* ---------------- 實戰紀錄：每天存下「明天作戰清單」，之後自動結算 ---------------- */
const HIST_FILE = path.join(ROOT, "history.json");
const TRACK_HOLD = 5;
const tickFloor = (p) => { const t = tick(p); return Math.round(Math.floor(p / t + 1e-9) * t * 100) / 100; };
const gradeOf = (w, n) => (w == null || n < 8 ? "C" : w >= 0.6 ? "A" : w >= 0.55 ? "B" : w >= 0.5 ? "C" : "D");
function planItems(events, stats) {
  const st = (g, k) => (stats[g] && stats[g][k] && stats[g][k][5]) || null;
  const items = [];
  for (const e of events) {
    const grp = e.k === 1 ? (e.px0 >= 100 ? "k1p" : "k1l") : (e.px0 >= 100 ? "k2p" : "k2l");
    // 掛低接：同一檔只留該組回測勝率最高的價位（跟網頁卡片一致）
    let bestL = null;
    for (const k of (e.next || []).filter((k) => KIND[k] === "limit")) { const s0 = st(grp, k); const w = s0 && s0.n >= 8 ? s0.win : -1; if (!bestL || w > bestL.w) bestL = { k, w }; }
    for (const k of e.next || []) {
      if (KIND[k] === "limit" && k !== (bestL && bestL.k)) continue;
      let s = st(grp, k);
      if (!s || s.n < 8) s = st(e.k === 1 ? "k1" : "k2", k);
      if (k === "B" && grp === "k1p") s = st("k1pg", "B") || s;
      items.push({ code: e.code, name: e.name, mkt: e.mkt, k: e.k, entry: k, kind: KIND[k] || "close", grade: gradeOf(s && s.win, s ? s.n : 0),
        win: s ? s.win : null, px0: e.px0, limit: LIMITS[k] ? tickFloor(e.px0 * (1 - LIMITS[k])) : null, end: e.end });
    }
  }
  // 同一檔同一種掛單只留一個（最高等級）
  const seen = new Set();
  return items.sort((a, b) => "ABCD".indexOf(a.grade) - "ABCD".indexOf(b.grade))
    .filter((x) => { const key = `${x.code}|${x.kind === "limit" ? "L" : x.entry}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
function settle(it, plan, bars) {
  const D = bars.map((b) => b.d), C = bars.map((b) => b.c);
  const n = D.indexOf(plan.next);
  if (n < 0) return { status: plan.next > (D[D.length - 1] || "") ? "待執行" : "沒交易" };
  let idx = n, px, open = it.kind === "open" || it.kind === "limit", dir = it.kind === "short" ? -1 : 1;
  if (it.kind === "limit") {
    idx = -1;
    for (let j = n; j < bars.length && D[j] <= it.end; j++) if (bars[j].l <= it.limit) { idx = j; px = Math.min(it.limit, bars[j].o); break; }
    if (idx < 0) return { status: D[D.length - 1] >= it.end ? "未成交" : "掛單中" };
  } else px = open ? bars[n].o : bars[n].c;
  if (!px) return { status: "沒交易" };
  const x = open ? idx + TRACK_HOLD - 1 : idx + TRACK_HOLD;
  const last = Math.min(x, bars.length - 1);
  const ret = dir > 0 ? C[last] / px - 1 - COST : 1 - C[last] / px - COST;
  return { status: x < bars.length ? "已結算" : "持有中", buy: D[idx], px: r4(px), exit: D[last], ret: r4(ret) };
}
async function trackRecord(asOf, next, events, stats, predict, disposals, barsOf) {
  let h = { plans: {} };
  try { h = JSON.parse(fs.readFileSync(HIST_FILE, "utf8")); } catch { /* 第一次 */ }
  const isNew = !h.plans[asOf];
  h.plans[asOf] = {
    next, items: planItems(events, stats),
    preds: predict.ok ? predict.cands.map((c) => ({ code: c.code, name: c.name, mkt: c.mkt, k: c.k, cat: c.cat })) : [],
  };
  fs.writeFileSync(HIST_FILE, JSON.stringify(h));
  const pubs = new Set(disposals.map((d) => `${d.code}|${d.pub}`));
  const rows = [];
  for (const [date, plan] of Object.entries(h.plans).sort((a, b) => b[0].localeCompare(a[0]))) {
    const need = [...plan.items, ...plan.preds];
    for (const it of need) {
      const key = `${it.mkt}${it.code}`;
      if (!barsOf.has(key)) { try { barsOf.set(key, await getBars(it.mkt, it.code, isoOf(new Date(new Date(`${date}T12:00:00`).getTime() - 40 * 86400000)).slice(0, 8) + "01", twNow())); } catch { barsOf.set(key, []); } }
    }
    for (const it of plan.items) rows.push({ plan: date, exec: plan.next, ...it, ...settle(it, plan, barsOf.get(`${it.mkt}${it.code}`) || []) });
    for (const p of plan.preds) {
      const bars = barsOf.get(`${p.mkt}${p.code}`) || [];
      const done = (bars.length && bars[bars.length - 1].d >= plan.next);
      const hit = pubs.has(`${p.code}|${plan.next}`);
      const row = { plan: date, exec: plan.next, code: p.code, name: p.name, mkt: p.mkt, k: p.k, entry: "A", kind: "pred", cat: p.cat, grade: "P" };
      if (!done) rows.push({ ...row, status: "待驗證" });
      else if (!hit) rows.push({ ...row, status: "沒進處置" });
      else rows.push({ ...row, hit: 1, ...settle({ kind: "close" }, plan, bars) });
    }
  }
  return { rows, isNew, since: Object.keys(h.plans).sort()[0], hold: TRACK_HOLD };
}

/* ---------------- K 線小圖資料（每檔最近 90 天） ---------------- */
function writeKline(barsOf) {
  const dir = path.join(ROOT, "k");
  fs.mkdirSync(dir, { recursive: true });
  for (const [key, bars] of barsOf) {
    if (!bars.length) continue;
    const code = key.slice(1);
    fs.writeFileSync(path.join(dir, `${code}.json`), JSON.stringify(bars.slice(-90).map((b) => [b.d, b.o, b.h, b.l, b.c, b.v])));
  }
}

/* ---------------- LINE 通知內容（真正送出由 notify.mjs 做） ---------------- */
function notifyText(out, track) {
  const nameOf = (k) => ENTRIES.find((x) => x[0] === k)?.[1] || k;
  const plan = planItems(out.events, out.stats).filter((x) => x.grade === "A");
  const L = [`【處置股】${out.predict.next || "明天"} 作戰清單（資料日 ${out.asOf}）`];
  if (out.market.today) L.push(`大盤 ${out.market.today.c}（${out.market.today.above ? "月線上" : "⚠ 月線下"}）`);
  L.push("", `A 級 ${plan.length} 筆：`);
  for (const x of plan.slice(0, 12)) {
    const how = x.kind === "limit" ? `掛 ${x.limit} 限價買` : x.kind === "short" ? `${nameOf(x.entry)}（${(out.margin.map[x.code] || [1])[0] ? "可融券" : "無券"}）` : nameOf(x.entry);
    L.push(`・${x.code} ${x.name}｜${how}｜勝率 ${Math.round((x.win || 0) * 100)}%`);
  }
  if (!plan.length) L.push("（沒有）");
  if (out.predict.ok && out.predict.cands.length) {
    L.push("", "公告日預判（再 1 次即處置）：");
    for (const c of out.predict.cands.slice(0, 8)) L.push(`・${c.code} ${c.name}｜${c.rule}`);
  }
  const done = track.rows.filter((r) => r.status === "已結算" && r.grade === "A");
  if (done.length) L.push("", `實戰紀錄 A 級已結算 ${done.length} 筆，勝率 ${Math.round(done.filter((r) => r.ret > 0).length / done.length * 100)}%`);
  L.push("", "https://justice-hung.github.io/disposition-backtest/");
  return L.join("\n");
}

/* ---------------- 主程式 ---------------- */
async function main() {
  const t0 = Date.now();
  const today = twNow();
  const todayIso = isoOf(today);
  const listFrom = isoOf(new Date(new Date(`${RULE_START}T12:00:00`).getTime() - 45 * 86400000));
  console.log(`處置股回測：新制起算 ${RULE_START}，抓處置公告 ${listFrom} ~ ${todayIso}`);
  const raw = await fetchDisposals(listFrom, todayIso);
  if (!raw.length) throw new Error("處置公告抓不到資料");

  const seen = new Set(), evs = [];
  for (const ev of raw) {
    if (!/^[1-9]\d{3}$/.test(ev.code) || ev.start < RULE_START) continue; // 只看普通股、新制之後
    const k = kindOf(ev.kind);
    if (!k) continue;
    const key = `${ev.mkt}${ev.code}${ev.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evs.push({ ...ev, k });
  }
  evs.sort((a, b) => a.start.localeCompare(b.start) || a.code.localeCompare(b.code));
  console.log(`   └ 納入回測 ${evs.length} 件處置（排除權證／ETF／人工管制撮合）`);

  const stocks = new Map();
  for (const ev of evs) {
    const key = `${ev.mkt}${ev.code}`;
    if (!stocks.has(key) || ev.start < stocks.get(key)) stocks.set(key, ev.start);
  }
  const barsOf = new Map();
  let n = 0;
  for (const [key, first] of stocks) {
    n++;
    const mkt = key[0], code = key.slice(1);
    const from = new Date(new Date(`${first}T12:00:00`).getTime() - 62 * 86400000);
    if (n % 10 === 1) console.log(`   … 日K ${n}/${stocks.size}`);
    barsOf.set(key, await getBars(mkt, code, isoOf(from).slice(0, 8) + "01", today));
  }

  // 交易日曆＋大盤月線
  const cal = await tradingDaysUpTo(todayIso);
  console.log(`   └ 大盤：${Object.keys(cal.market).length} 天有月線資料`);
  // 處置前 3 天的法人買賣超
  const instDates = [];
  for (const ev of evs) {
    const bars = barsOf.get(`${ev.mkt}${ev.code}`) || [];
    const s = bars.findIndex((b) => b.d >= ev.start);
    if (s >= 3) instDates.push(bars[s - 3].d, bars[s - 2].d, bars[s - 1].d);
  }
  let inst = null;
  try { inst = await instLoader(instDates); } catch (e) { console.log(`   ⚠ 法人資料：${e.message}`); }
  const ctx = { market: cal.market, inst };

  const events = [], upcoming = [];
  for (const ev of evs) {
    const bars = barsOf.get(`${ev.mkt}${ev.code}`) || [];
    const a = bars.length ? analyse(ev, bars, ctx) : null;
    if (a) events.push(a);
    else if (bars.length && ev.start > bars[bars.length - 1].d) {
      upcoming.push({ code: ev.code, name: ev.name, mkt: ev.mkt, k: ev.k, pub: ev.pub, start: ev.start, end: ev.end, min: ev.min ?? null, bias20: null, status: "pre", close: bars[bars.length - 1].c, px0: bars[bars.length - 1].c, gap: null, next: ["B", "D1", "L5", "L7", "L10"], r: {} });
    }
  }
  const stats = aggregate(events);
  const tradeDays = [...new Set([...barsOf.values()].flatMap((b) => b.map((x) => x.d)))].sort().filter((d) => d >= RULE_START);
  let predict = { ok: false, note: "" };
  try { predict = cal.days.length < 40 ? { ok: false, note: "抓不到交易日曆" } : await predictions(raw, [...events, ...upcoming], todayIso, listFrom, cal); } catch (e) { predict = { ok: false, note: e.message }; }
  const liveCodes = [...new Set([...events, ...upcoming].filter((e) => (e.next || []).length || e.status !== "done").map((e) => e.code)
    .concat(predict.ok ? predict.cands.map((c) => c.code) : []))];
  let margin = { map: {} };
  try { margin = await marginInfo(liveCodes, tradeDays); } catch (e) { console.log(`   ⚠ 融券資格：${e.message}`); }
  console.log(`   └ 融券資格：上市 ${margin.twse || "抓不到"}、上櫃 ${margin.tpex || "抓不到"}，${Object.keys(margin.map).length} 檔`);
  console.log(predict.ok ? `   └ 公告日預判：${predict.next} 候選 ${predict.cands.length} 檔（命中率用 ${predict.days} 個交易日回推）` : `   ⚠ 公告日預判：${predict.note}`);
  const lastDate = [...barsOf.values()].reduce((m, b) => (b.length && b[b.length - 1].d > (m || "") ? b[b.length - 1].d : m), null);
  let track = { rows: [] };
  try { track = await trackRecord(lastDate, predict.next || cal.nextTrading(lastDate), [...events, ...upcoming], stats, predict, raw, barsOf); }
  catch (e) { console.log(`   ⚠ 實戰紀錄：${e.message}`); }
  try { writeKline(barsOf); } catch (e) { console.log(`   ⚠ K 線資料：${e.message}`); }
  const mdays = Object.keys(cal.market).sort();
  const out = {
    generatedAt: `${todayIso} ${pad(today.getHours())}:${pad(today.getMinutes())}`,
    asOf: lastDate,
    ruleStart: RULE_START,
    cost: COST, holds: HOLDS, minN: MIN_N,
    entries: ENTRIES.map(([key, name, desc, real]) => ({ key, name, desc, real, kind: KIND[key] || "close", limit: LIMITS[key] })),
    groups: GROUPS.map(([key, name]) => ({ key, name })),
    stats,
    best: Object.fromEntries(HOLDS.map((H) => [H, bestOf(stats, H)])),
    events: [...events, ...upcoming].map((e) => ({ ...e, g: GROUPS.filter(([, , f]) => f(e)).map(([k]) => k) })),
    predict,
    margin,
    market: { today: cal.market[mdays[mdays.length - 1]] ? { date: mdays[mdays.length - 1], ...cal.market[mdays[mdays.length - 1]] } : null },
    track,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `window.DISP_BT = ${JSON.stringify(out)};\n`);
  // 新的一天才產生通知內容（備援排程重跑同一天不會重複通知）
  const NOTIFY = path.join(ROOT, "notify.txt");
  try { fs.rmSync(NOTIFY, { force: true }); if (track.isNew) fs.writeFileSync(NOTIFY, notifyText(out, track)); } catch (e) { console.log(`   ⚠ 通知內容：${e.message}`); }
  const b5 = out.best[5];
  const nameOf = (k) => ENTRIES.find((x) => x[0] === k)?.[1] || k;
  console.log(`✅ 處置股回測：${events.length} 件（上市 ${events.filter((e) => e.mkt === "市").length}、上櫃 ${events.filter((e) => e.mkt === "櫃").length}），資料日 ${lastDate}`);
  for (const g of ["k1", "k2"]) if (b5[g]) console.log(`   └ ${g === "k1" ? "第一次" : "第二次"}處置・抱5天最佳：${nameOf(b5[g].entry)}（勝率 ${(b5[g].win * 100).toFixed(0)}%，n=${b5[g].n}）`);
  console.log(`   耗時 ${((Date.now() - t0) / 1000).toFixed(0)} 秒，寫入 ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch((e) => { console.log(`❌ 處置股回測失敗：${e.message}`); process.exitCode = 1; });
