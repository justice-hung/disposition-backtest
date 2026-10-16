@echo off
chcp 65001 >nul
title 處置股回測 - 下載最新結果
cd /d "%~dp0"
echo.
echo  回測已改成 GitHub 每天 18:40 自動更新，這裡只是把最新結果下載到電腦...
git pull --rebase --autostash
start "" "%~dp0index.html"
timeout /t 5
