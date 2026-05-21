# Docker 声卡配置说明

## ⚠️ Windows 系统限制

**重要提示：** 在 Windows 系统上，Docker Desktop 运行在 Hyper-V 虚拟机中，**无法直接访问宿主机的声卡设备**。这意味着：

- Docker 容器内的程序无法通过 Windows 声卡播放音频
- 即使配置了声卡设备，也无法正常工作

## 解决方案

### 方案 1：本地运行（推荐 Windows 用户）

不使用 Docker，直接在 Windows 上运行 Node.js 应用：

```bash
# 安装依赖
npm install

# 运行服务
node server.js
```

这样可以正常使用 Windows 的声卡播放音乐。

### 方案 2：Linux 系统配置 - 使用 ALSA（已配置）

如果您使用的是 Linux 系统，可以通过以下配置让 Docker 使用 ALSA 声卡：

#### Docker Compose 配置（已更新）

```yaml
version: '3.8'

services:
  nas-local-music-player:
    image: node:25-alpine
    container_name: nas-local-music-player
    restart: unless-stopped
    ports:
      - "9524:9524"
    volumes:
      - "/path/to/nas-local-music-player:/app"
      - "/dev/snd:/dev/snd"              # 挂载声卡设备
      - "/etc/asound.conf:/etc/asound.conf:ro"  # ALSA 配置文件
      - "/proc/asound:/proc/asound:ro"   # ALSA 信息
    working_dir: "/app"
    command: "node server.js"
    environment:
      - NODE_ENV=production
      - PORT=9524
      - IS_DOCKER=true
      - ALSA_ENABLED=true
    devices:
      - "/dev/snd:/dev/snd"              # 声卡设备
    group_add:
      - audio                            # 添加 audio 组权限
    privileged: true                     # 特权模式（可选）
```

#### 配置说明

**挂载的设备：**
- `/dev/snd` - ALSA 声卡设备目录
- `/etc/asound.conf` - ALSA 配置文件（只读）
- `/proc/asound` - ALSA 设备信息（只读）

**环境变量：**
- `IS_DOCKER=true` - 标记为 Docker 环境
- `ALSA_ENABLED=true` - 启用 ALSA 播放

**权限设置：**
- `devices` - 挂载声卡硬件设备
- `group_add: audio` - 添加 audio 组权限
- `privileged: true` - 特权模式（确保可以访问硬件）

### 方案 3：网络流媒体（跨平台）

修改应用架构，将音频流通过网络传输到客户端浏览器播放：

1. 服务端提供音频文件流
2. 浏览器使用 HTML5 Audio 播放
3. 不依赖服务端声卡

这种方式需要重构应用，但可以在任何平台运行。

## 当前配置说明

您的 `docker-compose.yml` 已配置为使用 ALSA：

```yaml
environment:
  - IS_DOCKER=true      # 标记为 Docker 环境
  - ALSA_ENABLED=true   # 启用 ALSA 播放
devices:
  - "/dev/snd:/dev/snd" # 挂载声卡设备
group_add:
  - audio               # 添加 audio 组权限
privileged: true        # 特权模式
```

服务端会使用 `aplay` 命令通过 ALSA 播放音频。

## 测试声卡

在 Docker 容器中测试 ALSA 声卡：

```bash
# 进入容器
docker exec -it music-player sh

# 列出 ALSA 声卡设备
aplay -l

# 查看当前声卡状态
cat /proc/asound/cards

# 播放测试音（需要 alsa-utils）
speaker-test -t wav -c 2

# 测试特定设备
aplay -D hw:0,0 /usr/share/sounds/alsa/Front_Center.wav
```

## 常见问题

### Q: 为什么 Docker 中无法播放音频？

A: Docker 容器是隔离的环境，默认无法访问宿主机的硬件设备。需要通过 `--device` 参数显式挂载设备。

### Q: Windows 上如何解决？

A: 建议使用本地 Node.js 运行，或考虑使用浏览器播放方案（音频文件通过网络传输到客户端播放）。

### Q: Linux 上配置后仍然无声？

A: 检查以下几点：
1. 确认用户有 audio 组权限：`groups $USER`
2. 检查 PulseAudio/ALSA 配置
3. 确认没有其他程序占用声卡
4. 查看容器日志：`docker logs music-player`

## 推荐

对于 Windows 用户，**强烈建议使用本地 Node.js 运行**，这样可以获得最佳的音频播放体验。
