# Composite a character animation into its static poster's mugshot window -> animated poster mp4.
import os, sys, subprocess
from PIL import Image, ImageDraw
MX,MY,MW,MH,RAD=202,286,620,486,48
def run(key):
    poster=f"/tmp/repl/poster_{key}.png"; anim=f"/tmp/repl/{'whale_' if os.path.exists(f'/tmp/repl/whale_{key}_anim.mp4') else ''}{key}_anim.mp4"
    if not os.path.exists(anim): anim=f"/tmp/repl/whale_{key}_anim.mp4"
    fd=f"/tmp/repl/_f_{key}"; od=f"/tmp/repl/_o_{key}"
    subprocess.run(f"rm -rf {fd} {od}; mkdir -p {fd} {od}",shell=True)
    subprocess.run(f'ffmpeg -y -i {anim} -vf fps=25 {fd}/%03d.png',shell=True,stderr=subprocess.DEVNULL)
    base=Image.open(poster).convert("RGB")
    mask=Image.new("L",(MW,MH),0); ImageDraw.Draw(mask).rounded_rectangle([0,0,MW,MH],radius=RAD,fill=255)
    frames=sorted(os.listdir(fd))
    for i,fn in enumerate(frames):
        fr=Image.open(f"{fd}/{fn}").convert("RGB"); sc=max(MW/fr.width,MH/fr.height)
        fr=fr.resize((int(fr.width*sc),int(fr.height*sc)))
        cx=(fr.width-MW)//2; cy=int((fr.height-MH)*0.32); fr=fr.crop((cx,cy,cx+MW,cy+MH))
        out=base.copy(); out.paste(fr,(MX,MY),mask); out.save(f"{od}/{i:03d}.png")
    subprocess.run(f'ffmpeg -y -framerate 25 -i {od}/%03d.png -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart /tmp/repl/card_{key}.mp4',shell=True,stderr=subprocess.DEVNULL)
    subprocess.run(f"rm -rf {fd} {od}",shell=True)
    return os.path.getsize(f"/tmp/repl/card_{key}.mp4")
for k in sys.argv[1:]:
    print(k, run(k), "bytes", flush=True)
