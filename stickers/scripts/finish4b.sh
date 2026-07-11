#!/bin/bash
set +e
VK=$(cat /tmp/.vkey); MODEL=veo3.1-full-image-to-video
echo "=== waiting for renders ==="
for round in $(seq 1 60); do
  all=1
  python3 -c "import json;d=json.load(open('/tmp/qids4.json'));print('\n'.join(f'{k} {v}' for k,v in d.items() if v))" > /tmp/_q4.txt
  while read name qid; do
    [ -f "/tmp/veo_$name.mp4" ] && [ $(wc -c < /tmp/veo_$name.mp4) -gt 50000 ] && continue
    ct=$(curl -s -X POST "https://api.venice.ai/api/v1/video/retrieve" -H "Authorization: Bearer $VK" -H "Content-Type: application/json" -d "{\"queue_id\":\"$qid\",\"model\":\"$MODEL\"}" -o /tmp/_r_$name.bin -w "%{content_type}")
    if echo "$ct" | grep -qiv json; then cp /tmp/_r_$name.bin /tmp/veo_$name.mp4; echo "GOT $name $(wc -c < /tmp/veo_$name.mp4)"; else all=0; fi
  done < /tmp/_q4.txt
  [ "$all" = "1" ] && { echo "ALL RENDERED"; break; }
  sleep 20
done
echo "=== publishing to pack ==="
TOKEN=$(cat /tmp/.btoken); OWNER=$(cat /tmp/.bowner); SET=stagwifhood_by_STAGZBOT
ITEMS=("laptop|GRINDING|💻" "bow|LOCKED IN|🏹" "money|WE EATIN'|💸" "pray|WAGMI|🙏")
added=0
for it in "${ITEMS[@]}"; do
  IFS='|' read name label emoji <<< "$it"
  src=/tmp/veo_$name.mp4
  [ -f "$src" ] && [ $(wc -c < "$src") -gt 50000 ] || { echo "SKIP $name (no render)"; continue; }
  python3 /tmp/mklabel.py "$label" /tmp/lbl_$name.png
  for br in 300k 220k 160k; do
    ffmpeg -y -v error -t 2.9 -i "$src" -i /tmp/lbl_$name.png -filter_complex \
      "[0:v]crop='min(iw,ih)':'min(iw,ih)':'(iw-min(iw,ih))/2':'(ih-min(iw,ih))/2',scale=512:512,fps=30[v];[v][1:v]overlay=0:0" \
      -an -c:v libvpx-vp9 -pix_fmt yuv420p -b:v $br /tmp/pub_$name.webm
    [ $(wc -c < /tmp/pub_$name.webm) -le 256000 ] && break
  done
  fid=$(curl -s "https://api.telegram.org/bot$TOKEN/uploadStickerFile" -F user_id=$OWNER -F sticker_format=video -F "sticker=@/tmp/pub_$name.webm" | python3 -c "import sys,json;print(json.load(sys.stdin).get('result',{}).get('file_id',''))")
  [ -z "$fid" ] && { echo "UPLOAD-FAIL $name"; continue; }
  res=$(curl -s "https://api.telegram.org/bot$TOKEN/addStickerToSet" -F user_id=$OWNER -F name=$SET -F "sticker={\"sticker\":\"$fid\",\"format\":\"video\",\"emoji_list\":[\"$emoji\"]}")
  ok=$(echo "$res" | python3 -c "import sys,json;print(json.load(sys.stdin).get('ok'))")
  echo "ADD $name $emoji ok=$ok $(echo "$res" | python3 -c "import sys,json;d=json.load(sys.stdin);print('' if d.get('ok') else d.get('description',''))")"
  [ "$ok" = "True" ] && added=$((added+1))
done
echo "FINISHED: added $added/4 -> pack now $(curl -s "https://api.telegram.org/bot$TOKEN/getStickerSet?name=$SET" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('result',{}).get('stickers',[])))")"
