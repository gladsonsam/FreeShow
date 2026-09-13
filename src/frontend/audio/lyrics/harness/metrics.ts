// Scores a follow pass against the cue sheet.
//
// The headline number is coverage (share of the song spent on the right slide). Latency is
// reported signed: negative means the engine fired early, which is what leadMs is FOR, so
// a small negative median is healthy and only the spread is a problem.

import { expectedSlideAt, type Cue } from "./cues"
import type { Decision, PassResult } from "./runner"

export interface CueScore {
    slideIndex: number
    expectedMs: number
    firedMs: number | null
    latencyMs: number | null // fired - expected; negative = early
}

export interface Score {
    coveragePct: number // % of audio time on the correct slide
    cueScores: CueScore[]
    hitCues: number
    missedCues: number
    falseAdvances: number // decisions that matched no cue
    backwardJumps: number
    timeToLockMs: number | null // first correct decision
    medianLatencyMs: number | null
    p90AbsLatencyMs: number | null
    meanConfidenceCorrect: number | null
    meanConfidenceWrong: number | null
}

// a decision counts as "the" firing for a cue if it lands within this window
const MATCH_WINDOW_MS = 6000

function median(values: number[]): number | null {
    if (!values.length) return null
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function percentile(values: number[], p: number): number | null {
    if (!values.length) return null
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

function mean(values: number[]): number | null {
    if (!values.length) return null
    return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length)
}

export function score(result: PassResult, cues: Cue[], startSlide = 0): Score {
    // A cue only demands a decision if it actually changes the live slide. The first cue
    // is usually "slide 0 at t=0", which the engine is already anchored to.
    const transitions = cues.filter((cue, i) => cue.slideIndex !== (i === 0 ? startSlide : cues[i - 1].slideIndex))

    // ---- coverage ----
    let correctBlocks = 0
    let countedBlocks = 0
    for (const entry of result.timeline) {
        const expected = expectedSlideAt(cues, entry.timeMs)
        if (expected < 0) continue // before the first cue: nothing is "right" yet
        countedBlocks++
        if (entry.slide === expected) correctBlocks++
    }

    // ---- per-cue firing ----
    const unclaimed = new Set(result.decisions.map((_, i) => i))
    const cueScores: CueScore[] = transitions.map((cue) => {
        // nearest unclaimed decision for this slide within the window
        let best = -1
        let bestDist = Infinity
        result.decisions.forEach((decision, i) => {
            if (!unclaimed.has(i) || decision.slideIndex !== cue.slideIndex) return
            const dist = Math.abs(decision.timeMs - cue.timeMs)
            if (dist < bestDist && dist <= MATCH_WINDOW_MS) {
                bestDist = dist
                best = i
            }
        })

        if (best < 0) return { slideIndex: cue.slideIndex, expectedMs: cue.timeMs, firedMs: null, latencyMs: null }

        unclaimed.delete(best)
        const fired = result.decisions[best]
        return { slideIndex: cue.slideIndex, expectedMs: cue.timeMs, firedMs: fired.timeMs, latencyMs: fired.timeMs - cue.timeMs }
    })

    // ---- decision-level quality ----
    // "unclaimed" now holds exactly the decisions that matched no cue
    const correctConfidences: number[] = []
    const wrongConfidences: number[] = []
    let backwardJumps = 0
    let previousSlide = startSlide
    let timeToLockMs: number | null = null

    result.decisions.forEach((decision, i) => {
        if (unclaimed.has(i)) {
            wrongConfidences.push(decision.confidence)
            // only a spurious backward move is a fault; a song legitimately returns to
            // an earlier slide every time the chorus comes round again
            if (decision.slideIndex < previousSlide) backwardJumps++
        } else {
            correctConfidences.push(decision.confidence)
            if (timeToLockMs === null) timeToLockMs = decision.timeMs
        }
        previousSlide = decision.slideIndex
    })

    const latencies = cueScores.map((c) => c.latencyMs).filter((l): l is number => l !== null)

    return {
        coveragePct: countedBlocks ? Math.round((correctBlocks / countedBlocks) * 1000) / 10 : 0,
        cueScores,
        hitCues: cueScores.filter((c) => c.firedMs !== null).length,
        missedCues: cueScores.filter((c) => c.firedMs === null).length,
        falseAdvances: unclaimed.size,
        backwardJumps,
        timeToLockMs,
        medianLatencyMs: median(latencies),
        p90AbsLatencyMs: percentile(latencies.map(Math.abs), 90),
        meanConfidenceCorrect: mean(correctConfidences),
        meanConfidenceWrong: mean(wrongConfidences)
    }
}

export function formatScore(s: Score): string {
    const latency = s.medianLatencyMs === null ? "—" : `${s.medianLatencyMs > 0 ? "+" : ""}${s.medianLatencyMs}ms`
    const p90 = s.p90AbsLatencyMs === null ? "—" : `${s.p90AbsLatencyMs}ms`
    const lock = s.timeToLockMs === null ? "never" : `${(s.timeToLockMs / 1000).toFixed(1)}s`

    return [`coverage ${s.coveragePct}%`, `cues ${s.hitCues}/${s.hitCues + s.missedCues}`, `false ${s.falseAdvances}`, `back ${s.backwardJumps}`, `lat ${latency} (p90 ${p90})`, `lock ${lock}`, `conf ok/bad ${s.meanConfidenceCorrect ?? "—"}/${s.meanConfidenceWrong ?? "—"}`].join("  ")
}

export function decisionSummary(decisions: Decision[]): string {
    return decisions.map((d) => `${(d.timeMs / 1000).toFixed(1)}s->${d.slideIndex}(${d.confidence}%)`).join(" ")
}
