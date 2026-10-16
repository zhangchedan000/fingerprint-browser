# 指纹浏览器 · 架构说明

改代码前先读这一页。它说明每块代码管什么、谁引用谁，以及加字段、加页面、改颜色各要动哪里。

## 第一条规则：一份定义，到处引用

同一个东西出现两次，就做成一份“中心版”，其他地方都引用它，修改也只改这一份。

- **数据**：代理、分组各只存一份，窗口只存 `proxyId` / `groupId`。
- **颜色**：只在 `theme/tokens.ts` 里定义，其他地方不写任何颜色值（有测试检查）。
- **界面**：列表页、分配弹窗、代理格子、状态点都是共用组件，页面只填配置。

例外：看起来一样、但意思不同的东西不硬合并。比如代理密码和平台账号密码：底层共用加密，上层分开处理。

## 基础数据（主进程）

整个系统只有 3 种基础数据，以后加团队再多一种“成员”。其余都是引用。

| 数据 | 存在哪里 | 说明 |
|---|---|---|
| 窗口 | `profile-store.ts` | 指纹、Cookie、账号每个窗口各一份，绝不共享 |
| 代理 | `workspace-library.ts` | 代理库，窗口通过 `proxyId` 引用，`''` 表示直连 |
| 分组 | `workspace-library.ts` | 分组库，窗口通过 `groupId` 引用，`''` 表示未分组 |

三者写在同一个文件里（`profiles.json`，schema 12），所以引用永远和已保存的数据对得上。

**读取窗口时补全引用**：`ProfileStore.resolve()` 按 `proxyId` / `groupId` 填好 `proxy`、`group` 和 `proxyCheck`。其他代码（启动器、Cookie、导出）读到的就是完整窗口，不需要关心引用。

**统一入口：**

| 要做的事 | 唯一入口 |
|---|---|
| 手填的代理或分组名进入系统（编辑器、批量导入、恢复、迁移包） | `WorkspaceLibrary.ensureProxy` / `ensureGroup`：库里已有就复用，没有才新增 |
| 把窗口分配给代理或分组 | `ProfileStore.assignMany(ids, { proxyId?, groupId? })` |
| 窗口转回可重建的草稿（复制、导出配置、数据备份、迁移包） | `profile-portable.ts` 的 `portableDraft` |
| 代理检测结果 | 存在代理上（`setProxyCheck` / `setLibraryProxyCheck`），用它的窗口共享 |

**关系规则（都写在 `profile-store.ts`）：**

- 删除正在使用的代理，必须指定替换的代理，或改为直连（`removeProxy(id, replaceWith)`）。
- 删除分组：它的窗口变成未分组。
- 运行中的窗口不能换代理；正在被运行中窗口使用的代理不能改连接信息。
- 引用指向不存在的代理时，窗口标记 `proxyMissing`，**禁止启动**，绝不退回真实网络。
- 旧版数据（schema ≤ 11，代理存在窗口里）打开时自动升级：相同的代理合并成一条，分组名转成分组记录。升级前旧文件另存为 `profiles.v<N>.before-upgrade.json`。

## 界面（渲染进程 `src/renderer/src`）

```
theme/        颜色：tokens.ts 定义全部颜色，index.tsx 提供 applyTheme()
data/         workspace.tsx：所有页面共用的数据（窗口、代理库、分组库、内核、扩展）
components/   共用组件：ListPage（列表模板）、AssignModal（选一个库记录的分配弹窗）、WindowPicker（勾选窗口）、
              StatCards（统计卡片）、ProxyCell、StatusDot、Sidebar、格式化函数
pages/        每个侧边栏页面一个文件夹
  registry.tsx  页面登记表：侧边栏、顶栏、导航都从这里读取
  windows/      窗口管理（列表、编辑抽屉、批量导入等）
  proxies/      代理 IP（代理库：添加、批量导入、检测、分配到窗口、删除时选替换）
  kernels/ extensions/ recycle/   目前还是弹窗，以后改成页面
App.tsx       外壳：侧边栏 + 顶栏 + 当前页面
```

- 页面不直接重复调用主进程拿同一份数据，统一用 `useWorkspace()`。在一个页面改了数据，其他页面会同时更新。
- 代理被几个窗口使用、分组里有几个窗口，都是 `workspace.tsx` 根据窗口实时算出来的，不另外保存。

## 常见改动怎么做

**给窗口加一个字段**
1. `shared/types.ts`：`BrowserProfile` / `ProfileDraft` 加字段。
2. `shared/validation.ts`：`validateProfileDraft` 加校验和默认值。
3. `main/profile-portable.ts`：如果这个字段要随复制、导出一起带走，在这里加一行。
4. 在需要显示的页面里摆放（编辑抽屉 / 列表列）。

**加一个页面**
1. 新建 `pages/<名称>/`，导出页面组件。
2. 在 `pages/registry.tsx` 的 `PAGES` 里登记一行（图标、名称、分区、计数）。
3. 列表类页面直接用 `components/ListPage`；需要分配的地方用 `components/AssignModal`。

**加一种可分配的东西（例如以后的“成员”）**
1. `workspace-library.ts` 加成员库（照代理、分组的写法）。
2. 窗口加引用字段（如 `memberIds`），并在 `assignMany` 里加上它的检查。
3. 界面用 `AssignModal`（选一个成员）或 `WindowPicker`（勾选窗口）选择，不需要写新的分配逻辑。

代理页的“分配到窗口”就是这样做的：勾选窗口用 `WindowPicker`，提交走 `assignMany`；按顺序批量分配只是先把代理和窗口配好对（`pages/proxies/pairing.ts`），再按代理分组调用 `assignMany`。

**改颜色 / 加主题 / 深色模式**
- 只改 `theme/tokens.ts`：`LIGHT` 是浅色，`DARK` 是深色，`ACCENT_PRESETS` 是可选主题色。
- 切换主题调用 `applyTheme({ accent, mode })`，自己写的样式和 antd 组件一起变。
- 写样式时只用 `var(--fb-*)`。`theme/theme.test.ts` 会检查有没有写死的颜色。

**加界面文字**
- 用 `t("中文原文")`，并在 13 个语言文件 `shared/locales/*.json` 里补上翻译。
- 主进程报错用中文原文抛出，界面用 `translateMessage` 翻译，所以这些原文也要加进语言文件。
- `npm test` 会检查是否漏翻。

## 验证

- `npm test`：类型检查、全部单元测试（包括升级旧数据、引用规则、主题检查、翻译检查）、内核锁检查。
- `npx electron-vite build`：打包检查。
