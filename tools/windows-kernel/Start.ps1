[CmdletBinding()]
param(
    [Parameter()]
    [string]$BuildRoot = "D:\prism-chromium",

    [Parameter()]
    [ValidateRange(1, 64)]
    [int]$Jobs = 4
)

# One command for everything, safe to run again at any time:
#   first run  -> check the machine, prepare the pinned source, build
#   after a stop/crash/reboot -> resume where it stopped
#   after copying in a newer kit -> apply only the new patches, then rebuild what changed

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$kit = $PSScriptRoot
$repository = Join-Path $BuildRoot "ungoogled-chromium-windows"
$source = Join-Path $repository "build\src"

Write-Host "== 1/3 Checking this machine" -ForegroundColor Cyan
& (Join-Path $kit "Check-Prerequisites.ps1") -BuildRoot $BuildRoot
if ($LASTEXITCODE -ne 0) { exit 1 }

if (-not (Test-Path (Join-Path $repository "prism-build-lock.json"))) {
    Write-Host "== 2/3 Preparing pinned source (first run)" -ForegroundColor Cyan
    & (Join-Path $kit "Prepare-Source.ps1") -BuildRoot $BuildRoot
} elseif (Test-Path $source) {
    Write-Host "== 2/3 Bringing existing source up to this kit's patches" -ForegroundColor Cyan
    & (Join-Path $kit "Update-Prism-Patches.ps1") -BuildRoot $BuildRoot
} else {
    Write-Host "== 2/3 Re-preparing source (download had not finished)" -ForegroundColor Cyan
    & (Join-Path $kit "Prepare-Source.ps1") -BuildRoot $BuildRoot
}

Write-Host "== 3/3 Building (resumes automatically)" -ForegroundColor Cyan
& (Join-Path $kit "Build-Kernel.ps1") -BuildRoot $BuildRoot -Jobs $Jobs
