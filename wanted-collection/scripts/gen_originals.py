import json, urllib.request, concurrent.futures as cf
KEY=open("/tmp/.vkey").read().strip(); MODEL="nano-banana-pro-edit"
BASE=open("/tmp/repl/shadow.b64").read().strip()
R=json.load(open("/tmp/repl/roster_originals.json"))
STYLE=("Match this EXACT art style, quality and mood — a detailed semi-realistic HOODED STAG legend "
  "(deer with antlers, dark hood) against a green crypto candlestick-chart background, cinematic and "
  "premium ('The Hooded 20' style). It MUST clearly be a STAG/deer with antlers, not a human. Hood up, "
  "menacing confident smirk, holding up ONE complete glowing green arrow. Head-and-shoulders bust, "
  "centered, facing forward. No text/watermark/badge. Ultra detailed. Character: ")
def gen(item):
    k,v=item
    body=json.dumps({"model":MODEL,"prompt":STYLE+v["desc"],"image":BASE}).encode()
    req=urllib.request.Request("https://api.venice.ai/api/v1/image/edit",data=body,headers={"Authorization":"Bearer "+KEY,"Content-Type":"application/json"})
    try:
        raw=urllib.request.urlopen(req,timeout=260).read()
        if raw[0]==0x89: open(f"/tmp/repl/orig_{k}.png","wb").write(raw); return f"OK {k} {len(raw)//1024}KB"
        return f"NONIMG {k}"
    except Exception as e: return f"FAIL {k} {str(e)[:70]}"
with cf.ThreadPoolExecutor(max_workers=5) as ex:
    for r in ex.map(gen, R.items()): print(r,flush=True)
