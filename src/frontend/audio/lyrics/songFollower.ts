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
const JUMP_EPS = 0.0002
// emission sharpness: weight = exp(BETA * (similarity - 1))
const BETA = 7
const CONF_WINDOW_SEC = 2.5
const QUALITY_EMA = 0.25
const KEY_SEARCH_FRAMES = 2
const KEY_MIN_FRAMES = 20 // earliest lock: 20 *voted* frames, not just 20 elapsed frames
const KEY_MAX_FRAMES = 400 // fallback lock after substantial tonal evidence — early confusion (quiet intro + room noise) must not cement a wrong key
const KEY_MARGIN = 0.01
// A frame only votes for a key when one shift explains the audio clearly better than
// every other: broadband noise matches all shifts almost equally, so those frames
// abstain instead of casting random votes. Calibrated on a quiet-intro song under
// 10 dB pink noise: correct-position frames vote ~75% for the true shift, while
// wrong-position frames mostly abstain and otherwise scatter.
const KEY_VOTE_MIN_SIM = 0.9
const KEY_VOTE_MIN_MARGIN = 0.06
// After locking, keep a sliding window of recent votes. If a different shift dominates
// it, the lock was wrong (e.g. taken during early confusion) — switch instead of
// staying confidently lost forever. Votes here still only come from clear frames, so
// diffuse/noisy stretches pause revalidation rather than triggering flips.
const KEY_REVALIDATE_WINDOW = 100
const KEY_REVALIDATE_FLIP = 60

export class SongFollower {
    private ref: FollowerReference
    private p: Float64Array
    private scratch: Float64Array
    private prefix: Float64Array
    private jumpFrames: number[]
    private _quality = 0.5
    private _position = 0
    private pitchShift = 0
    private keyFrames = 0
    private keyLocked = false
    private keyEvidence = new Float64Array(CHROMA_DIM)
    private keyScores = new Float64Array(CHROMA_DIM)
    private refInvNorm: Float64Array
    private keyRecent: number[] = []

    constructor(ref: FollowerReference) {
        this.ref = ref
        this.p = new Float64Array(ref.frameCount)
        this.scratch = new Float64Array(ref.frameCount)
        this.prefix = new Float64Array(ref.frameCount + 1)
        // inverse chroma norms for posterior-weighted key voting (0 for silent frames)
        this.refInvNorm = new Float64Array(ref.frameCount)
        for (let i = 0; i < ref.frameCount; i++) {
            let n = 0
            const off = i * CHROMA_DIM
            for (let d = 0; d < CHROMA_DIM; d++) n += ref.chroma[off + d] * ref.chroma[off + d]
            this.refInvNorm[i] = n > 0 ? 1 / Math.sqrt(n) : 0
        }
        // structural jump targets: song start + every slide mark
        const targets = new Set<number>([0])
        for (const m of ref.marks) targets.add(Math.min(ref.frameCount - 1, Math.max(0, m.frame)))
        this.jumpFrames = [...targets].sort((a, b) => a - b)
        this.anchorFrame(0)
    }

    get position() {
        return this._position
    }

    get keyShift() {
        return this.pitchShift > CHROMA_DIM / 2 ? this.pitchShift - CHROMA_DIM : this.pitchShift
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

        // Estimate one global key shift for the performance. Until the key locks, the
        // position tracker marginalises over keys (best shift per position) instead of
        // committing to a provisional guess: a wrong early guess would steer the
        // posterior somewhere wrong, and votes taken there would then "confirm" the
        // wrong key — a feedback loop that locked tritones within seconds on quiet
        // intros. Key votes are scored against the whole reference weighted by the
        // position posterior (soft voting): when lost or diffuse no shift wins clearly
        // and the frame abstains. Both cost ~12x a single cosine per reference frame
        // but only run until the key locks. After locking, a cheap point check keeps
        // validating and can still overturn a wrong lock (keyRecent window).
        if (energy >= LOW_ENERGY) this.updatePitchShift(chroma)

        // ---- transition ----
        for (let i = 0; i < n; i++) {
            let v = T_STAY * p[i]
            if (i >= 1) v += T_1 * p[i - 1]
            if (i >= 2) v += T_2 * p[i - 2]
            if (i >= 3) v += T_3 * p[i - 3]
            next[i] = v
        }
        // Clamp steps that would run beyond the reference onto its final frame. Without
        // this absorbing edge, probability leaks away during a long outro and the tiny
        // structural-jump prior eventually sends the tracker back into the song.
        next[n - 1] += (T_1 + T_2 + T_3) * p[n - 1]
        if (n > 1) next[n - 1] += (T_2 + T_3) * p[n - 2]
        if (n > 2) next[n - 1] += T_3 * p[n - 3]
        // structural jumps
        const jumpShare = JUMP_EPS / this.jumpFrames.length
        for (let i = 0; i < n; i++) next[i] *= 1 - JUMP_EPS
        for (const f of this.jumpFrames) next[f] += jumpShare

        // ---- emission ----
        // Pre-lock the key is unknown, so each position scores its best shift
        // (marginalising over keys). Post-lock positions score the locked shift.
        const liveQuiet = energy < LOW_ENERGY
        const keyKnown = this.keyLocked
        let sum = 0
        for (let i = 0; i < n; i++) {
            const refQuiet = this.ref.energy[i] < LOW_ENERGY
            let sim: number
            if (liveQuiet && refQuiet) sim = 0.75
            else if (liveQuiet !== refQuiet) sim = liveQuiet ? 0.45 : 0.35
            else sim = keyKnown ? this.chromaSim(chroma, i) : this.maxChromaSim(chroma, i)
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

        // acoustic quality at the tracked position (skip while the live signal is quiet).
        // Pre-lock the key is unknown, so quality is also key-agnostic (best shift).
        if (!liveQuiet && this.ref.energy[bestIndex] >= LOW_ENERGY) {
            const sim = this.keyLocked ? this.chromaSim(chroma, bestIndex) : this.maxChromaSim(chroma, bestIndex)
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
        return this.chromaSimAtShift(live, refFrame, this.pitchShift)
    }

    // Best transposition at one reference frame — the key-marginalised match used
    // while the performance key is still unknown.
    private maxChromaSim(live: Float32Array, refFrame: number): number {
        let best = 0
        for (let shift = 0; shift < CHROMA_DIM; shift++) {
            const sim = this.chromaSimAtShift(live, refFrame, shift)
            if (sim > best) best = sim
        }
        return best
    }

    private chromaSimAtShift(live: Float32Array, refFrame: number, shift: number): number {
        const offset = refFrame * CHROMA_DIM
        let dot = 0
        let na = 0
        let nb = 0
        for (let d = 0; d < CHROMA_DIM; d++) {
            const a = live[(d + shift) % CHROMA_DIM]
            const b = this.ref.chroma[offset + d]
            dot += a * b
            na += a * a
            nb += b * b
        }
        const denom = Math.sqrt(na) * Math.sqrt(nb)
        return denom > 0 ? dot / denom : 0
    }

    private updatePitchShift(live: Float32Array) {
        if (!this.keyLocked) {
            this.voteKeySoft(live)
            return
        }
        this.voteKeyRevalidate(live)
    }

    // Pre-lock: score every shift against the full reference, weighted by where the
    // tracker currently believes the song is. A diffuse posterior spreads weight
    // everywhere so nothing wins clearly (abstain); a concentrated one votes
    // decisively for the shift that matches there.
    private voteKeySoft(live: Float32Array) {
        let na = 0
        for (let d = 0; d < CHROMA_DIM; d++) na += live[d] * live[d]
        if (na <= 0) return
        const invNa = 1 / Math.sqrt(na)

        const scores = this.keyScores.fill(0)
        let weight = 0
        for (let i = 0; i < this.ref.frameCount; i++) {
            if (this.ref.energy[i] < LOW_ENERGY) continue
            const w = this.p[i]
            if (w <= 0) continue
            const invNb = this.refInvNorm[i]
            if (invNb === 0) continue
            weight += w
            const scale = w * invNa * invNb
            const off = i * CHROMA_DIM
            for (let shift = 0; shift < CHROMA_DIM; shift++) {
                let dot = 0
                for (let d = 0; d < CHROMA_DIM; d++) dot += live[(d + shift) % CHROMA_DIM] * this.ref.chroma[off + d]
                scores[shift] += scale * dot
            }
        }
        if (weight <= 0) return
        for (let shift = 0; shift < CHROMA_DIM; shift++) scores[shift] /= weight

        let best = 0
        let bestScore = -Infinity
        let secondScore = -Infinity
        for (let shift = 0; shift < CHROMA_DIM; shift++) {
            const s = scores[shift]
            if (s > bestScore) {
                secondScore = bestScore
                bestScore = s
                best = shift
            } else if (s > secondScore) {
                secondScore = s
            }
        }

        // Unclear frame (noise matches every shift alike, or nothing matches well):
        // abstain. Random votes from confused frames are what used to lock a wrong
        // key (e.g. tritone +6) within seconds on quiet intros under room noise.
        if (bestScore < KEY_VOTE_MIN_SIM || bestScore - secondScore < KEY_VOTE_MIN_MARGIN) return

        this.keyEvidence[best] += bestScore
        this.keyFrames++

        this.electProvisionalKey()
        if (this.keyFrames < KEY_MIN_FRAMES) return

        const margin = (this.keyEvidence[this.pitchShift] - this.secondEvidence()) / this.keyFrames
        if (margin >= KEY_MARGIN || this.keyFrames >= KEY_MAX_FRAMES) {
            this.keyLocked = true
        }
    }

    // Use the best provisional shift immediately so a transposed performance does
    // not push the position posterior off course while calibration accumulates.
    private electProvisionalKey() {
        let bestShift = 0
        for (let shift = 1; shift < CHROMA_DIM; shift++) {
            if (this.keyEvidence[shift] > this.keyEvidence[bestShift]) bestShift = shift
        }
        this.pitchShift = bestShift
    }

    private secondEvidence(): number {
        let second = -Infinity
        for (let shift = 0; shift < CHROMA_DIM; shift++) {
            if (shift !== this.pitchShift) second = Math.max(second, this.keyEvidence[shift])
        }
        return second
    }

    // Post-lock: cheap point check near the tracked position. Votes still only come
    // from clear frames, so diffuse/noisy stretches pause revalidation instead of
    // triggering flips. A sustained run of clear votes against the locked shift
    // means the lock was taken while lost — flip to the better shift.
    private voteKeyRevalidate(live: Float32Array) {
        const lo = Math.max(0, this._position - KEY_SEARCH_FRAMES)
        const hi = Math.min(this.ref.frameCount - 1, this._position + KEY_SEARCH_FRAMES)

        let hasReferenceSignal = false
        for (let frame = lo; frame <= hi; frame++) {
            if (this.ref.energy[frame] >= LOW_ENERGY) {
                hasReferenceSignal = true
                break
            }
        }
        if (!hasReferenceSignal) return

        let best = 0
        let bestSim = -Infinity
        let secondSim = -Infinity
        for (let shift = 0; shift < CHROMA_DIM; shift++) {
            let sim = 0
            for (let frame = lo; frame <= hi; frame++) {
                if (this.ref.energy[frame] < LOW_ENERGY) continue
                sim = Math.max(sim, this.chromaSimAtShift(live, frame, shift))
            }
            if (sim > bestSim) {
                secondSim = bestSim
                bestSim = sim
                best = shift
            } else if (sim > secondSim) {
                secondSim = sim
            }
        }

        if (bestSim < KEY_VOTE_MIN_SIM || bestSim - secondSim < KEY_VOTE_MIN_MARGIN) return

        this.keyRecent.push(best)
        if (this.keyRecent.length > KEY_REVALIDATE_WINDOW) this.keyRecent.shift()
        if (this.keyRecent.length < KEY_REVALIDATE_WINDOW) return

        const counts = new Array<number>(CHROMA_DIM).fill(0)
        for (const vote of this.keyRecent) counts[vote]++
        let challenger = -1
        for (let shift = 0; shift < CHROMA_DIM; shift++) {
            if (shift !== this.pitchShift && counts[shift] >= KEY_REVALIDATE_FLIP) challenger = shift
        }
        if (challenger < 0) return

        this.pitchShift = challenger
        this.keyEvidence.fill(0)
        this.keyEvidence[challenger] = KEY_REVALIDATE_FLIP
        this.keyFrames = KEY_REVALIDATE_FLIP
        this.keyRecent = []
    }
}

// re-export for engine code that works with follower updates
export { cosineSimilarity }
