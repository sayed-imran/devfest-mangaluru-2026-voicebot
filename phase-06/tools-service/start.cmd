@echo off
rem Windows: create .venv on first run, install requirements, start the tools service.
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" goto install
where py >nul 2>nul
if errorlevel 1 goto use_python
py -3 -m venv .venv
goto check_venv
:use_python
python -m venv .venv
:check_venv
if not exist ".venv\Scripts\python.exe" (
  echo Could not create .venv. Install Python 3.10+ from https://www.python.org/downloads/ and run this again.
  exit /b 1
)

:install
".venv\Scripts\python.exe" -c "import sys; sys.exit(sys.version_info < (3, 10))"
if errorlevel 1 (
  echo Python 3.10 or newer is required. Delete the .venv folder and run this again with a newer Python.
  exit /b 1
)
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 exit /b 1
".venv\Scripts\python.exe" -m gemma_tools %*
