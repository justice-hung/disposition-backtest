/**
 * LINE 通知：把 backtest.mjs 產生的 notify.txt 推播到你的 LINE（LINE Messaging API，用你自己的官方帳號）
 * 需要在 GitHub repo 的 Settings → Secrets and variables → Actions 設定：
 *   LINE_TOKEN ＝ Messaging API 的 Channel access token（長期）
 *   LINE_TO    ＝ 你自己的 LINE userId（U 開頭那串）
 * 沒設定就自動略過，不影響回測。notify.txt 只有「新的一個交易日」才會產生，所以同一天不會重複通知。
 */
import fs from "node:fs";
const token = process.env.LINE_TOKEN, to = process.env.LINE_TO;
const file = new URL("./notify.txt", import.meta.url);
if (!fs.existsSync(file)) { console.log("今天沒有新的通知內容（同一天已通知過或資料沒更新）"); process.exit(0); }
if (!token || !to) { console.log("沒有設定 LINE_TOKEN / LINE_TO，略過 LINE 通知"); process.exit(0); }
const text = fs.readFileSync(file, "utf8").slice(0, 4900);
const res = await fetch("https://api.line.me/v2/bot/message/push", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
});
if (!res.ok) { console.log(`❌ LINE 通知失敗：HTTP ${res.status} ${(await res.text()).slice(0, 300)}`); process.exitCode = 1; }
else console.log("✅ 已送出 LINE 通知");
