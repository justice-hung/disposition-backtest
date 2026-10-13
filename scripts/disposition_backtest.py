#!/usr/bin/env python3
"""處置股回測：抓證交所 + 櫃買中心處置公告與日 K，回測各種買點，輸出 docs/disposition/data.json。

每天盤後由 GitHub Actions 執行。價格依「股票 x 月份」快取在 data/disposition/cache/，
已收完的月份不重抓，所以每天只需要抓當月資料。

用法:
    python scripts/disposition_backtest.py               # 正常更新
    python scripts/disposition_backtest.py --start 2026-08-10
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import statistics
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "data" / "disposition" / "cache"
OUT_FILE = ROOT / "docs" / "disposition" / "data.json"

TZ = dt.timezone(dt.timedelta(hours=8))
COST = 0.006          # 手續費買賣 0.1425%x2 + 證交稅 0.3%，取整 0.6%
HOLDS = [3, 5, 10, 20]
NEW_RULE_START = "2026-08-10"   # 處置新制（5 個營業日、約 2 分鐘撮合）上路日

UA = {"User-Agent": "Mozilla/5.0 (twstock-dashboard disposition backtest)"}
SESSION = requests.Session()
SESSION.headers.update(UA)

ENTRIES = [  # key, 中文名稱, 說明
    ("A",   "公告日收盤",       "處置公告當天收盤買"),
    ("B",   "處置D1開盤",       "處置第 1 天開盤買"),
    ("D1",  "處置D1收盤",       "處置第 1 天收盤買"),
    ("D2",  "處置D2收盤",       "處置第 2 天收盤買"),
    ("D3",  "處置D3收盤",       "處置第 3 天收盤買"),
    ("D4",  "處置D4收盤",       "處置第 4 天收盤買"),
    ("D5",  "處置D5收盤",       "處置第 5 天收盤買"),
    ("X0",  "出關首日開盤",     "處置結束後第 1 個交易日開盤買"),
    ("X1",  "出關首日收盤",     "處置結束後第 1 個交易日收盤買"),
    ("X3",  "出關第3日收盤",    "處置結束後第 3 個交易日收盤買"),
    ("F",   "處置中首根收黑",   "處置期間第一次收盤下跌當天收盤買"),
    ("M5",  "首次跌破5日線",    "處置開始後首次收盤 < 5MA 當天收盤買（觀察到出關後 10 天）"),
    ("M10", "首次跌破10日線",   "處置開始後首次收盤 < 10MA 當天收盤買"),
    ("M20", "首次跌破月線",     "處置開始後首次收盤 < 20MA 當天收盤買"),
]

GROUPS = [  # key, 名稱
    ("all", "全部"),
    ("k1", "第一次處置"),
    ("k2", "第二次(再次)處置"),
    ("hb", "處置前乖離月線 > 25%"),
    ("lb", "處置前乖離月線 ≤ 25%"),
    ("twse", "上市"),
    ("tpex", "上櫃"),
]


# ---------------------------------------------------------------- utils
def roc_to_iso(s: str) -> str:
    y, m, d = s.strip().split("/")
    return f"{int(y) + 1911:04d}-{int(m):02d}-{int(d):02d}"


def num(s):
    try:
        return float(str(s).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def get_json(url: str, params: dict, tries: int = 4, pause: float = 2.0):
    for i in range(tries):
        try:
            r = SESSION.get(url, params=params, timeout=30)
            if r.status_code == 200 and r.text.strip().startswith("{"):
                return r.json()
            print(f"  ! {r.status_code} {url} {params}", file=sys.stderr)
        except requests.RequestException as e:
            print(f"  ! {e} {url} {params}", file=sys.stderr)
        time.sleep(pause * (i + 2) * 2)
    return None


def months_between(start: dt.date, end: dt.date):
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        m += 1
        if m == 13:
            y, m = y + 1, 1


# ---------------------------------------------------------------- disposition lists
def fetch_twse_disposition(start: dt.date, end: dt.date):
    j = get_json("https://www.twse.com.tw/rwd/zh/announcement/punish", {
        "startDate": start.strftime("%Y%m%d"), "endDate": end.strftime("%Y%m%d"),
        "querytype": 3, "response": "json"})
    out = []
    for d in (j or {}).get("data", []) or []:
        # 編號, 公布日期, 證券代號, 證券名稱, 累計, 處置條件, 處置起迄時間, 處置措施, 處置內容, 備註
        rng = re.split(r"[～~]", d[6])
        if len(rng) != 2:
            continue
        out.append(dict(market="twse", pub=roc_to_iso(d[1]), code=d[2].strip(), name=d[3].strip(),
                        reason=d[5], start=roc_to_iso(rng[0]), end=roc_to_iso(rng[1]), kind=d[7].strip(),
                        detail=d[8]))
    return out


def fetch_tpex_disposition(start: dt.date, end: dt.date):
    j = get_json("https://www.tpex.org.tw/www/zh-tw/bulletin/disposal", {
        "startDate": start.strftime("%Y/%m/%d"), "endDate": end.strftime("%Y/%m/%d"), "response": "json"})
    out = []
    tables = (j or {}).get("tables") or []
    for d in (tables[0]["data"] if tables else []):
        # 編號, 公布日期, 證券代號, 證券名稱(含連結), 累計, 處置起訖時間, 處置原因, 處置措施, 處置內容, ...
        rng = re.split(r"[～~]", d[5])
        if len(rng) != 2:
            continue
        out.append(dict(market="tpex", pub=roc_to_iso(d[1]), code=d[2].strip(),
                        name=re.sub(r"\(.*$", "", d[3]).strip(), reason=d[6],
                        start=roc_to_iso(rng[0]), end=roc_to_iso(rng[1]), kind=d[7].strip(), detail=d[8]))
    return out


def classify(ev) -> int | None:
    """1 = 第一次處置, 2 = 第二次/再次處置, None = 其他(人工管制撮合等不納入)。"""
    k = ev["kind"]
    if "人工" in k:
        return None
    if "第一次" in k:
        return 1
    if "第二次" in k or "再次" in k:
        return 2
    return None


# ---------------------------------------------------------------- prices (cached)
def load_cache(market, code):
    p = CACHE_DIR / f"{market}_{code}.json"
    if p.exists():
        return json.loads(p.read_text("utf-8"))
    return {"months": {}}


def save_cache(market, code, c):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / f"{market}_{code}.json").write_text(json.dumps(c, ensure_ascii=False, separators=(",", ":")), "utf-8")


def fetch_month(market, code, y, m):
    if market == "twse":
        j = get_json("https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY",
                     {"date": f"{y}{m:02d}01", "stockNo": code, "response": "json"})
        rows = (j or {}).get("data") if j else None
        if j is not None and rows is None and j.get("stat") not in (None, "OK"):
            rows = []  # 例如「很抱歉，沒有符合條件的資料!」→ 該月無資料
        time.sleep(2.0)
    else:
        j = get_json("https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock",
                     {"code": code, "date": f"{y}/{m:02d}/01", "response": "json"})
        t = (j or {}).get("tables") or []
        rows = t[0].get("data", []) if t else ([] if j is not None else None)
        time.sleep(1.2)
    if rows is None:
        return None
    # 日期, 成交股數/張數, 成交金額, 開盤, 最高, 最低, 收盤, 漲跌, 筆數
    return [[roc_to_iso(r[0]), num(r[3]), num(r[4]), num(r[5]), num(r[6]), num(r[1])] for r in rows]


def get_bars(market, code, first: dt.date, today: dt.date):
    c = load_cache(market, code)
    changed = False
    for y, m in months_between(first, today):
        key = f"{y}-{m:02d}"
        ent = c["months"].get(key)
        if ent and ent.get("complete"):
            continue
        rows = fetch_month(market, code, y, m)
        if rows is None:
            continue
        month_done = (y, m) < (today.year, today.month)
        c["months"][key] = {"complete": month_done, "rows": rows}
        changed = True
    if changed:
        save_cache(market, code, c)
    bars = {}
    for ent in c["months"].values():
        for d, o, h, l, cl, v in ent["rows"]:
            bars[d] = [o, h, l, cl, v]
    out = []
    for d in sorted(bars):
        o, h, l, cl, v = bars[d]
        if cl is None:  # 當日無成交 → 沿用前一日收盤
            if not out:
                continue
            cl = out[-1]["c"]
            o = h = l = cl
        o = cl if o is None else o
        h = cl if h is None else h
        l = cl if l is None else l
        out.append({"d": d, "o": o, "h": h, "l": l, "c": cl, "v": v})
    return out


# ---------------------------------------------------------------- backtest per event
def sma(closes, n, i):
    if i < n - 1:
        return None
    return sum(closes[i - n + 1:i + 1]) / n


def analyse_event(ev, bars):
    dates = [b["d"] for b in bars]
    C = [b["c"] for b in bars]
    s = next((i for i, d in enumerate(dates) if d >= ev["start"]), None)
    if s is None or s < 21:
        return None
    e = max((i for i, d in enumerate(dates) if d <= ev["end"]), default=-1)
    if e < s:
        return None

    def first_below(n):
        for i in range(s, min(e + 10, len(bars) - 1) + 1):
            m = sma(C, n, i)
            if m is not None and C[i] < m:
                return i
        return None

    def first_down():
        for i in range(s, e + 1):
            if C[i] < C[i - 1]:
                return i
        return None

    ma20 = sma(C, 20, s - 1)
    entries = {"A": (s - 1, False), "B": (s, True)}
    for k in range(1, 6):
        if s + k - 1 <= e:
            entries[f"D{k}"] = (s + k - 1, False)
    entries.update({"X0": (e + 1, True), "X1": (e + 1, False), "X3": (e + 3, False),
                    "F": (first_down(), False), "M5": (first_below(5), False),
                    "M10": (first_below(10), False), "M20": (first_below(20), False)})
    res = {}
    for key, (idx, use_open) in entries.items():
        if idx is None or idx < 0 or idx >= len(bars):
            continue
        px = bars[idx]["o"] if use_open else bars[idx]["c"]
        if not px:
            continue
        r = {"d": dates[idx]}
        for H in HOLDS:
            x = idx + H - 1 if use_open else idx + H
            if x < len(bars):
                lo_from = idx if use_open else idx + 1
                low = min(b["l"] for b in bars[lo_from:x + 1])
                r[str(H)] = [round(C[x] / px - 1, 4), round(low / px - 1, 4)]
        res[key] = r

    today_i = len(bars) - 1
    status = None
    if dates[-1] < ev["start"]:
        status = "announced"
    elif s <= today_i <= e:
        status = f"day{today_i - s + 1}"
    elif today_i > e:
        status = "ended"
    return {
        "market": ev["market"], "code": ev["code"], "name": ev["name"], "k": ev["k"],
        "pub": ev["pub"], "start": ev["start"], "end": ev["end"], "len": e - s + 1,
        "bias20": round(C[s - 1] / ma20 - 1, 4) if ma20 else None,
        "runup20": round(C[s - 1] / C[s - 21] - 1, 4),
        "status": status, "last": dates[-1], "lastClose": C[-1],
        "r": res,
    }


def live_signals(ev, bars):
    """目前處置中/剛公告的股票：今天觸發了哪些買點。"""
    if not bars:
        return {}
    dates = [b["d"] for b in bars]
    C = [b["c"] for b in bars]
    i = len(bars) - 1
    s = next((j for j, d in enumerate(dates) if d >= ev["start"]), None)
    sig = {}
    if dates[-1] == ev["pub"] or (s is None and dates[-1] < ev["start"]):
        sig["A"] = True
    if s is None:
        return sig
    e = max((j for j, d in enumerate(dates) if d <= ev["end"]), default=-1)
    if s <= i <= e:
        sig[f"D{i - s + 1}"] = True
        if C[i] < C[i - 1] and all(C[j] >= C[j - 1] for j in range(s, i)):
            sig["F"] = True
    if s <= i <= e + 10:
        for n in (5, 10, 20):
            m_now, prev = sma(C, n, i), [sma(C, n, j) for j in range(s, i)]
            if m_now and C[i] < m_now and all(pm is None or C[j] >= pm for j, pm in zip(range(s, i), prev)):
                sig[f"M{n}"] = True
    if e >= 0 and i == e + 3:
        sig["X3"] = True
    return sig


# ---------------------------------------------------------------- aggregate
def in_group(ev, g):
    return {
        "all": True, "k1": ev["k"] == 1, "k2": ev["k"] == 2,
        "hb": ev["bias20"] is not None and ev["bias20"] > 0.25,
        "lb": ev["bias20"] is not None and ev["bias20"] <= 0.25,
        "twse": ev["market"] == "twse", "tpex": ev["market"] == "tpex",
    }[g]


def aggregate(events):
    stats = {}
    for g, _ in GROUPS:
        evs = [e for e in events if in_group(e, g)]
        stats[g] = {}
        for key, *_ in ENTRIES:
            stats[g][key] = {}
            for H in HOLDS:
                rs = [e["r"][key][str(H)] for e in evs if key in e["r"] and str(H) in e["r"][key]]
                if not rs:
                    continue
                net = [x[0] - COST for x in rs]
                stats[g][key][str(H)] = {
                    "n": len(net),
                    "win": round(sum(1 for x in net if x > 0) / len(net), 4),
                    "mean": round(statistics.mean(net), 4),
                    "median": round(statistics.median(net), 4),
                    "dd": round(statistics.mean(x[1] for x in rs), 4),
                }
    return stats


def best_entries(stats, H="5", min_n=15):
    best = {}
    for g, _ in GROUPS:
        cands = [(v[H]["win"], v[H]["median"], k) for k, v in stats[g].items() if H in v and v[H]["n"] >= min_n]
        if cands:
            w, med, k = max(cands)
            best[g] = {"entry": k, "win": w, "median": med, "n": stats[g][k][H]["n"]}
    return best


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default=NEW_RULE_START)
    ap.add_argument("--today", default=None, help="YYYY-MM-DD，測試用")
    args = ap.parse_args()

    today = dt.date.fromisoformat(args.today) if args.today else dt.datetime.now(TZ).date()
    start = dt.date.fromisoformat(args.start)
    list_from = start - dt.timedelta(days=45)

    print(f"抓處置公告 {list_from} ~ {today}")
    raw = fetch_twse_disposition(list_from, today) + fetch_tpex_disposition(list_from, today)
    print(f"  公告 {len(raw)} 筆")

    seen, evs = set(), []
    for ev in raw:
        if not re.fullmatch(r"\d{4}", ev["code"]):
            continue                       # 只看普通股（排除權證、ETF、可轉債）
        if ev["start"] < args.start:
            continue                       # 只看新制上路後開始的處置
        k = classify(ev)
        if k is None:
            continue
        key = (ev["market"], ev["code"], ev["start"])
        if key in seen:
            continue
        seen.add(key)
        ev["k"] = k
        evs.append(ev)
    evs.sort(key=lambda e: (e["start"], e["code"]))
    print(f"  納入回測 {len(evs)} 件")

    events, live = [], []
    bar_cache = {}
    for n, ev in enumerate(evs, 1):
        mk = (ev["market"], ev["code"])
        if mk not in bar_cache:
            first = dt.date.fromisoformat(min(e["start"] for e in evs if (e["market"], e["code"]) == mk)) - dt.timedelta(days=62)
            print(f"  [{n}/{len(evs)}] {ev['market']} {ev['code']} {ev['name']}")
            bar_cache[mk] = get_bars(ev["market"], ev["code"], first.replace(day=1), today)
        bars = bar_cache[mk]
        a = analyse_event(ev, bars)
        if a:
            events.append(a)
            recent = len(bars) >= 11 and ev["end"] >= bars[-11]["d"]
            if a["status"] != "ended" or recent:
                a["signals"] = live_signals(ev, bars)
        elif bars and ev["start"] > bars[-1]["d"]:
            # 已公告、還沒開始處置
            live.append({"market": ev["market"], "code": ev["code"], "name": ev["name"], "k": ev["k"],
                         "pub": ev["pub"], "start": ev["start"], "end": ev["end"], "status": "announced",
                         "lastClose": bars[-1]["c"] if bars else None, "signals": live_signals(ev, bars)})

    stats = aggregate(events)
    last_date = max((e["last"] for e in events), default=None)
    data = {
        "generatedAt": dt.datetime.now(TZ).isoformat(timespec="minutes"),
        "lastTradingDate": last_date,
        "ruleStart": args.start,
        "cost": COST,
        "holds": HOLDS,
        "entries": [{"key": k, "name": n, "desc": d} for k, n, d in ENTRIES],
        "groups": [{"key": k, "name": n} for k, n in GROUPS],
        "stats": stats,
        "best5": best_entries(stats, "5"),
        "best10": best_entries(stats, "10"),
        "events": events,
        "upcoming": live,
    }
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), "utf-8")
    print(f"寫入 {OUT_FILE}：{len(events)} 件事件，最後交易日 {last_date}")


if __name__ == "__main__":
    main()
