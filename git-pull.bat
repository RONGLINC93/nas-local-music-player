@echo off
title Git Pull

echo ======================================
echo         Git Pull Script
echo ======================================
echo.

echo Directory: %cd%
echo.

echo Pulling...
git pull

if errorlevel 1 (
    echo.
    echo FAILED
) else (
    echo.
    echo SUCCESS
)

echo.
echo ======================================
pause