@echo off
setlocal
cd /d "%~dp0"
title bleepblorp 0.2 - Strategist member beta testing

echo.
echo  bleepblorp 0.2 - Strategist member beta testing
echo  Educational paper assistant. Not financial advice.
echo  All trading involves risk. You are responsible for any use of this software.
echo  This bot does not place Kalshi orders.
echo.

if not exist "%~dp0package.json" (
  echo ERROR: package.json not found.
  echo Unzip the pack, then run this file from the folder that also contains
  echo START HERE.txt and package.json ^(not a parent folder^).
  echo.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed ^(or this window was open before you installed it^).
  echo 1. Install Node.js 20 LTS from https://nodejs.org
  echo 2. Close this window, open Start-bleepblorp.bat again.
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)

if not exist "%~dp0.env.local" (
  copy /Y "%~dp0.env.example" "%~dp0.env.local" >nul
  echo Created .env.local from the template.
  echo Kalshi keys are optional for a first look. See the manual, section 4.
  echo.
)

if not exist "%~dp0node_modules\" (
  echo First-time install: downloading packages. This can take a few minutes.
  echo If this fails, unzip to C:\bleepblorp-0.2 instead of OneDrive/Desktop.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. See bleepblorp-0.2-manual.txt troubleshooting.
    pause
    exit /b 1
  )
)

if not exist "%~dp0.next\" (
  echo Building... first build can take a minute.
  echo.
  call npm run build
  if errorlevel 1 (
    echo.
    echo Build failed. See bleepblorp-0.2-manual.txt troubleshooting.
    pause
    exit /b 1
  )
)

echo.
echo Starting. When the terminal says Ready, open:
echo   http://localhost:3000
echo Leave this window open while you use the bot. Ctrl+C stops it.
echo.

call npm run start
echo.
echo Server stopped.
pause
