import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
LABEL, OUT = sys.argv[1], sys.argv[2]
F="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def fit(t,mw):
    for s in range(150,44,-4):
        f=ImageFont.truetype(F,s)
        if f.getbbox(t)[2]<=mw: return f
    return ImageFont.truetype(F,44)
f=fit(LABEL,478); b=f.getbbox(LABEL); tw=b[2]-b[0]; x=(512-tw)//2-b[0]; y=512-(b[3]-b[1])-26
im=Image.new("RGBA",(512,512),(0,0,0,0))
glow=Image.new("RGBA",(512,512),(0,0,0,0)); ImageDraw.Draw(glow).text((x,y),LABEL,font=f,fill=(150,255,60,255),stroke_width=13,stroke_fill=(150,255,60,255)); glow=glow.filter(ImageFilter.GaussianBlur(9))
im=Image.alpha_composite(im,glow)
ImageDraw.Draw(im).text((x,y),LABEL,font=f,fill=(158,244,24,255),stroke_width=7,stroke_fill=(8,22,4,255))
im.save(OUT); print("label",OUT)
