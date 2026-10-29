# 指纹浏览器 (Fingerprint Browser)

本地多环境指纹浏览器：每个窗口独立的 Cookie、缓存、扩展、代理和指纹配置，数据保存在本机；团队版可把窗口同步到自己的团队服务器。

## 版本与下载

- 启动器：本仓库的 [Releases](https://github.com/zhangchedan000/fingerprint-browser/releases)，每个版本的改动见 [`release-notes/`](release-notes/)。已安装的在「设置 → 关于」里更新。
- 浏览器内核（Prism 指纹内核，Chromium 156 / 155）：单独发布在 [prism-kernel-releases](https://github.com/zhangchedan000/prism-kernel-releases/releases)，在软件的「内核管理 → 在线下载内核」里一键安装和更新。内核的补丁和编译包不在本仓库。
- 开发分支：[`desktop-updates`](https://github.com/zhangchedan000/fingerprint-browser/tree/desktop-updates)；打标签 `v*` 后自动打包 Windows 安装包并发布。

## 功能

- 窗口管理：分组、标签、收藏、批量导入 / 操作、回收站、复制窗口
- 指纹：UA 和 Client Hints、系统版本、语言、时区、地理位置、屏幕、CPU / 内存、显卡（WebGL / WebGPU / 视频编解码）、Canvas / WebGL / 音频 / ClientRects 噪音、按系统语言的字体、语音、媒体设备、键盘布局、WebRTC
- 代理：HTTP / HTTPS / SOCKS5、API 提取、代理 IP 库（检测结果和 IP 评分共用）、网络加速节点、按出口 IP 配国家、时区和语言
- 检测：指纹检测、深度检测（检测网站）、IP 评分
- 迁移与团队：Cookie 导入导出、窗口备份、团队云端同步（登录状态、书签、扩展等）

## 开发

需要 Node.js 22+。

```bash
npm ci
npm test          # 类型检查 + 单元测试
npm run dev       # 开发模式
npm run dist:win  # 打包 Windows 安装包
```

代码结构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，界面多语言见 [docs/localization.md](docs/localization.md)。实机测试在 `tools/app-e2e/`。

## 致谢与许可

本项目基于 [Prism Browser Community](https://github.com/DFarm6/Prism-Browser-Community)（MIT）二次开发，已移除其 Pro 授权、激活、公告和自动更新等联网组件。原始 MIT 许可与版权声明保留在 [LICENSE](LICENSE)。

Prism 指纹内核基于 [ungoogled-chromium](https://github.com/ungoogled-software/ungoogled-chromium)，最初移植自 [fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium) 144 的补丁，分发内核时请一并遵守其许可。
