# Hey Gemma, No Internet - DevFest Mangaluru 2026 workshop setup (Windows 10/11)
#
#   powershell -ExecutionPolicy Bypass -c "irm https://sayed-imran.github.io/devfest-mangaluru-2026-voicebot/setup.ps1 | iex"
#
# What it does (safe to re-run; anything already present is skipped):
#   1. Git, nvm-windows + Node.js LTS   (via winget; one UAC prompt when nvm switches Node)
#   2. Python 3.10+                     (uses yours if it is new enough, else installs 3.12 via winget)
#   3. clones the workshop repo, runs `npm install` once, and pre-installs the phase 05 Python packages
#
# Options (set before running):
#   $env:DEVFEST_DIR = "D:\somewhere"   where to clone the repo  (default: ~\devfest-mangaluru-2026-voicebot)
#   $env:SKIP_REPO   = "1"              only install the tools; don't clone or install the workshop
#
# Note: this file is kept plain ASCII on purpose (Windows PowerShell 5.1 + irm mangle UTF-8).

function Invoke-DevfestSetup {
  # Not 'Stop': Windows PowerShell 5.1 turns any stderr output of git/npm/nvm into a fatal error.
  # Native commands are checked through $LASTEXITCODE instead, and Fail throws.
  $ErrorActionPreference = 'Continue'
  $ProgressPreference = 'SilentlyContinue'

  $NodeMajor = '24'
  $PythonWinget = 'Python.Python.3.12'
  $RepoUrl = 'https://github.com/sayed-imran/devfest-mangaluru-2026-voicebot.git'
  $Dest = if ($env:DEVFEST_DIR) { $env:DEVFEST_DIR } else { Join-Path $HOME 'devfest-mangaluru-2026-voicebot' }

  function Step($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
  function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
  function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
  function Fail($m) { throw $m }

  # Re-read PATH and nvm variables after an installer changed them (no new window needed).
  function Update-SessionEnv {
    foreach ($name in 'NVM_HOME', 'NVM_SYMLINK') {
      $v = [Environment]::GetEnvironmentVariable($name, 'User')
      if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name, 'Machine') }
      if ($v) { Set-Item "env:$name" $v }
    }
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
    # The variables inside PATH (%NVM_HOME%) are not expanded when read this way.
    $env:Path = [Environment]::ExpandEnvironmentVariables($env:Path)
  }

  function Install-WithWinget($id, $label) {
    Write-Host "  installing $label (winget $id) ..."
    winget install -e --id $id --silent --accept-source-agreements --accept-package-agreements | Out-Null
    # -1978335189 = already installed / no newer version
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
      Fail "winget could not install $label (exit code $LASTEXITCODE)."
    }
    Update-SessionEnv
  }

  # Returns a command that runs Python 3.10+ able to create a venv, or $null.
  function Find-Python {
    $candidates = @(
      @('py', '-3.13'), @('py', '-3.12'), @('py', '-3.11'), @('py', '-3.10'), @('py', '-3'),
      @('python'),
      @((Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'))
    )
    foreach ($c in $candidates) {
      $exe = $c[0]
      $pre = @($c | Select-Object -Skip 1)
      if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
      # The Microsoft Store "python" stub fails this check (it prints a hint and exits non-zero).
      & $exe @pre -c "import sys, venv, ensurepip; sys.exit(sys.version_info < (3, 10))" 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { return , $c }
    }
    return $null
  }

  Write-Host "Hey Gemma, No Internet - DevFest Mangaluru 2026 workshop setup" -ForegroundColor White

  # ---------------------------------------------------------------- prerequisites
  Step 'Checking prerequisites'
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Fail "winget is missing. Install 'App Installer' from the Microsoft Store (https://aka.ms/getwinget), then re-run."
  }
  Ok 'winget found'

  # Windows blocks npm.ps1 by default ("running scripts is disabled on this system"),
  # which breaks `npm run dev` in a normal PowerShell window. RemoteSigned for this user fixes it.
  $userPolicy = Get-ExecutionPolicy -Scope CurrentUser
  $machinePolicy = Get-ExecutionPolicy -Scope LocalMachine
  if ($userPolicy -in 'Undefined', 'Restricted' -and $machinePolicy -in 'Undefined', 'Restricted') {
    try {
      Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force -ErrorAction Stop
      Ok 'PowerShell execution policy set to RemoteSigned for your user (lets npm run)'
    } catch { Warn 'could not change the execution policy; use npm.cmd instead of npm if npm is blocked' }
  } else { Ok "PowerShell execution policy: $userPolicy / $machinePolicy" }

  if (Get-Command git -ErrorAction SilentlyContinue) { Ok 'git found' }
  else { Install-WithWinget 'Git.Git' 'Git'; Ok 'git installed' }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    $gitBin = Join-Path $env:ProgramFiles 'Git\cmd'
    if (Test-Path $gitBin) { $env:Path = "$gitBin;$env:Path" } else { Fail 'git is still not on PATH. Open a new PowerShell window and re-run.' }
  }

  # ---------------------------------------------------------------- nvm-windows
  Step 'nvm-windows (Node Version Manager)'
  Update-SessionEnv
  if (-not (Get-Command nvm -ErrorAction SilentlyContinue)) {
    $existingNode = Get-Command node -ErrorAction SilentlyContinue
    if ($existingNode) {
      Warn "Node is already installed outside nvm ($($existingNode.Source))."
      Warn "If 'nvm use' fails below, uninstall that Node from Settings > Apps and re-run this script."
    }
    Install-WithWinget 'CoreyButler.NVMforWindows' 'nvm-windows'
  }
  if (-not (Get-Command nvm -ErrorAction SilentlyContinue) -and $env:NVM_HOME) {
    $env:Path = "$env:NVM_HOME;$env:Path"
  }
  if (-not (Get-Command nvm -ErrorAction SilentlyContinue)) {
    Fail 'nvm was installed but is not on PATH yet. Close this window, open a new PowerShell, and run the same command again.'
  }
  Ok "nvm $((nvm version | Out-String).Trim())"

  # ---------------------------------------------------------------- Node.js
  Step "Node.js $NodeMajor LTS"
  $nodeVersion = $null
  try {
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -ErrorAction Stop
    $nodeVersion = ($index | Where-Object { $_.version -like "v$NodeMajor.*" } | Select-Object -First 1).version.TrimStart('v')
  } catch { }
  if (-not $nodeVersion) { Fail 'Could not look up the latest Node.js version (check your internet connection).' }

  $installed = (nvm list | Out-String)
  if ($installed -match [regex]::Escape($nodeVersion)) { Ok "Node $nodeVersion already installed" }
  else {
    nvm install $nodeVersion | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail "nvm install $nodeVersion failed." }
    Ok "installed Node $nodeVersion"
  }
  Write-Host '  switching to it (Windows may ask for permission - click Yes) ...'
  nvm use $nodeVersion | Out-Host
  Update-SessionEnv
  if ($env:NVM_SYMLINK -and -not ($env:Path -split ';' -contains $env:NVM_SYMLINK)) { $env:Path = "$env:NVM_SYMLINK;$env:Path" }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "node is not on PATH after 'nvm use'. Open a new PowerShell and run: nvm use $nodeVersion"
  }
  # npm.cmd (not npm) so a restrictive execution policy can't block npm.ps1
  Ok "node $(node -v), npm $(npm.cmd -v)"

  # ---------------------------------------------------------------- Python
  Step 'Python 3.12+ (3.10 minimum)'
  $py = Find-Python
  if ($py) { Ok "using $(& $py[0] @($py | Select-Object -Skip 1) --version 2>&1) ($($py -join ' '))" }
  else {
    Warn 'no Python 3.10+ found; installing Python 3.12'
    Install-WithWinget $PythonWinget 'Python 3.12'
    $py = Find-Python
    if (-not $py) { Fail 'Python installed, but this window cannot see it yet. Open a new PowerShell and re-run.' }
    Ok "installed $(& $py[0] @($py | Select-Object -Skip 1) --version 2>&1)"
  }

  # ---------------------------------------------------------------- workshop repo
  if ($env:SKIP_REPO -eq '1') {
    Step 'Skipping the workshop repo (SKIP_REPO=1)'
  } else {
    Step "Workshop repo -> $Dest"
    if (Test-Path (Join-Path $Dest '.git')) {
      git -C $Dest pull --ff-only --quiet
      if ($LASTEXITCODE -ne 0) { Warn "could not fast-forward $Dest; using it as is" } else { Ok 'updated existing clone' }
    } elseif (Test-Path $Dest) {
      Fail "$Dest exists and is not a git clone. Move it away or set `$env:DEVFEST_DIR to another folder."
    } else {
      git clone --quiet $RepoUrl $Dest
      if ($LASTEXITCODE -ne 0) { Fail 'git clone failed.' }
      Ok 'cloned'
    }

    Step 'npm install (all five phases, one download)'
    Push-Location $Dest
    try {
      $env:npm_config_update_notifier = 'false'
      npm.cmd install --no-audit --no-fund --loglevel=error
      if ($LASTEXITCODE -ne 0) { Fail 'npm install failed.' }
    } finally { Pop-Location }
    Ok 'node_modules ready'

    Step 'Phase 05 tools service: Python packages'
    $ts = Join-Path $Dest 'phase-05\tools-service'
    $venvPy = Join-Path $ts '.venv\Scripts\python.exe'
    if (-not (Test-Path $venvPy)) {
      & $py[0] @($py | Select-Object -Skip 1) -m venv (Join-Path $ts '.venv')
      if ($LASTEXITCODE -ne 0) { Fail 'Could not create the Python virtual environment.' }
    }
    & $venvPy -m pip install --disable-pip-version-check -q -r (Join-Path $ts 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { Fail 'pip install failed.' }
    Ok "$ts\.venv ready ($(& $venvPy --version))"
  }

  # ---------------------------------------------------------------- done
  Write-Host ""
  Write-Host "All set." -ForegroundColor Green
  Write-Host ""
  Write-Host "  Open a new terminal, then:"
  Write-Host ""
  if ($env:SKIP_REPO -eq '1') {
    Write-Host "    git clone $RepoUrl"
    Write-Host "    cd devfest-mangaluru-2026-voicebot; npm install"
  } else {
    Write-Host "    cd `"$Dest`""
  }
  Write-Host "    cd phase-01; npm run dev        # http://localhost:3000"
  Write-Host ""
  Write-Host "  Bring headphones. See you at DevFest Mangaluru!" -ForegroundColor DarkGray
}

# Errors are reported without `exit`, so the PowerShell window stays open when run via `irm | iex`.
try { Invoke-DevfestSetup }
catch {
  Write-Host ""
  Write-Host "Setup stopped: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Fix the issue above and run the same command again - finished steps are skipped." -ForegroundColor Red
}
