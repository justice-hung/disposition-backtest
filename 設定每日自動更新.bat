@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 回測已改由 GitHub Actions 每天自動更新，電腦上的排程不需要了：如果之前設定過就移除
schtasks /Delete /TN DispositionBacktest /F >nul 2>&1
echo.
echo 回測已改成 GitHub 每天自動更新，電腦不用開著。
echo 這個檔案可以刪掉。
pause
