"""離線測試：用假資料（格式照抄證交所/櫃買實際回傳）跑完整流程。"""
import datetime as dt, random, sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import disposition_backtest as bt

random.seed(1)
bt.time.sleep = lambda *_: None
bt.CACHE_DIR = Path("/tmp/dbt_cache")
bt.OUT_FILE = Path("/tmp/dbt_out/data.json")
TODAY = dt.date(2026, 10, 14)

# trading days
days, d = [], dt.date(2026, 5, 1)
while d <= TODAY:
    if d.weekday() < 5:
        days.append(d)
    d += dt.timedelta(days=1)
roc = lambda d: f"{d.year-1911}/{d.month:02d}/{d.day:02d}"
CODES = {"twse": [str(2400+i) for i in range(20)], "tpex": [str(3200+i) for i in range(20)]}
PX = {}
for m, cs in CODES.items():
    for c in cs:
        p, rows = 50.0, []
        for dd in days:
            o = p * (1 + random.uniform(-.02, .02)); p = max(5, p * (1 + random.gauss(0.004, 0.035)))
            rows.append([roc(dd), "1,234,000", "61,700,000", f"{o:.2f}", f"{max(o,p)*1.01:.2f}", f"{min(o,p)*.99:.2f}", f"{p:.2f}", "0.5", "999"])
        PX[(m, c)] = rows

def ev(i, code):
    s = days[i]; e = days[i + 4]; pub = days[i - 1]
    return s, e, pub

def fake(url, params, **k):
    if "punish" in url:
        data = []
        for n, (code, i, kind) in enumerate([(c, 70+j%40, "第一次處置") for j,c in enumerate(CODES["twse"])] + [(c, 76+j%35, "第二次處置") for j,c in enumerate(CODES["twse"][:10])] + [("2401", 90, "人工管制撮合"), ("035348", 90, "第一次處置")]):
            s, e, pub = ev(i, code)
            data.append([n, roc(pub), code, "名稱", 1, "連續三次", f"{roc(s)}～{roc(e)}", kind, "...", ""])
        # an announced-but-not-started event (starts tomorrow)
        data.append([99, roc(TODAY), "2403", "欣興", 2, "連續三次", "115/10/15～115/10/21", "第二次處置", "...", ""])
        return {"stat": "OK", "data": data}
    if "disposal" in url:
        data = []
        for n, (code, i, kind) in enumerate([(c, 70+j*2, "第一次處置") for j,c in enumerate(CODES["tpex"])] + [(c, 82+j*2, "再次處置") for j,c in enumerate(CODES["tpex"][:12])]):
            s, e, pub = ev(min(i, len(days) - 5), code)
            data.append([n, roc(pub), code, f"名稱(../x.html?code={code})", 1, f"{roc(s)}~{roc(e)}", "連續3個營業日", kind, "...", "1", "1", ""])
        return {"tables": [{"data": data}], "stat": "ok"}
    if "STOCK_DAY" in url:
        ym = params["date"][:6]; code = params["stockNo"]
        return {"stat": "OK", "data": [r for r in PX[("twse", code)] if f"{int(r[0][:3])+1911}{r[0][4:6]}" == ym]}
    if "tradingStock" in url:
        y, m, _ = params["date"].split("/"); code = params["code"]
        return {"tables": [{"data": [r for r in PX[("tpex", code)] if f"{int(r[0][:3])+1911}/{r[0][4:6]}" == f"{y}/{m}"]}]}
    raise ValueError(url)

bt.get_json = fake
# ensure the far-future event range is valid for padding
sys.argv = ["x", "--today", TODAY.isoformat()]
bt.main()
d = json.loads(bt.OUT_FILE.read_text())
print("events", len(d["events"]), "upcoming", len(d["upcoming"]))
print("best5", d["best5"])
print("sample", json.dumps(d["events"][-1], ensure_ascii=False)[:600])
