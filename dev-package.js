const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// 从 .gitignore-dev 文件加载忽略规则
function loadIgnoreRules(gitIgnorePath) {
  const rules = [];
  if (fs.existsSync(gitIgnorePath)) {
    const content = fs.readFileSync(gitIgnorePath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        continue;
      }
      rules.push(trimmed);
    }
  }
  return rules;
}

// 检查文件是否应该被忽略
function shouldIgnore(fileName, isDirectory, rules) {
  for (const rule of rules) {
    let pattern = rule;
    let isDirRule = false;

    if (pattern.endsWith('/')) {
      isDirRule = true;
      pattern = pattern.slice(0, -1);
    }

    if (pattern.startsWith('*.')) {
      const extension = pattern.slice(1);
      if (fileName.endsWith(extension)) {
        return true;
      }
    } else if (isDirRule && isDirectory) {
      if (fileName === pattern) {
        return true;
      }
    } else if (!isDirRule && !isDirectory) {
      if (fileName === pattern) {
        return true;
      }
    }
  }
  return false;
}

function createZipPackage(outputPath) {
  const rootDir = __dirname;
  const zip = new AdmZip();
  const ignoreRules = loadIgnoreRules(path.join(rootDir, '.gitignore-dev'));

  console.log('开始开发打包...');
  console.log('输出文件:', outputPath);
  console.log('忽略规则文件: .gitignore-dev');
  console.log('加载的忽略规则:', ignoreRules);
  console.log('');

  function walkDirectory(dir) {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      const isDir = stat.isDirectory();

      if (shouldIgnore(file, isDir, ignoreRules)) {
        console.log('跳过:', file + (isDir ? '/' : ''));
        continue;
      }

      if (isDir) {
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

  zip.writeZip(outputPath);

  const fileSizeMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);
  console.log('\n打包完成!');
  console.log('文件大小:', fileSizeMB, 'MB');
}

const args = process.argv.slice(2);
let outputZip;

if (args.length > 0) {
  outputZip = path.resolve(args[0]);
} else {
  const timestamp = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/[-:T.]/g, '').slice(0, 12);
  outputZip = path.join(__dirname, `NAS本地音乐播放器_开发版${timestamp}.zip`);
}

createZipPackage(outputZip);
