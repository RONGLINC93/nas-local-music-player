# NAS本地音乐播放器 - 项目约定规则

## 核心指令约定

### 推送
- 直接执行 git 命令：`git add .` → `git commit -m "消息"` → `git push`
- **绝对禁止**运行 `node git-push.js` 或 `手动推送.bat`

### 拉取
- 执行：`git pull`

### 发布
- 执行：`.\release.ps1`
- 支持参数：`-Message "xxx"`、`-AutoIncrement`

## 硬约束
- release.ps1 必须使用 UTF-8 编码处理中文
- server.js 中 versionInfo 变量必须在条件块外声明
- 不要手动更新 version.json，由 release.ps1 自动更新版本号
- **所有确认提示必须使用自定义模态框**，禁止使用浏览器原生的 `confirm()`、`alert()`、`prompt()`
  - 模态框风格统一：红色警告图标 + 确认/取消按钮
  - 删除操作使用红色危险按钮（btn-danger）
  - 参考实现：`deleteCacheModal`、`clearCacheModal`、`deleteSourceFileModal`

## 更新日志处理
- 当前版本号从 PROJECT_MEMORY.md 读取
- 如果版本号不存在：新建该版本号的条目
- 如果版本号存在：直接在该版本号下更新说明
- 如果日期不一致：增加一个条目，记录日期为当前日期

## 项目信息
- 当前版本：1.2.5
- 已发布版本：1.2.4
- GitHub仓库：https://github.com/RONGLINC93/nas-local-music-player
