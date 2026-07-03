const { execSync } = require('child_process');

console.log('======================================');
console.log('        Git Pull 一键拉取脚本');
console.log('======================================');
console.log('');

console.log('📁 当前目录:', process.cwd());
console.log('');

console.log('🔄 拉取远程最新代码...');
try {
    const output = execSync('git pull', { encoding: 'utf-8' });
    console.log(output);
    console.log('✅ 拉取成功！');
} catch (error) {
    console.log(error.stdout || error.message);
    console.log('❌ 拉取失败');
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