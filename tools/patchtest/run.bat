@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
    echo patchtest needs Node.js 22 or newer: https://nodejs.org
    if "%~1"=="" pause
    exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
    echo Node.js %NODE_MAJOR% is too old for patchtest, install 22 or newer: https://nodejs.org
    if "%~1"=="" pause
    exit /b 1
)
if "%~1"=="" (
    node "%~dp0patchtest.mjs" --help
    echo.
    echo Run it from a terminal: run.bat ^<plugin folder^>
    pause
    exit /b 0
)
node "%~dp0patchtest.mjs" %*
exit /b %ERRORLEVEL%
