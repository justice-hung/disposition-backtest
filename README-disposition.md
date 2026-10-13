# 處置股回測頁

每天盤後自動抓證交所與櫃買中心的處置公告和日 K，回測處置新制（2026-08-10 起）之後各種買點的勝率，
產生 `docs/disposition/data.json`，由 `docs/disposition/index.html` 顯示。

## 檔案

| 檔案 | 用途 |
|---|---|
| `scripts/disposition_backtest.py` | 抓資料、回測、輸出 data.json |
| `docs/disposition/index.html` | 回測頁（純靜態，讀同資料夾的 data.json） |
| `.github/workflows/disposition-backtest.yml` | 每個交易日 18:40（台北）自動執行並 commit |
| `data/disposition/cache/` | 日 K 快取（執行後自動產生，已收完的月份不重抓） |
| `tests/mock_run.py` | 離線測試（假資料） |

## 安裝步驟

1. 把這些檔案放進你的網站 repo 根目錄（保留資料夾結構），push 上去。
2. **Settings → Pages**：Source 選 `Deploy from a branch`，Branch 選 `main`、資料夾選 `/docs`。
   （如果你的網站已經用別的方式部署，只要讓 `docs/disposition/` 跟著發布就好。）
3. **Settings → Actions → General → Workflow permissions** 選 `Read and write permissions`。
4. 到 **Actions → 處置股回測每日更新 → Run workflow** 手動跑第一次。
   第一次要抓所有處置股約 5 個月的日 K，大約 20–30 分鐘；之後每天只抓當月，幾分鐘就好。
5. 開 `https://<你的帳號>.github.io/<repo>/disposition/` 就能看到。

## 本機執行

```bash
pip install -r requirements-disposition.txt
python scripts/disposition_backtest.py
cd docs/disposition && python -m http.server 8000   # 打開 http://localhost:8000
```

## 調整

- 起算日：`--start 2026-08-10`（預設就是新制上路日）
- 交易成本：`COST = 0.006`
- 持有天數：`HOLDS = [3, 5, 10, 20]`
- 買點定義：`ENTRIES` 與 `analyse_event()`
- 分組：`GROUPS` 與 `in_group()`（頁面上的 `inGroup()` 要同步改）

## 如果 Actions 抓不到資料

證交所偶爾會擋海外或雲端 IP。若 log 出現大量 `! 403` 或逾時，改成在自己電腦跑
`python scripts/disposition_backtest.py` 再 commit/push，或用 Windows 工作排程器每天執行一次。
