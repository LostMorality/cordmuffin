@echo off
setlocal
rem Rebuilds stub.exe and regenerates ../stubBinary.ts. Only needed to rebuild the stand-in from source:
rem the plugin already ships a built copy in stubBinary.ts.
rem Needs the Visual Studio C++ build tools (any edition, 2017 or newer) and Node.js. Offers to install what's missing.
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js is needed to finish the build. Get it from https://nodejs.org or run:
    echo     winget install --id OpenJS.NodeJS.LTS --exact
    exit /b 1
)

rem Already inside a developer prompt: use that compiler.
where cl >nul 2>&1
if not errorlevel 1 goto build

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VSPATH="
if exist "%VSWHERE%" (
    for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%i"
)
if not defined VSPATH goto notools
if not exist "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" goto notools
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cd /d "%~dp0"
goto build

:notools
echo The Visual Studio C++ build tools weren't found.
echo They're free and about 2-3 GB. You can also get them from https://visualstudio.microsoft.com/visual-cpp-build-tools/
echo (pick "Desktop development with C++").
where winget >nul 2>&1
if errorlevel 1 exit /b 1
choice /c YN /m "Install them now with winget"
if errorlevel 2 exit /b 1
winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --accept-package-agreements --accept-source-agreements --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
if errorlevel 1 (
    echo The install didn't finish. Try the link above instead.
    exit /b 1
)
echo Installed. Run build.cmd again.
exit /b 0

:build
cl /nologo /O1 /GS- /W3 stub.c /link /NODEFAULTLIB /ENTRY:WinMainCRTStartup /SUBSYSTEM:WINDOWS kernel32.lib user32.lib /OUT:stub.exe || exit /b 1
del stub.obj
node -e "const b=require('fs').readFileSync('stub.exe').toString('base64');require('fs').writeFileSync('../stubBinary.ts','/*\n * cordmuffin\n * Copyright (c) 2026 cordmuffin contributors\n * SPDX-License-Identifier: GPL-3.0-or-later\n */\n\n// Built from stub/stub.c by stub/build.cmd.\nexport const STUB_EXE_BASE64 = \"'+b+'\";\n')" || exit /b 1
echo Built stub.exe and updated ../stubBinary.ts.
