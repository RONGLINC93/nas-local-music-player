# 使用 Node.js 最新版本 作为基础镜像
FROM node:latest

# 安装系统级依赖：
# - alsa-utils: ALSA 工具集，包含 aplay 等音频播放命令
# - ffmpeg: 多媒体框架，用于音频解码和处理
# - libasound2: ALSA 音频库
RUN apt-get update && apt-get install -y --no-install-recommends \
    alsa-utils ffmpeg libasound2 \
    && rm -rf /var/lib/apt/lists/*

# 设置容器内工作目录
WORKDIR /app

# 直接复制项目文件（包含已安装的 node_modules）
COPY . .

# 暴露服务端口
EXPOSE 9524

# 启动 Node.js 服务
CMD ["node", "server.js"]
