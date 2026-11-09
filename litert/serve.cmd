@echo off
rem Start LiteRT-LM's OpenAI-compatible server for the workshop.
rem
rem   litert\serve.cmd                 gemma4-e4b (laptop default)
rem   litert\serve.cmd gemma4-e2b      Raspberry Pi / 8GB machines
rem   litert\serve.cmd gemma4-26b      DGX Spark
rem
rem Imports the model into the local registry on first run, then serves it on :8081.
setlocal

set "ALIAS=%~1"
if "%ALIAS%"=="" set "ALIAS=gemma4-e4b"
if "%LITERT_HOST%"=="" set "LITERT_HOST=127.0.0.1"
if "%LITERT_PORT%"=="" set "LITERT_PORT=8081"

if /i "%ALIAS%"=="gemma4-e2b" (
  set "REPO=litert-community/gemma-4-E2B-it-litert-lm"
  set "FILE=gemma-4-E2B-it.litertlm"
) else if /i "%ALIAS%"=="gemma4-e4b" (
  set "REPO=litert-community/gemma-4-E4B-it-litert-lm"
  set "FILE=gemma-4-E4B-it.litertlm"
) else if /i "%ALIAS%"=="gemma4-12b" (
  set "REPO=litert-community/gemma-4-12B-it-litert-lm"
  set "FILE=gemma-4-12B-it.litertlm"
) else if /i "%ALIAS%"=="gemma4-26b" (
  set "REPO=litert-community/gemma-4-26B-A4B-it-litert-lm"
  set "FILE=gemma-4-26B-A4B-it.litertlm"
) else (
  echo Unknown alias: %ALIAS%
  echo Use one of: gemma4-e2b, gemma4-e4b, gemma4-12b, gemma4-26b
  exit /b 1
)

where litert-lm >nul 2>&1
if errorlevel 1 (
  echo litert-lm is not installed. Run:  uv tool install litert-lm
  exit /b 1
)

litert-lm list 2>nul | findstr /i /c:"%ALIAS%" >nul
if errorlevel 1 (
  echo ==^> Importing %REPO% as "%ALIAS%" ^(first run only, this downloads weights^)
  litert-lm import --from-huggingface-repo=%REPO% %FILE% %ALIAS%
  if errorlevel 1 exit /b 1
)

echo ==^> Serving "%ALIAS%" on http://%LITERT_HOST%:%LITERT_PORT%/v1
echo     Point the app's LLM_BASE_URL at that address and LLM_MODEL at "%ALIAS%".
litert-lm serve --host %LITERT_HOST% --port %LITERT_PORT%
