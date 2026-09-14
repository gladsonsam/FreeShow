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
    showId?: string
    layoutId?: string
    cues: Cue[]
}

export function loadCueSheet(file: string): CueSheet {
    const parsed = JSON.parse(readFileSync(file, "utf8"))

    const cues: Cue[] = (parsed.cues || [])
        .map((cue: any) => ({ timeMs: Number(cue.timeMs), slideIndex: Number(cue.slideIndex) }))
        .filter((cue: Cue) => Number.isFinite(cue.timeMs) && Number.isFinite(cue.slideIndex))
        .sort((a: Cue, b: Cue) => a.timeMs - b.timeMs)

    if (!cues.length) throw new Error(`${file}: no usable cues`)

    const slideCount = Number(parsed.slideCount) || Math.max(...cues.map((c) => c.slideIndex)) + 1
    if (!Number.isInteger(slideCount) || slideCount < 1) throw new Error(`${file}: slideCount must be a positive integer`)
    if (cues.some((cue) => cue.timeMs < 0 || !Number.isInteger(cue.slideIndex) || cue.slideIndex < 0 || cue.slideIndex >= slideCount)) {
        throw new Error(`${file}: cues must have non-negative times and slide indexes between 0 and ${slideCount - 1}`)
    }

    return {
        songName: parsed.songName || "fixture",
        slideCount,
        showId: typeof parsed.showId === "string" ? parsed.showId : undefined,
        layoutId: typeof parsed.layoutId === "string" ? parsed.layoutId : undefined,
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
