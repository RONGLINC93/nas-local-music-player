# NAS本地音乐播放器

一个轻量级的本地音乐播放器，支持通过网页界面控制 NAS 服务器播放音乐。通过插入 AUX 音频线或 USB 声卡设备，即可实现音乐播放。

---

## 功能特性

### 播放控制
- 播放 / 暂停 / 停止
- 上一首 / 下一首
- 4种播放模式：顺序播放、随机播放、单曲播放、单曲循环

### 音乐管理
- 支持格式：MP3、FLAC、WAV、M4A、OGG、WMA
- 自动扫描 `music/` 目录
- 批量上传音乐文件（最多50个文件，单个最大500MB）
- 删除音乐文件

### 声卡管理
- 自动检测系统声卡设备
- 支持选择不同的音频输出设备
- 跨平台支持（Windows / macOS / Linux / Docker）

### 系统功能
- 支持 ZIP 包热更新
- 配置文件持久化
- 多客户端状态同步

---

## 技术架构

| 组件 | 技术 |
|------|------|
| 后端 | Express.js (Node.js) |
| 前端 | 原生 HTML / CSS / JavaScript |
| 音频播放 | ffplay / afplay / aplay |
| 元数据解析 | music-metadata |
| 容器化 | Docker (Alpine) |

---

## 快速开始

### 本地运行

```bash
# 安装依赖
npm install

# 启动服务
node server.js
```

访问地址：`http://localhost:9524`

### Docker 部署

```bash
docker-compose up -d
```

### Windows 一键启动

双击运行 `start.bat`

---

## 目录结构

```
NAS本地音乐播放器/
├── server.js              # 后端服务核心逻辑
├── config.json            # 用户配置文件
├── music/                 # 音乐文件存放目录
├── public/                # 前端资源
│   ├── index.html         # 主页面
│   ├── app.js             # 前端逻辑
│   └── style.css          # 样式文件
├── Dockerfile             # Docker 镜像配置
├── docker-compose.yml     # 容器编排配置
├── package.json           # 项目依赖
├── start.bat              # Windows 启动脚本
├── 打包.bat               # Docker 镜像打包脚本
├── install-ffmpeg.ps1      # ffmpeg 安装脚本
└── DOCKER_AUDIO.md        # Docker 音频配置说明
```

---

## API 接口

| 接口 | 方法 | 功能 |
|------|------|------|
| `/api/playlist` | GET | 获取播放列表 |
| `/api/upload-music` | POST | 上传音乐文件 |
| `/api/refresh` | GET | 刷新音乐库 |
| `/api/play/:index` | GET | 播放指定歌曲 |
| `/api/pause` | GET | 暂停播放 |
| `/api/resume` | GET | 继续播放 |
| `/api/stop` | GET | 停止播放 |
| `/api/next` | GET | 播放下一首 |
| `/api/previous` | GET | 播放上一首 |
| `/api/status` | GET | 获取播放状态 |
| `/api/play-mode` | GET/POST | 获取/设置播放模式 |
| `/api/volume` | GET/POST | 获取/设置音量 |
| `/api/audio-devices` | GET | 获取声卡列表 |
| `/api/audio-device` | POST | 选择声卡设备 |
| `/api/download/:index` | GET | 下载音乐文件 |
| `/api/delete/:index` | DELETE | 删除音乐文件 |
| `/api/system-update` | POST | 系统更新 |

---

## 播放模式

| 模式 | 说明 |
|------|------|
| `sequence` | 顺序播放，播完自动下一首 |
| `random` | 随机播放 |
| `single` | 单曲播放，播完停止 |
| `loop` | 单曲循环 |

---

## 多平台音频播放

| 平台 | 播放器 | 说明 |
|------|--------|------|
| Windows | ffplay | 需安装 ffmpeg |
| macOS | afplay | 系统自带 |
| Linux | aplay | ALSA 工具 |
| Docker | ffmpeg → aplay | 管道转发音频 |

---

## 配置说明

配置文件 `config.json` 位于项目根目录：

```json
{
    "playMode": "random"
}
```

启动后会自动加载上次保存的播放模式。

---

## Docker 部署说明

### 前提条件

1. 宿主机已安装 Docker 和 Docker Compose
2. NAS 支持 Docker 运行

### 部署步骤

1. 修改 `docker-compose.yml` 中的卷挂载路径，指向 NAS 上的音乐文件夹
2. 运行打包脚本或手动构建镜像
3. 启动容器

### 音频配置

Docker 环境下音频通过以下方式工作：

1. ffmpeg 解码音频文件
2. 通过管道将 PCM 数据传递给 aplay
3. aplay 输出到 ALSA 声卡设备

详细说明请参阅 `DOCKER_AUDIO.md`。

---

## 更新日志

详见 `CHANGELOG.md`

---

## 许可证

MIT License

---

© 2026 RONGLINC93. All Rights Reserved.
