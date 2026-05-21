$gitPath = "C:\Program Files\Git\bin"
if (-not $env:PATH.Contains($gitPath)) {
    $env:PATH = "$gitPath;$env:PATH"
}

cd "d:\Desktop\nas-local-music-player"
git add -A
git commit -m "更新代码"
git push
