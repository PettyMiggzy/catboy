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
    for (cx,cy) in [(64,64),(W-64,64),(64,H-64),(W-64,H-64)]:
        arrow(cx-24,cy-24,cx+24,cy+24,FOREST); arrow(cx+24,cy-24,cx-24,cy+24,BROWN)
    def ctext(y,s,sz,tracking=0,fill=INK,shadow=True):
        f=font(sz); widths=[d.textlength(ch,font=f) for ch in s]; total=sum(widths)+tracking*(len(s)-1); x=(W-total)/2
        for i,ch in enumerate(s):
            if shadow: d.text((x+2,y+2),ch,font=f,fill=(40,26,12,120))
            d.text((x,y),ch,font=f,fill=fill); x+=widths[i]+tracking
        return total
    ctext(48,"WANTED",146,tracking=12)
    d.line([(210,206),(W-210,206)],fill=FOREST,width=3); d.polygon([(W//2-9,200),(W//2+9,200),(W//2,216)],fill=GOLD)
    ctext(224,"DEAD  OR  ALIVE",40,tracking=10,fill=BROWN)
    # square mugshot window — fits the full scene (cover)
    ws=580; mx=(W-ws)//2; my=286
    d.rectangle([mx-13,my-13,mx+ws+13,my+ws+13],fill=(196,168,120,255),outline=(46,30,14,255),width=8)
    ch=Image.open(char_path).convert("RGB"); sc=max(ws/ch.width,ws/ch.height); ch=ch.resize((int(ch.width*sc),int(ch.height*sc)))
    cx=(ch.width-ws)//2; cy=(ch.height-ws)//2; ch=ch.crop((cx,cy,cx+ws,cy+ws))
    base.paste(ch,(mx,my)); d=ImageDraw.Draw(base,"RGBA"); d.rectangle([mx,my,mx+ws,my+ws],outline=(70,48,24,255),width=3)
    # name banner
    nf=font(46); nw=d.textlength(f'"{name}"',font=nf); bw=nw+64; bx=(W-bw)/2; byy=my+ws+18
    d.rounded_rectangle([bx,byy,bx+bw,byy+60],radius=9,fill=(60,44,22,255),outline=GOLD,width=3)
    d.text(((W-nw)/2,byy+6),f'"{name}"',font=nf,fill=(224,214,192))
    ctext(byy+82,crime,36,tracking=2,fill=INK)
    ctext(byy+130,"REWARD",30,tracking=12,fill=BROWN); ctext(byy+164,reward,66,tracking=2,fill=FOREST)
    rc=RAR.get(rarity,GOLD); bw2,bh2=270,46; bx2=(W-bw2)//2; byy2=1196
    d.rounded_rectangle([bx2,byy2,bx2+bw2,byy2+bh2],radius=23,fill=rc,outline=(30,20,10,255),width=3)
    bf=font(26); tw=d.textlength(rarity,font=bf); d.text(((W-tw)/2,byy2+9),rarity,font=bf,fill=(240,235,225))
    base.save(out); return out
