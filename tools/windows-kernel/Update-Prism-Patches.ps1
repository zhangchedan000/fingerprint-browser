[CmdletBinding()]
param(
    [Parameter()]
    [string]$BuildRoot = "C:\prism-chromium"
)

# Brings an already-built source tree up to this kit's kernel-lock.json:
# - a patch the source does not contain yet is applied;
# - a patch that changed since it was applied is taken out (the previously applied copy is
#   reverse-applied) and the new version is applied;
# - a patch the lock no longer lists is taken out.
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
if (-not (Test-Path (Join-Path $SourcePath "out\Default\build.ninja"))) {
    # The first build has not reached compiling yet, so build.py has not patched the source:
    # it will apply every patch from the series itself. Only refresh the copies it reads.
    foreach ($patch in @($KernelLock.patches)) {
        $kitPatch = Join-Path $PSScriptRoot "patches\$($patch.file)"
        $destination = Join-Path $patchDirectory ([string]$patch.seriesPath).Replace("/", "\")
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        Copy-Item $kitPatch $destination -Force
    }
    Set-PrismKernelPatchSeries $KernelLock (Join-Path $patchDirectory "series")
    $pendingLockPath = Join-Path $RepositoryPath "prism-build-lock.json"
    $pendingLock = Get-Content $pendingLockPath -Raw | ConvertFrom-Json
    $pendingHashes = [ordered]@{}
    foreach ($patch in @($KernelLock.patches)) { $pendingHashes[$patch.file] = $patch.sha256 }
    $pendingLock | Add-Member -NotePropertyName contractSha256 -NotePropertyValue $ContractHash -Force
    $pendingLock | Add-Member -NotePropertyName prismPatchSha256 -NotePropertyValue $pendingHashes -Force
    $pendingLock | ConvertTo-Json -Depth 8 | Set-Content -Path $pendingLockPath -Encoding utf8
    Write-Host "The first build has not started compiling yet; build.py will apply every patch." -ForegroundColor Green
    exit 0
}
$buildLockPath = Join-Path $RepositoryPath "prism-build-lock.json"
if (-not (Test-Path $buildLockPath)) { throw "The Prism build lock is missing." }
$buildLock = Get-Content $buildLockPath -Raw | ConvertFrom-Json
# What is in the source now: file name -> SHA-256 of the copy that was applied.
$appliedHashes = @{}
if ($buildLock.PSObject.Properties.Name -contains "prismPatchSha256" -and $buildLock.prismPatchSha256) {
    foreach ($property in $buildLock.prismPatchSha256.PSObject.Properties) {
        $appliedHashes[$property.Name] = [string]$property.Value
    }
}

function Invoke-SourcePatch {
    param([string]$PatchPath, [switch]$Reverse, [string]$Name)
    $direction = if ($Reverse) { @("-R") } else { @() }
    & git.exe -C $RepositoryPath apply --check --unsafe-paths --directory=build/src @direction $PatchPath
    if ($LASTEXITCODE -ne 0) {
        $what = if ($Reverse) { "taken out of" } else { "applied to" }
        throw "$Name cannot be cleanly $what the current source. Keep $BuildRoot as it is and send the logs back."
    }
    & git.exe -C $RepositoryPath apply --unsafe-paths --directory=build/src @direction $PatchPath
    if ($LASTEXITCODE -ne 0) { throw "git apply failed for $Name." }
}

# 1. Take out patches the lock no longer lists (their applied copy is still in the patch folder).
$lockedFiles = @($KernelLock.patches | ForEach-Object { [string]$_.file })
$removed = @()
foreach ($file in @($appliedHashes.Keys)) {
    if ($lockedFiles -contains $file) { continue }
    $oldCopy = Get-ChildItem -Path $patchDirectory -Recurse -Filter $file -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $oldCopy) { throw "$file was applied earlier but its copy is gone; cannot take it out safely." }
    $oldHash = (Get-FileHash -Algorithm SHA256 -Path $oldCopy.FullName).Hash.ToLowerInvariant()
    if ($oldHash -ne $appliedHashes[$file]) { throw "The applied copy of $file was modified; cannot take it out safely." }
    Invoke-SourcePatch -PatchPath $oldCopy.FullName -Reverse -Name $file
    Remove-Item -LiteralPath $oldCopy.FullName
    $appliedHashes.Remove($file)
    $removed += $file
}

# 2. Apply new patches and replace changed ones.
$applied = @()
$replaced = @()
foreach ($patch in @($KernelLock.patches)) {
    $kitPatch = Join-Path $PSScriptRoot "patches\$($patch.file)"
    if (-not (Test-Path $kitPatch)) { throw "Patch $($patch.file) is missing from this kit." }
    $hash = (Get-FileHash -Algorithm SHA256 -Path $kitPatch).Hash.ToLowerInvariant()
    if ($hash -ne $patch.sha256) { throw "Unexpected hash for $($patch.file): $hash" }
    $destination = Join-Path $patchDirectory ([string]$patch.seriesPath).Replace("/", "\")
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null

    $previousHash = if ($appliedHashes.ContainsKey($patch.file)) { $appliedHashes[$patch.file] } else { "" }
    if ($previousHash -eq $hash) {
        Copy-Item $kitPatch $destination -Force
        if ((Get-MarkerState $patch) -ne "applied") {
            throw "$($patch.file) is recorded as applied but its markers are missing. Keep $BuildRoot as it is and send the logs back."
        }
        continue
    }
    if ($previousHash) {
        # An earlier version is in the source: its copy in the patch folder is what was applied.
        if (-not (Test-Path $destination)) { throw "The applied copy of $($patch.file) is gone; cannot replace it safely." }
        $copyHash = (Get-FileHash -Algorithm SHA256 -Path $destination).Hash.ToLowerInvariant()
        if ($copyHash -ne $previousHash) { throw "The applied copy of $($patch.file) was modified; cannot replace it safely." }
        Invoke-SourcePatch -PatchPath $destination -Reverse -Name "$($patch.file) (previous version)"
        Copy-Item $kitPatch $destination -Force
        Invoke-SourcePatch -PatchPath $destination -Name $patch.file
        $replaced += $patch.file
    } else {
        switch (Get-MarkerState $patch) {
            "applied" { Copy-Item $kitPatch $destination -Force; continue }
            "partial" { throw "$($patch.file) is only partly in the source. Keep $BuildRoot as it is and send the logs back." }
            default {
                Copy-Item $kitPatch $destination -Force
                Invoke-SourcePatch -PatchPath $destination -Name $patch.file
                $applied += $patch.file
            }
        }
    }
    if ((Get-MarkerState $patch) -ne "applied") { throw "$($patch.file) applied but its markers are not all present." }
    $appliedHashes[$patch.file] = $hash
}

$seriesPath = Join-Path $patchDirectory "series"
Set-PrismKernelPatchSeries $KernelLock $seriesPath
Assert-PrismKernelPatchSeries $KernelLock $seriesPath

$hashes = [ordered]@{}
foreach ($patch in @($KernelLock.patches)) { $hashes[$patch.file] = $patch.sha256 }
$buildLock | Add-Member -NotePropertyName contractSha256 -NotePropertyValue $ContractHash -Force
$buildLock | Add-Member -NotePropertyName prismPatchSha256 -NotePropertyValue $hashes -Force
$buildLock | ConvertTo-Json -Depth 8 | Set-Content -Path $buildLockPath -Encoding utf8

Write-Host ""
if ($applied.Count -eq 0 -and $replaced.Count -eq 0 -and $removed.Count -eq 0) {
    Write-Host "Source already contains every patch in this kit." -ForegroundColor Green
} else {
    if ($applied.Count -gt 0) { Write-Host "Applied: $($applied -join ', ')" -ForegroundColor Green }
    if ($replaced.Count -gt 0) { Write-Host "Updated: $($replaced -join ', ')" -ForegroundColor Green }
    if ($removed.Count -gt 0) { Write-Host "Taken out: $($removed -join ', ')" -ForegroundColor Green }
}
Write-Host "Next: .\Build-Kernel.ps1 -BuildRoot $BuildRoot -Jobs 4"
