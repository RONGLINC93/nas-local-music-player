# 使用 Node.js 22 Debian Slim 作为基础镜像
# 使用阿里云公共镜像源，避免私有镜像代理认证问题
FROM registry.cn-hangzhou.aliyuncs.com/library/node:22-slim

# 安装系统级依赖：
# - alsa-utils: ALSA 工具集，包含 aplay 等音频播放命令
# - ffmpeg: 多媒体框架，用于音频解码和处理
# - libasound2: ALSA 音频库
RUN apt-get update && apt-get install -y --no-install-recommends \
    alsa-utils ffmpeg libasound2 \
    && rm -rf /var/lib/apt/lists/*

# 设置容器内工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json（利用 Docker 缓存层优化构建）
COPY package*.json ./

# 安装 Node.js 依赖（仅生产环境）：
# - express: Web 框架
# - music-metadata: 音频元数据解析
# - fluent-ffmpeg: FFmpeg Node.js 封装
# - ffmetadata: FFmpeg 元数据读写
# - node-id3: MP3 ID3 标签处理
# - mp3-parser: MP3 文件解析
# - multer: 文件上传处理
# - adm-zip: ZIP 解压缩
# - iconv-lite: 字符编码转换
RUN npm install --production

# 复制应用代码到容器
COPY . .

# 暴露服务端口
EXPOSE 9524

# 启动 Node.js 服务
CMD ["node", "server.js"]
