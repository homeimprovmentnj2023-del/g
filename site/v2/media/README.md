# Drop your real assets here

Nothing in this folder is invented — every file below is one you already have.

## Hero video (the single most important asset on the page)

| File | What it is |
|---|---|
| `hero-refinishing.mp4` | The real refinishing footage. H.264 video + AAC audio plays everywhere. |
| `hero-poster.jpg` | First frame. Use a **glossy finished tub**, not a dirty before-shot — on a slow connection it is the first thing a visitor sees. |
| `hero-refinishing.webm` | Optional. Smaller; served first where supported. Set `video.webm` in config.js. |

The page shows an honest placeholder panel until `hero-refinishing.mp4` exists,
so it never renders a broken black box.

### Audio

The clip should carry the **sales voiceover**, not the original on-site audio.
Until it does, leave `video.hasVoiceover: false` in config.js — the 🔊 button
stays hidden, because unmuting into hammering and echo actively costs the lead.

The voiceover should cover: professional refinishing · glossy like-new result ·
professional-grade process and materials · built for long-lasting results ·
**8+ years potential** with proper care depending on use and conditions ·
**2-year warranty included** · free quote · no payment required to get one ·
call us · text a bathtub photo for a fast quote · view available appointments ·
see the completed work before paying.

> **Say it exactly that way round.** The warranty is 2 years. The 8+ years is
> potential longevity with proper care — never described as guaranteed, and
> never merged with the warranty.

## Proof section (`work-1` … `work-6`)

Your clearest real work — before/after stills and short clips. Images `.jpg`,
clips `.mp4` (muted, looping, `playsinline` so they behave like images).
4:3 crops. Roughly: chipped cast iron, spray application, stained tub +
surround, finished gloss, tile refinishing, crack/fiberglass repair.

There are ~47 real photos in `backend/data/photos/` on the Windows machine
(served at `/photos/<name>` by the local backend) — the best of those are
likely the fastest source.

## Compression

Keep the hero under ~6 MB. Mobile abandonment is steep and this audience is
not on fast connections.

```bash
ffmpeg -i input.mov -vcodec libx264 -crf 24 -preset slow -vf "scale=1280:-2" \
       -acodec aac -b:a 128k -movflags +faststart hero-refinishing.mp4
ffmpeg -i hero-refinishing.mp4 -ss 00:00:02 -vframes 1 -q:v 3 hero-poster.jpg
```

`-movflags +faststart` matters: without it the video will not begin playing
until the whole file has downloaded.
