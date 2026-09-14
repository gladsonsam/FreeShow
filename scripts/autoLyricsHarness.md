# Auto Lyrics offline test harness

The harness tests Auto Lyrics without opening FreeShow, granting microphone access, or
playing audio in real time. It decodes a recording, runs the production learning and
following engine on a virtual clock, and reports slide coverage, missed cues, false
advances, latency, and confidence.

It requires Node.js dependencies (`npm install`) and `ffmpeg` on `PATH`.

## Make a cue sheet on your laptop

Start the local cue maker:

```sh
npm run test:lyrics:cues
```

Open `http://127.0.0.1:4174`, choose the MP3, enter the number of lyric slides, and
play the song. Each time the live lyrics should change, press the matching slide button
(or keys 1–9). Use Backspace to undo a mistake. Download `cues.json` when the song is
finished. The MP3 stays on your laptop; the page has no upload or network step.

Send the original MP3 and downloaded `cues.json` back for regression testing.

## Run a recording directly

Create a cue sheet from your operator notes or recording timestamps:

```json
{
    "songName": "Cornerstone",
    "slideCount": 4,
    "cues": [
        { "timeMs": 0, "slideIndex": 0 },
        { "timeMs": 12400, "slideIndex": 1 },
        { "timeMs": 26800, "slideIndex": 2 },
        { "timeMs": 41100, "slideIndex": 1 }
    ]
}
```

`timeMs` is the point in the recording where the slide should become live. Slide indexes
are zero-based. Then run:

```sh
npm run test:lyrics -- --audio /path/to/take.wav --cues /path/to/cues.json
```

The first pass learns from the cue sheet. Subsequent passes replay the recording with
tempo, noise, level, EQ, and pitch perturbations to expose regressions. This is a
repeatable robustness test, not a substitute for testing a genuinely different live
performance.

## Reusable local fixtures

For recordings used repeatedly, create this untracked layout:

```text
fixtures/autolyrics/Cornerstone/
  source.wav
  cues.json
```

The audio fixture directory is gitignored so copyrighted or private recordings are not
committed. Run all fixtures or select one:

```sh
npm run test:lyrics
npm run test:lyrics -- --song Cornerstone
```

A cue sheet can also be exported from a learned song in the Auto Lyrics popup when
FreeShow is running in development mode, but the app is not required.

## Useful regression commands

```sh
# Discover exact fixture and variant names
npm run test:lyrics -- --list

# Fast smoke test
npm run test:lyrics -- --song Cornerstone --variant identity,tempo_0.9x,noise_10dB

# Tune confidence threshold and lead time
npm run test:lyrics -- --song Cornerstone --sweep

# Produce JSON and fail automation when a run is below the quality bar
npm run test:lyrics -- --song Cornerstone --json results.json --min-coverage 85 --max-false 1
```

Run `npm run test:lyrics -- --help` for every option. The synthetic unit suite remains
available with `npm run test:unit -- --run src/frontend/audio/lyrics/autoLyrics.test.ts`.
