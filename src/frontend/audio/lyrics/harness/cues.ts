// Ground truth for a fixture: when each slide should be live. Export one from the Auto
// Lyrics popup after running the song through once.

import { readFileSync } from "node:fs"

export interface Cue {
    timeMs: number
    slideIndex: number
}

export interface CueSheet {
    songName: string
    slideCount: number
    cues: Cue[]
}

export function loadCueSheet(file: string): CueSheet {
    const parsed = JSON.parse(readFileSync(file, "utf8"))

    const cues: Cue[] = (parsed.cues || [])
        .map((cue: any) => ({ timeMs: Number(cue.timeMs), slideIndex: Number(cue.slideIndex) }))
        .filter((cue: Cue) => Number.isFinite(cue.timeMs) && Number.isFinite(cue.slideIndex))
        .sort((a: Cue, b: Cue) => a.timeMs - b.timeMs)

    if (!cues.length) throw new Error(`${file}: no usable cues`)

    return {
        songName: parsed.songName || "fixture",
        slideCount: Number(parsed.slideCount) || Math.max(...cues.map((c) => c.slideIndex)) + 1,
        cues
    }
}

// which slide should be live at this moment (-1 before the first cue)
export function expectedSlideAt(cues: Cue[], timeMs: number) {
    let slide = -1
    for (const cue of cues) {
        if (cue.timeMs > timeMs) break
        slide = cue.slideIndex
    }
    return slide
}
