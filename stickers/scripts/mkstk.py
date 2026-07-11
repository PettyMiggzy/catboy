import sys, math, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from rembg import remove

SRC, LABEL, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
FRAMES, SIZE = 60, 512
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# 1) cut out background -> transparent, autocrop to content
cut = remove(Image.open(SRC).convert("RGBA"))
bbox = cut.getbbox()
if bbox: cut = cut.crop(bbox)

# 2) fit character into a 512 canvas, leaving headroom at top for the label
maxw, maxh = int(SIZE*0.92), int(SIZE*0.74)
r = min(maxw/cut.width, maxh/cut.height)
cut = cut.resize((max(1,int(cut.width*r)), max(1,int(cut.height*r))), Image.LANCZOS)
cx = (SIZE - cut.width)//2
cy = SIZE - cut.height - 6            # anchored near the bottom

# soft green aura behind the character
aura = Image.new("RGBA", (SIZE, SIZE), (0,0,0,0))
ad = ImageDraw.Draw(aura)
ad.ellipse([SIZE*0.12, SIZE*0.2, SIZE*0.88, SIZE*0.98], fill=(60,230,120,120))
aura = aura.filter(ImageFilter.GaussianBlur(46))

# 3) label text (cream fill, dark-green stroke, green glow) — WEN style
def fit_font(txt, maxw):
    for s in range(120, 40, -4):
        f = ImageFont.truetype(FONT, s)
        if f.getbbox(txt)[2] <= maxw: return f
    return ImageFont.truetype(FONT, 40)
font = fit_font(LABEL, int(SIZE*0.9))
tb = font.getbbox(LABEL); tw, th = tb[2]-tb[0], tb[3]-tb[1]
tx, ty = (SIZE-tw)//2 - tb[0], int(SIZE*0.03)
# glow layer
glow = Image.new("RGBA", (SIZE, SIZE), (0,0,0,0))
ImageDraw.Draw(glow).text((tx,ty), LABEL, font=font, fill=(70,255,140,255),
    stroke_width=10, stroke_fill=(70,255,140,255))
glow = glow.filter(ImageFilter.GaussianBlur(9))
# crisp text
txt = Image.new("RGBA", (SIZE, SIZE), (0,0,0,0))
ImageDraw.Draw(txt).text((tx,ty), LABEL, font=font, fill=(245,222,150,255),
    stroke_width=6, stroke_fill=(20,60,25,255))

os.makedirs("/tmp/frames", exist_ok=True)
for f in os.listdir("/tmp/frames"): os.remove("/tmp/frames/"+f)
for i in range(FRAMES):
    p = i/FRAMES
    bob = int(round(math.sin(p*2*math.pi)*5))          # gentle vertical bob
    pulse = 0.55 + 0.45*(0.5+0.5*math.sin(p*2*math.pi)) # aura/text-glow pulse
    frame = Image.new("RGBA", (SIZE, SIZE), (0,0,0,0))
    a = aura.copy(); a.putalpha(a.getchannel("A").point(lambda v: int(v*pulse)))
    frame = Image.alpha_composite(frame, a)
    frame.alpha_composite(cut, (cx, cy+bob))
    g = glow.copy(); g.putalpha(g.getchannel("A").point(lambda v: int(v*(0.5+0.5*pulse))))
    frame = Image.alpha_composite(frame, g)
    frame = Image.alpha_composite(frame, txt)
    frame.save(f"/tmp/frames/f{i:03d}.png")
print("frames done:", OUT)
