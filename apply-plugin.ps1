# apply-plugin.ps1
# Deploy the local-context plugin from this repo to the installed opencode config.
# Run from anywhere - the script resolves its own location automatically.
#
# Usage (from any directory):
#   & 'E:\_tools\strata\opencode-plugin\apply-plugin.ps1'
#
# This script:
#   1. Checks that Node.js is available.
#   2. Syntax-checks local-context.ts with Node (no execution).
#   3. Copies the plugin files to the opencode plugins directory.
#   4. Prints a reminder to restart opencode manually.
#
# Idempotent - safe to run repeatedly. Only writes are file copies.

# Resolve the directory where this script lives.
# $PSScriptRoot is a built-in PowerShell variable that always points here.
$PluginDir = $PSScriptRoot
$TargetDir = 'C:\Users\FakuPara\.config\opencode\plugins'

# --- Step 1: check Node.js ---------------------------------------------------
Write-Host "Checking Node.js..."
$NodeVersion = node --version 2>$null
if (-not $?) {
    Write-Host ""
    Write-Host "ERROR: Node.js is not installed or not on PATH." -ForegroundColor Red
    Write-Host "Please install Node.js first, then run this script again." -ForegroundColor Red
    exit 1
}
Write-Host "  Node.js $NodeVersion OK"

# --- Step 2: syntax-check the local copy --------------------------------------
Write-Host ""
Write-Host "Syntax-checking local-context.ts..."
$TsFile = Join-Path $PluginDir 'local-context.ts'
$CheckResult = node --experimental-strip-types --check $TsFile 2>&1
if (-not $?) {
    Write-Host ""
    Write-Host "ERROR: Syntax check failed. Do NOT proceed." -ForegroundColor Red
    Write-Host $CheckResult
    Write-Host ""
    Write-Host "The plugin file in this repo has a syntax error." -ForegroundColor Red
    Write-Host "Fix it in local-context.ts before applying." -ForegroundColor Red
    exit 1
}
Write-Host "  Syntax OK"

# --- Step 3: copy files to the installed opencode -----------------------------
Write-Host ""
Write-Host "Copying plugin files to $TargetDir ..."

# Ensure the target directory exists.
if (-not (Test-Path $TargetDir)) {
    Write-Host "  Target directory does not exist. Creating it..." -ForegroundColor Yellow
    New-Item -Path $TargetDir -ItemType Directory -Force | Out-Null
}

# Copy every .ts and .json file from the repo root into the target.
# This picks up local-context.ts and any future plugin files added here.
$Files = Get-ChildItem -Path $PluginDir -Filter '*.ts' -File +
         Get-ChildItem -Path $PluginDir -Filter '*.json' -File

foreach ($File in $Files) {
    Copy-Item -Path $File.FullName -Destination $TargetDir -Force
    Write-Host "  Copied: $($File.Name)"
}

# --- Step 4: done banner ------------------------------------------------------
Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
Write-Host "Plugin files installed. Restart opencode yourself to" -ForegroundColor Green
Write-Host "load the new plugin (nothing was restarted by this script)." -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
