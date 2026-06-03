@echo off
chcp 65001 >nul
title Git Push 一键推送

echo ======================================
echo         Git Push 一键推送脚本
echo ======================================
echo.

echo 📁 当前目录: %cd%
echo.

echo 🔍 检查文件状态...
git status
echo.

echo 📥 添加所有更改...
git add .
echo.

for /f "tokens=1-4 delims=/ " %%i in ("%date%") do (
    set date_str=%%l-%%j-%%k
)
set time_str=%time:~0,2%:%time:~3,2%:%time:~6,2%
set message=Update: %date_str% %time_str%

echo 📝 提交更改，消息: %message%
git commit -m "%message%"
if errorlevel 1 (
    echo.
    echo ❌ 提交失败
    pause
    exit /b 1
)

echo.
echo 📤 推送到远程仓库...
git push
if errorlevel 1 (
    echo.
    echo ❌ 推送失败
) else (
    echo.
    echo ✅ 推送成功！
)

echo.
echo ======================================
pause