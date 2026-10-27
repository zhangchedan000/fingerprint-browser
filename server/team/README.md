# 团队服务器

指纹浏览器的「团队」功能用的服务器，基于 [PocketBase](https://pocketbase.io)（MIT 许可证）。PocketBase 自带账号、权限规则和文件存储，这里只有表结构（`pb_migrations`）和几段服务器脚本（`pb_hooks`），本身不需要写服务端程序。

## 存了什么

| 表 | 内容 |
| --- | --- |
| `users` | 一个主账号和若干成员账号。主账号只能通过初始化码创建一次，成员由主账号创建。 |
| `team_profiles` | 共享窗口：配置（包含代理和平台账号密码）、分配给哪些成员、登录态压缩包。 |
| `team_locks` | 窗口当前由谁占用。软件每 30 秒发一次心跳，超过 90 秒没有心跳就自动释放。 |
| `team_logs` | 操作日志：登录、打开、关闭、上传、分配、成员管理，只有主账号能看。 |

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

PocketBase 自带的网页管理后台在 `/_/`，需要先在服务器上创建一个超级管理员：

```bash
docker exec prism-team /pb/pocketbase superuser upsert 邮箱 密码 --dir=/pb/pb_data
```

## 测试

`smoke-test.sh` 会在一台**全新的**服务器上依次走一遍：建账号、权限、占用锁、版本冲突、40 MB 上传下载、停用账号。它会创建测试账号，跑完要清空 `pb_data`。
