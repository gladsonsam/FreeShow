// Online song-position tracker ("score follower").
//
// Given a learned reference timeline (chroma frames + slide-change marks from a previous
// performance), this tracks WHERE IN THE SONG the live audio currently is, one frame at a
// time, using a hidden-Markov forward pass over reference positions:
//
//   - transitions allow pausing and 0-3x local tempo (the band never plays exactly like
//     last week), plus a tiny probability of jumping to any section start (extra chorus,
//     skipped bridge, spontaneous repeats)
//   - emissions compare live vs reference chroma (harmony), falling back to
//     quiet/loud agreement when either side has no signal
//   - the posterior is summarised as a position + confidence (probability mass
//     concentrated around the tracked position) + acoustic match quality
//
// Pure TypeScript, no DOM/store dependencies — unit-tested with synthetic,
// time-warped feature sequences.

import { CHROMA_DIM, LOW_ENERGY } from "./chromaFeatures"
import { cosineSimilarity } from "./dsp"
import type { SongMark } from "./songMap"

export interface FollowerReference {
    fps: number
    frameCount: number
    chroma: Float32Array // CHROMA_DIM * frameCount (values 0..1)
    energy: Float32Array // frameCount (values 0..1)
    marks: SongMark[]
}

export interface FollowerUpdate {
    position: number // tracked reference frame
    slideIndex: number // slide live at the tracked position
    confidence: number // 0..1 posterior mass within ±2.5s of the position
    quality: number // 0..1 recent acoustic similarity at the tracked position
}

// local tempo model: stay / 1x / 2x / 3x reference speed per frame
const T_STAY = 0.1
const T_1 = 0.68
const T_2 = 0.19
const T_3 = 0.03
// probability of a structural jump (repeat/skip) per frame, spread over section starts
const JUMP_EPS = 0.002
// emission sharpness: weight = exp(BETA * (similarity - 1))
const BETA = 7
const CONF_WINDOW_SEC = 2.5
const QUALITY_EMA = 0.25

export class SongFollower {
    private ref: FollowerReference
    private p: Float64Array
    private scratch: Float64Array
    private prefix: Float64Array
    private jumpFrames: number[]
    private _quality = 0.5
    private _position = 0

    constructor(ref: FollowerReference) {
        this.ref = ref
        this.p = new Float64Array(ref.frameCount)
        this.scratch = new Float64Array(ref.frameCount)
        this.prefix = new Float64Array(ref.frameCount + 1)
        // structural jump targets: song start + every slide mark
        const targets = new Set<number>([0])
        for (const m of ref.marks) targets.add(Math.min(ref.frameCount - 1, Math.max(0, m.frame)))
        this.jumpFrames = [...targets].sort((a, b) => a - b)
        this.anchorFrame(0)
    }

    get position() {
        return this._position
    }

    // Concentrate the posterior around a reference frame (soft: some spread + uniform floor)
    private anchorFrame(frame: number) {
        const sigma = this.ref.fps * 2
        const uniform = 0.1 / this.ref.frameCount
        let sum = 0
        for (let i = 0; i < this.ref.frameCount; i++) {
            const d = (i - frame) / sigma
            this.p[i] = Math.exp(-0.5 * d * d) + uniform
            sum += this.p[i]
        }
        for (let i = 0; i < this.ref.frameCount; i++) this.p[i] /= sum
        this._position = frame
        this._quality = 0.5
    }

    // The operator navigated manually — they know where the song is; re-lock to that slide.
    // If the slide appears multiple times (chorus), pick the occurrence nearest the current position.
    anchorToSlide(slideIndex: number) {
        const occurrences = this.ref.marks.filter((m) => m.slideIndex === slideIndex)
        if (!occurrences.length) return
        let best = occurrences[0]
        for (const m of occurrences) {
            if (Math.abs(m.frame - this._position) < Math.abs(best.frame - this._position)) best = m
        }
        this.anchorFrame(best.frame)
    }

    slideAt(frame: number): number {
        const marks = this.ref.marks
        let slide = marks.length ? marks[0].slideIndex : 0
        for (const m of marks) {
            if (m.frame > frame) break
            slide = m.slideIndex
        }
        return slide
    }

    step(chroma: Float32Array, energy: number): FollowerUpdate {
        const n = this.ref.frameCount
        const p = this.p
        const next = this.scratch

        // ---- transition ----
        for (let i = 0; i < n; i++) {
            let v = T_STAY * p[i]
            if (i >= 1) v += T_1 * p[i - 1]
            if (i >= 2) v += T_2 * p[i - 2]
            if (i >= 3) v += T_3 * p[i - 3]
            next[i] = v
        }
        // structural jumps
        const jumpShare = JUMP_EPS / this.jumpFrames.length
        for (let i = 0; i < n; i++) next[i] *= 1 - JUMP_EPS
        for (const f of this.jumpFrames) next[f] += jumpShare

        // ---- emission ----
        const liveQuiet = energy < LOW_ENERGY
        let sum = 0
        for (let i = 0; i < n; i++) {
            const refQuiet = this.ref.energy[i] < LOW_ENERGY
            let sim: number
            if (liveQuiet && refQuiet) sim = 0.75
            else if (liveQuiet !== refQuiet) sim = liveQuiet ? 0.45 : 0.35
            else sim = this.chromaSim(chroma, i)
            next[i] *= Math.exp(BETA * (sim - 1))
            sum += next[i]
        }

        // normalise (guard against total underflow)
        if (sum < 1e-300) {
            const uniform = 1 / n
            for (let i = 0; i < n; i++) next[i] = uniform
        } else {
            for (let i = 0; i < n; i++) next[i] /= sum
        }
        this.p.set(next)

        // ---- summarise: window with the most probability mass ----
        const w = Math.round(this.ref.fps * CONF_WINDOW_SEC)
        const prefix = this.prefix
        prefix[0] = 0
        for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + p[i]

        let bestMass = -1
        let bestIndex = 0
        for (let i = 0; i < n; i++) {
            const lo = Math.max(0, i - w)
            const hi = Math.min(n, i + w + 1)
            const mass = prefix[hi] - prefix[lo]
            if (mass > bestMass) {
                bestMass = mass
                bestIndex = i
            }
        }
        // refine: probability-weighted mean inside the winning window
        {
            const lo = Math.max(0, bestIndex - w)
            const hi = Math.min(n, bestIndex + w + 1)
            let weighted = 0
            for (let i = lo; i < hi; i++) weighted += i * p[i]
            if (bestMass > 1e-12) bestIndex = Math.round(weighted / bestMass)
        }
        this._position = bestIndex

        // acoustic quality at the tracked position (skip while the live signal is quiet)
        if (!liveQuiet && this.ref.energy[bestIndex] >= LOW_ENERGY) {
            const sim = this.chromaSim(chroma, bestIndex)
            this._quality = this._quality * (1 - QUALITY_EMA) + sim * QUALITY_EMA
        }

        return {
            position: bestIndex,
            slideIndex: this.slideAt(bestIndex),
            confidence: Math.max(0, Math.min(1, bestMass)),
            quality: this._quality
        }
    }

    private chromaSim(live: Float32Array, refFrame: number): number {
        const offset = refFrame * CHROMA_DIM
        let dot = 0
        let na = 0
        let nb = 0
        for (let d = 0; d < CHROMA_DIM; d++) {
            const a = live[d]
            const b = this.ref.chroma[offset + d]
            dot += a * b
            na += a * a
            nb += b * b
        }
        const denom = Math.sqrt(na) * Math.sqrt(nb)
        return denom > 0 ? dot / denom : 0
    }
}

// re-export for engine code that works with follower updates
export { cosineSimilarity }
