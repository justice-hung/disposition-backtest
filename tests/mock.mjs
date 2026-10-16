// 離線測試：假資料（格式照證交所／櫃買實際回傳）
const realST = globalThis.setTimeout; globalThis.setTimeout = (f) => realST(f, 0);
let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
const days = []; for (let d = new Date("2026-05-01T12:00:00"); d <= new Date("2026-10-14T12:00:00"); d = new Date(d.getTime() + 864e5)) if (d.getDay() % 6) days.push(d);
const p2 = (n) => String(n).padStart(2, "0");
const roc = (d) => `${d.getFullYear() - 1911}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`;
const T = Array.from({ length: 20 }, (_, i) => String(2400 + i)), P = Array.from({ length: 20 }, (_, i) => String(3200 + i));
const PX = {};
for (const c of [...T, ...P]) { let p = 50; PX[c] = days.map((d) => { const o = p * (1 + (rnd() - .5) * .04); p = Math.max(5, p * (1 + .004 + .035 * gauss())); return [roc(d), "1,000", "50,000", o.toFixed(2), (Math.max(o, p) * 1.01).toFixed(2), (Math.min(o, p) * .99).toFixed(2), p.toFixed(2), "0", "9"]; }); }
const L = days.length;
const ev = (i) => [roc(days[i - 1]), roc(days[i]), roc(days[i + 4])];
globalThis.fetch = async (url) => {
  const u = new URL(url); let body;
  if (url.includes("punish")) {
    const data = [...T.map((c, j) => [c, 70 + (j % 40), "第一次處置"]), ...T.slice(0, 10).map((c, j) => [c, 76 + (j % 35), "第二次處置"]), ["2401", 90, "人工管制撮合"], ["035348", 90, "第一次處置"], ["2403", L - 1, "第二次處置"]]
      .map(([c, i, k], n) => { const [pub, s, e] = i + 4 < L ? ev(i) : [roc(days[L - 1]), "115/10/15", "115/10/21"]; return [n, pub, c, "名" + c, 1, "連續三次", `${s}～${e}`, k, "...", ""]; });
    body = { stat: "OK", data };
  } else if (url.includes("disposal")) {
    const data = [...P.map((c, j) => [c, 70 + j * 2, "第一次處置"]), ...P.slice(0, 12).map((c, j) => [c, 82 + j * 2, "再次處置"]), ["3219", L - 2, "再次處置"], ["3218", L - 3, "第一次處置"]]
      .map(([c, i, k], n) => { const ii = i; const pub = roc(days[ii - 1]), s = roc(days[ii]), e = ii + 4 < L ? roc(days[ii + 4]) : "115/10/20"; return [n, pub, c, `名${c}(../x?code=${c})`, 1, `${s}~${e}`, "連續3個營業日", k, "...", "", "", ""]; });
    body = { tables: [{ data }] };
  } else if (url.includes("STOCK_DAY")) {
    const ym = u.searchParams.get("date").slice(0, 6), c = u.searchParams.get("stockNo");
    body = { stat: "OK", data: PX[c].filter((r) => `${+r[0].slice(0, 3) + 1911}${r[0].slice(4, 6)}` === ym) };
  } else if (url.includes("tradingStock")) {
    const [y, m] = u.searchParams.get("date").split("/"), c = u.searchParams.get("code");
    body = { tables: [{ data: PX[c].filter((r) => `${+r[0].slice(0, 3) + 1911}/${r[0].slice(4, 6)}` === `${y}/${m}`) }] };
  } else throw new Error(url);
  return new Response(JSON.stringify(body), { status: 200 });
};
await import("../backtest.mjs");
