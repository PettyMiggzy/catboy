#!/bin/bash
VK=$(cat /tmp/.vkey); MODEL=veo3.1-full-image-to-video
python3 - "$VK" "$MODEL" <<'PY'
import sys,json,base64,urllib.request
VK,MODEL=sys.argv[1],sys.argv[2]
prompts={
 "laptop":"the character typing fast on a glowing laptop, dark cinematic room, green screen glow, subtle head bob, looping",
 "bow":"the character doing a slow confident bow, dark cinematic lighting, green rim light, looping",
 "money":"the character throwing stacks of cash that rain down, dark cinematic, green glow, looping",
 "pray":"the character clasping hands looking up hopeful, dark cinematic, soft green light, gentle motion, looping",
}
out={}
for name,pr in prompts.items():
    b64=base64.b64encode(open(f"/tmp/dk_{name}.png","rb").read()).decode()
    body=json.dumps({"model":MODEL,"prompt":pr,"image_url":f"data:image/png;base64,{b64}"}).encode()
    req=urllib.request.Request("https://api.venice.ai/api/v1/video/queue",data=body,
        headers={"Authorization":"Bearer "+VK,"Content-Type":"application/json"})
    try:
        d=json.load(urllib.request.urlopen(req,timeout=60))
        qid=d.get("queue_id") or d.get("id") or ""
        print(f"queued {name} -> {qid}")
        out[name]=qid
    except urllib.error.HTTPError as e:
        print(f"queue FAIL {name}: {e.code} {e.read()[:150]}")
        out[name]=""
    except Exception as e:
        print(f"queue ERR {name}: {e}")
        out[name]=""
json.dump(out,open("/tmp/qids4.json","w"))
print("saved qids4:",out)
PY
