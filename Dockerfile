FROM node:25-alpine

# 安装 ALSA 工具、ffmpeg 和中文语言支持
RUN apk add --no-cache alsa-lib alsa-utils ffmpeg \
    && apk add --no-cache icu-data-full \
    && rm -rf /var/cache/apk/*

# 设置工作目录
WORKDIR /app

# 复制依赖文件
COPY package*.json ./

# 安装依赖
RUN npm install --production

# 复制应用代码
COPY . .

# 暴露端口
EXPOSE 9524

# 启动命令
CMD ["node", "server.js"]
