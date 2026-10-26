# 指纹浏览器 (Fingerprint Browser)

本地多环境指纹浏览器，仅供个人本地使用：每个环境独立的 Cookie、缓存、扩展、代理和指纹配置，数据全部保存在本机，不连接任何第三方服务器。

## 持续维护分支

桌面软件后续更新统一维护在 [`desktop-updates`](https://github.com/zhangchedan000/fingerprint-browser/tree/desktop-updates) 分支，以 Git 提交记录保存源码，不通过 Release 附件分发源码。

当前应用版本：**0.1.1**。本次新增：

- 网络加速节点来源编辑，可修改名称、节点链接和订阅地址。
- 自动选择低延迟节点；手动固定后跨重启保留，可随时切回自动模式。
- 每个环境可选择恢复上次关闭的标签页，或打开指定页面。

实现与验证说明见 [0.1.1 更新说明](docs/desktop-network-session-0.1.1.md)。此分支推送后会执行 Windows 自动测试和便携版构建；浏览器内核继续独立管理。

## 功能

- 多环境管理：分组、标签、收藏、批量操作、回收站、复制环境
- 指纹：UA、语言、时区、屏幕、CPU/内存/GPU，Canvas / WebGL / Audio / DOMRect / 字体一致性
- 代理：HTTP / HTTPS / SOCKS5，代理检测，WebRTC 防泄漏，按出口 IP 匹配时区和语言
- 迁移：Cookie 导入导出、单环境备份、全部环境加密迁移包
- 内核管理：Chromium 144 指纹内核（基于 fingerprint-chromium + 本仓库 `tools/kernel-patches` 补丁）

## 开发

需要 Node.js 22+。

```bash
npm ci
npm test          # 类型检查 + 单元测试 + 内核锁校验
npm run dev       # 开发模式
npm run dist:win  # 打包 Windows（安装版 / 免安装版 / zip）
```

打包产物不含内核，可在应用的「浏览器内核」页面导入本地编译的 Chromium。

## 编译内核（Windows x64）

版本、上游 commit、补丁顺序和 SHA-256 锁定在 `tools/kernel-lock.json`，编译脚本在 `tools/windows-kernel`（说明见该目录 README）。建议 32 GB 内存、约 300 GB SSD 空间。

## 致谢与许可

本项目基于 [Prism Browser Community](https://github.com/DFarm6/Prism-Browser-Community)（MIT）二次开发，已移除其 Pro 授权、激活、公告和自动更新等联网组件。原始 MIT 许可与版权声明保留在 [LICENSE](LICENSE)。

指纹内核基于 [fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium) 与 [ungoogled-chromium](https://github.com/ungoogled-software/ungoogled-chromium)，分发内核时请一并遵守其许可。
