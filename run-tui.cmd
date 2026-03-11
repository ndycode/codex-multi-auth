@echo off
setlocal
set "ROOT=%~dp0"
set "SANDBOX=%ROOT%.sandbox\manual-check"
set "CODEX_HOME=%SANDBOX%\codex-home"
set "CODEX_MULTI_AUTH_DIR=%CODEX_HOME%\multi-auth"
set "CODEX_MULTI_AUTH_CONFIG_PATH=%CODEX_MULTI_AUTH_DIR%\config.json"
set "HOME=%SANDBOX%\home"
set "USERPROFILE=%HOME%"
set "XDG_CONFIG_HOME=%SANDBOX%\xdg-config"
"C:\Users\neil\.bun\bin\bun.exe" run runtime\opentui\index.tsx
