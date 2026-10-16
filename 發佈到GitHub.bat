@echo off
chcp 65001 >nul
title 處置股回測 - 發佈到 GitHub
cd /d "%~dp0"
echo.
echo  正在把這個資料夾的修改上傳到 GitHub...
echo.
git add -A
git commit -m "更新 %date% %time%"
rem 雲端每天也會推回測資料上去，先拉下最新版本再推，避免上傳失敗
git pull --rebase --autostash
git push
echo.
if errorlevel 1 (echo  ❌ 上傳失敗，請把這個畫面截圖給 Claude。) else (echo  ✅ 上傳完成！網頁約 1~2 分鐘後更新：https://justice-hung.github.io/disposition-backtest/)
echo.
pause
