import json, urllib.request, base64, concurrent.futures as cf
KEY=open("/tmp/.vkey").read().strip(); MODEL="seedream-v5-pro"
STYLE=("'The Hooded 20' crypto-outlaw collectible style: a detailed semi-realistic anthropomorphic HOODED "
  "STAG (deer with antlers, hood up) with GLOWING GREEN eyes, cinematic premium digital painting, dramatic "
  "lighting, high detail, a faint green $STAG energy accent. Unique 1-of-1 scene: ")
P={
 "emeraldbandit":"REGAL POWER POSE, front-facing: an emerald-armored stag lord on a throne of vines, glowing "
   "emerald gemstones set in ornate green armor and antlers, holding a jewel-encrusted longbow, emerald-lit "
   "hall, opulent green-and-gold palette.",
 "greenghost":"A translucent SPECTRAL GHOST stag rising from swirling green mist in a foggy Sherwood graveyard "
   "at night, semi-transparent glowing body, eerie phantom archer, tombstones, ghostly green low light, wide "
   "haunting framing.",
 "ironantler":"LOW HEROIC ANGLE on a battlefield: a massive war stag in riveted iron plate armor and iron-clad "
   "antlers, gripping a huge iron warbow, grim scarred face, sparks and smoke, cold steel-grey and green "
   "palette, banners behind.",
 "nightshade":"CLOSE MENACING shot: a sinister purple-hooded stag holding up a dripping poison-tipped arrow, "
   "coiling violet toxic smoke, apothecary dungeon of vials, deep purple-and-green palette, glowing violet-"
   "green eyes.",
 "poacher":"A rugged fur-cloaked stag hunter CROUCHED by a snare trap in a snowy pine forest camp at dusk, "
   "animal-bone trophies and pelts, aiming a crossbow, earthy brown palette, gritty survivalist, half-body.",
 "frostpoint":"An icy FROST stag in a blizzard inside a frozen crystal cave, frost-covered antlers, DRAWING a "
   "glowing pale-blue ice arrow, swirling snow and breath-fog, cold blue-white-and-green palette, sharp.",
 "hedgerunner":"DYNAMIC MOTION: a lean scout stag mid-LEAP over a Sherwood hedgerow in daylight, cloak "
   "streaming, light leather gear, sun-dappled green forest, sense of speed, action framing.",
 "twobit":"A scrappy young outlaw stag in a candle-lit TAVERN back-room, cocky crooked grin, patched hood, "
   "flipping a gold coin off his thumb, mugs and cards on the table, warm amber-and-green tavern light, "
   "half-body.",
 "bramble":"A camouflaged forest-scout stag half-HIDDEN in leafy undergrowth, cloak of moss and leaves, twigs "
   "in the antlers, peering out through ferns, dappled green woodland, stealthy, off-center framing.",
 "copperarrow":"A humble copper-toned stag at a FLETCHER'S WORKBENCH crafting arrows by candlelight, warm "
   "copper-and-bronze glow, wood shavings and feathers, modest workshop, cozy side-lit scene.",
 "pickpocket":"A sly small stag CUTTING A PURSE in a bustling medieval Sherwood market, mischievous grin, "
   "quick hands, blurred crowd and stalls behind, warm daylight with green accents, candid motion.",
}
def gen(item):
    n,p=item
    body=json.dumps({"model":MODEL,"prompt":STYLE+p,"width":1024,"height":1024}).encode()
    req=urllib.request.Request("https://api.venice.ai/api/v1/image/generate",data=body,headers={"Authorization":"Bearer "+KEY,"Content-Type":"application/json"})
    try:
        raw=urllib.request.urlopen(req,timeout=260).read()
        if raw[:1]==b'\x89': open(f"/tmp/repl/uniq_{n}.png","wb").write(raw); return f"OK {n}"
        j=json.loads(raw); img=None
        if "images" in j and j["images"]: img=j["images"][0]
        elif "data" in j and j["data"]: img=j["data"][0].get("b64_json") or j["data"][0].get("url")
        elif "image" in j: img=j["image"]
        if img and str(img).startswith("http"):
            open(f"/tmp/repl/uniq_{n}.png","wb").write(urllib.request.urlopen(img,timeout=120).read()); return f"OK(url) {n}"
        if img: open(f"/tmp/repl/uniq_{n}.png","wb").write(base64.b64decode(img)); return f"OK {n}"
        return f"NOIMG {n} {str(j)[:120]}"
    except Exception as e:
        try: return f"ERR {n} {e.read().decode()[:120]}"
        except: return f"ERR {n} {str(e)[:100]}"
with cf.ThreadPoolExecutor(max_workers=5) as ex:
    for r in ex.map(gen, P.items()): print(r,flush=True)
