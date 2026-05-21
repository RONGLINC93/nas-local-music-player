# ffmpeg 自动安装脚本
# 适用于 Windows 系统
# 自动下载、解压并配置环境变量

$ErrorActionPreference = "Stop"

function Test-CommandExists {
    param([string]$command)
    $exists = $null -ne (Get-Command $command -ErrorAction SilentlyContinue)
    return $exists
}

# 检查是否已安装
if (Test-CommandExists "ffplay") {
    Write-Host "ffplay 已安装，版本信息：" -ForegroundColor Green
    ffplay -version
    Write-Host ""
    Write-Host "安装完成！" -ForegroundColor Green
    pause
    exit 0
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "    ffmpeg 自动安装程序" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# 下载配置
$downloadUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
$installDir = "$env:ProgramFiles\ffmpeg"
$zipPath = "$env:TEMP\ffmpeg.zip"

Write-Host "下载 ffmpeg..." -ForegroundColor Yellow
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing
    Write-Host "下载完成" -ForegroundColor Green
} catch {
    Write-Host "下载失败: $_" -ForegroundColor Red
    pause
    exit 1
}

Write-Host "解压文件到 $installDir..." -ForegroundColor Yellow
try {
    if (Test-Path $installDir) {
        Remove-Item -Recurse -Force $installDir
    }
    Expand-Archive -Path $zipPath -DestinationPath $installDir -Force
    
    # 找到实际的bin目录
    $binDir = Get-ChildItem -Path $installDir -Recurse -Filter "bin" | Select-Object -First 1
    if ($binDir) {
        $installDir = $binDir.FullName
    } else {
        $installDir = "$installDir\bin"
    }
    
    Write-Host "解压完成，安装目录: $installDir" -ForegroundColor Green
} catch {
    Write-Host "解压失败: $_" -ForegroundColor Red
    pause
    exit 1
}

Write-Host "配置系统环境变量 PATH..." -ForegroundColor Yellow
try {
    $currentPath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
    
    if ($currentPath -notlike "*$installDir*") {
        $newPath = $currentPath + ";$installDir"
        [Environment]::SetEnvironmentVariable("PATH", $newPath, "Machine")
        Write-Host "环境变量已更新" -ForegroundColor Green
    } else {
        Write-Host "环境变量已存在" -ForegroundColor Green
    }
} catch {
    Write-Host "配置环境变量失败: $_" -ForegroundColor Red
    pause
    exit 1
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "    安装完成！" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "注意事项：" -ForegroundColor Yellow
Write-Host "  1. 请重启命令行窗口或重启电脑以使环境变量生效"
Write-Host "  2. 重启音乐播放器服务后即可使用声卡切换功能"
Write-Host ""
Write-Host "测试 ffplay 是否可用（需要重启终端后生效）" -ForegroundColor Yellow

pause