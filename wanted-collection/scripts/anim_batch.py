import json, base64, urllib.request, time, io, sys, concurrent.futures as cf
from PIL import Image
KEY=open("/tmp/.vkey").read().strip(); MODEL="veo3.1-fast-image-to-video"
names=sys.argv[1:]
def prompt(n):
    extra="Gold pixel cubes float and shimmer around it. " if n=="craigmack" else ""
    return ("Cinematic living 1-of-1 NFT loop. The hooded stag's eyes glow and pulse, the green arrow glows "
      "and flickers with energy, the green candlestick chart bars flicker and rise, faint green embers and "
      "light rain drift down. Slow breathing, one slow confident blink, a slight menacing head tilt, hood "
      "shifting a touch. "+extra+"Keep the EXACT same character, colors and framing. Subtle, slow, dark, "
      "epic, atmospheric — NOT bouncy or cartoonish. Seamless looping feel.")
def durl(n):
    im=Image.open(f"/tmp/repl/whale_{n}.png").convert("RGB"); b=io.BytesIO(); im.save(b,"PNG")
    return "data:image/png;base64,"+base64.b64encode(b.getvalue()).decode()
def queue(n):
    body=json.dumps({"model":MODEL,"prompt":prompt(n),"image_url":durl(n),"duration":"4s","resolution":"720p"}).encode()
    req=urllib.request.Request("https://api.venice.ai/api/v1/video/queue",data=body,headers={"Authorization":"Bearer "+KEY,"Content-Type":"application/json"})
    return json.loads(urllib.request.urlopen(req,timeout=120).read())["queue_id"]
def retrieve(qid):
    body=json.dumps({"model":MODEL,"queue_id":qid}).encode()
    req=urllib.request.Request("https://api.venice.ai/api/v1/video/retrieve",data=body,headers={"Authorization":"Bearer "+KEY,"Content-Type":"application/json"})
    r=urllib.request.urlopen(req,timeout=120).read()
    if r[4:8]==b"ftyp": return ("V",r)
    try: return ("J",json.loads(r))
    except: return ("R",r)
ids={}
for n in names:
    try: ids[n]=queue(n); print("queued",n,ids[n],flush=True)
    except Exception as e: print("QFAIL",n,str(e)[:100],flush=True)
done=set()
for _ in range(220):
    if len(done)==len(ids): break
    time.sleep(6)
    for n,qid in ids.items():
        if n in done: continue
        try: k,v=retrieve(qid)
        except: continue
        if k=="V": open(f"/tmp/repl/whale_{n}_anim.mp4","wb").write(v); print("SAVED",n,len(v),flush=True); done.add(n)
        elif k=="J" and str(v.get("status","")).upper() in ("FAILED","ERROR"): print("FAIL",n,v,flush=True); done.add(n)
print("ALLDONE",len(done),flush=True)
