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
  ["S5", "D5收盤放空", "處置第 5 天收盤融券／借券賣出，抱 N 天回補（報酬已換算成做空的賺賠；回檔＝持有期間最大反向漲幅）", true],
];
const KIND = { B: "open", X0: "open", F: "open", M5: "open", M10: "open", M20: "open", L5: "limit", L7: "limit", L10: "limit", S5: "short" }; // 其餘為收盤買
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
];

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
      out.push({ mkt: "市", code: String(r[2]).trim(), name: String(r[3]).trim(), pub: rocToIso(r[1]), start: rocToIso(rng[0]), end: rocToIso(rng[1]), kind: String(r[7]).trim() });
    }
  } catch (e) { console.log(`❌ 上市處置公告：${e.message}`); }
  try {
    const j = await getJSON(`https://www.tpex.org.tw/www/zh-tw/bulletin/disposal?startDate=${slash(from)}&endDate=${slash(to)}&response=json`);
    for (const r of (j.tables?.[0]?.data) || []) {
      const rng = String(r[5]).split(/[～~]/);
      if (rng.length !== 2) continue;
      out.push({ mkt: "櫃", code: String(r[2]).trim(), name: String(r[3]).replace(/\(.*$/, "").trim(), pub: rocToIso(r[1]), start: rocToIso(rng[0]), end: rocToIso(rng[1]), kind: String(r[7]).trim() });
    }
  } catch (e) { console.log(`❌ 上櫃處置公告：${e.message}`); }
  return out;
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
  // 日期, 成交量, 成交金額, 開, 高, 低, 收, 漲跌, 筆數
  return rows.map((r) => [rocToIso(r[0]), num(r[3]), num(r[4]), num(r[5]), num(r[6])]);
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
    if (!c.months[key]?.complete) {
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
    let [, o, h, l, cl] = map.get(d);
    if (cl == null) { if (!bars.length) continue; cl = bars[bars.length - 1].c; o = h = l = cl; } // 無成交沿用前收
    bars.push({ d, o: o ?? cl, h: h ?? cl, l: l ?? cl, c: cl });
  }
  return bars;
}

/* ---------------- 回測 ---------------- */
const sma = (C, n, i) => (i < n - 1 ? null : C.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);

function analyse(ev, bars) {
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
  if (s <= i && i <= e + 10) for (const n of [5, 10, 20]) if (firstBelow(n) === i) next.push(`M${n}`);
  const m20 = sma(C, 20, s - 1);
  return {
    code: ev.code, name: ev.name, mkt: ev.mkt, k: ev.k, pub: ev.pub, start: ev.start, end: ev.end,
    bias20: m20 ? r4(C[s - 1] / m20 - 1) : null,
    px0: P0, gap: bars[s] ? r4(bars[s].o / P0 - 1) : null,
    status: i < s ? "pre" : i <= eEnd ? `d${i - s + 1}` : i <= e + 10 ? "post" : "done",
    close: C[i], next, r,
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


/* ---------------- 公告日預判（讀戰情室「處置股雷達」的注意累計） ---------------- */
// 戰情室資料來源：1) 本機旁邊的 twstock-warroom 資料夾 2) GitHub raw 3) 網站編碼檔（.bin）
const WARROOM_LOCAL = path.join(ROOT, "..", "twstock-warroom", "public", "data");
const WARROOM_RAW = "https://raw.githubusercontent.com/justice-hung/twstock-warroom/main/public/data";
const WARROOM_SITE = "https://warroom.justice-hung.win/data";
const zlib = await import("node:zlib");
function decodeBin(buf, name) { // 與戰情室 scripts/encode-data.mjs 相同演算法
  const K = [0x74, 0x77, 0x2d, 0x77, 0x72, 0x2d, 0x32, 0x30, 0x32, 0x36, 0x2d, 0x6a, 0x68];
  let h = 0x811c9dc5;
  const str = String.fromCharCode(...K) + "/" + name;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let x = h || 1;
  const b = Uint8Array.from(buf);
  for (let i = 0; i < b.length; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] ^= x & 0xff; }
  return JSON.parse(zlib.inflateRawSync(Buffer.from(b)).toString("utf8"));
}
async function warroomData(name) {
  try { return JSON.parse(fs.readFileSync(path.join(WARROOM_LOCAL, `${name}.json`), "utf8")); } catch { /* 下一個來源 */ }
  try { const r = await fetch(`${WARROOM_RAW}/${name}.json`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) }); if (r.ok) return await r.json(); } catch { /* 下一個來源 */ }
  try {
    const r = await fetch(`${WARROOM_SITE}/${name}.bin`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (r.ok && !(r.headers.get("content-type") || "").includes("html")) return decodeBin(Buffer.from(await r.arrayBuffer()), name);
  } catch { /* 沒有 */ }
  return null;
}
// 雷達的 watch 列：[代號,名稱,市場,收盤,漲跌%,連續第一款,連續1~8款,10日內,30日內,還差次數,接近規則,任一款即算,今日款次,近10日軌跡,觸發價,處置中]
const predCat = (r) => (!/第一款/.test(r[10]) ? "other" : r[14]?.always ? "always" : "price");
async function predictions(events, tradeDays) {
  const latest = await warroomData("latest");
  const X = latest?.disposition;
  if (!X?.watch) return { ok: false, note: "讀不到戰情室的處置股雷達資料" };
  const cands = X.watch.filter((r) => r[9] === 1).map((r) => ({
    code: r[0], name: r[1], mkt: r[2], close: r[3], pct: r[4], k: r[15] ? 2 : 1, cat: predCat(r),
    rule: r[10], todayK: r[12], tr: r[14] || {},
  }));
  // 命中率：用戰情室每天的快照，看「明天再1次即處置」的股票，下個交易日是否真的公告處置
  const pubs = new Set(events.map((e) => `${e.code}|${e.pub}`));
  const hit = {};
  let days = 0;
  for (const d of tradeDays.slice(-40)) {
    const snap = await warroomData(d);
    const W = snap?.disposition;
    if (!W?.watch || !W.next || W.next > tradeDays[tradeDays.length - 1]) continue; // 結果還沒出來的不算
    days++;
    for (const r of W.watch) {
      if (r[9] !== 1) continue;
      const key = predCat(r) + (r[15] ? "_in" : "");
      const h = (hit[key] = hit[key] || { n: 0, hit: 0 });
      h.n++;
      if (pubs.has(`${r[0]}|${W.next}`)) h.hit++;
    }
  }
  return { ok: true, asOf: X.asOf, next: X.next, cands, hit, days };
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

  const events = [], upcoming = [];
  for (const ev of evs) {
    const bars = barsOf.get(`${ev.mkt}${ev.code}`) || [];
    const a = bars.length ? analyse(ev, bars) : null;
    if (a) events.push(a);
    else if (bars.length && ev.start > bars[bars.length - 1].d) {
      upcoming.push({ code: ev.code, name: ev.name, mkt: ev.mkt, k: ev.k, pub: ev.pub, start: ev.start, end: ev.end, bias20: null, status: "pre", close: bars[bars.length - 1].c, px0: bars[bars.length - 1].c, gap: null, next: ["B", "D1", "L5", "L7", "L10"], r: {} });
    }
  }
  const stats = aggregate(events);
  const tradeDays = [...new Set([...barsOf.values()].flatMap((b) => b.map((x) => x.d)))].sort().filter((d) => d >= RULE_START);
  let predict = { ok: false, note: "" };
  try { predict = await predictions([...events, ...upcoming], tradeDays); } catch (e) { predict = { ok: false, note: e.message }; }
  console.log(predict.ok ? `   └ 公告日預判：明天候選 ${predict.cands.length} 檔（命中率用 ${predict.days} 天快照計算）` : `   ⚠ 公告日預判：${predict.note}`);
  const lastDate = [...barsOf.values()].reduce((m, b) => (b.length && b[b.length - 1].d > (m || "") ? b[b.length - 1].d : m), null);
  const out = {
    generatedAt: `${todayIso} ${pad(today.getHours())}:${pad(today.getMinutes())}`,
    asOf: lastDate,
    ruleStart: RULE_START,
    cost: COST, holds: HOLDS, minN: MIN_N,
    entries: ENTRIES.map(([key, name, desc, real]) => ({ key, name, desc, real, kind: KIND[key] || "close", limit: LIMITS[key] })),
    groups: GROUPS.map(([key, name]) => ({ key, name })),
    stats,
    best: Object.fromEntries(HOLDS.map((H) => [H, bestOf(stats, H)])),
    events: [...events, ...upcoming],
    predict,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `window.DISP_BT = ${JSON.stringify(out)};\n`);
  const b5 = out.best[5];
  const nameOf = (k) => ENTRIES.find((x) => x[0] === k)?.[1] || k;
  console.log(`✅ 處置股回測：${events.length} 件（上市 ${events.filter((e) => e.mkt === "市").length}、上櫃 ${events.filter((e) => e.mkt === "櫃").length}），資料日 ${lastDate}`);
  for (const g of ["k1", "k2"]) if (b5[g]) console.log(`   └ ${g === "k1" ? "第一次" : "第二次"}處置・抱5天最佳：${nameOf(b5[g].entry)}（勝率 ${(b5[g].win * 100).toFixed(0)}%，n=${b5[g].n}）`);
  console.log(`   耗時 ${((Date.now() - t0) / 1000).toFixed(0)} 秒，寫入 ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch((e) => { console.log(`❌ 處置股回測失敗：${e.message}`); process.exitCode = 1; });
