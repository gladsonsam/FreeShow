// Scores a follow pass against the cue sheet.
//
// Latency is signed and firing early is the point of leadMs, so a small negative median is
// healthy — only the spread matters. Correctness comes from cue matching for the same
// reason: an early decision is still the right one.

import { expectedSlideAt, type Cue } from "./cues"
import type { PassResult } from "./runner"

export interface Score {
    coveragePct: number // share of the song spent on the right slide
    hitCues: number
    missedCues: number
    falseAdvances: number // decisions matching no cue
    backwardJumps: number
    timeToLockMs: number | null
    medianLatencyMs: number | null
    p90AbsLatencyMs: number | null
    meanConfidenceCorrect: number | null
    meanConfidenceWrong: number | null
}

const MATCH_WINDOW_MS = 6000

function median(values: number[]) {
    if (!values.length) return null
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function p90(values: number[]) {
    if (!values.length) return null
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))]
}

function mean(values: number[]) {
    if (!values.length) return null
    return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length)
}

export function score(result: PassResult, cues: Cue[], startSlide = 0): Score {
    // a cue only needs a decision if it actually changes the live slide — the first is
    // usually "slide 0 at t=0", which the engine is already on
    const transitions = cues.filter((cue, i) => cue.slideIndex !== (i === 0 ? startSlide : cues[i - 1].slideIndex))

    let correct = 0
    let counted = 0
    for (const entry of result.timeline) {
        const expected = expectedSlideAt(cues, entry.timeMs)
        if (expected < 0) continue // before the first cue nothing is "right" yet
        counted++
        if (entry.slide === expected) correct++
    }

    // claim the nearest decision for each cue; whatever is left over is a false advance
    const unclaimed = new Set(result.decisions.map((_, i) => i))
    const latencies: number[] = []
    let missedCues = 0

    for (const cue of transitions) {
        let best = -1
        let bestDist = MATCH_WINDOW_MS

        result.decisions.forEach((decision, i) => {
            if (!unclaimed.has(i) || decision.slideIndex !== cue.slideIndex) return
            const dist = Math.abs(decision.timeMs - cue.timeMs)
            if (dist <= bestDist) {
                bestDist = dist
                best = i
            }
        })

        if (best < 0) {
            missedCues++
            continue
        }

        unclaimed.delete(best)
        latencies.push(result.decisions[best].timeMs - cue.timeMs)
    }

    const confidenceCorrect: number[] = []
    const confidenceWrong: number[] = []
    let backwardJumps = 0
    let previousSlide = startSlide
    let timeToLockMs: number | null = null

    result.decisions.forEach((decision, i) => {
        if (unclaimed.has(i)) {
            confidenceWrong.push(decision.confidence)
            // a song legitimately returns to an earlier slide each chorus, so only count
            // backward moves that matched no cue
            if (decision.slideIndex < previousSlide) backwardJumps++
        } else {
            confidenceCorrect.push(decision.confidence)
            if (timeToLockMs === null) timeToLockMs = decision.timeMs
        }
        previousSlide = decision.slideIndex
    })

    return {
        coveragePct: counted ? Math.round((correct / counted) * 1000) / 10 : 0,
        hitCues: latencies.length,
        missedCues,
        falseAdvances: unclaimed.size,
        backwardJumps,
        timeToLockMs,
        medianLatencyMs: median(latencies),
        p90AbsLatencyMs: p90(latencies.map(Math.abs)),
        meanConfidenceCorrect: mean(confidenceCorrect),
        meanConfidenceWrong: mean(confidenceWrong)
    }
}

export function formatScore(s: Score) {
    const latency = s.medianLatencyMs === null ? "—" : `${s.medianLatencyMs > 0 ? "+" : ""}${s.medianLatencyMs}ms`

    return [`coverage ${s.coveragePct}%`, `cues ${s.hitCues}/${s.hitCues + s.missedCues}`, `false ${s.falseAdvances}`, `back ${s.backwardJumps}`, `lat ${latency} (p90 ${s.p90AbsLatencyMs ?? "—"}ms)`, `lock ${s.timeToLockMs === null ? "never" : (s.timeToLockMs / 1000).toFixed(1) + "s"}`, `conf ok/bad ${s.meanConfidenceCorrect ?? "—"}/${s.meanConfidenceWrong ?? "—"}`].join("  ")
}
