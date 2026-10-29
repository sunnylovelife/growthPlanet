# 成长星球 · 部署文档（搬瓦工 VPS）

对应文档：[技术设计](./03-tech-design.md)

> 本文按**当前代码的实际实现**编写。技术设计第 11 节写的是 Docker Compose 方案，但代码目前是"一个 Node 进程 + 内置 SQLite + 本地文件"，不需要 Docker，下面采用更简单的 **systemd + Caddy** 方案。

---

## 1. 部署架构

```
iPad / 手机浏览器
      │  HTTPS (443)
      ▼
   Caddy  ── 自动申请/续期 Let's Encrypt 证书，反向代理
      │  HTTP 127.0.0.1:8787
      ▼
 Node 24 进程（systemd 守护）
   ├── API：/api/*
   ├── 孩子端静态页：/            （apps/kid/dist）
   ├── 家长后台静态页：/admin/     （apps/admin/dist）
   ├── 视频播放：/media/videos/*  （支持 Range）
   ├── 定时任务：每 30 秒跑一次（生成任务周期、游泳自动确认等）
   └── 抖音下载队列：Chromium(playwright) → yt-dlp → 失败提示家长相册上传
      │
      ▼
 /opt/growthPlanet/data/
   ├── growth.sqlite (+ -wal / -shm)   数据库
   ├── videos/                          视频文件
   ├── photos/                          作业照片
   └── uploads/                         分片上传临时目录
```

关键事实（来自代码）：

| 项 | 值 |
|----|----|
| 运行时 | Node.js ≥ 22.18，推荐 **Node 24 LTS**（需要内置的 `node:sqlite` 和 TypeScript 类型擦除） |
| 启动命令 | `node --experimental-strip-types apps/server/src/index.ts`（即 `pnpm start`） |
| 端口 | 环境变量 `PORT`，默认 `8787`，监听 `0.0.0.0` |
| 数据目录 | 固定为 `<仓库根目录>/data`，不可配置 |
| 浏览器 | 环境变量 `CHROMIUM_PATH` 可指定 Chromium；不设则用 playwright 自带的 |
| 时区 | 业务代码固定按北京时间（`+08:00`）计算，服务器系统时区无所谓 |
| 首次启动 | 数据库为空时自动创建账号 `parent` / `boy` / `girl`，密码都是 `123456`；有 ffmpeg 时生成一条欢迎视频 |

## 2. 购买与准备 VPS

### 2.1 套餐选择

- **线路**：优先 **CN2 GIA-E**（如 DC6 / DC9 洛杉矶）或 **香港 CN2 GIA**，晚高峰在国内看视频才流畅。普通 KVM 线路晚高峰可能明显卡顿。
- **内存**：建议 **≥ 2GB**。下载抖音视频时会启动无头 Chromium，峰值约 300~500MB；1GB 套餐也能跑，但必须加 swap（见 3.3 节）。
- **硬盘**：视频是主要占用，720p 约 10MB/分钟。20GB 套餐大约能放几十个小时的视频，够家庭用；注意定期清理不用的视频。
- **系统**：在 KiwiVM 面板重装为 **Ubuntu 24.04 x86_64**（或 Debian 12）。playwright 的 `install-deps` 只官方支持 Ubuntu / Debian，不要选 CentOS。

### 2.2 搬瓦工特有注意点

- **SSH 端口不是 22**：搬瓦工会分配一个随机 SSH 端口，在 KiwiVM 面板首页可以看到，下文用 `<SSH端口>` 表示。
- **root 密码**：在 KiwiVM 面板 "Root password modification" 里生成。
- **IP 是否被墙**：拿到 IP 后先在国内 `ping` 一下，或用 [ping.pe](https://ping.pe) 检测。若国内全部不通，可以在 KiwiVM 里付费换 IP。
- **快照/备份**：KiwiVM 提供免费快照（Snapshots）和自动备份（Backups），部署完成后手动打一个快照。

### 2.3 域名

PWA 和 Service Worker 必须使用 HTTPS，所以需要一个域名（海外服务器无需 ICP 备案）。

在域名服务商处添加一条 **A 记录**：`growth.example.com → VPS 的 IP`（下文均以 `growth.example.com` 代指你的域名）。如果用 Cloudflare，**先关掉橙色云朵（仅 DNS）**，否则视频流量会绕路变慢，且 Caddy 申请证书可能失败。

## 3. 服务器初始化

以下命令用 root 登录执行：

```bash
ssh -p <SSH端口> root@<VPS_IP>
```

### 3.1 系统更新与基础工具

```bash
apt update && apt upgrade -y
apt install -y curl git ufw ffmpeg sqlite3 ca-certificates
```

`ffmpeg` 自带 `ffprobe`，用于探测视频时长、生成欢迎视频；`sqlite3` 用于备份。

### 3.2 创建运行用户

不要用 root 跑服务：

```bash
useradd -m -s /bin/bash growth
mkdir -p /opt/growthPlanet && chown growth:growth /opt/growthPlanet
```

### 3.3 添加 swap（1GB / 2GB 内存套餐建议都加）

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h
```

### 3.4 防火墙

服务进程监听在 `0.0.0.0:8787`，**必须挡住 8787**，只让 Caddy 对外：

```bash
ufw allow <SSH端口>/tcp   # 一定先放行 SSH 端口，否则会把自己锁在外面
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status
```

### 3.5 安装 Node 24 与 pnpm

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
node -v                       # 应为 v24.x

corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm -v                       # 应为 9.15.0
```

### 3.6 安装 yt-dlp（备用下载器）

使用独立二进制，不依赖 Python：

```bash
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
yt-dlp --version
```

### 3.7 安装 Caddy

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

## 4. 部署代码

### 4.1 本地：先把代码推到 GitHub

```bash
# 在本地仓库根目录
git add .
git status            # 确认没有 data/、dist/、node_modules/、.pnpm-store/
git commit -m "..."
git push origin main
```

`.gitignore` 已排除 `data/`、构建产物和依赖缓存，本地开发数据库和测试视频不会被上传，服务器会从空库开始。

> 仓库若是私有的，服务器上 clone 需要凭据：推荐在服务器 `growth` 用户下生成 SSH key（`ssh-keygen -t ed25519`），把公钥加到 GitHub 仓库的 **Settings → Deploy keys**（只读），然后用 `git@github.com:sunnylovelife/growthPlanet.git` 地址 clone。

### 4.2 服务器：拉取、安装依赖、构建前端

切换到 `growth` 用户：

```bash
su - growth
cd /opt/growthPlanet
git clone https://github.com/sunnylovelife/growthPlanet.git .

pnpm install --frozen-lockfile

pnpm --dir apps/kid build      # 产出 apps/kid/dist，挂在 /
pnpm --dir apps/admin build    # 产出 apps/admin/dist，挂在 /admin/
```

### 4.3 安装 Chromium（主下载器）

浏览器本体以 `growth` 用户安装（装到 `~/.cache/ms-playwright`）：

```bash
# 仍是 growth 用户
pnpm --dir apps/server exec playwright-core install chromium
exit   # 回到 root
```

系统依赖库需要 root 安装：

```bash
cd /opt/growthPlanet
pnpm --dir apps/server exec playwright-core install-deps chromium
```

### 4.4 先手动跑一次

```bash
su - growth -c "cd /opt/growthPlanet && PORT=8787 pnpm start"
```

看到 `成长星球已启动 http://localhost:8787` 后，另开一个 SSH 窗口验证：

```bash
curl http://127.0.0.1:8787/api/ping
# {"ok":true,"now":"..."}
```

确认无误后 `Ctrl+C` 停掉，交给 systemd 守护。

## 5. systemd 守护进程

创建 `/etc/systemd/system/growth-planet.service`：

```ini
[Unit]
Description=Growth Planet
After=network-online.target
Wants=network-online.target

[Service]
User=growth
Group=growth
WorkingDirectory=/opt/growthPlanet
Environment=PORT=8787
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --experimental-strip-types apps/server/src/index.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
systemctl daemon-reload
systemctl enable --now growth-planet
systemctl status growth-planet
journalctl -u growth-planet -f      # 实时查看日志
```

## 6. Caddy 反向代理与 HTTPS

编辑 `/etc/caddy/Caddyfile`，整个替换为：

```caddyfile
growth.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8787
}
```

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
journalctl -u caddy -f      # 观察证书申请，出现 "certificate obtained successfully" 即成功
```

Caddy 会自动申请并续期证书，HTTP 自动跳转 HTTPS，视频的 Range 请求会原样透传，不需要额外配置。

## 7. 上线后必做

1. **立即修改默认密码**：打开 `https://growth.example.com/admin/`，用 `parent / 123456` 登录，在账号管理里把家长和两个孩子的密码都改掉（也可以新建自己的账号后停用默认账号）。服务暴露在公网，这一步不能省。
2. **iPad 安装到主屏幕**：iPad 用 Safari 打开 `https://growth.example.com/` → 分享 → 添加到主屏幕，之后从主屏幕图标启动即为全屏模式。
3. **实测抖音下载**：在家长后台粘贴几条抖音分享文案，观察是否能下载成功。海外 IP 被抖音风控是常见情况，失败时后台会显示原因，此时用"从相册上传"兜底。
4. **KiwiVM 打快照**：一切正常后在面板手动打一个快照。

## 8. 日常更新

```bash
ssh -p <SSH端口> root@<VPS_IP>
su - growth
cd /opt/growthPlanet
git pull
pnpm install --frozen-lockfile
pnpm --dir apps/kid build
pnpm --dir apps/admin build
exit
systemctl restart growth-planet
```

注意：

- 下载队列和分片上传进度都保存在内存中，**重启会中断正在进行的下载/上传**。重启前到后台确认没有"下载中"的视频；中断的视频可点"重试"。
- 数据库表结构用 `CREATE TABLE IF NOT EXISTS` 创建，**新增字段不会自动加到已有表上**。以后若改了表结构，需要手动写 `ALTER TABLE`，上线前务必先备份。
- 如果 `playwright-core` 版本升级，需要重新执行 4.3 节安装对应版本的 Chromium。
- 孩子端有 Service Worker 缓存页面，更新后 iPad 上可能要完全关闭应用再打开一次才能看到新版本。

## 9. 备份

数据全部在 `/opt/growthPlanet/data/`，其中**数据库是最重要的**（钱包账本、任务记录都在里面），视频丢了可以重新下载。

### 9.1 服务器上每日备份数据库

SQLite 开着 WAL，不能直接 `cp` 数据库文件，要用 `.backup` 命令：

```bash
su - growth
mkdir -p ~/backup
crontab -e
```

加入一行（每天凌晨 3 点备份，保留 14 天）：

```cron
0 3 * * * sqlite3 /opt/growthPlanet/data/growth.sqlite ".backup '/home/growth/backup/growth-$(date +\%F).sqlite'" && find /home/growth/backup -name 'growth-*.sqlite' -mtime +14 -delete
```

### 9.2 拉一份到自己电脑（异地备份）

在自己的 Mac 上执行（可以放进 Mac 的定时任务）：

```bash
rsync -avz -e "ssh -p <SSH端口>" root@<VPS_IP>:/home/growth/backup/ ~/growthPlanet-backup/db/
rsync -avz -e "ssh -p <SSH端口>" root@<VPS_IP>:/opt/growthPlanet/data/photos/ ~/growthPlanet-backup/photos/
```

### 9.3 恢复

```bash
systemctl stop growth-planet
cp /home/growth/backup/growth-2026-10-29.sqlite /opt/growthPlanet/data/growth.sqlite
rm -f /opt/growthPlanet/data/growth.sqlite-wal /opt/growthPlanet/data/growth.sqlite-shm
chown growth:growth /opt/growthPlanet/data/growth.sqlite
systemctl start growth-planet
```

## 10. 常见问题排查

| 现象 | 排查 |
|------|------|
| 浏览器打不开域名 | `dig growth.example.com` 看解析是否指向 VPS；`ufw status` 看 80/443 是否放行；`journalctl -u caddy` 看证书是否申请成功 |
| 502 Bad Gateway | Node 进程没起来：`systemctl status growth-planet`、`journalctl -u growth-planet -n 100` |
| 启动报 `node:sqlite` 找不到或 `.ts` 无法执行 | Node 版本太低，`node -v` 确认是 v24 |
| 打开首页是 404 JSON `没有这个页面` | 前端没构建，检查 `apps/kid/dist`、`apps/admin/dist` 是否存在 |
| 视频下载失败："浏览器：服务器上没有安装" | 4.3 节的 Chromium 没装，或是用 root 而不是 `growth` 用户装的 |
| 视频下载失败："抖音没有返回视频信息，可能触发了验证" | 海外 IP 被风控，属预期情况，改用相册上传 |
| 视频下载失败："yt-dlp：服务器上没有安装" | 3.6 节未完成，或 `/usr/local/bin` 不在 PATH |
| 下载时进程被杀 / 服务器卡死 | 内存不足，检查 swap：`free -h`；`dmesg \| grep -i oom` |
| 晚上看视频卡顿 | 线路问题，考虑换 CN2 GIA 套餐，或在后台少放超长视频 |
| 硬盘满了 | `du -sh /opt/growthPlanet/data/*`，在后台删除不用的视频；`data/uploads/` 下中断上传的残留目录可以手动删掉 |

## 11. 已知限制（部署相关）

- iPad 主屏幕图标目前用的是 SVG，iOS 不支持 SVG 作为 `apple-touch-icon`，会显示为页面截图。需要时补一张 180×180 的 PNG 图标。
- 后台"从相册上传"的视频不会转码，iPhone 拍的 HEVC 视频在 iPad 上能播，但体积较大。
- 登录日志目前没有记录真实 IP（代码里写的是空字符串）。若要记录，需要读取 Caddy 转发的 `X-Forwarded-For` 头。
