# Rysuje ikony aplikacji (uruchamiane automatycznie przy publikacji).
from PIL import Image, ImageDraw
import sys, os
out = sys.argv[1] if len(sys.argv) > 1 else "web"
G = (61, 107, 47); Y = (242, 194, 48); D = (42, 36, 5)

def icon(size, pad, bg=True, mono=False):
    S = size * 4
    im = Image.new("RGBA", (S, S), G + (255,) if bg else (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    u = S / 108 * (1 - pad)
    o = S / 2 - 54 * u
    def R(x0, y0, x1, y1, r, fill):
        d.rounded_rectangle([o + x0 * u, o + y0 * u, o + x1 * u, o + y1 * u], radius=r * u, fill=fill)
    col = (255, 255, 255, 255) if mono else Y + (255,)
    R(47, 26, 61, 42, 3, col)
    R(32, 36, 76, 82, 9, col)
    hole = (0, 0, 0, 0) if mono else G + (255,)
    d.ellipse([o + 49 * u, o + 42 * u, o + 59 * u, o + 52 * u], fill=hole)
    if not mono:
        R(40, 60, 68, 65, 2, D + (255,)); R(40, 70, 60, 75, 2, D + (255,))
    return im.resize((size, size), Image.LANCZOS)

icon(192, 0.05).save(os.path.join(out, "ikona-192.png"))
icon(512, 0.05).save(os.path.join(out, "ikona-512.png"))
icon(512, 0.25).save(os.path.join(out, "ikona-maskable-512.png"))
icon(180, 0.08).save(os.path.join(out, "apple-touch-icon.png"))
icon(96, 0.0, bg=False, mono=True).save(os.path.join(out, "odznaka-96.png"))
print("Ikony gotowe")
