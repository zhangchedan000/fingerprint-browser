[CmdletBinding()]
param(
    [Parameter()]
    [string]$BuildRoot = "C:\prism-chromium"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "Kernel-Lock.ps1")
$KernelLock = Get-PrismKernelLock
$PlatformContract = $KernelLock.platforms.'windows-x64'
$PlatformRepository = $PlatformContract.repository
$PlatformTag = $PlatformContract.tag
$PlatformCommit = $PlatformContract.commit
$FingerprintRepository = $KernelLock.fingerprint.repository
$FingerprintTag = $KernelLock.fingerprint.tag
$FingerprintCommit = $KernelLock.fingerprint.commit
$ChromiumVersion = $KernelLock.chromiumVersion
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"

function Invoke-Git {
    param(
        [string]$WorkingDirectory,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    if ($WorkingDirectory) {
        & git.exe -C $WorkingDirectory @Arguments
    } else {
        & git.exe @Arguments
    }
    if ($LASTEXITCODE -ne 0) {
        throw "git failed: git $($Arguments -join ' ')"
    }
}

if ($BuildRoot.Contains(" ") -or $BuildRoot.Length -gt 40) {
    throw "Use a short build path without spaces, for example D:\prism-chromium."
}

$driveLetter = [System.IO.Path]::GetPathRoot($BuildRoot).Substring(0, 1)
$volume = Get-Volume -DriveLetter $driveLetter -ErrorAction Stop
if ($volume.FileSystem -ne "NTFS") {
    throw "The build drive must use NTFS. Current filesystem: $($volume.FileSystem)."
}

New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
git.exe config --global core.longpaths true
if ($LASTEXITCODE -ne 0) {
    throw "Could not enable Git long-path support."
}

$repositoryWasCloned = $false
if (-not (Test-Path $RepositoryPath)) {
    Write-Host "Cloning the pinned Windows platform repository..."
    Invoke-Git "" clone --filter=blob:none --depth 1 --branch $PlatformTag $PlatformRepository $RepositoryPath
    $repositoryWasCloned = $true
} elseif (-not (Test-Path (Join-Path $RepositoryPath ".git"))) {
    throw "$RepositoryPath exists but is not a Git repository. Choose an empty BuildRoot."
}

if (-not $repositoryWasCloned) {
    $platformDirty = @(& git.exe -C $RepositoryPath status --porcelain --untracked-files=no)
    $unexpectedPlatformChanges = @($platformDirty | Where-Object {
        $_ -notmatch "^[ MADRCU?!]{2} ungoogled-chromium$" `
            -and $_ -ne " M build.py"
    })
    if ($unexpectedPlatformChanges.Count -gt 0) {
        throw "The Windows platform repository has local changes. Refusing to overwrite them."
    }
}

Write-Host "Checking out Windows platform tag $PlatformTag..."
Invoke-Git $RepositoryPath fetch --depth 1 origin "refs/tags/$PlatformTag`:refs/tags/$PlatformTag"
Invoke-Git $RepositoryPath checkout --detach "refs/tags/$PlatformTag"
$actualPlatformCommit = (& git.exe -C $RepositoryPath rev-parse HEAD) -join ""
if ($actualPlatformCommit -ne $PlatformCommit) {
    throw "Unexpected platform commit: $actualPlatformCommit"
}

if ((Test-Path $FingerprintPath) -and -not (Test-Path (Join-Path $FingerprintPath ".git"))) {
    $submoduleEntry = (& git.exe -C $RepositoryPath ls-files --stage -- "ungoogled-chromium") -join ""
    $placeholderFiles = @(Get-ChildItem -LiteralPath $FingerprintPath -Force -ErrorAction SilentlyContinue)
    if ($submoduleEntry -match "^160000 " -or $placeholderFiles.Count -eq 0) {
        Write-Host "Removing the platform repository fingerprint submodule placeholder..."
        Remove-Item -LiteralPath $FingerprintPath -Recurse -Force
    } else {
        throw "$FingerprintPath exists, is not a Git repository, and contains unrecognized files."
    }
}

if (-not (Test-Path $FingerprintPath)) {
    Write-Host "Cloning the pinned fingerprint patch repository..."
    Invoke-Git "" clone --filter=blob:none --depth 1 --branch $FingerprintTag $FingerprintRepository $FingerprintPath
} else {
    $allowedFingerprintChanges = @(" M patches/series") + @($KernelLock.patches | ForEach-Object { "?? patches/$($_.seriesPath)" })
    $fingerprintDirty = @(& git.exe -C $FingerprintPath status --porcelain)
    $unexpectedFingerprintChanges = @($fingerprintDirty | Where-Object { $allowedFingerprintChanges -notcontains $_ })
    if ($unexpectedFingerprintChanges.Count -gt 0) {
        throw "The fingerprint repository has local changes. Refusing to overwrite them."
    }
    Write-Host "Checking out fingerprint tag $FingerprintTag..."
    Invoke-Git $FingerprintPath fetch --depth 1 origin "refs/tags/$FingerprintTag`:refs/tags/$FingerprintTag"
    Invoke-Git $FingerprintPath checkout --detach "refs/tags/$FingerprintTag"
}

$actualFingerprintCommit = (& git.exe -C $FingerprintPath rev-parse HEAD) -join ""
if ($actualFingerprintCommit -ne $FingerprintCommit) {
    throw "Unexpected fingerprint commit: $actualFingerprintCommit"
}

$chromiumVersion = (Get-Content (Join-Path $FingerprintPath "chromium_version.txt") -Raw).Trim()
if ($chromiumVersion -ne $ChromiumVersion) {
    throw "Unexpected Chromium version: $chromiumVersion"
}

# Every Prism patch comes from kernel-lock.json: check its hash, then place it where the series expects it.
$prismPatchHashes = [ordered]@{}
foreach ($patch in @($KernelLock.patches)) {
    $source = Join-Path $PSScriptRoot "patches\$($patch.file)"
    if (-not (Test-Path $source)) {
        throw "Prism patch is missing: $source"
    }
    $hash = (Get-FileHash -Algorithm SHA256 -Path $source).Hash.ToLowerInvariant()
    if ($hash -ne $patch.sha256) {
        throw "Unexpected Prism patch hash for $($patch.file): $hash"
    }
    $destination = Join-Path (Join-Path $FingerprintPath "patches") ([string]$patch.seriesPath).Replace("/", "\")
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
    Copy-Item -Path $source -Destination $destination -Force
    $prismPatchHashes[$patch.file] = $hash
}
$seriesPath = Join-Path $FingerprintPath "patches\series"
Set-PrismKernelPatchSeries $KernelLock $seriesPath
Assert-PrismKernelPatchSeries $KernelLock $seriesPath

& git.exe -C $RepositoryPath config submodule.ungoogled-chromium.url $FingerprintRepository
if ($LASTEXITCODE -ne 0) {
    throw "Could not record the fingerprint submodule URL."
}

$lock = [ordered]@{
    schemaVersion = 5
    contractSchemaVersion = $KernelLock.schemaVersion
    contractSha256 = (Get-FileHash -Algorithm SHA256 -Path $script:PrismKernelLockPath).Hash.ToLowerInvariant()
    chromiumVersion = $chromiumVersion
    target = "windows-x64"
    platformRepository = $PlatformRepository
    platformTag = $PlatformTag
    platformCommit = $PlatformCommit
    fingerprintRepository = $FingerprintRepository
    fingerprintTag = $FingerprintTag
    fingerprintCommit = $FingerprintCommit
    prismPatchSha256 = $prismPatchHashes
    preparedAtUtc = [DateTime]::UtcNow.ToString("o")
}
$lock | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $RepositoryPath "prism-build-lock.json") -Encoding utf8

$tmpPath = Join-Path $BuildRoot "tmp"
New-Item -ItemType Directory -Path $tmpPath -Force | Out-Null

Write-Host ""
Write-Host "Pinned source is ready:" -ForegroundColor Green
Write-Host "  $RepositoryPath"
Write-Host ""
Write-Host "Next command:"
Write-Host ".\Build-Kernel.ps1 -BuildRoot `"$BuildRoot`" -Jobs 4"
