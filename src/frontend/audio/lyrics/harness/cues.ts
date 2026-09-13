// Cue sheet = the ground truth for a fixture: when each slide should be live.
//
// Produced by the app's "Export cue sheet" button (Auto Lyrics popup), which dumps a
// learned map's marks, so a fixture annotates itself after one normal run-through.

import { readFileSync } from "node:fs"
import type { SongMark } from "../songMap"

export interface Cue {
    timeMs: number
    slideIndex: number
}

export interface CueSheet {
    songName: string
    slideCount: number
    cues: Cue[]
}

export function marksToCues(marks: SongMark[], fps: number): Cue[] {
    return marks.map((mark) => ({ timeMs: Math.round((mark.frame / fps) * 1000), slideIndex: mark.slideIndex }))
}

export function loadCueSheet(file: string): CueSheet {
    const parsed = JSON.parse(readFileSync(file, "utf8"))

    const cues: Cue[] = (parsed.cues || [])
        .map((cue: any) => ({ timeMs: Number(cue.timeMs), slideIndex: Number(cue.slideIndex) }))
        .filter((cue: Cue) => Number.isFinite(cue.timeMs) && Number.isFinite(cue.slideIndex))
        .sort((a: Cue, b: Cue) => a.timeMs - b.timeMs)

    if (!cues.length) throw new Error(`${file}: no usable cues`)

    const slideCount = Number(parsed.slideCount) || Math.max(...cues.map((c) => c.slideIndex)) + 1
    return { songName: parsed.songName || "fixture", slideCount, cues }
}

// Which slide should be live at a given moment, per the cue sheet (-1 before the first cue)
export function expectedSlideAt(cues: Cue[], timeMs: number): number {
    let slide = -1
    for (const cue of cues) {
        if (cue.timeMs > timeMs) break
        slide = cue.slideIndex
    }
    return slide
}
