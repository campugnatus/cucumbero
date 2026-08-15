#!/usr/bin/env python3
"""Regenerate the extension icons from the 🥒 glyph.

Everything is the same cucumber on transparency — the toolbar sizes get a hair
of padding, the notification icon gets more because the daemon draws it large.

    python3 tools/make-icons.py
"""

from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"
GLYPH = "\U0001F952"  # 🥒
OUT = "icons"

# NotoColorEmoji is a CBDT bitmap font with a single strike; FreeType accepts
# only size 109 for it, so render once at that size and scale from there.
FONT_PX = 109

# (filename, canvas px, fraction of the canvas the glyph should occupy)
TARGETS = [
    ("icon16.png", 16, 0.92),
    ("icon32.png", 32, 0.92),
    ("icon48.png", 48, 0.92),
    ("icon128.png", 128, 0.92),
    ("cucumber.png", 128, 0.68),  # notification icon
]


def master():
    """The glyph, cropped tight and squared out on transparency."""
    font = ImageFont.truetype(FONT, FONT_PX)
    canvas = Image.new("RGBA", (FONT_PX * 2, FONT_PX * 2), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).text(
        (FONT_PX, FONT_PX), GLYPH, font=font, anchor="mm", embedded_color=True
    )
    glyph = canvas.crop(canvas.getbbox())
    side = max(glyph.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(glyph, ((side - glyph.width) // 2, (side - glyph.height) // 2))
    return square


def main():
    src = master()
    for name, size, fill in TARGETS:
        inner = max(1, round(size * fill))
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        img.paste(src.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2,) * 2)
        img.save(f"{OUT}/{name}")
        print(f"{OUT}/{name}  {size}px, glyph {inner}px")


if __name__ == "__main__":
    main()
