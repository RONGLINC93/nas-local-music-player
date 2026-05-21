# Project Memory - NAS本地音乐播放器

## 项目信息
- **项目名称**: NAS本地音乐播放器
- **GitHub仓库**: https://github.com/RONGLINC93/nas-local-music-player
- **当前版本**: 1.0.1

## 硬约束 (Hard Constraints)
- release.ps1 必须使用 UTF-8 编码处理中文
- server.js 中 versionInfo 变量必须在条件块外声明

## 工程约定 (Engineering Conventions)
- GitHub发布需要 .env 文件（包含 GITHUB_TOKEN 和 GITHUB_REPO）
- 发布脚本: .\release.ps1 [-Message "xxx"] [-AutoIncrement]

## 经验教训 (Lessons Learned)
- PowerShell 默认编码(GBK)会导致中文乱码，需要显式指定 -Encoding UTF8
- 变量作用域问题: 条件块内声明的变量在块外不可访问

## 用户偏好 (User Preferences)
- 当用户说"发布"时，自动执行以下操作:
  1. 更新 CHANGELOG.md 添加新版本条目
  2. 递增小版本号 (如 1.0.1 → 1.0.2)
  3. 提交并推送到 GitHub
  4. 创建 Git tag (如 v1.0.2)
  5. 创建 GitHub Release 并上传 ZIP 包

## 已修复的问题
1. ✅ release.ps1 中文乱码问题 (添加 UTF-8 编码支持)
2. ✅ server.js versionInfo is not defined (变量作用域问题)
3. ✅ GitHub 发布流程配置

## 发布命令
```powershell
# 普通发布
.\release.ps1

# 带自定义消息
.\release.ps1 -Message "修复了一些bug"

# 自动递增版本号并发布
.\release.ps1 -AutoIncrement

# 自动递增版本号并带自定义消息
.\release.ps1 -AutoIncrement -Message "新增功能"
```
