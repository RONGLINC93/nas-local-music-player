#!/usr/bin/env bash
# ============================================================================
# 飞牛 fpk 打包脚本（Linux / macOS / WSL / 飞牛 NAS 本机）
#   用法：./build-fpk.sh
#   前置：fnpack 已放入 PATH，或放在本目录下名为 fnpack
#   产物：项目根目录 fpk/<appname>-<version>.fpk
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="$(cd "${HERE}/.." && pwd)"
PKG="${HERE}/nasmp"
SERVER="${PKG}/app/server"

echo "=== 飞牛 fpk 打包：NAS本地音乐播放器 ==="

echo "[1/6] 复制程序文件到打包目录 ..."
rm -rf "${SERVER}"
mkdir -p "${SERVER}"
cp "${PROJ}/server.js" "${PROJ}/package.json" "${SERVER}/"
[ -f "${PROJ}/version.json" ] && cp "${PROJ}/version.json" "${SERVER}/"
cp -r "${PROJ}/public" "${SERVER}/public"
[ -d "${PROJ}/online_sources" ] && cp -r "${PROJ}/online_sources" "${SERVER}/online_sources"

echo "[2/6] 复制运行时依赖（node_modules） ..."
# 全自动处理：优先复制项目根目录的 node_modules；缺失则直接在打包目录安装生产依赖。
if [ -d "${PROJ}/node_modules/express" ]; then
  cp -r "${PROJ}/node_modules" "${SERVER}/node_modules"
elif command -v npm >/dev/null 2>&1; then
  echo "    未找到 node_modules，使用 npm 安装生产依赖 ..."
  ( cd "${SERVER}" && npm install --omit=dev --no-audit --no-fund --loglevel=error )
fi
if [ ! -d "${SERVER}/node_modules/express" ]; then
  echo "依赖准备失败：请先在 ${PROJ} 执行 npm install，或确保能在 ${SERVER} 中联网执行 npm install" >&2
  exit 1
fi

echo "[3/6] 生成应用图标 ..."
if command -v pwsh >/dev/null 2>&1; then
  pwsh -NoProfile -File "${HERE}/make-icons.ps1" || true
else
  echo "    跳过：未找到 pwsh（图标已随仓库保留）"
fi

echo "[4/6] 同步 manifest 版本号（唯一来源 package.json） ..."
PKG_VERSION="$(awk -F'"' '/"version"/ { print $4; exit }' "${PROJ}/package.json")"
if [ -n "${PKG_VERSION}" ]; then
  sed -i "s/^[[:space:]]*version[[:space:]]*=.*$/version               = ${PKG_VERSION}/" "${PKG}/manifest"
  echo "    manifest version = ${PKG_VERSION}"
else
  echo "    package.json 中未找到 version，保持 manifest 原值"
fi

echo "[5/6] 统一换行符为 LF，并赋予脚本可执行权限 ..."
while IFS= read -r -d '' f; do
  case "${f}" in
    *.png|*.jpg|*.jpeg|*.ico|*.gif) continue ;;
  esac
  sed -i 's/\r$//' "${f}"
done < <(find "${PKG}" -type f ! -path "*/app/server/*" -print0)
chmod 0755 "${PKG}"/cmd/* 2>/dev/null || true

echo "[6/6] 查找 fnpack、打包并重命名产物 ..."
FNPACK="${FNPACK:-}"
if [ -z "${FNPACK}" ] && [ -x "${HERE}/fnpack" ]; then
  FNPACK="${HERE}/fnpack"
fi
if [ -z "${FNPACK}" ] && [ -x "${PROJ}/fnpack" ]; then
  FNPACK="${PROJ}/fnpack"
fi
if [ -z "${FNPACK}" ]; then
  FNPACK="$(command -v fnpack || true)"
fi
if [ -z "${FNPACK}" ]; then
  echo "未找到 fnpack。请从 https://developer.fnnas.com/docs/cli/fnpack/ 下载对应平台的版本，"
  echo "放入 PATH，或命名为 fnpack 放在 ${HERE} 下。"
  exit 1
fi
echo "    使用 ${FNPACK}"
( cd "${PKG}" && "${FNPACK}" build )

# 读取 manifest 中的字段（去掉首尾空白）
read_field() {
  awk -F= -v k="$1" '
    $1 ~ "^[[:space:]]*" k "[[:space:]]*$" {
      v = $2
      sub(/^[[:space:]]+/, "", v)
      sub(/[[:space:]]+$/, "", v)
      print v
      exit
    }
  ' "${PKG}/manifest"
}

APPNAME="$(read_field appname)"
VERSION="$(read_field version)"
APPNAME="${APPNAME:-nasmp}"

RAW="${PKG}/${APPNAME}.fpk"
OUT="${RAW}"
if [ -f "${RAW}" ] && [ -n "${VERSION}" ]; then
  VPKG="${PKG}/${APPNAME}-${VERSION}.fpk"
  if [ "${VPKG}" != "${RAW}" ]; then
    mv -f "${RAW}" "${VPKG}"
  fi
  OUT="${VPKG}"
fi

# 统一输出到项目根目录 fpk/（不存在则新建）
OUTDIR="${PROJ}/fpk"
mkdir -p "${OUTDIR}"
mv -f "${OUT}" "${OUTDIR}/$(basename "${OUT}")"
OUT="${OUTDIR}/$(basename "${OUT}")"

echo
echo "打包完成：${OUT}"
echo "  应用：${APPNAME}   版本：${VERSION:-未知}"
echo "安装：把 fpk 上传到飞牛应用中心，或 SSH 登录后执行："
echo "  appcenter-cli install-fpk $(basename "${OUT}")"
