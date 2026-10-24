[CmdletBinding()]
param(
    [Parameter()]
    [string]$BuildRoot = "C:\prism-chromium",

    [Parameter()]
    [ValidateRange(1, 64)]
    [int]$Jobs = 4
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "Kernel-Lock.ps1")
$KernelLock = Get-PrismKernelLock
$PlatformContract = $KernelLock.platforms.'windows-x64'
$ChromiumVersion = $KernelLock.chromiumVersion
$ExpectedPlatformCommit = $PlatformContract.commit
$ExpectedFingerprintCommit = $KernelLock.fingerprint.commit
$prismPatchHashes = [ordered]@{}
foreach ($patch in @($KernelLock.patches)) { $prismPatchHashes[$patch.file] = $patch.sha256 }
$ExpectedContractHash = (Get-FileHash -Algorithm SHA256 -Path $script:PrismKernelLockPath).Hash.ToLowerInvariant()
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"
$OutputPath = Join-Path $SourcePath "out\Default"
$BuildNinja = Join-Path $OutputPath "build.ninja"
$LogDirectory = Join-Path $BuildRoot "logs"
$ArtifactDirectory = Join-Path $BuildRoot "artifacts\$ChromiumVersion-windows-x64"
$TmpPath = Join-Path $BuildRoot "tmp"

if ($null -eq ("PrismPowerState" -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PrismPowerState {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint flags);
}
"@
}

function Invoke-Checked {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath exited with code $LASTEXITCODE"
    }
}

function Get-PythonExecutable {
    foreach ($candidate in @("python", "python3")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($null -ne $command -and $command.CommandType -eq "Application") {
            return $command.Source
        }
    }
    throw "Python 3.11 or newer was not found."
}

function Enable-Python3Shim {
    param([string]$PythonExecutable)
    $shimRoot = Join-Path $BuildRoot "python-shim"
    New-Item -ItemType Directory -Path $shimRoot -Force | Out-Null
    $shimPath = Join-Path $shimRoot "python3.cmd"
    "@`"$PythonExecutable`" %*" | Set-Content -LiteralPath $shimPath -Encoding ascii
    $env:PATH = "$shimRoot;$env:PATH"
    & python3.cmd -c "import sys; print(sys.executable)"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create the python3 compatibility shim required by gclient.bat."
    }
}

function Assert-CleanPythonEnvironment {
    param([string]$PythonExecutable)
    $environmentKind = (& $PythonExecutable -c "import os,sys; print('clean' if sys.prefix != sys.base_prefix and not os.environ.get('CONDA_PREFIX') else 'shared')") -join ""
    if ($LASTEXITCODE -ne 0 -or $environmentKind -ne "clean") {
        throw "Activate a clean Python venv before building (for example C:\prism-venv). Anaconda and global environments can shadow Chromium build.py."
    }
}

function Enable-Vs2026SourceCompatibility {
    $setenvPath = Join-Path $SourcePath "tools\win\setenv.py"
    if (Test-Path $setenvPath) {
        $setenv = [System.IO.File]::ReadAllText($setenvPath)
        if ($setenv -notmatch "2026") {
            $updatedSetenv = $setenv.Replace("['2022']", "['2026', '2022']")
            if ($updatedSetenv -eq $setenv) {
                throw "Could not extend tools\win\setenv.py for Visual Studio 2026."
            }
            [System.IO.File]::WriteAllText(
                $setenvPath,
                $updatedSetenv,
                (New-Object System.Text.UTF8Encoding($false))
            )
        }
    }

    $buildDriverPath = Join-Path $RepositoryPath "build.py"
    $buildDriver = [System.IO.File]::ReadAllText($buildDriverPath)
    $marker = "# PRISM_VS2026_SETENV_COMPAT"
    if ($buildDriver -notmatch [regex]::Escape($marker)) {
        $cloneLine = "        subprocess.run([sys.executable, str(Path('ungoogled-chromium', 'utils', 'clone.py')), '-o', 'build\\src', '-p', 'win32' if args.x86 else 'win-arm64' if args.arm else 'win64'], check=True)"
        $injection = @"
$cloneLine
        $marker
        setenv_path = source_tree / 'tools' / 'win' / 'setenv.py'
        setenv_text = setenv_path.read_text(encoding='utf-8')
        if '2026' not in setenv_text:
            updated_setenv = setenv_text.replace("['2022']", "['2026', '2022']")
            if updated_setenv == setenv_text:
                raise RuntimeError('Could not extend tools/win/setenv.py for Visual Studio 2026')
            setenv_path.write_text(updated_setenv, encoding='utf-8')
"@
        if (-not $buildDriver.Contains($cloneLine)) {
            throw "Pinned build.py no longer contains the expected Chromium clone command."
        }
        $buildDriver = $buildDriver.Replace($cloneLine, $injection.TrimEnd())
        [System.IO.File]::WriteAllText(
            $buildDriverPath,
            $buildDriver,
            (New-Object System.Text.UTF8Encoding($false))
        )
    }
}

function Write-BuildState {
    param(
        [string]$Status,
        [string]$Message,
        [string]$StatePath,
        [string]$StartedAtUtc,
        [string]$BuildLog
    )
    $state = [ordered]@{
        schemaVersion = 1
        status = $Status
        message = $Message
        startedAtUtc = $StartedAtUtc
        updatedAtUtc = [DateTime]::UtcNow.ToString("o")
        log = $BuildLog
        artifacts = $ArtifactDirectory
    }
    $state | ConvertTo-Json -Depth 4 | Set-Content -Path $StatePath -Encoding utf8
}

function Assert-PinnedSource {
    $lockPath = Join-Path $RepositoryPath "prism-build-lock.json"
    if (-not (Test-Path $lockPath)) {
        throw "Pinned source is not prepared. Run Prepare-Source.ps1 first."
    }

    $platformCommit = (& git.exe -C $RepositoryPath rev-parse HEAD) -join ""
    $fingerprintCommit = (& git.exe -C $FingerprintPath rev-parse HEAD) -join ""
    if ($platformCommit -ne $ExpectedPlatformCommit) {
        throw "Unexpected Windows platform commit: $platformCommit"
    }
    if ($fingerprintCommit -ne $ExpectedFingerprintCommit) {
        throw "Unexpected fingerprint commit: $fingerprintCommit"
    }
    Assert-PrismKernelPatchSeries $KernelLock (Join-Path $FingerprintPath "patches\series")
    foreach ($patch in @($KernelLock.patches)) {
        $patchPath = Join-Path (Join-Path $FingerprintPath "patches") ([string]$patch.seriesPath).Replace("/", "\")
        if (-not (Test-Path $patchPath)) {
            throw "Prism patch $($patch.file) is missing. Run Prepare-Source.ps1 (new build) or Update-Prism-Patches.ps1 (existing build) from this kit."
        }
        $patchHash = (Get-FileHash -Algorithm SHA256 -Path $patchPath).Hash.ToLowerInvariant()
        if ($patchHash -ne $patch.sha256) {
            throw "Unexpected Prism patch hash for $($patch.file): $patchHash"
        }
    }
    $lock = Get-Content $lockPath -Raw | ConvertFrom-Json
    if (-not ($lock.PSObject.Properties.Name -contains "contractSha256") -or
        $lock.contractSha256 -ne $ExpectedContractHash) {
        throw "The prepared source uses a different kernel-lock.json. Run Prepare-Source.ps1 from this kit."
    }
    if (Test-Path $BuildNinja) {
        # Source was already patched once: every patch in the lock must be visible in it.
        foreach ($patch in @($KernelLock.patches)) {
            foreach ($marker in @($patch.appliedMarkers)) {
                $parts = ([string]$marker) -split "::", 2
                $sourceFile = Join-Path $SourcePath ($parts[0].Replace("/", "\"))
                if (-not (Test-Path $sourceFile) -or
                    -not (Select-String -Path $sourceFile -Pattern $parts[1] -SimpleMatch -Quiet)) {
                    throw "Existing Chromium source does not include $($patch.file). Run Update-Prism-Patches.ps1 first."
                }
            }
        }
    }
}

function Invoke-ResumeNinja {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $vsPath = (& $vswhere -latest -prerelease -products * -version "[18.0,19.0)" -property installationPath) -join ""
    if ([string]::IsNullOrWhiteSpace($vsPath)) {
        throw "Visual Studio 2026 was not found (Chromium 156 requires 18.x)."
    }

    $vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
    $ninja = Join-Path $SourcePath "third_party\ninja\ninja.exe"
    if (-not (Test-Path $vcvars)) {
        throw "vcvars64.bat was not found: $vcvars"
    }
    if (-not (Test-Path $ninja)) {
        throw "Ninja was not found: $ninja"
    }

    $command = "call `"$vcvars`" >nul && set DEPOT_TOOLS_WIN_TOOLCHAIN=0 && `"$ninja`" -C `"$OutputPath`" -j $Jobs chrome chromedriver mini_installer"
    & cmd.exe /d /s /c $command
    if ($LASTEXITCODE -ne 0) {
        throw "Ninja exited with code $LASTEXITCODE. Run this same script again to resume."
    }
}

function Export-Artifacts {
    param([string]$PythonExecutable)

    Push-Location $RepositoryPath
    try {
        Invoke-Checked $PythonExecutable @("package.py")
    } finally {
        Pop-Location
    }

    New-Item -ItemType Directory -Path $ArtifactDirectory -Force | Out-Null
    $packageFiles = @(Get-ChildItem -Path (Join-Path $RepositoryPath "build") -File |
        Where-Object { $_.Name -like "ungoogled-chromium_$ChromiumVersion-*" })
    if ($packageFiles.Count -lt 2) {
        throw "Expected the ZIP and installer under $RepositoryPath\build."
    }

    foreach ($file in $packageFiles) {
        Copy-Item -Path $file.FullName -Destination $ArtifactDirectory -Force
    }

    foreach ($name in @("chromedriver.exe", "args.gn")) {
        $sourceFile = Join-Path $OutputPath $name
        if (-not (Test-Path $sourceFile)) {
            throw "Expected build output is missing: $sourceFile"
        }
        Copy-Item -Path $sourceFile -Destination $ArtifactDirectory -Force
    }

    Copy-Item -Path (Join-Path $RepositoryPath "prism-build-lock.json") -Destination $ArtifactDirectory -Force

    $manifestPath = Join-Path $ArtifactDirectory "manifest.json"
    $sumsPath = Join-Path $ArtifactDirectory "SHA256SUMS.txt"
    Remove-Item -Path $manifestPath, $sumsPath -Force -ErrorAction SilentlyContinue
    $payloadFiles = @(Get-ChildItem -Path $ArtifactDirectory -File | Sort-Object Name)

    $chromePath = Join-Path $OutputPath "chrome.exe"
    $driverPath = Join-Path $OutputPath "chromedriver.exe"
    $manifest = [ordered]@{
        schemaVersion = 2
        chromiumVersion = $ChromiumVersion
        target = "windows-x64"
        contractSha256 = $ExpectedContractHash
        chromeFileVersion = (Get-Item $chromePath).VersionInfo.FileVersion
        chromedriverFileVersion = (Get-Item $driverPath).VersionInfo.FileVersion
        platformCommit = $ExpectedPlatformCommit
        fingerprintCommit = $ExpectedFingerprintCommit
        prismPatchSha256 = $prismPatchHashes
        jobs = $Jobs
        buildLog = (Split-Path $transcriptPath -Leaf)
        completedAtUtc = [DateTime]::UtcNow.ToString("o")
        files = @($payloadFiles | ForEach-Object {
            $hash = Get-FileHash -Algorithm SHA256 -Path $_.FullName
            [ordered]@{
                name = $_.Name
                size = $_.Length
                sha256 = $hash.Hash.ToLowerInvariant()
            }
        })
    }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding utf8

    # The checksum list covers the payload and manifest, but never itself.
    # This keeps repeated incremental packaging deterministic and avoids
    # circular hashes from stale metadata files left by a previous run.
    $hashFiles = @(Get-ChildItem -Path $ArtifactDirectory -File |
        Where-Object { $_.Name -ne "SHA256SUMS.txt" } |
        Sort-Object Name)
    $hashLines = foreach ($file in $hashFiles) {
        $hash = Get-FileHash -Algorithm SHA256 -Path $file.FullName
        "$($hash.Hash.ToLowerInvariant())  $($file.Name)"
    }
    $hashLines | Set-Content -Path $sumsPath -Encoding ascii
}

Assert-PinnedSource
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $TmpPath -Force | Out-Null
$env:TMP = $TmpPath
$env:TEMP = $TmpPath
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = "0"

$python = Get-PythonExecutable
Assert-CleanPythonEnvironment $python
Enable-Python3Shim $python
Enable-Vs2026SourceCompatibility
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$transcriptPath = Join-Path $LogDirectory "windows-kernel-$timestamp.log"
$statePath = Join-Path $LogDirectory "windows-kernel-latest.json"
$startedAtUtc = [DateTime]::UtcNow.ToString("o")
Start-Transcript -Path $transcriptPath | Out-Null
Write-BuildState "running" "Build started" $statePath $startedAtUtc $transcriptPath

# ES_CONTINUOUS | ES_SYSTEM_REQUIRED. This keeps the machine awake while the script runs.
[PrismPowerState]::SetThreadExecutionState([uint32]"0x80000001") | Out-Null

try {
    Invoke-Checked $python @("-m", "pip", "install", "httplib2==0.22.0")

    if (Test-Path $BuildNinja) {
        Write-Host "Existing Ninja graph found. Resuming the incremental build..." -ForegroundColor Cyan
        Invoke-ResumeNinja
    } else {
        if (Test-Path (Join-Path $SourcePath "BUILD.gn")) {
            throw "A partial source setup exists but build.ninja is missing. Send the latest log back for diagnosis before cleaning or reapplying patches."
        }
        Write-Host "Starting source retrieval, patching, GN generation, and the first build..." -ForegroundColor Cyan
        Push-Location $RepositoryPath
        try {
            Invoke-Checked $python @("build.py", "-j", $Jobs.ToString())
        } finally {
            Pop-Location
        }
    }

    Export-Artifacts $python
    Write-BuildState "completed" "Build and artifact verification completed" $statePath $startedAtUtc $transcriptPath
    Write-Host ""
    Write-Host "Windows fingerprint Chromium build completed." -ForegroundColor Green
    Write-Host "Artifacts: $ArtifactDirectory"
    Write-Host "Build log: $transcriptPath"
} catch {
    Write-BuildState "failed" $_.Exception.Message $statePath $startedAtUtc $transcriptPath
    Write-Host ""
    Write-Host $_.Exception.Message -ForegroundColor Red
    if (Test-Path $BuildNinja) {
        Write-Host "The incremental build state is intact. Run this same command again to resume."
    } else {
        Write-Host "The failure happened before a Ninja graph was generated. Do not delete the download_cache."
        Write-Host "Send the log to the macOS development task before cleaning the source tree: $transcriptPath"
    }
    exit 1
} finally {
    [PrismPowerState]::SetThreadExecutionState([uint32]"0x80000000") | Out-Null
    Stop-Transcript | Out-Null
}
