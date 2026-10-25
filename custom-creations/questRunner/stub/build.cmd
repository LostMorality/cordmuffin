@echo off
rem Rebuilds stub.exe and regenerates ../stubBinary.ts. Needs VS 2022 Build Tools (C++).
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
cd /d "%~dp0"
cl /nologo /O1 /GS- /W3 stub.c /link /NODEFAULTLIB /ENTRY:WinMainCRTStartup /SUBSYSTEM:WINDOWS kernel32.lib user32.lib /OUT:stub.exe || exit /b 1
del stub.obj
node -e "const b=require('fs').readFileSync('stub.exe').toString('base64');require('fs').writeFileSync('../stubBinary.ts','/*\n * cordmuffin\n * Copyright (c) 2026 cordmuffin contributors\n * SPDX-License-Identifier: GPL-3.0-or-later\n */\n\n// Built from stub/stub.c by stub/build.cmd.\nexport const STUB_EXE_BASE64 = \"'+b+'\";\n')"
