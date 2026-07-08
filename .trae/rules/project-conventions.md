# NAS本地音乐播放器 - 项目约定规则

## 核心指令约定

### 推送
- 直接执行 git 命令：`git add .` → `git commit -m "消息"` → `git push`
- **绝对禁止**运行 `node git-push.js` 或 `手动推送.bat`
- **不要自动推送**：修改代码后不要做任何 git 操作（不 add、不 commit、不 push），等用户明确指示再处理
- 当用户说"推送"时，执行完整流程：git add → git commit → git push（自动提交并推送所有更改）

### 拉取
- 执行：`git pull`
- 当用户说"拉取"时，只执行 `git pull`

### 发布
- 执行：`.\release.ps1`
- 支持参数：`-Message "xxx"`、`-AutoIncrement`
- 当用户说"发布"时，执行完整发布流程（release.ps1）

## 硬约束
- release.ps1 必须使用 UTF-8 编码处理中文
- server.js 中 versionInfo 变量必须在条件块外声明
- 不要手动更新 version.json，由 release.ps1 自动更新版本号
- **所有确认提示必须使用自定义模态框**，禁止使用浏览器原生的 `confirm()`、`alert()`、`prompt()`
  - 模态框风格统一：红色警告图标 + 确认/取消按钮
  - 删除操作使用红色危险按钮（btn-danger）
  - 模态框 HTML 结构参考 `deleteCacheModal`、`clearCacheModal` 等已有实现

## 更新日志处理
- **修改代码后，更新 CHANGELOG.md，不发布**
- 当前版本号从 PROJECT_MEMORY.md 读取
- 如果版本号不存在：新建该版本号的条目
- 如果版本号存在：直接在该版本号下更新说明
- 如果日期不一致：增加一个条目，记录日期为当前日期
- 日期按倒序排列，最新的日期在最上面
- 当用户说"更新日志"时，按上述规则处理

## 项目信息
- 当前版本：1.2.5
- 已发布版本：1.2.4
- GitHub仓库：https://github.com/RONGLINC93/nas-local-music-player

## 经验教训
- PowerShell 默认编码(GBK)会导致中文乱码，需要显式指定 -Encoding UTF8
- 变量作用域问题: 条件块内声明的变量在块外不可访问
- 发布前需要确保代码已推送到远程仓库
- 处理时间日期时，注意时区问题
- VM 沙箱中的对象需要通过 JSON 序列化来切断原型链（decontextify）
- songInfo 字段标准化：需要将 meta 字段提升到顶层，并映射各平台特有字段

## 发布流程详解
1. **版本递增**: 解析 version.json、package-lock.json、package.json、PROJECT_MEMORY.md（已发布版本号、当前版本号），将最后一位版本号 +1
2. **代码提交**: 自动 git add → git commit → git push
3. **创建Tag**: git tag -a v{版本号} → git push origin {tag}
4. **读取日志**: 从 CHANGELOG.md 提取 ## [版本号] 对应的内容
5. **创建Release**: 通过 GitHub API 创建 Release，包含中文更新说明
6. **上传安装包**: 打包项目文件为 ZIP，排除 .git、node_modules、.env 等

## 发布命令
```powershell
# 普通发布（使用当前版本号）
.\release.ps1

# 带自定义提交消息
.\release.ps1 -Message "修复了一些bug"

# 自动递增版本号并发布
.\release.ps1 -AutoIncrement

# 自动递增版本号并带自定义消息
.\release.ps1 -AutoIncrement -Message "新增功能"
```

## 关键文件说明
| 文件 | 作用 | 更新时机 |
|------|------|----------|
| version.json | 存储版本号、构建时间、构建号 | 使用 -AutoIncrement 时更新 |
| CHANGELOG.md | 更新日志 | 手动维护 |
| release.ps1 | 自动发布脚本 | 手动维护 |
| PROJECT_MEMORY.md | 项目记忆文件 | 自动/手动更新 |

## 配置要求
.env 文件必须包含:
```env
GITHUB_TOKEN=你的GitHub令牌（需要repo权限）
GITHUB_REPO=用户名/仓库名（如 RONGLINC93/nas-local-music-player）
```
