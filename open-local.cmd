@echo off
rem Opens the Tempest Rising database in the default browser.
rem The path is resolved relative to this file, so it can be moved anywhere.
rem Messages are plain ASCII: the Windows console reads .cmd files in the
rem system code page, and non-ASCII text turns into garbage here.

setlocal
set "PAGE=%~dp0web\index.html"

if not exist "%PAGE%" (
  echo.
  echo   Not found: %PAGE%
  echo.
  echo   The page is missing or was not generated. Run:
  echo     npm run build
  echo.
  pause
  exit /b 1
)

start "" "%PAGE%"
endlocal
