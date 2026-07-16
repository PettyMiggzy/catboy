from PIL import Image, ImageDraw, ImageFont, ImageFilter
import random, math
W,H=1024,1280
FP="/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
def font(sz): return ImageFont.truetype(FP,sz)
FOREST=(38,74,36); BROWN=(74,50,26); INK=(56,38,20); GOLD=(150,110,26)
RAR={"MYTHIC":(150,60,150),"LEGENDARY":(150,110,26),"EPIC":(40,92,120),"RARE":(60,90,50)}
def build(char_path,name,crime,reward,rarity,out,seed=9):
    random.seed(seed)
    base=Image.new("RGB",(W,H),(222,201,156)); px=base.load()
    for y in range(H):
        for x in range(W):
            n=random.randint(-9,9); r,g,b=px[x,y]; px[x,y]=(max(0,min(255,r+n)),max(0,min(255,g+n)),max(0,min(255,b+n-8)))
    base=base.filter(ImageFilter.GaussianBlur(0.4)); d=ImageDraw.Draw(base,"RGBA")
    for _ in range(80):
        cx,cy=random.randint(0,W),random.randint(0,H); rr=random.randint(30,150)
        d.ellipse([cx-rr,cy-rr,cx+rr,cy+rr],fill=(120,90,45,random.randint(5,12)))
    vig=Image.new("L",(W,H),0); vd=ImageDraw.Draw(vig)
    for i in range(150): vd.rectangle([i,i,W-i,H-i],outline=int(i*1.4))
    vig=vig.filter(ImageFilter.GaussianBlur(50)); base=Image.composite(base,Image.new("RGB",(W,H),(70,52,24)),vig.point(lambda v:255-v))
    d=ImageDraw.Draw(base,"RGBA")
    for _ in range(650):
        x=random.randint(0,W); d.line([(x,0),(x,random.randint(0,28))],fill=(46,30,14,200),width=2); d.line([(x,H),(x,H-random.randint(0,28))],fill=(46,30,14,200),width=2)
    for _ in range(650):
        y=random.randint(0,H); d.line([(0,y),(random.randint(0,28),y)],fill=(46,30,14,200),width=2); d.line([(W,y),(W-random.randint(0,28),y)],fill=(46,30,14,200),width=2)
    d.rectangle([28,28,W-28,H-28],outline=FOREST,width=6); d.rectangle([40,40,W-40,H-40],outline=BROWN,width=2)
    def arrow(x1,y1,x2,y2,col):
        d.line([(x1,y1),(x2,y2)],fill=col,width=5); ang=math.atan2(y2-y1,x2-x1)
        for s in (-1,1): d.line([(x2,y2),(x2-22*math.cos(ang+s*0.5),y2-22*math.sin(ang+s*0.5))],fill=col,width=5)
    for (cx,cy) in [(66,66),(W-66,66),(66,H-66),(W-66,H-66)]:
        arrow(cx-26,cy-26,cx+26,cy+26,FOREST); arrow(cx+26,cy-26,cx-26,cy+26,BROWN)
    def ctext(y,s,sz,tracking=0,fill=INK,shadow=True):
        f=font(sz); widths=[d.textlength(ch,font=f) for ch in s]; total=sum(widths)+tracking*(len(s)-1); x=(W-total)/2
        for i,ch in enumerate(s):
            if shadow: d.text((x+2,y+2),ch,font=f,fill=(40,26,12,120))
            d.text((x,y),ch,font=f,fill=fill); x+=widths[i]+tracking
        return total
    ctext(50,"WANTED",148,tracking=12)
    d.line([(210,210),(W-210,210)],fill=FOREST,width=3); d.polygon([(W//2-10,204),(W//2+10,204),(W//2,220)],fill=GOLD)
    ctext(226,"DEAD  OR  ALIVE",42,tracking=10,fill=BROWN)
    mw,mh=620,486; mx=(W-mw)//2; my=286
    frame=Image.new("RGBA",(mw+28,mh+28),(0,0,0,0)); fd=ImageDraw.Draw(frame); fd.rounded_rectangle([0,0,mw+28,mh+28],radius=54,fill=(196,168,120,255),outline=(46,30,14,255),width=8)
    base.paste(frame,(mx-14,my-14),frame)
    ch=Image.open(char_path).convert("RGB"); sc=max(mw/ch.width,mh/ch.height); ch=ch.resize((int(ch.width*sc),int(ch.height*sc)))
    cx=(ch.width-mw)//2; cy=int((ch.height-mh)*0.32); ch=ch.crop((cx,cy,cx+mw,cy+mh)).convert("RGBA")
    mask=Image.new("L",(mw,mh),0); ImageDraw.Draw(mask).rounded_rectangle([0,0,mw,mh],radius=48,fill=255); base.paste(ch,(mx,my),mask)
    d=ImageDraw.Draw(base,"RGBA"); d.rounded_rectangle([mx,my,mx+mw,my+mh],radius=48,outline=(70,48,24,255),width=3)
    # name banner
    nf=font(52); nw=d.textlength(f'"{name}"',font=nf); bw=nw+70; bx=(W-bw)/2; byy=812
    d.rounded_rectangle([bx,byy,bx+bw,byy+66],radius=10,fill=(60,44,22,255),outline=GOLD,width=3)
    d.text(((W-nw)/2,byy+7),f'"{name}"',font=nf,fill=(224,214,192))
    ctext(902,crime,38,tracking=2,fill=INK)
    ctext(956,"REWARD",34,tracking=12,fill=BROWN); ctext(994,reward,78,tracking=2,fill=FOREST)
    rc=RAR.get(rarity,GOLD); bw2,bh2=300,50; bx2=(W-bw2)//2; byy2=1098
    d.rounded_rectangle([bx2,byy2,bx2+bw2,byy2+bh2],radius=25,fill=rc,outline=(30,20,10,255),width=3)
    bf=font(28); tw=d.textlength(rarity,font=bf); d.text(((W-tw)/2,byy2+11),rarity,font=bf,fill=(240,235,225))
    sx,sy,sr=884,1176,44; d.ellipse([sx-sr,sy-sr,sx+sr,sy+sr],fill=(40,92,40,255),outline=(24,58,24,255),width=4)
    pts=[]
    for i in range(10):
        a=-math.pi/2+i*math.pi/5; r=28 if i%2==0 else 12; pts.append((sx+r*math.cos(a),sy+r*math.sin(a)))
    d.polygon(pts,fill=(210,232,190,255))
    ctext(1180,"BY ORDER OF THE SHERIFF OF NOTTINGHAM",22,tracking=2,fill=BROWN)
    base.save(out)
    return out
