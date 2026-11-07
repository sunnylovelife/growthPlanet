# 成长星球 · 家里 Mac 部署文档（VirtualBox 虚拟机）

对应文档：[VPS 部署文档](./04-deploy.md)

> 适用于家里那台 **MacBook Pro Retina 13" Late 2013 / macOS High Sierra 10.13.6 / 4GB 内存**，不升级系统。
>
> 思路：High Sierra 装不了 Node 24，所以在 Mac 上开一个 **AlmaLinux 9 虚拟机**，服务跑在虚拟机里。虚拟机里的步骤和 VPS 基本一样，本文只写不同的地方，相同的部分直接引用 04 文档的章节号。

---

## 0. 结构

```
iPad（家里 WiFi）
   │  http://<Mac 的局域网 IP>:8787
   ▼
Mac（High Sierra）── VirtualBox 端口转发 8787 → 虚拟机 8787
   ▼
AlmaLinux 9 虚拟机（1.5GB 内存，2 核）
   └── Node 24 进程（systemd 守护），数据在 /opt/growthPlanet/data/
```

和 VPS 部署的区别：

| 项 | VPS | 家里 Mac 虚拟机 |
|----|-----|----------------|
| 访问方式 | `https://域名` | `http://Mac的IP:8787`，只在家里 WiFi 能用 |
| Caddy / 证书 | 需要 | 不需要 |
| 服务监听 | `127.0.0.1:8787` | `0.0.0.0:8787`（端口转发要求） |
| 前端构建 | 在工作电脑构建后上传 | 直接在虚拟机里构建 |
| 抖音下载 | 海外 IP，容易被风控 | 家里宽带 IP，成功率更高 |
| Service Worker | 生效 | 不生效（需要 HTTPS），不影响使用，只是没有离线缓存 |

## 1. Mac 准备

### 1.1 检查硬盘空间

终端执行 `df -h /`，看 `Avail` 一列。虚拟机磁盘设为按需增长，上限建议：

- 可用空间 ≥ 80GB：虚拟机磁盘上限 60GB
- 可用空间 40~80GB：上限 30GB

### 1.2 不让 Mac 睡眠

**系统偏好设置 → 节能**：

- 「电源适配器」标签页：勾选「**当显示器关闭时，防止电脑自动进入睡眠**」。
- 显示器关闭时间随意，屏幕灭了不影响服务。
- **不要合上盖子**：没接外接显示器时，合盖一定会睡眠，虚拟机会暂停。

Mac 要一直插着电源。

### 1.3 固定 Mac 的局域网 IP

**系统偏好设置 → 网络 → Wi-Fi** 里能看到 Mac 当前的 IP（如 `192.168.1.23`）。

在路由器后台的「DHCP 静态分配 / 地址保留」里，把这个 IP 绑定到 Mac 的 MAC 地址。否则路由器重启后 IP 可能会变，iPad 就找不到服务了。

## 2. 安装 VirtualBox 6.1

> High Sierra 只能用 **6.1** 系列。7.0 能装上，但跑不了虚拟机。

1. 打开 <https://download.virtualbox.org/virtualbox/6.1.50/>，下载文件名以 `OSX.dmg` 结尾的那个（约 120MB）。
2. 双击安装。
3. 安装过程中如果提示「系统扩展已被阻止」：打开 **系统偏好设置 → 安全性与隐私 → 通用**，点击「来自开发者 Oracle America, Inc. 的系统软件已被阻止载入」旁边的「**允许**」。然后**重新运行一次安装程序**。
4. 安装完成后打开终端，确认能找到命令：

```bash
VBoxManage --version      # 应为 6.1.50r...
```

## 3. 创建虚拟机

### 3.1 下载 AlmaLinux 9 安装镜像

从阿里云镜像下载（国内较快）：<https://mirrors.aliyun.com/almalinux/9/isos/x86_64/>，选择 `AlmaLinux-9-latest-x86_64-minimal.iso`（约 2GB）。

### 3.2 新建虚拟机

打开 VirtualBox → **新建**：

| 设置项 | 值 |
|--------|----|
| 名称 | `growth`（后面的命令都用这个名字，别改） |
| 类型 / 版本 | Linux / Red Hat (64-bit) |
| 内存 | **1536 MB** |
| 虚拟硬盘 | 现在创建 → VDI → **动态分配** → 大小按 1.1 节定 |

创建好后选中虚拟机 → **设置**：

- **系统 → 处理器**：2 个 CPU。
- **存储**：点「控制器: IDE」下的光盘图标 → 右侧光盘下拉 → 选择 3.1 下载的 iso。
- **声音**：取消勾选「启用声音」。
- **网络 → 网卡 1**：连接方式保持「网络地址转换 (NAT)」→ 展开「高级」→ **端口转发**，添加两条规则：

| 名称 | 协议 | 主机 IP | 主机端口 | 子系统 IP | 子系统端口 |
|------|------|---------|----------|-----------|------------|
| ssh | TCP | 127.0.0.1 | 2222 | | 22 |
| web | TCP | （留空） | 8787 | | 8787 |

`ssh` 那条只允许 Mac 自己连。`web` 那条主机 IP 留空，表示家里 WiFi 上的设备都能访问 8787。

### 3.3 安装 AlmaLinux

点击「**启动**」，选择 `Install AlmaLinux 9`，进入图形安装界面：

1. 语言：选简体中文即可。
2. **安装目的地**：点进去直接点「完成」，使用自动分区。自动分区会顺带创建 swap。
3. **软件选择**：「最小安装」。
4. **网络和主机名**：把网卡开关**打开**，主机名填 `growth`。
5. **时间和日期**：亚洲 / 上海。
6. **Root 密码**：设置一个密码，并勾选「**允许 root 用户使用密码进行 SSH 登录**」。
7. 点「开始安装」，大约 10~20 分钟。装完点「重启系统」。

重启后看到 `growth login:` 就说明装好了。这个窗口可以关掉：选择「**发送关机信号**」，等虚拟机关机。

### 3.4 后台启动虚拟机

以后都不需要打开 VirtualBox 窗口。在 Mac 终端里执行：

```bash
VBoxManage startvm growth --type headless
```

等半分钟，再从 Mac 终端登录虚拟机：

```bash
ssh -p 2222 root@127.0.0.1
```

## 4. 在虚拟机里部署

以下命令都在 `ssh -p 2222 root@127.0.0.1` 登录后执行。按 [04-deploy.md](./04-deploy.md) 的章节走，有差异的地方如下：

| 04 文档章节 | 在虚拟机里怎么做 |
|-------------|-----------------|
| 3.1 确认环境 | 照做，Docker 相关的忽略 |
| 3.2 基础工具 | 照做 |
| 3.3 增加 swap | 先 `free -h`：Swap 一行已有 1G 以上就**跳过** |
| 3.4 运行用户 | 照做 |
| 3.5 防火墙 | **改为**下面 4.1 节 |
| 3.6 ~ 3.8 Node / ffmpeg / yt-dlp | 照做，下载慢见 4.4 节 |
| 3.9 Caddy | **跳过** |
| 4.1 拉代码 | 照做 |
| 4.2 前端构建 | **改为**下面 4.2 节 |
| 4.3 Chromium | 照做 |
| 4.4 手动跑一次 | 把 `HOST=127.0.0.1` 改成 `HOST=0.0.0.0`，**同样要抄下初始密码** |
| 5 systemd | 照做，service 文件改动见下面 4.3 节 |
| 6 Caddy | **跳过**（没有 Caddy，也不用管 SELinux） |

### 4.1 防火墙放行 8787

虚拟机里没有 Docker，可以正常 reload：

```bash
firewall-cmd --permanent --add-port=8787/tcp
firewall-cmd --reload
```

### 4.2 前端直接在虚拟机里构建

```bash
su - growth -c "cd /opt/growthPlanet && pnpm --dir apps/kid build && pnpm --dir apps/admin build"
```

### 4.3 systemd 文件的不同点

在 04 文档第 5 节的基础上改这几行：

```ini
Environment=HOST=0.0.0.0
MemoryHigh=900M
MemoryMax=1100M
```

`OOMScoreAdjust=500` 那行可以删掉，虚拟机里只跑这一个服务。

### 4.4 国内下载慢的替代地址

- **Node**：把 04 文档 3.6 节里的 `https://nodejs.org/dist/` 换成 `https://npmmirror.com/mirrors/node/`。
- **pnpm 依赖**：先执行 `su - growth -c "pnpm config set registry https://registry.npmmirror.com"`，再 `pnpm install`。
- **Chromium**：可以试试加环境变量走国内镜像。镜像不一定有当前版本，报 404 就去掉这个变量，用默认地址：

```bash
su - growth -c "cd /opt/growthPlanet && PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright pnpm --dir apps/server exec playwright-core install chromium"
```

- **GitHub**（clone 代码、yt-dlp）：慢的话多重试几次。

### 4.5 验证

在 Mac 终端执行：

```bash
curl http://127.0.0.1:8787/api/ping        # {"ok":true,...}
```

在 iPad 的 Safari 打开 `http://<Mac的IP>:8787/`，应能看到孩子端登录页。

如果 Mac 上 curl 正常、iPad 打不开：

- 检查 **系统偏好设置 → 安全性与隐私 → 防火墙**。如果防火墙是开着的，在「防火墙选项」里允许 `VBoxHeadless` 接受传入连接。
- 确认 iPad 和 Mac 连的是同一个 WiFi。有些路由器的「访客网络」是隔离的。

## 5. 上线后必做

1. **修改初始密码**：打开 `http://<Mac的IP>:8787/admin/`，用 `parent` 登录，把三个账号的密码都改掉。
2. **iPad 添加到主屏幕**：Safari 打开 `http://<Mac的IP>:8787/` → 分享 → 添加到主屏幕。
3. **实测抖音下载**：在家长后台粘贴一条抖音分享文案。同时在虚拟机里执行 `free -h`，观察内存占用。
4. **打一个虚拟机快照**（在 Mac 终端执行，虚拟机运行中也可以打）：

```bash
VBoxManage snapshot growth take "ok-$(date +%F)"
```

## 6. 开机自动启动虚拟机

### 6.1 Mac 开机自动登录

**系统偏好设置 → 用户与群组 → 登录选项 → 自动登录**，选择你的账户。

如果这里是灰色的，说明开了 FileVault 磁盘加密。可以在「安全性与隐私 → FileVault」里关掉；不想关的话，Mac 重启后就要手动登录一次。

### 6.2 登录后自动启动虚拟机

在 Mac 上创建 `~/Library/LaunchAgents/com.growthplanet.vm.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.growthplanet.vm</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/VBoxManage</string>
    <string>startvm</string>
    <string>growth</string>
    <string>--type</string>
    <string>headless</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
```

启用：

```bash
launchctl load ~/Library/LaunchAgents/com.growthplanet.vm.plist
```

### 6.3 关机前先关虚拟机

Mac 关机或重启前，先让虚拟机正常关机，避免数据库写到一半被强制断电：

```bash
VBoxManage controlvm growth acpipowerbutton
VBoxManage list runningvms        # 等这里不再显示 growth，再关 Mac
```

## 7. 日常更新

```bash
ssh -p 2222 root@127.0.0.1
su - growth -c "cd /opt/growthPlanet && git pull && pnpm install --frozen-lockfile && pnpm --dir apps/kid build && pnpm --dir apps/admin build"
systemctl restart growth-planet
```

04 文档第 8 节末尾的注意事项同样适用。

## 8. 备份

1. 虚拟机里每天备份数据库：照做 04 文档 9.1 节。
2. 把备份拉到 Mac 上（在 Mac 终端执行）：

```bash
mkdir -p ~/growthPlanet-backup
rsync -avz -e "ssh -p 2222" root@127.0.0.1:/home/growth/backup/ ~/growthPlanet-backup/db/
rsync -avz -e "ssh -p 2222" root@127.0.0.1:/opt/growthPlanet/data/photos/ ~/growthPlanet-backup/photos/
```

3. 大改动之前打一个快照（见 5.4）。出问题时关掉虚拟机，用下面的命令回到快照：

```bash
VBoxManage snapshot growth restore "快照名"
```

`VBoxManage snapshot growth list` 可以查看有哪些快照。

> 注意：快照和虚拟机磁盘都在 Mac 的同一块硬盘上。Mac 硬盘坏了会一起丢，所以第 2 步的数据库备份最好再拷一份到别处（U 盘或网盘）。

## 9. 常见问题

| 现象 | 排查 |
|------|------|
| `VBoxManage startvm` 报 `Kernel driver not installed` | 2.3 节的「允许」没点，或点完没重装 VirtualBox |
| 启动报 VT-x 不可用 | 这台 Mac 默认是开启的；重启 Mac 再试 |
| `ssh -p 2222` 连不上 | `VBoxManage list runningvms` 看虚拟机有没有在跑；刚启动要等半分钟 |
| iPad 打不开、Mac 上 curl 正常 | 见 4.5 节：Mac 防火墙、访客网络隔离、Mac 的 IP 变了 |
| 一段时间后 iPad 打不开 | 多半是 Mac 睡眠了，检查 1.2 节，确认盖子开着、插着电 |
| Mac 很卡 | 4GB 内存里虚拟机占了 1.5GB，不要在这台 Mac 上同时开很多网页或程序 |
| 其他服务端问题 | 和 VPS 一样，见 04 文档第 10 节（Caddy 相关的忽略） |

## 10. 已知限制

- **VirtualBox 6.1 已停止更新**：6.1.50（2024 年 1 月）是最后一个版本，之后不再有安全补丁。虚拟机只在家里局域网可访问，风险可控；但不要把 8787 端口映射到公网。
- **只在家里能用**：出门在外打不开。要在外面用，还是要走 VPS。
- **内存紧张**：High Sierra 本身大约占 1.5~2GB，再加上虚拟机，4GB 基本用满。这台 Mac 最好专门用来跑服务。
- **没有 HTTPS**：Service Worker 不生效，iPad 上没有离线缓存。家里网络稳定的话，用起来没有区别。
