Write-Host "======================================" -ForegroundColor Cyan
Write-Host "        Git Push 一键推送脚本" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan

Write-Host ""
Write-Host "📁 当前目录: $(Get-Location)" -ForegroundColor Gray

Write-Host ""
Write-Host "🔍 检查文件状态..." -ForegroundColor Yellow
git status

Write-Host ""
Write-Host "📥 添加所有更改..." -ForegroundColor Yellow
git add .

$message = "Update: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host ""
Write-Host "📝 提交更改，消息: $message" -ForegroundColor Yellow
git commit -m $message

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "❌ 提交失败" -ForegroundColor Red
    pause
    exit 1
}

Write-Host ""
Write-Host "📤 推送到远程仓库..." -ForegroundColor Yellow
git push

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "✅ 推送成功！" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "❌ 推送失败" -ForegroundColor Red
}

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
pause