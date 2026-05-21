const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

function createZipPackage(outputPath) {
  const rootDir = __dirname;
  const zip = new AdmZip();
  
  console.log('开始打包文件...');
  console.log('输出文件:', outputPath);
  
  function walkDirectory(dir) {
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      
      if ((dir === rootDir && stat.isFile() && file.endsWith('.zip'))) {
        console.log('跳过:', file);
        continue;
      }
      
      if (stat.isDirectory() && file === 'music') {
        console.log('跳过目录:', file);
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
      const content = fs.readFileSync(versionFile, 'utf8');
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

const timestamp = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace(/[-:T.]/g, '').slice(0, 12);
const outputZip = path.join(__dirname, `NAS本地音乐播放器${timestamp}.zip`);

createZipPackage(outputZip);