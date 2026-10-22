@echo off
setlocal
where go >nul 2>nul
if errorlevel 1 (
  echo Go is required. Install Go 1.25+ and restart your terminal.
  exit /b 1
)
pushd "%~dp0backend"
go run ./cmd/deploy
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%
