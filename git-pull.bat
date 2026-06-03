@echo off
title Git Pull

echo ======================================
echo         Git Pull Script
echo ======================================
echo.

echo Directory: %cd%
echo.

echo Pulling latest code...
git pull

if errorlevel 1 (
    echo.
    echo FAILED
    pause
    exit /b 1
)

echo.
echo SUCCESS

echo.
echo ======================================
pause