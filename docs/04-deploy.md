# 成长星球 · 部署文档（搬瓦工 VPS · AlmaLinux 9）

对应文档：[技术设计](./03-tech-design.md)

> 本文按**当前代码的实际实现**和**这台已有的 VPS** 编写。技术设计第 11 节写的是 Docker Compose 方案，但代码目前是"一个 Node 进程 + 内置 SQLite + 本地文件"，不需要 Docker，这里采用更简单的 **systemd + Caddy** 方案。

---

## 0. 目标服务器现状与原则

| 项 | 现状 |
|----|------|
| 系统 | AlmaLinux 9.7（RHEL 系，用 `dnf`，默认开启 SELinux） |
| CPU / 内存 | 2 核 / 1GB，已有 544MB swap |
| 磁盘 | `/` 19G，可用约 15G |
| 已有服务 | Docker 跑着 `codex-proxy-rs`、`postgres`、`redis`，分别绑在 `127.0.0.1:8080 / 5432 / 6379` |
| 端口占用 | 80、443、8787 均空闲 |

**部署原则：已有的东西不要动。**

- 不修改、不重启 Docker 和现有容器。
- 不改现有 swap，只**额外**增加一个 swap 文件。
- Node 装在独立目录 `/opt/node24`，ffmpeg、yt-dlp 用静态二进制放进 `/usr/local/bin`，不替换系统已有的任何软件。
- 不执行 `firewall-cmd --reload`（reload 可能清掉 Docker 写入的网络规则），只追加放行 80/443。
- 成长星球服务只监听 `127.0.0.1:8787`，由 Caddy 对外，不需要为 8787 改防火墙。
- 给成长星球服务设置内存上限和更高的 OOM 优先级：内存不够时先牺牲它，不影响现有容器。

## 1. 部署架构

```
iPad / 手机浏览器
      │  HTTPS (443)
      ▼
   Caddy  ── 自动申请/续期 Let's Encrypt 证书，反向代理
      │  HTTP 127.0.0.1:8787
      ▼
 Node 24 进程（systemd 守护，内存上限 600MB）
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
| 运行时 | Node.js ≥ 22.18，使用 **Node 24 LTS**（需要内置的 `node:sqlite` 和 TypeScript 类型擦除） |
| 启动命令 | `node --experimental-strip-types apps/server/src/index.ts` |
| 监听地址 | 环境变量 `HOST`（默认 `0.0.0.0`）和 `PORT`（默认 `8787`）；本部署设为 `127.0.0.1:8787` |
| 数据目录 | 固定为 `<仓库根目录>/data`，不可配置 |
| 浏览器 | 环境变量 `CHROMIUM_PATH` 可指定 Chromium；不设则用 playwright 自带的 |
| 时区 | 业务代码固定按北京时间（`+08:00`）计算，服务器系统时区无所谓 |
| 首次启动 | 数据库为空时自动创建账号 `parent` / `boy` / `girl`，密码都是 `123456`；有 ffmpeg 时生成一条欢迎视频 |

## 2. 准备域名

PWA 和 Service Worker 必须使用 HTTPS，所以需要一个域名（海外服务器无需 ICP 备案）。

在域名服务商处添加一条 **A 记录**：`growth.example.com → VPS 的 IP`（下文均以 `growth.example.com` 代指你的域名）。如果用 Cloudflare，**先关掉橙色云朵（仅 DNS）**，否则视频流量会绕路变慢，且 Caddy 申请证书可能失败。

## 3. 服务器初始化

以下命令用 root 登录执行（搬瓦工的 SSH 端口不是 22，在 KiwiVM 面板首页查看）：

```bash
ssh -p <SSH端口> root@<VPS_IP>
```

### 3.1 先确认环境

```bash
uname -m                              # 应为 x86_64
getenforce                            # 一般为 Enforcing
systemctl is-active firewalld         # active 或 inactive，3.5 节要用
swapon --show                         # 记下已有 swap，后面不动它
command -v node ffmpeg ffprobe yt-dlp caddy   # 确认这些都还没装，避免覆盖
```

### 3.2 安装基础工具（只新增，不升级系统）

不执行 `dnf upgrade`，避免顺带升级 Docker 等已有软件：

```bash
dnf install -y git tar xz sqlite curl
```

### 3.3 额外增加 2G swap

1GB 内存同时承载现有容器和本服务非常吃紧，下载抖音时启动的 Chromium 峰值还要 300~500MB。已有的 544MB swap 不动，再加一个独立的 swap 文件：

```bash
fallocate -l 2G /swapfile-growth
chmod 600 /swapfile-growth
mkswap /swapfile-growth
swapon /swapfile-growth
echo '/swapfile-growth none swap sw 0 0' >> /etc/fstab
swapon --show        # 应看到原有 swap 和 /swapfile-growth 两条
free -h
```

### 3.4 创建运行用户

```bash
useradd -m -s /bin/bash growth
mkdir -p /opt/growthPlanet && chown growth:growth /opt/growthPlanet
```

### 3.5 防火墙放行 80/443

先看 3.1 节 `firewalld` 的状态：

- **inactive**：什么都不用做（搬瓦工本身没有外部防火墙）。因为服务只监听 `127.0.0.1`，8787 不会暴露。
- **active**：同时写入运行时和永久规则，**不要执行 `firewall-cmd --reload`**：

```bash
firewall-cmd --add-service=http --add-service=https
firewall-cmd --permanent --add-service=http --add-service=https
firewall-cmd --list-services
```

### 3.6 安装 Node 24（独立目录）

用官方二进制包装到 `/opt/node24`，不影响系统和容器：

```bash
cd /tmp
NODE_TAR=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep 'linux-x64.tar.xz' | awk '{print $2}')
curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$NODE_TAR"
mkdir -p /opt/node24
tar -xJf "$NODE_TAR" -C /opt/node24 --strip-components=1
/opt/node24/bin/node -v        # 应为 v24.x

/opt/node24/bin/corepack enable
/opt/node24/bin/corepack prepare pnpm@9.15.0 --activate
```

让 `growth` 用户的登录 Shell 能找到 node 和 pnpm：

```bash
echo 'export PATH=/opt/node24/bin:$PATH' >> /home/growth/.bashrc
```

### 3.7 安装 ffmpeg / ffprobe（静态二进制）

AlmaLinux 官方源没有 ffmpeg，加 RPM Fusion 等第三方源会牵连很多系统包，这里直接用静态编译版：

```bash
cd /tmp
curl -fsSLO https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar -xJf ffmpeg-release-amd64-static.tar.xz
cp ffmpeg-*-amd64-static/ffmpeg ffmpeg-*-amd64-static/ffprobe /usr/local/bin/
ffmpeg -version | head -1
ffprobe -version | head -1
```

### 3.8 安装 yt-dlp（备用下载器）

```bash
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
yt-dlp --version
```

### 3.9 安装 Caddy

```bash
dnf install -y 'dnf-command(copr)'
dnf copr enable -y @caddy/caddy
dnf install -y caddy
caddy version
```

## 4. 部署代码

### 4.1 拉取代码并安装依赖

```bash
su - growth
cd /opt/growthPlanet
git clone https://github.com/sunnylovelife/growthPlanet.git .
pnpm install --frozen-lockfile
```

> 仓库若改为私有：在 `growth` 用户下 `ssh-keygen -t ed25519`，把公钥加到 GitHub 仓库的 **Settings → Deploy keys**（只读），改用 `git@github.com:sunnylovelife/growthPlanet.git` clone。

### 4.2 前端在本地 Mac 构建后上传

服务器可用内存只有一两百 MB，在上面跑 Vite 构建会大量占用 swap、拖慢现有容器。前端在本地构建再传上去：

```bash
# 在本地 Mac 的仓库根目录执行
pnpm --dir apps/kid build
pnpm --dir apps/admin build
rsync -avz --delete -e "ssh -p <SSH端口>" apps/kid/dist/   root@<VPS_IP>:/opt/growthPlanet/apps/kid/dist/
rsync -avz --delete -e "ssh -p <SSH端口>" apps/admin/dist/ root@<VPS_IP>:/opt/growthPlanet/apps/admin/dist/
```

上传后在服务器上修正属主：

```bash
chown -R growth:growth /opt/growthPlanet/apps/kid/dist /opt/growthPlanet/apps/admin/dist
```

### 4.3 安装 Chromium（主下载器）

浏览器本体以 `growth` 用户安装（装到 `~/.cache/ms-playwright`）：

```bash
su - growth
cd /opt/growthPlanet
pnpm --dir apps/server exec playwright-core install chromium
exit
```

playwright 的 `install-deps` 不支持 RHEL 系，系统依赖库需要手动装（都是新增的图形/字体库，不影响已有服务）：

```bash
dnf install -y nss atk at-spi2-atk cups-libs libdrm libxkbcommon \
  libXcomposite libXdamage libXrandr libXfixes mesa-libgbm pango alsa-lib
```

检查是否还缺库（没有输出即为正常）：

```bash
find /home/growth/.cache/ms-playwright -type f \( -name 'chrome-headless-shell' -o -name 'headless_shell' -o -name 'chrome' \) \
  -exec ldd {} \; | grep 'not found'
```

若有 `not found`，用 `dnf provides '*/库文件名'` 找到对应的包再装。

> 如果之后发现下载视频时整台机器明显变卡，可以不用 Chromium：执行 `rm -rf /home/growth/.cache/ms-playwright`，服务会自动退到 yt-dlp，再失败就提示家长从相册上传。

### 4.4 先手动跑一次

```bash
su - growth -c "cd /opt/growthPlanet && HOST=127.0.0.1 PORT=8787 node --experimental-strip-types apps/server/src/index.ts"
```

看到 `成长星球已启动` 后，另开一个 SSH 窗口验证：

```bash
curl http://127.0.0.1:8787/api/ping            # {"ok":true,"now":"..."}
ss -tlnp | grep 8787                           # 应为 127.0.0.1:8787，而不是 0.0.0.0:8787
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
Environment=HOST=127.0.0.1
Environment=PORT=8787
Environment=NODE_ENV=production
Environment=PATH=/opt/node24/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/opt/node24/bin/node --experimental-strip-types apps/server/src/index.ts
Restart=always
RestartSec=3
MemoryHigh=450M
MemoryMax=600M
OOMScoreAdjust=500

[Install]
WantedBy=multi-user.target
```

- `PATH` 里必须包含 `/usr/local/bin`，服务才能找到 ffmpeg、ffprobe、yt-dlp。
- `MemoryHigh` / `MemoryMax` 限制的是整个服务（包括它启动的 Chromium）；超出时只会杀掉本服务内的进程，不会波及现有容器。
- `OOMScoreAdjust=500` 让整机内存耗尽时内核优先杀本服务。

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
systemctl enable --now caddy
systemctl reload caddy
journalctl -u caddy -f      # 出现 "certificate obtained successfully" 即证书申请成功
```

Caddy 会自动申请并续期证书，HTTP 自动跳转 HTTPS，视频的 Range 请求会原样透传。

**SELinux**：如果浏览器访问返回 502，且 `journalctl -u caddy` 里有 `permission denied` 连接 `127.0.0.1:8787`，说明 SELinux 拦截了 Caddy 访问本地端口，执行：

```bash
setsebool -P httpd_can_network_connect 1
```

## 7. 上线后必做

1. **立即修改默认密码**：打开 `https://growth.example.com/admin/`，用 `parent / 123456` 登录，在账号管理里把家长和两个孩子的密码都改掉。服务暴露在公网，这一步不能省。
2. **iPad 安装到主屏幕**：iPad 用 Safari 打开 `https://growth.example.com/` → 分享 → 添加到主屏幕，之后从主屏幕图标启动即为全屏模式。
3. **实测抖音下载**：在家长后台粘贴一条抖音分享文案，同时在另一个窗口执行 `free -h` 和 `docker stats --no-stream` 观察内存，确认现有容器没受影响。海外 IP 被抖音风控是常见情况，失败时用"从相册上传"兜底。
4. **KiwiVM 打快照**：一切正常后在面板手动打一个快照。

## 8. 日常更新

```bash
# 本地 Mac：构建并上传前端（同 4.2 节）
pnpm --dir apps/kid build && pnpm --dir apps/admin build
rsync -avz --delete -e "ssh -p <SSH端口>" apps/kid/dist/   root@<VPS_IP>:/opt/growthPlanet/apps/kid/dist/
rsync -avz --delete -e "ssh -p <SSH端口>" apps/admin/dist/ root@<VPS_IP>:/opt/growthPlanet/apps/admin/dist/

# 服务器：拉代码、装依赖、重启
ssh -p <SSH端口> root@<VPS_IP>
chown -R growth:growth /opt/growthPlanet/apps/kid/dist /opt/growthPlanet/apps/admin/dist
su - growth -c "cd /opt/growthPlanet && git pull && pnpm install --frozen-lockfile"
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

> AlmaLinux 最小安装可能没有 cron：`dnf install -y cronie && systemctl enable --now crond`。

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
| 浏览器打不开域名 | `dig growth.example.com` 看解析是否指向 VPS；firewalld 开着时 `firewall-cmd --list-services` 看是否有 http/https；`journalctl -u caddy` 看证书是否申请成功 |
| 502 Bad Gateway | 先看 Node 进程：`systemctl status growth-planet`、`journalctl -u growth-planet -n 100`；进程正常则看第 6 节 SELinux |
| 启动报 `node:sqlite` 找不到或 `.ts` 无法执行 | 用的不是 `/opt/node24/bin/node`，检查 systemd 文件里的 `ExecStart` |
| 打开首页是 404 JSON `没有这个页面` | 前端没上传，检查 `apps/kid/dist`、`apps/admin/dist` 是否存在 |
| 视频下载失败，提示浏览器启动失败 / 缺少 `.so` 库 | 4.3 节的系统依赖没装全，按 `ldd` 检查结果补装 |
| 视频下载失败："抖音没有返回视频信息，可能触发了验证" | 海外 IP 被风控，属预期情况，改用相册上传 |
| 视频下载失败："yt-dlp：服务器上没有安装" | 3.8 节未完成，或 systemd 文件 `PATH` 里没有 `/usr/local/bin` |
| 服务频繁重启，日志里有 `oom-kill` | 触发了 `MemoryMax`，多半是下载时 Chromium 太占内存；可删掉 Chromium（见 4.3 节末尾）只用相册上传 |
| 现有容器变慢 | `free -h` 看 swap 是否打满；`docker stats --no-stream` 看各容器占用；必要时 `systemctl stop growth-planet` 先停本服务 |
| 硬盘满了 | `du -sh /opt/growthPlanet/data/*`，在后台删除不用的视频；`data/uploads/` 下中断上传的残留目录可以手动删掉 |

## 11. 已知限制（部署相关）

- 1GB 内存是硬约束：现有容器加本服务已接近上限，抖音下载（Chromium）会明显依赖 swap。家庭场景下载频率低，可以接受；若长期卡顿，建议升级到 2GB 套餐。
- iPad 主屏幕图标目前用的是 SVG，iOS 不支持 SVG 作为 `apple-touch-icon`，会显示为页面截图。需要时补一张 180×180 的 PNG 图标。
- 后台"从相册上传"的视频不会转码，iPhone 拍的 HEVC 视频在 iPad 上能播，但体积较大。
- 登录日志目前没有记录真实 IP（代码里写的是空字符串）。若要记录，需要读取 Caddy 转发的 `X-Forwarded-For` 头。
