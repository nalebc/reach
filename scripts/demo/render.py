"""Compose the README tour from CUA screenshots, without changing their UI.

Requires Pillow. Run: python render.py CAPTURE_DIRECTORY OUTPUT_DIRECTORY
Captures (scripts/demo/capture.mjs makes them): home.png, optionally
home-000.png…home-031.png, screen.png, invite.png, approve.png, chat.png,
files.png. Optional --frames DIR exports a video timeline.
"""
from pathlib import Path
import argparse
import json
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser()
parser.add_argument("captures", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--frames", type=Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
W, H = 1120, 800
BG, WHITE, MINT, MUTED = "#101511", "#f2f3eb", "#c4ebd3", "#96a69a"

def mono(size):
    for path in ["/System/Library/Fonts/Menlo.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"]:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)

def font(size, bold=False):
    names = (["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"] if bold else
             ["/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"])
    for path in names:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)

scenes = [
    ("home", "Your Mac.\nIn your pocket.", "Screen, files, terminals and chats,\nfrom any phone browser.", "01  /  YOUR MAC"),
    ("screen", "Full control.\nIn real time.", "Hardware H.264, up to 60 fps,\nstraight from your Mac.", "02  /  LIVE SCREEN"),
    ("invite", "Give an agent\nyour Mac.", "Pick a preset. It joins with\none command, over MCP.", "03  /  AGENTS OVER MCP", "$ claude mcp add reach -- …"),
    ("approve", "Nothing gets in\nwithout you.", "Match its code, then approve.\nPause or end it any time.", "04  /  APPROVAL"),
    ("chat", "Your agents,\non the go.", "Codex and Claude Code chats:\nread, reply, approve.", "05  /  CHATS"),
    ("files", "That file\nyou needed.", "Browse, preview and share\nfrom your phone.", "06  /  FILES"),
]

def compose(scene, screenshot, progress=0):
    _, title, subtitle, label, *code = scenes[scene]
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    # A restrained dotted connection motif echoes the app's own identity.
    for x in range(40, 620, 24):
        for y in range(100, 760, 24):
            d.ellipse((x,y,x+1,y+1), fill="#263029")
    d.text((54,42), "reach", font=font(36,True), fill=WHITE)
    d.rounded_rectangle((54,180,363,216), radius=18, fill="#21342a")
    d.text((72,190),label,font=font(13,True),fill=MINT)
    d.multiline_text((50,249),title,font=font(55,True),fill=WHITE,spacing=8)
    d.multiline_text((54,427),subtitle,font=font(23),fill=MUTED,spacing=9)
    if code:
        d.rounded_rectangle((54,494,490,528), radius=9, fill="#0b100d", outline="#2c3a31")
        d.text((68,503), code[0], font=mono(15), fill=MINT)
    d.line((54,542,490,542), fill="#344139", width=1)
    d.text((54,563),"Private access through Tailscale",font=font(17),fill=MINT)
    d.text((54,596),"Phone browser + your Mac",font=font(15),fill=MUTED)
    # Actual browser viewport is preserved at a uniform scale.
    shot = Image.open(screenshot).convert("RGB")
    shot.thumbnail((340,736),Image.Resampling.LANCZOS)
    x,y=697+(340-shot.width)//2,32+(736-shot.height)//2
    d.rounded_rectangle((x-9,y-9,x+shot.width+9,y+shot.height+9),radius=32,fill="#080b09",outline="#425348",width=2)
    mask=Image.new("L",shot.size,0)
    ImageDraw.Draw(mask).rounded_rectangle((0,0,shot.width-1,shot.height-1),radius=23,fill=255)
    im.paste(shot,(x,y),mask)
    for i in range(len(scenes)):
        a=54+i*64
        d.rounded_rectangle((a,699,a+48,703),radius=2,fill=MINT if i==scene else "#364038")
    d.text((54,737),"UI WALKTHROUGH  ·  SAMPLE DATA",font=font(12,True),fill=MUTED)
    return im

frames, durations = [], []
previous = None
for i,(name,*_) in enumerate(scenes):
    image=compose(i,args.captures/f"{name}.png")
    if previous:
        for t in range(1,9):
            frames.append(Image.blend(previous,image,t/8));durations.append(50)
    moving=sorted(args.captures.glob("home-[0-9][0-9][0-9].png")) if name=="home" else []
    if moving:
        for p in moving:
            frames.append(compose(i,p));durations.append(70)
        frames.append(image);durations.append(1300)
    else:
        frames.append(image);durations.append(3200)
    previous=image

poster=compose(0,args.captures/"home.png")
poster.save(args.output/"reach-demo-poster.png",optimize=True)
# One shared palette keeps colors stable across transitions.
palette=poster.quantize(colors=160)
gif=[f.quantize(palette=palette,dither=Image.Dither.NONE) for f in frames]
gif[0].save(args.output/"reach-demo.gif",save_all=True,append_images=gif[1:],duration=durations,loop=0,optimize=True,disposal=1)
if args.frames:
    args.frames.mkdir(parents=True,exist_ok=True)
    timeline=[]
    for i,(frame,duration) in enumerate(zip(frames,durations)):
        name=f"frame-{i:04}.png"
        frame.save(args.frames/name)
        timeline.append({"file":name,"milliseconds":duration})
    (args.frames/"timeline.json").write_text(json.dumps(timeline))
print(json.dumps({"width":W,"height":H,"seconds":sum(durations)/1000,"frames":len(frames),"gif_bytes":(args.output/"reach-demo.gif").stat().st_size}))
