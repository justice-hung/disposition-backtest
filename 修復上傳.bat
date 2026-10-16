@echo off
chcp 65001 >nul
title 處置股回測 - 修復上傳
cd /d "%~dp0"
echo.
echo  取消剛才卡住的合併，改用電腦上的版本覆蓋 GitHub...
echo  （GitHub 上多出來的只是舊版自動排程產生的資料，可以覆蓋）
echo.
git rebase --abort
git checkout main
git add -A
git commit -m "改成 Node 版回測網頁"
git push --force origin main
echo.
if errorlevel 1 (echo  ❌ 還是失敗，請把這個畫面截圖給 Claude。) else (echo  ✅ 上傳完成！這個「修復上傳.bat」可以刪掉了。)
echo.
pause
