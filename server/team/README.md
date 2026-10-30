# 团队服务器

指纹浏览器的「团队」功能用的服务器，基于 [PocketBase](https://pocketbase.io)（MIT 许可证）。PocketBase 自带账号、权限规则和文件存储，这里只有表结构（`pb_migrations`）和几段服务器脚本（`pb_hooks`），本身不需要写服务端程序。

## 存了什么

| 表 | 内容 |
| --- | --- |
| `users` | 一个主账号和若干成员账号。主账号只能通过初始化码创建一次；成员由主账号创建，或者用主账号生成的邀请码自己注册。 |
| `team_invites` | 邀请码：一人一码，7 天有效，注册一个成员后作废。只能通过 `pb_hooks/invites.pb.js` 的接口读写。 |
| `team_profiles` | 共享窗口：配置（包含代理和平台账号密码）、分配给哪些成员、登录态压缩包。 |
| `team_locks` | 窗口当前由谁占用。软件每 30 秒发一次心跳，超过 90 秒没有心跳就自动释放。 |
| `team_logs` | 操作日志：登录、打开、关闭、上传、分配、成员管理，只有主账号能看。 |

同一个用户名 15 分钟内输错 5 次密码会暂停登录 15 分钟；同一个 IP 乱试邀请码也一样（`team_utils.js` 的 `MAX_FAILURES`、`HOLD_MS`）。暂停记录在内存里，重启服务器就清空。

成员只能看到分配给自己的窗口，不能修改配置。上传登录态之前必须先占用窗口，而且版本号要对得上，这样两个人不会互相覆盖。

## 部署

需要 Docker。下面以 `/opt/prism-team` 为例：

```bash
cd /opt/prism-team
(umask 077; echo "TEAM_SETUP_CODE=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')" > .env)
mkdir -p pb_data
docker compose up -d --build
```

- 服务只监听 `127.0.0.1:8090`，同时加入 Nginx Proxy Manager 的网络（默认 `nginx-proxy-manager_default`，可以用 `PROXY_NETWORK` 修改）。
- 对外入口：新加坡服务器用的是手写的 Nginx Proxy Manager 配置（`nginx-proxy-host.conf`，域名 `temu.orenge.ccwu.cc`），证书由 NPM 容器里的 certbot 申请。也可以在 NPM 面板里加一个 Proxy Host，转发到 `http://prism-team:8090`，开启 SSL，并在 Advanced 里加一行 `client_max_body_size 2048m;`。
- 第一次在软件的「团队」里连接这个域名时，会要求填初始化码（`.env` 里的 `TEAM_SETUP_CODE`）来创建主账号。主账号创建后，初始化码就没用了。

## 数据和备份

所有数据都在 `pb_data/`：SQLite 数据库加上上传的登录态文件。

- 服务器每天北京时间 03:00 自动备份一次（`pb_data/backups/`），保留最近 7 份（`1761600003_backups.js`）。
- 主账号可以在软件的「团队 → 服务器」里查看磁盘和数据占用、谁在用哪个窗口，并能立即备份、下载或删除备份。这些操作都会记进日志。接口：`/api/team/server`、`/api/team/backups`，只有主账号能调。
- 备份是整个 `pb_data` 的 zip，里面有窗口配置（含代理和平台账号密码）和登录态，要妥善保管。
- 恢复备份会覆盖现有数据，请在服务器上操作：停掉容器，把 zip 解压覆盖 `pb_data/` 后再启动。

### 异地备份（Cloudflare R2）

上面的 zip 和数据在同一块硬盘上，服务器坏了会一起丢。所以有变化时，再往 R2 存一份（`pb_hooks/r2_utils.js`，用容器里的 rclone）：

- 数据库（账号、窗口配置、日志）：有改动后 1 分钟内传一份完整副本，`db/<时间>.db.gz`，保留 7 天。心跳和占用这些临时状态不算改动。
- 登录态：窗口关闭、上传后 1 分钟内传到 `storage/`。
- 每天北京时间 03:30（以及服务器启动后第一分钟）做一次完整同步：`storage/` 和服务器保持一致，被删的文件移到 `deleted/<日期>/` 保留 7 天。
- 软件「团队 → 服务器」里能看到最近一次同步的时间和失败原因。

开启：在 R2 建一个存储桶，再建一个「对象读和写」权限、只限这个桶的 API 令牌。然后用主账号在软件「团队 → 服务器 → 异地备份」里点「设置异地备份」，填存储桶的 S3 API 地址（`https://<账户>.r2.cloudflarestorage.com/<存储桶>`）和令牌的两个密钥。服务器先试着写一个小文件，成功了才保存到 `pb_data/r2.env`（权限 600），之后软件里只显示密钥 ID 的前后几位。容器里要有 rclone，所以第一次加上这个功能时要 `docker compose up -d --build`。

恢复：在服务器的部署目录里运行 `sudo ./r2-restore.sh`，它会先列出要用的数据库副本，确认后加 `--yes`。它会把现在的 `pb_data` 改名留着，再从 R2 拉回最新的数据库（或指定的那一份）和全部登录态。

PocketBase 自带的网页管理后台在 `/_/`，需要先在服务器上创建一个超级管理员：

```bash
docker exec prism-team /pb/pocketbase superuser upsert 邮箱 密码 --dir=/pb/pb_data
```

## 私有文件（`pb_hooks/assets.pb.js`）

有些文件启动器要用、但不能放进公开的安装包或公开的内核发布，就放在服务器的 `pb_data/assets/`，团队成员登录后由启动器下载（`GET /api/team/assets/<名字>`，没登录 401，停用的账号 403）。现在有两个：

| 文件 | 用途 | 原件 |
| --- | --- | --- |
| `seguiemj-win10.ttf` | Win10 的表情字体（Segoe UI Emoji 1.29，SHA-256 `7c0244dd…692a2b4f`）：Win11 电脑上开 Win10 窗口时用它画表情 | 私有仓库 `prism-kernel` 的 `private-assets/win10-emoji/` |
| `segoeui-win10.zip` | Win10 的 Segoe UI 全家 12 个文件（正体 5.62、斜体 5.32、Black 2.02，SHA-256 `2e1bfb50…c58ccd39586a7`）：Win11 电脑上开 Win10 窗口时用它排 Segoe UI（Win11 的 5.72 字距不同） | 私有仓库 `prism-kernel` 的 `private-assets/win10-segoeui/` |

`pb_data/` 整个在每天的备份 zip 里，所以从备份恢复服务器时这些文件也回来了。

**放上去 / 重新放上去**（换了服务器、或者 `pb_data` 丢了）：上传要一次性口令，只能在服务器上生成，用一次就作废：

```bash
cd /opt/prism-team
T=$(head -c 24 /dev/urandom | base64 | tr -d '/+='); echo -n "$T" > pb_data/assets/.upload-token; echo "$T"
```

然后在有这个文件的电脑上（从私有仓库取）：

```bash
node upload-asset.mjs seguiemj-win10.ttf seguiemj-win10.ttf <上面的口令>
```

返回 `200 {"name":"seguiemj-win10.ttf","size":2072388}` 就好了。

## 测试

`smoke-test.sh` 会在一台**全新的**服务器上依次走一遍：建账号、权限、占用锁、版本冲突、40 MB 上传下载、停用账号。它会创建测试账号，跑完要清空 `pb_data`。
