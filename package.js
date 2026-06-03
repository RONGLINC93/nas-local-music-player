const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// 从 .gitignore 文件加载忽略规则
function loadGitIgnoreRules(gitIgnorePath) {
  const rules = [];
  if (fs.existsSync(gitIgnorePath)) {
    const content = fs.readFileSync(gitIgnorePath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // 跳过空行和注释
      if (trimmed === '' || trimmed.startsWith('#')) {
        continue;
      }
      rules.push(trimmed);
    }
  }
  return rules;
}

// 检查文件是否应该被忽略
function shouldIgnore(file, rules) {
    for (const rule of rules) {
    let pattern = rule;
    let isDirectory = false;
    
    // 处理目录规则（末尾带 /）
    if (pattern.endsWith('/')) {
      isDirectory = true;
      pattern = pattern.slice(0, -1);
    }
    
    // 处理通配符规则（如 *.log）
    if (pattern.startsWith('*.')) {
      const extension = pattern.slice(1); // 去掉 *，得到 .log
      if (file.endsWith(extension)) {
        return true;
      }
    } else if (isDirectory) {
      // 目录规则：检查文件名是否匹配
      if (file === pattern) {
        return true;
      }
    } else {
      // 文件规则：检查文件名是否匹配
      if (file === pattern) {
        return true;
      }
    }
  }
  
  return false;
}

function createZipPackage(outputPath) {
  const rootDir = __dirname;
  const zip = new AdmZip();
  const gitIgnoreRules = loadGitIgnoreRules(path.join(rootDir, '.gitignore'));
  
  console.log('开始打包文件...');
  console.log('输出文件:', outputPath);
  console.log('加载的忽略规则:', gitIgnoreRules);
  
  function walkDirectory(dir) {
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      
      // 使用 .gitignore 规则检查是否跳过
      if (shouldIgnore(file, gitIgnoreRules)) {
        console.log('跳过:', file);
        continue;
      }
      
      if (stat.isDirectory()) {
        walkDirectory(filePath);
      } else {
        const relativePath = path.relative(rootDir, filePath);
        const entryPath = relativePath.replace(/\\/g, '/');
        const fileContent = fs.readFileSync(filePath);
        
        zip.addFile(entryPath, Buffer.from(fileContent), '', 0x0008);
        console.log('添加文件:', entryPath);
      }
    }
  }
  
  walkDirectory(rootDir);
  
  // 添加版本信息（从 version.json 读取）
  const versionFile = path.join(rootDir, 'version.json');
  let versionInfo = {
    version: 'unknown',
    buildTime: new Date().toISOString(),
    buildNumber: Date.now().toString(36),
    project: 'NAS本地音乐播放器'
  };
  
  if (fs.existsSync(versionFile)) {
    try {
      let content = fs.readFileSync(versionFile, 'utf8');
      content = content.replace(/^\uFEFF/, ''); // 移除 UTF-8 BOM
      const parsed = JSON.parse(content);
      versionInfo = {
        version: parsed.version || 'unknown',
        buildTime: parsed.buildTime || new Date().toISOString(),
        buildNumber: parsed.buildNumber || Date.now().toString(36),
        project: parsed.project || 'NAS本地音乐播放器'
      };
    } catch (e) {
      console.log('读取 version.json 失败，使用默认值');
    }
  } else {
    console.log('未找到 version.json，使用默认值');
  }
  
  zip.addFile('version.json', Buffer.from(JSON.stringify(versionInfo, null, 2)), '', 0x0008);
  
  zip.writeZip(outputPath);
  
  console.log('\n打包完成!');
  console.log('文件大小:', (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2), 'MB');
}

// 获取命令行参数指定的输出文件名
const args = process.argv.slice(2);
let outputZip;

if (args.length > 0) {
  outputZip = path.resolve(args[0]);
} else {
  const timestamp = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/[-:T.]/g, '').slice(0, 12);
  outputZip = path.join(__dirname, `NAS本地音乐播放器${timestamp}.zip`);
}

createZipPackage(outputZip);