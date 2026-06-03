const { execSync } = require('child_process');

console.log('======================================');
console.log('        Git Push 一键推送脚本');
console.log('======================================');
console.log('');

console.log('📁 当前目录:', process.cwd());
console.log('');

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

const now = new Date();
const message = `Update: ${now.getFullYear()}-${String(now.getMonth()+1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

console.log(`📝 提交更改，消息: ${message}`);
try {
    execSync(`git commit -m "${message}"`, { encoding: 'utf-8' });
} catch (error) {
    console.log(error.stdout || error.message);
    console.log('❌ 提交失败');
    process.exit(1);
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

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', () => {
    process.exit(0);
});