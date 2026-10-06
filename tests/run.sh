#!/usr/bin/env bash
# 小锚端到端测试：起酒馆 → 跑脚本 → 关酒馆
#
# 用法：
#   ST_DIR=/path/to/SillyTavern tests/run.sh            跑全部（t1 t3 t4 t5 t6）
#   ST_DIR=... tests/run.sh t3                           只跑一个
#   ST_DIR=... ST_CONFIG=tests/out/config-gzip.yaml tests/run.sh t5
#
# 环境变量（都有默认值）：
#   ST_DIR      酒馆根目录（必须已经 npm install 过）       默认 ~/st
#   ST_PORT     端口                                         默认 8123
#   ST_DATA     酒馆 dataRoot                                默认 $ST_DIR/data
#   ST_USER     用户目录名                                   默认 default-user
#   ST_CONFIG   额外的 config.yaml 路径（可选）
#   ST_COMPRESS=1  用开了 requestCompression（minPayloadSize 2kb）的配置起酒馆，给 t7 用
#   KEEP_ST=1   跑完不关酒馆
# 默认跑 t1 t3 t4 t5 t6。t7（压缩）要单独用 ST_COMPRESS=1 起一个实例；t8（性能）慢，手动跑。
# 如果端口上已经有酒馆在跑，就直接用它，跑完也不关。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
: "${ST_DIR:=$HOME/st}"
: "${ST_PORT:=8123}"
: "${ST_DATA:=$ST_DIR/data}"
: "${ST_USER:=default-user}"
: "${ST_CONFIG:=}"
: "${ST_COMPRESS:=0}"
: "${KEEP_ST:=0}"
export ST_DIR ST_PORT ST_DATA ST_USER
OUT="$HERE/out"
mkdir -p "$OUT"
URL="http://127.0.0.1:$ST_PORT/"

[ -f "$ST_DIR/server.js" ] || { echo "ST_DIR=$ST_DIR 下没有 server.js"; exit 2; }
[ -d "$ST_DIR/node_modules" ] || { echo "$ST_DIR 还没 npm install"; exit 2; }

# 把本仓库挂进全局第三方扩展目录（符号链接，改代码即时生效）
EXT_DIR="$ST_DIR/public/scripts/extensions/third-party"
mkdir -p "$EXT_DIR"
[ -e "$EXT_DIR/st-chat-anchor" ] || ln -s "$REPO" "$EXT_DIR/st-chat-anchor"

if [ "$ST_COMPRESS" = 1 ] && [ -z "$ST_CONFIG" ]; then
    ST_CONFIG="$OUT/config-gzip.yaml"
    python3 - "$ST_DIR/default/config.yaml" "$ST_CONFIG" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'(  requestCompression:\n)(.*?)(?=\n  [a-zA-Z]|\n[a-zA-Z])', src, re.S)
body = m.group(2).replace('    enabled: false', '    enabled: true', 1)
body = re.sub(r"    minPayloadSize: '[^']*'", "    minPayloadSize: '2kb'", body, count=1)
open(sys.argv[2], 'w', encoding='utf-8').write(src[:m.start(2)] + body + src[m.end(2):])
PY
    echo "已生成开启 requestCompression 的配置：$ST_CONFIG"
fi

STARTED=0
if curl -fs "$URL" >/dev/null 2>&1; then
    echo "端口 $ST_PORT 上已经有酒馆在跑，直接用它"
else
    ARGS=(--port "$ST_PORT" --listen false --browserLaunchEnabled false --dataRoot "$ST_DATA")
    [ -n "$ST_CONFIG" ] && ARGS+=(--configPath "$ST_CONFIG")
    echo "启动酒馆：node server.js ${ARGS[*]}"
    # exec 让子 shell 直接变成 node，这样 $! 就是 node 的 PID，也不会有多余的 shell 攥着管道不放
    (cd "$ST_DIR" && exec node server.js "${ARGS[@]}" </dev/null >"$OUT/st.log" 2>&1) &
    echo $! >"$OUT/st.pid"
    STARTED=1
    for i in $(seq 1 150); do
        curl -fs "$URL" >/dev/null 2>&1 && break
        sleep 2
    done
    curl -fs "$URL" >/dev/null 2>&1 || { echo "酒馆没起来，看 $OUT/st.log"; tail -30 "$OUT/st.log"; exit 2; }
    echo "酒馆已就绪"
fi

cleanup() {
    if [ "$STARTED" = 1 ] && [ "$KEEP_ST" != 1 ]; then
        kill "$(cat "$OUT/st.pid")" 2>/dev/null || true
        echo "酒馆已关闭"
    fi
}
trap cleanup EXIT

TESTS=("$@")
[ ${#TESTS[@]} -eq 0 ] && TESTS=(t1 t3 t4 t5 t6)
FAIL=0
for t in "${TESTS[@]}"; do
    f=$(ls "$HERE"/"${t}"_*.py 2>/dev/null | head -1)
    [ -n "$f" ] || { echo "没有 $t 对应的脚本"; FAIL=1; continue; }
    python3 "$f" || FAIL=1
done
exit $FAIL
