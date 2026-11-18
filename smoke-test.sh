#!/bin/zsh
# 坐忘 MVP 冒烟测试：只针对本机 127.0.0.1:3000，不碰其它目录/服务
set -e

BASE="http://127.0.0.1:3000"
NOW=$(date +%s)000
D7=$((7 * 24 * 60 * 60 * 1000))
D8=$((8 * 24 * 60 * 60 * 1000))
D2=$((2 * 24 * 60 * 60 * 1000))

echo "==> 1. 健康检查"
curl -s "$BASE/api/health"; echo

echo "==> 2. 清空旧数据（仅 trunc 项目内 data/visits.jsonl）"
: > "/Users/Richard/Documents/workbuddy/zuowang-mvp/data/visits.jsonl"

echo "==> 3. 注入测试样本"
# 用户A：8 天前首访，2 天前回访 —— 满7天且已复访
curl -s -X POST "$BASE/api/pv" -H 'Content-Type: application/json' \
  -d "{\"id\":\"aaaaaaaa-0000-4000-8000-000000000001\",\"ts\":$((NOW-D8)),\"event\":\"page_view\",\"src\":\"qr\"}" > /dev/null
curl -s -X POST "$BASE/api/pv" -H 'Content-Type: application/json' \
  -d "{\"id\":\"aaaaaaaa-0000-4000-8000-000000000001\",\"ts\":$((NOW-D2)),\"event\":\"page_view\",\"src\":\"qr\"}" > /dev/null
# 用户B：8 天前首访，之后没来 —— 满7天但未复访
curl -s -X POST "$BASE/api/pv" -H 'Content-Type: application/json' \
  -d "{\"id\":\"bbbbbbbb-0000-4000-8000-000000000002\",\"ts\":$((NOW-D8)),\"event\":\"page_view\",\"src\":\"direct\"}" > /dev/null
# 用户C：今天首访 —— 未满7天，不计入判定
curl -s -X POST "$BASE/api/pv" -H 'Content-Type: application/json' \
  -d "{\"id\":\"cccccccc-0000-4000-8000-000000000003\",\"ts\":$NOW,\"event\":\"page_view\",\"src\":\"short\"}" > /dev/null
# 补充漏斗与停留事件
curl -s -X POST "$BASE/api/pv" -H 'Content-Type: application/json' \
  -d "{\"id\":\"aaaaaaaa-0000-4000-8000-000000000001\",\"ts\":$((NOW-D2+1200)),\"event\":\"fog_revealed\",\"src\":\"qr\"}" > /dev/null
curl -s -X POST "$BASE/api/pv" -H 'Content-Type: application/json' \
  -d "{\"id\":\"aaaaaaaa-0000-4000-8000-000000000001\",\"ts\":$((NOW-D2+9000)),\"event\":\"dissipate_done\",\"src\":\"qr\"}" > /dev/null
curl -s -X POST "$BASE/api/pv" -H 'Content-Type: application/json' \
  -d "{\"id\":\"aaaaaaaa-0000-4000-8000-000000000001\",\"ts\":$((NOW-D2+45000)),\"event\":\"exit\",\"src\":\"qr\",\"duration\":45000}" > /dev/null

echo "==> 4. 拉取统计"
curl -s "$BASE/api/stats" | python3 -m json.tool
echo
echo "==> 预期：pv=4, uv=3, day7.mature=2, day7.returned=1, day7.rate=50"
