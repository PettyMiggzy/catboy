#!/bin/bash
TOKEN=$(cat /tmp/.btoken); OWNER=$(cat /tmp/.bowner); SET=stagwifhood_by_STAGZBOT
# name | label | emoji | source mp4
ITEMS=(
"cook|COOKIN'|🍳|/tmp/veo_cook3.mp4"
"laptop|GRINDING|💻|/tmp/veo_laptop.mp4"
"bow|LOCKED IN|🏹|/tmp/veo_bow.mp4"
"coin|BULLISH|🪙|/tmp/veo_coin.mp4"
"gym|DO YOU EVEN HODL|💪|/tmp/veo_gym.mp4"
"coffee|GM|☕|/tmp/veo_coffee.mp4"
"moon|TO THE MOON|🚀|/tmp/veo_moon.mp4"
"money|WE EATIN'|💸|/tmp/veo_money.mp4"
"diamond|HODL|💎|/tmp/veo_diamond.mp4"
"pray|WAGMI|🙏|/tmp/veo_pray.mp4"
)
added=0
for it in "${ITEMS[@]}"; do
  IFS='|' read name label emoji src <<< "$it"
  # wait up to ~12 min for this render
  for w in $(seq 1 48); do [ -f "$src" ] && break; sleep 15; done
  [ -f "$src" ] || { echo "MISS $name (no render)"; continue; }
  python3 /tmp/mklabel.py "$label" /tmp/lbl_$name.png
  ffmpeg -y -v error -t 2.9 -i "$src" -i /tmp/lbl_$name.png -filter_complex \
    "[0:v]crop='min(iw,ih)':'min(iw,ih)':'(iw-min(iw,ih))/2':'(ih-min(iw,ih))/2',scale=512:512,fps=30[v];[v][1:v]overlay=0:0" \
    -an -c:v libvpx-vp9 -pix_fmt yuv420p -b:v 300k /tmp/pub_$name.webm
  sz=$(wc -c < /tmp/pub_$name.webm)
  if [ "$sz" -gt 256000 ]; then
    ffmpeg -y -v error -t 2.9 -i "$src" -i /tmp/lbl_$name.png -filter_complex \
      "[0:v]crop='min(iw,ih)':'min(iw,ih)':'(iw-min(iw,ih))/2':'(ih-min(iw,ih))/2',scale=512:512,fps=30[v];[v][1:v]overlay=0:0" \
      -an -c:v libvpx-vp9 -pix_fmt yuv420p -b:v 200k /tmp/pub_$name.webm
    sz=$(wc -c < /tmp/pub_$name.webm)
  fi
  fid=$(curl -s "https://api.telegram.org/bot$TOKEN/uploadStickerFile" -F user_id=$OWNER -F sticker_format=video -F "sticker=@/tmp/pub_$name.webm" | python3 -c "import sys,json;print(json.load(sys.stdin).get('result',{}).get('file_id',''))")
  if [ -z "$fid" ]; then echo "UPLOAD-FAIL $name"; continue; fi
  res=$(curl -s "https://api.telegram.org/bot$TOKEN/addStickerToSet" -F user_id=$OWNER -F name=$SET -F "sticker={\"sticker\":\"$fid\",\"format\":\"video\",\"emoji_list\":[\"$emoji\"]}")
  ok=$(echo "$res" | python3 -c "import sys,json;print(json.load(sys.stdin).get('ok'))")
  echo "ADD $name ($label $emoji) ${sz}b -> ok=$ok $(echo "$res" | python3 -c "import sys,json;d=json.load(sys.stdin);print('' if d.get('ok') else d.get('description',''))")"
  [ "$ok" = "True" ] && added=$((added+1))
done
echo "PUBLISHED $added stickers to $SET"
