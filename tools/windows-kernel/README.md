# Windows 指纹内核构建包

在你自己的 Windows x64 电脑上编译带全部指纹补丁的 Chromium 内核。编好后在软件“内核管理 → 导入本地内核”里选 `chrome.exe` 即可使用。

实际固定值以构建包内的 `kernel-lock.json` 为唯一依据；下列内容是当前锁的可读摘要：

- Chromium：`144.0.7559.132`
- Windows 平台仓库标签：`144.0.7559.132-1.1`
- Windows 平台提交：`469861bcfd3f4c871986437502b05f3076cad15e`
- Fingerprint Chromium 标签：`144.0.7559.132`
- 指纹补丁提交：`831623f2965e34554304caabfc3a1e4e3741db1f`
- 指纹补丁：`kernel-patches/` 里全部补丁，清单和 SHA-256 以 `kernel-lock.json` 的 `patches` 为准
- 架构：Windows x64

## 一、机器要求

建议使用：

- Windows 10/11 x64，建议使用较新的 Windows 11；
- 16 GB 内存为最低实用配置，建议 32 GB 或更多；
- NTFS SSD，建议至少剩余 300 GB；低于 180 GB 时检查脚本会拒绝继续；
- 构建目录使用短路径且不能包含空格，例如 `D:\prism-chromium`；
- 编译期间保持电源连接，不要拔掉构建磁盘。

不要安装或配置 `depot_tools`。本项目使用 `ungoogled-chromium-windows` 自带的下载、工具链和补丁流程。

## 二、安装依赖

1. 安装 Visual Studio 2022（17.x）或 Visual Studio 2026（18.x）Community。
2. 在 Visual Studio Installer 中选择：
   - `Desktop development with C++`；
   - C++ ATL；
   - C++ MFC；
   - Windows 11 SDK `10.0.26100.x`。
3. 给 Windows SDK 安装 `Debugging Tools for Windows`。
4. 安装 Python 3.12 x64，并创建不继承 Anaconda 包的干净 venv：

```powershell
py -3.12 -m venv C:\prism-venv
C:\prism-venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
```

不要在 Anaconda base 或包含 PyPI `build` 包的环境中运行 Chromium 构建；它会和平台仓库的 `build.py`
或相关导入产生名称冲突。构建脚本会在 `BuildRoot\python-shim` 自动创建 `python3.cmd` 并加入当前进程
PATH，兼容 `gclient.bat` 对 `python3` 命令的调用，不需要复制或修改 Python 安装目录。
5. 在 Windows 的“应用执行别名”中关闭 Microsoft Store 的 `python.exe` 和 `python3.exe` 别名。
6. 安装 Git for Windows 和 7-Zip。
7. 以管理员身份打开 PowerShell，启用长路径：

```powershell
Set-ItemProperty `
  -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
  -Name LongPathsEnabled `
  -Type DWord `
  -Value 1
```

设置后重启 Windows。

## 三、一键编译

在项目机器上运行 `npm run kernel:export-kits`，把 `release\kernel-build-kits\windows-kernel` 整个文件夹复制到 Windows，
例如 `D:\windows-kernel-build-kit`。以管理员身份打开 PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
C:\prism-venv\Scripts\Activate.ps1
cd D:\windows-kernel-build-kit
.\Start.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

`Start.ps1` 依次做三件事：检查机器 → 准备固定版本源码 → 编译。第一次完整编译要几个小时，期间不要关机。

- 内存 32 GB 可以先用 `-Jobs 4`，稳定后再加大；机械硬盘不要加大。
- 编译期间脚本会阻止电脑睡眠，但挡不住手动关机、系统更新重启或拔盘。

## 四、中断、重启、换新版工具包

**什么情况都只运行同一条命令**：

```powershell
.\Start.ps1 -BuildRoot D:\prism-chromium -Jobs 4
```

- 中断或重启后：自动从断点继续，不会重新下载，也不会重新打补丁。
- 拿到新版工具包后：先把新工具包覆盖到原工具包目录，再运行上面的命令。脚本只给源码打上**新增的补丁**
  （`Update-Prism-Patches.ps1`），然后增量编译受影响的文件，不会重做完整编译。
- 如果报“只打上了一部分”或“补丁打不上”：不要删除 `D:\prism-chromium`，把 `D:\prism-chromium\logs`
  里最新的日志发回来。

### 加一个新补丁要改哪里

只改两处：把补丁放进 `tools/kernel-patches/`（同时复制到 `tools/windows-kernel/patches/`），在
`tools/kernel-lock.json` 的 `patches` 里加一行（文件名、SHA-256、插在哪个补丁后面、用来确认已打上的标记）。
准备源码、编译前检查、增量更新三个脚本都从这份清单读取，不需要改脚本。

## 五、成功产物

成功后文件位于：

```text
D:\prism-chromium\artifacts\144.0.7559.132-windows-x64
```

主要文件包括：

- `ungoogled-chromium_144.0.7559.132-1.1_windows_x64.zip`
- `ungoogled-chromium_144.0.7559.132-1.1_installer_x64.exe`
- `chromedriver.exe`
- `args.gn`
- `prism-build-lock.json`
- `manifest.json`
- `SHA256SUMS.txt`

编译结束后，把整个产物目录和最后一份日志复制回项目机器。Prism 集成时优先使用 ZIP，安装程序只用于独立内核验收。
`manifest.json` 的 `prismPatchSha256` 列出这次编进去的全部补丁。

## 六、注意事项

- 当前产物没有 Prism 的商业代码签名，Windows SmartScreen 可能提示未知发布者；
- 第一次完整编译可能持续数小时到一天以上，取决于 CPU、内存、磁盘和网络；
- 不要把源码放在 exFAT、FAT32、网络盘、OneDrive 同步目录或路径包含空格的位置；
- 不要用 `Remove-Item -Recurse -Force` 清理不确定的路径；
- Windows 编译与 macOS 后续开发可以同时进行，互不阻塞。

## 上游依据

- Windows 平台构建仓库：<https://github.com/ungoogled-software/ungoogled-chromium-windows>
- Fingerprint Chromium：<https://github.com/adryfish/fingerprint-chromium/tree/144.0.7559.132>
- Chromium 144 Windows 构建要求：<https://github.com/chromium/chromium/blob/144.0.7559.132/docs/windows_build_instructions.md>
