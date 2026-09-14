import type { Outputs } from "../../../types/Output"
import type { OutSlide } from "../../../types/Show"

export interface ActiveLyricsOutput {
    id: string
    slide: OutSlide | null
}

// Auto Lyrics and its cue recorder must observe the same audience output. Prefer the
// explicitly active output, falling back to the first enabled non-stage output.
export function getActiveLyricsOutput(outputs: Outputs): ActiveLyricsOutput | null {
    const entries = Object.entries(outputs).filter(([, output]) => output.enabled && !output.stageOutput)
    const active = entries.find(([, output]) => output.active) || entries[0]
    if (!active) return null
    return { id: active[0], slide: active[1].out?.slide || null }
}
