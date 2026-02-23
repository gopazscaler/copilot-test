param(
  [int]$Parallelism = 2
)

$ErrorActionPreference = "Stop"

$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
$env:NPM_CONFIG_STRICT_SSL = "false"

function Test-Command($name) {
  $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

function Ensure-Node {
  if (Test-Command "node") { return }

  $nodePath = Join-Path $env:ProgramFiles "nodejs\node.exe"
  $npmPath = Join-Path $env:ProgramFiles "nodejs\npm.cmd"
  if ((Test-Path $nodePath) -and (Test-Path $npmPath)) {
    $env:Path = "$env:ProgramFiles\nodejs;" + $env:Path
    if (Test-Command "node") { return }
  }

  Write-Host "[INFO] Node.js not found. Installing Node.js LTS via winget..."
  if (-not (Test-Command "winget")) {
    throw "winget not found. Please install Node.js LTS manually from https://nodejs.org and re-run."
  }

  winget install -e --id OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements
  $installExit = $LASTEXITCODE

  if (-not (Test-Path $nodePath) -or -not (Test-Path $npmPath)) {
    throw "Node.js install completed but node/npm not found. Please re-open PowerShell and re-run."
  }

  $env:Path = "$env:ProgramFiles\nodejs;" + $env:Path
  if (-not (Test-Command "node")) {
    throw "Node.js installed but not available on PATH. Please re-open PowerShell and re-run."
  }

  if ($installExit -ne 0) {
    Write-Host "[WARN] winget returned exit code $installExit, but Node.js is installed and available. Continuing."
  }
}

function Ensure-Dependencies($workDir) {
  Push-Location $workDir
  if (-not (Test-Path "package.json")) {
    npm init -y | Out-Null
  }
  if (-not (Test-Path "node_modules\playwright")) {
    npm install playwright
  }
  $env:NODE_TLS_REJECT_UNAUTHORIZED="0"
  npx playwright install
  Pop-Location
}

$workDir = Split-Path -Parent $PSCommandPath
Ensure-Node
Ensure-Dependencies $workDir

Push-Location $workDir

if ($Parallelism -lt 1) {
  $Parallelism = 2
}
$env:PARALLELISM = "$Parallelism"

 $markerFile = Join-Path $workDir "copilot_login_done"
 $needsLogin = $true
 if (Test-Path $markerFile) {
   Write-Host "[INFO] Login marker found; verifying existing session..."
   $env:AUTH_CHECK_ONLY = "1"
   $env:LOGIN_ONLY = "0"
   $env:HEADLESS = "true"
   node .\copilot_test.js
   $authExit = $LASTEXITCODE
   Write-Host "[INFO] Auth-check exit code $authExit"
   if ($authExit -eq 0) {
     $needsLogin = $false
     Write-Host "[INFO] Session valid; skipping login-only run."
   } elseif ($authExit -eq 2) {
     Write-Host "[INFO] Session invalid; login required."
   } elseif ($authExit -eq 130) {
     Write-Host "[INFO] Auth check cancelled by user (Ctrl+C)."
     exit 130
   } else {
     throw "Auth check failed (exit code $authExit)."
   }
 }

 if ($needsLogin) {
  Write-Host "[INFO] Starting login-only run (headful)..."
  $env:AUTH_CHECK_ONLY = "0"
  $env:LOGIN_ONLY = "1"
  $env:HEADLESS = "false"
  node .\copilot_test.js
  $loginExit = $LASTEXITCODE
  Write-Host "[INFO] Login-only run finished with exit code $loginExit"
  if ($loginExit -eq 130) {
    Write-Host "[INFO] Login-only run cancelled by user (Ctrl+C)."
    exit 130
  }
  if ($loginExit -ne 0) {
    throw "Login-only run failed (exit code $loginExit)."
  }
  New-Item -ItemType File -Path $markerFile -Force | Out-Null
}

Write-Host "[INFO] Starting main run (headless)..."
$env:LOGIN_ONLY = "0"
$env:HEADLESS = "true"
$env:AUTH_CHECK_ONLY = "0"
node .\copilot_test.js
$mainExit = $LASTEXITCODE
if ($mainExit -ne 0) {
  Write-Host "[INFO] Main run exited with code $mainExit"
  exit $mainExit
}

Pop-Location
