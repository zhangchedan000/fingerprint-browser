[CmdletBinding()]
param(
    [Parameter()]
    [string]$BuildRoot = "C:\prism-chromium"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "Kernel-Lock.ps1")
$KernelLock = Get-PrismKernelLock

$script:Failures = 0

function Write-Check {
    param(
        [string]$Name,
        [bool]$Passed,
        [string]$Detail
    )

    if ($Passed) {
        Write-Host "[OK]   $Name - $Detail" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] $Name - $Detail" -ForegroundColor Red
        $script:Failures++
    }
}

function Get-PythonExecutable {
    foreach ($candidate in @("python", "python3")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($null -ne $command -and $command.CommandType -eq "Application") {
            return $command.Source
        }
    }
    return $null
}

Write-Host "Prism Windows fingerprint Chromium prerequisite check"
Write-Host "Pinned Chromium version: $($KernelLock.chromiumVersion)"
Write-Host ""

foreach ($patch in @($KernelLock.patches)) {
    $patchPath = Join-Path $PSScriptRoot "patches\$($patch.file)"
    $patchHash = if (Test-Path $patchPath) {
        (Get-FileHash -Algorithm SHA256 -Path $patchPath).Hash.ToLowerInvariant()
    } else {
        ""
    }
    Write-Check "Patch $($patch.file)" ($patchHash -eq $patch.sha256) $patchPath
}

$os = Get-CimInstance Win32_OperatingSystem
$isSupportedWindows = [version]$os.Version -ge [version]"10.0"
Write-Check "Windows" $isSupportedWindows "$($os.Caption) $($os.Version)"

$isX64 = [Environment]::Is64BitOperatingSystem
Write-Check "Architecture" $isX64 $env:PROCESSOR_ARCHITECTURE

$buildDriveName = [System.IO.Path]::GetPathRoot($BuildRoot).Substring(0, 1)
$systemDrive = Get-PSDrive -Name $buildDriveName -ErrorAction SilentlyContinue
if ($null -eq $systemDrive) {
    Write-Check "Build drive" $false "Cannot resolve the drive for $BuildRoot"
} else {
    $freeGiB = [math]::Round($systemDrive.Free / 1GB, 1)
    Write-Check "Free disk" ($freeGiB -ge 180) "$freeGiB GiB free; 300 GiB or more is recommended"
}

$driveLetter = [System.IO.Path]::GetPathRoot($BuildRoot).Substring(0, 1)
$volume = Get-Volume -DriveLetter $driveLetter -ErrorAction SilentlyContinue
if ($null -eq $volume) {
    Write-Check "Filesystem" $false "Cannot inspect drive $driveLetter"
} else {
    Write-Check "Filesystem" ($volume.FileSystem -eq "NTFS") "$($volume.FileSystem); NTFS is required"
}

$shortPath = ($BuildRoot.Length -le 40) -and (-not $BuildRoot.Contains(" "))
Write-Check "Build path" $shortPath "$BuildRoot; use a short path without spaces"

$longPaths = Get-ItemPropertyValue `
    -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
    -Name "LongPathsEnabled" `
    -ErrorAction SilentlyContinue
Write-Check "Long paths" ($longPaths -eq 1) "LongPathsEnabled must be 1"

$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($null -eq $git) {
    Write-Check "Git" $false "git.exe was not found"
} else {
    $gitVersion = (& $git.Source --version) -join " "
    Write-Check "Git" ($LASTEXITCODE -eq 0) $gitVersion
}

$python = Get-PythonExecutable
if ($null -eq $python) {
    Write-Check "Python" $false "Python 3.11 or newer was not found"
} else {
    $pythonVersionText = (& $python -c "import sys; print('.'.join(map(str, sys.version_info[:3])))") -join ""
    $pythonVersion = [version]$pythonVersionText
    Write-Check "Python" ($pythonVersion -ge [version]"3.11") "$pythonVersionText at $python"
    $venvProbe = (& $python -c "import os,sys; print('clean' if sys.prefix != sys.base_prefix and not os.environ.get('CONDA_PREFIX') else 'shared')") -join ""
    Write-Check "Clean Python venv" ($venvProbe -eq "clean") "Use py -3.12 -m venv C:\prism-venv; do not build inside Anaconda"
}

$sevenZipCandidates = @()
$sevenZipCommand = Get-Command 7z.exe -ErrorAction SilentlyContinue
if ($null -ne $sevenZipCommand -and (Test-Path $sevenZipCommand.Source)) {
    $sevenZipCandidates += $sevenZipCommand.Source
}
$defaultSevenZip = "$env:ProgramFiles\7-Zip\7z.exe"
if ((Test-Path $defaultSevenZip) -and ($sevenZipCandidates -notcontains $defaultSevenZip)) {
    $sevenZipCandidates += $defaultSevenZip
}
$sevenZipDetail = "7z.exe was not found"
if ($sevenZipCandidates.Count -gt 0) {
    $sevenZipDetail = $sevenZipCandidates[0]
}
Write-Check "7-Zip" ($sevenZipCandidates.Count -gt 0) $sevenZipDetail

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    Write-Check "Visual Studio" $false "vswhere.exe was not found; install Visual Studio 2026"
} else {
    $vsPath = (& $vswhere -latest -prerelease -products * -version "[18.0,19.0)" `
        -requires Microsoft.VisualStudio.Workload.NativeDesktop `
        Microsoft.VisualStudio.Component.VC.ATLMFC `
        -property installationPath) -join ""
    $vsDetail = "C++ and ATL/MFC components are missing"
    if (-not [string]::IsNullOrWhiteSpace($vsPath)) {
        $vsDetail = $vsPath
    }
    Write-Check "Visual Studio 2026 (Chromium 156 requires 18.x)" (-not [string]::IsNullOrWhiteSpace($vsPath)) $vsDetail
}

$sdkRoot = "${env:ProgramFiles(x86)}\Windows Kits\10"
$sdkInclude = Join-Path $sdkRoot "Include\10.0.28000.0"
$sdkDebugger = Join-Path $sdkRoot "Debuggers\x64\cdb.exe"
Write-Check "Windows 11 SDK" (Test-Path $sdkInclude) "Windows 11 SDK 10.0.28000.2270 is required (Visual Studio Installer, Individual components)"
Write-Check "SDK debugging tools" (Test-Path $sdkDebugger) "$sdkDebugger"

$depotTools = Get-Command gclient.bat -ErrorAction SilentlyContinue
Write-Check "No depot_tools" ($null -eq $depotTools) "This build uses the platform repository's custom toolchain"

Write-Host ""
if ($script:Failures -gt 0) {
    Write-Host "$($script:Failures) prerequisite check(s) failed." -ForegroundColor Red
    Write-Host "Fix the failed items, open a new Administrator PowerShell, and run this script again."
    exit 1
}

Write-Host "All required checks passed." -ForegroundColor Green
exit 0
