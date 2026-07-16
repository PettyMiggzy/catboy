import os, sys, subprocess
from PIL import Image
WS=580; MX=(1024-WS)//2; MY=286   # square window matches posterlib2
def run(key, anim, poster):
    fd=f"/tmp/repl/_cf_{key}"; od=f"/tmp/repl/_co_{key}"
    subprocess.run(f"rm -rf {fd} {od}; mkdir -p {fd} {od}",shell=True)
    subprocess.run(f'ffmpeg -y -i {anim} -vf fps=25 {fd}/%03d.png',shell=True,stderr=subprocess.DEVNULL)
    base=Image.open(poster).convert("RGB")
    frames=sorted(os.listdir(fd))
    for i,fn in enumerate(frames):
        fr=Image.open(f"{fd}/{fn}").convert("RGB"); sc=max(WS/fr.width,WS/fr.height); fr=fr.resize((int(fr.width*sc),int(fr.height*sc)))
        cx=(fr.width-WS)//2; cy=(fr.height-WS)//2; fr=fr.crop((cx,cy,cx+WS,cy+WS))
        out=base.copy(); out.paste(fr,(MX,MY)); out.save(f"{od}/{i:03d}.png")
    subprocess.run(f'ffmpeg -y -framerate 25 -i {od}/%03d.png -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart /tmp/repl/final_{key}.mp4',shell=True,stderr=subprocess.DEVNULL)
    subprocess.run(f"rm -rf {fd} {od}",shell=True)
    return os.path.getsize(f"/tmp/repl/final_{key}.mp4")
if __name__=="__main__":
    for k in sys.argv[1:]:
        anim=f"/tmp/repl/uniq_{k}_anim.mp4"
        if not os.path.exists(anim): anim=f"/tmp/repl/whale_{k}_anim.mp4"
        poster=f"/tmp/repl/wp_{k}.png"
        if os.path.exists(anim) and os.path.exists(poster): print(k, run(k,anim,poster),flush=True)
        else: print("SKIP",k,"(missing anim or poster)",flush=True)
