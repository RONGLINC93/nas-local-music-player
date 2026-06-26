const { execSync } = require('child_process');

console.log('======================================');
console.log('        Git Push 一键推送脚本');
console.log('======================================');
console.log('');

console.log('📁 当前目录:', process.cwd());
console.log('');

// 获取用户输入的提交消息
const args = process.argv.slice(2);
let message;

if (args.length > 0) {
    message = args.join(' ');
} else {
    // 自动生成摘要
    try {
        const statusOutput = execSync('git status --porcelain', { encoding: 'utf-8' });
        const lines = statusOutput.trim().split('\n').filter(l => l);
        
        if (lines.length === 0) {
            console.log('⚠️ 没有需要提交的更改');
            process.exit(0);
        }
        
        // 分析更改类型
        const added = lines.filter(l => l.startsWith('A') || l.startsWith('??')).length;
        const modified = lines.filter(l => l.startsWith('M')).length;
        const deleted = lines.filter(l => l.startsWith('D')).length;
        
        // 分析文件类型
        const files = lines.map(l => l.substring(3).trim());
        const jsFiles = files.filter(f => f.endsWith('.js')).length;
        const cssFiles = files.filter(f => f.endsWith('.css')).length;
        const htmlFiles = files.filter(f => f.endsWith('.html')).length;
        const jsonFiles = files.filter(f => f.endsWith('.json')).length;
        const otherFiles = files.length - jsFiles - cssFiles - htmlFiles - jsonFiles;
        
        // 生成摘要
        const parts = [];
        if (added > 0) parts.push(`新增${added}个文件`);
        if (modified > 0) parts.push(`修改${modified}个文件`);
        if (deleted > 0) parts.push(`删除${deleted}个文件`);
        
        const typeParts = [];
        if (jsFiles > 0) typeParts.push(`JS(${jsFiles})`);
        if (cssFiles > 0) typeParts.push(`CSS(${cssFiles})`);
        if (htmlFiles > 0) typeParts.push(`HTML(${htmlFiles})`);
        if (jsonFiles > 0) typeParts.push(`JSON(${jsonFiles})`);
        if (otherFiles > 0) typeParts.push(`其他(${otherFiles})`);
        
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        
        message = `${parts.join('、')} [${typeParts.join('、')}] - ${timeStr}`;
    } catch (error) {
        const now = new Date();
        const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        message = `更新代码 - ${timeStr}`;
    }
}

console.log('🔍 检查文件状态...');
try {
    const statusOutput = execSync('git status', { encoding: 'utf-8' });
    console.log(statusOutput);
} catch (error) {
    console.log(error.stdout || error.message);
}

console.log('📥 添加所有更改...');
try {
    execSync('git add .', { encoding: 'utf-8' });
} catch (error) {
    console.log(error.stdout || error.message);
}

console.log(`📝 提交更改，消息: ${message}`);
try {
    execSync(`git commit -m "${message}"`, { encoding: 'utf-8' });
} catch (error) {
    const output = error.stdout || error.message;
    if (output.includes('nothing to commit')) {
        console.log('⚠️ 没有需要提交的更改');
    } else {
        console.log(output);
        console.log('❌ 提交失败');
        process.exit(1);
    }
}

console.log('📤 推送到远程仓库...');
try {
    const pushOutput = execSync('git push', { encoding: 'utf-8' });
    console.log(pushOutput);
    console.log('✅ 推送成功！');
} catch (error) {
    console.log(error.stdout || error.message);
    console.log('❌ 推送失败');
    process.exit(1);
}

console.log('');
console.log('======================================');

let countdown = 10;
console.log(`${countdown}秒后自动退出，按任意键立即退出...`);

const timer = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
        clearInterval(timer);
        console.log('');
        process.exit(0);
    }
    process.stdout.write(`\r${countdown}秒后自动退出，按任意键立即退出...`);
}, 1000);

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', () => {
    clearInterval(timer);
    console.log('');
    process.exit(0);
});