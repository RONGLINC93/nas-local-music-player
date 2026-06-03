@echo off
chcp 65001 >nul
title Git Pull 一键拉取

echo ======================================
echo         Git Pull 一键拉取脚本
echo ======================================
echo.

echo 📁 当前目录: %cd%
echo.

echo 🔄 拉取远程最新代码...
git pull

if errorlevel 1 (
    echo.
    echo ❌ 拉取失败
) else (
    echo.
    echo ✅ 拉取成功！
)

echo.
echo ======================================
pause