[CmdletBinding()]
param(
    [Parameter()]
    [string]$BuildRoot = "C:\prism-chromium"
)

# Brings an already-built source tree up to this kit's kernel-lock.json:
# every patch the lock lists but the source does not yet contain is applied, nothing else is touched.
# Afterwards Build-Kernel.ps1 only recompiles the affected files.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "Kernel-Lock.ps1")
$KernelLock = Get-PrismKernelLock
$ContractHash = (Get-FileHash -Algorithm SHA256 -Path $script:PrismKernelLockPath).Hash.ToLowerInvariant()
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"

if (-not (Test-Path (Join-Path $RepositoryPath ".git")) -or -not (Test-Path (Join-Path $FingerprintPath ".git"))) {
    throw "No prepared source under $BuildRoot. For a first build run Prepare-Source.ps1 instead."
}
if (-not (Test-Path $SourcePath)) {
    throw "Chromium source has not been downloaded yet. Just run Build-Kernel.ps1; it applies every patch."
}
$activeNinja = @(Get-CimInstance Win32_Process -Filter "Name = 'ninja.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($BuildRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
})
if ($activeNinja.Count -gt 0) { throw "The Chromium build is still running. Wait for it to finish first." }

function Get-MarkerState {
    param([object]$Patch)
    $found = 0
    $markers = @($Patch.appliedMarkers)
    foreach ($marker in $markers) {
        $parts = ([string]$marker) -split "::", 2
        $file = Join-Path $SourcePath ($parts[0].Replace("/", "\"))
        if ((Test-Path $file) -and (Select-String -Path $file -Pattern $parts[1] -SimpleMatch -Quiet)) { $found++ }
    }
    if ($markers.Count -eq 0) { return "unknown" }
    if ($found -eq $markers.Count) { return "applied" }
    if ($found -eq 0) { return "missing" }
    return "partial"
}

$patchDirectory = Join-Path $FingerprintPath "patches"
$applied = @()
foreach ($patch in @($KernelLock.patches)) {
    $kitPatch = Join-Path $PSScriptRoot "patches\$($patch.file)"
    if (-not (Test-Path $kitPatch)) { throw "Patch $($patch.file) is missing from this kit." }
    $hash = (Get-FileHash -Algorithm SHA256 -Path $kitPatch).Hash.ToLowerInvariant()
    if ($hash -ne $patch.sha256) { throw "Unexpected hash for $($patch.file): $hash" }
    $destination = Join-Path $patchDirectory ([string]$patch.seriesPath).Replace("/", "\")
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
    Copy-Item $kitPatch $destination -Force

    switch (Get-MarkerState $patch) {
        "applied" { continue }
        "unknown" { Write-Host "  $($patch.file): no markers, assumed applied." -ForegroundColor Yellow; continue }
        "partial" { throw "$($patch.file) is only partly in the source. Keep $BuildRoot as it is and send the logs back." }
        "missing" {
            & git.exe -C $RepositoryPath apply --check --unsafe-paths --directory=build/src $kitPatch
            if ($LASTEXITCODE -ne 0) { throw "$($patch.file) does not apply cleanly to the current source." }
            & git.exe -C $RepositoryPath apply --unsafe-paths --directory=build/src $kitPatch
            if ($LASTEXITCODE -ne 0) { throw "Could not apply $($patch.file)." }
            if ((Get-MarkerState $patch) -ne "applied") { throw "$($patch.file) applied but its markers are not all present." }
            $applied += $patch.file
        }
    }
}

$seriesPath = Join-Path $patchDirectory "series"
Set-PrismKernelPatchSeries $KernelLock $seriesPath
Assert-PrismKernelPatchSeries $KernelLock $seriesPath

$buildLockPath = Join-Path $RepositoryPath "prism-build-lock.json"
if (-not (Test-Path $buildLockPath)) { throw "The Prism build lock is missing." }
$buildLock = Get-Content $buildLockPath -Raw | ConvertFrom-Json
$hashes = [ordered]@{}
foreach ($patch in @($KernelLock.patches)) { $hashes[$patch.file] = $patch.sha256 }
$buildLock | Add-Member -NotePropertyName contractSha256 -NotePropertyValue $ContractHash -Force
$buildLock | Add-Member -NotePropertyName prismPatchSha256 -NotePropertyValue $hashes -Force
$buildLock | ConvertTo-Json -Depth 8 | Set-Content -Path $buildLockPath -Encoding utf8

Write-Host ""
if ($applied.Count -eq 0) {
    Write-Host "Source already contains every patch in this kit." -ForegroundColor Green
} else {
    Write-Host "Applied: $($applied -join ', ')" -ForegroundColor Green
}
Write-Host "Next: .\Build-Kernel.ps1 -BuildRoot $BuildRoot -Jobs 4"
