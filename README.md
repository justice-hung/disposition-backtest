# 處置股回測

網頁：https://justice-hung.github.io/disposition-backtest/ （手機也能看）

GitHub Actions 每個交易日台灣時間 19:40 自動抓證交所／櫃買的處置公告與日 K、重算回測，
推回 repo 後 GitHub Pages 自動更新網頁，電腦不用開著。

## 檔案

| 檔案 | 用途 |
|---|---|
| index.html | 回測網頁（讀同資料夾的 data.js） |
| backtest.mjs | 回測主程式（Node.js） |
| data.js | 回測結果（Actions 每天自動更新） |
| cache/ | 日 K 快取（已收完的月份不重抓） |
| .github/workflows/disposition-backtest.yml | 每日自動更新排程 |
| 發佈到GitHub.bat | 改了程式後點這個上傳 |
| 更新回測.bat | 把 GitHub 上的最新結果下載到電腦並打開網頁 |
| tests/mock.mjs | 離線測試（假資料） |

## 回測規則重點

- 只算 2026-08-10 處置新制上路後開始的處置；普通股；排除權證、ETF、人工管制撮合。報酬扣 0.6% 成本。
- 資料在收盤後才更新，所以「收黑、跌破均線」一律用隔天開盤價回測；
  「公告日收盤」因為公告在收盤後才出來，標成「需預判」、不列入最佳買點。
- 網頁最上面「明天可以買」只列明天來得及執行的買點。

## 注意

網頁網址是公開的（知道網址的人都看得到），已設定不讓搜尋引擎收錄。
