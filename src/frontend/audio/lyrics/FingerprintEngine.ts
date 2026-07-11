// Ties fingerprint computation, learning, and matching together.
//
// Learning: whenever the operator changes slides, the fingerprints collected during
// the stable middle of that slide (after LEARN_DEBOUNCE_MS) are stored. Multiple
// passes through the same section build up to MAX_SAMPLES examples.
//
// Matching: each chunk is fingerprinted and compared against all stored examples
// using nearest-neighbour (not average). A decaying confidence accumulator smooths
// over transient mismatches without adding latency for clean matches.

import { computeFingerprint } from "./audioFingerprint"
import type { Fingerprint } from "./audioFingerprint"
import { fingerprintDB } from "./FingerprintDB"

const LEARN_DEBOUNCE_MS = 2000   // skip the first 2s of a slide (transition audio)
const BUFFER_SLOTS = 10          // ~10 seconds of fingerprint history
const MATCH_THRESHOLD = 60       // combined similarity * 100 to consider a candidate
const COOLDOWN_MS = 4000         // suppress decisions for this long after navigation
const CONFIDENCE_DECAY = 0.6     // multiply accumulated confidence by this each frame (no match)
const CONFIDENCE_FIRE = 1.8      // fire when accumulated confidence exceeds this

interface Buffered {
    fp: Fingerprint
    ts: number
}

export interface FingerprintDecision {
    showId: string
    slideIndex: number
    confidence: number
}

export class FingerprintEngine {
    private showId = ""
    private currentSlideIndex = -1
    private slideStartTs = 0
    private buffer: Buffered[] = []
    private cooldownUntil = 0
    private _learnedCount = 0

    // Accumulated confidence per candidate slide (decays when not matched)
    private accumulated: Record<number, number> = {}

    private decisionCb: ((d: FingerprintDecision) => void) | null = null
    private scoreCb: ((score: number) => void) | null = null

    onDecision(cb: (d: FingerprintDecision) => void) {
        this.decisionCb = cb
    }

    onScore(cb: (score: number) => void) {
        this.scoreCb = cb
    }

    notifySlide(showId: string, slideIndex: number, now: number) {
        // Learn from the slide we're leaving
        if (this.showId && this.currentSlideIndex >= 0) {
            const eligible = this.buffer.filter((b) => b.ts > this.slideStartTs + LEARN_DEBOUNCE_MS)
            for (const b of eligible) {
                fingerprintDB.add(this.showId, this.currentSlideIndex, b.fp)
            }
            this._learnedCount = fingerprintDB.countSlides(this.showId)
        }

        this.showId = showId
        this.currentSlideIndex = slideIndex
        this.slideStartTs = now
        this.accumulated = {}
        this.cooldownUntil = now + COOLDOWN_MS
    }

    handleChunk(pcm: Float32Array, now: number) {
        const fp = computeFingerprint(pcm)
        if (!fp) return

        this.buffer.push({ fp, ts: now })
        if (this.buffer.length > BUFFER_SLOTS) this.buffer.shift()

        if (!this.showId || now < this.cooldownUntil) return

        const match = fingerprintDB.match(this.showId, fp)

        // Decay all accumulated scores each frame
        for (const k of Object.keys(this.accumulated)) {
            this.accumulated[Number(k)] *= CONFIDENCE_DECAY
        }

        this.scoreCb?.(match?.confidence ?? 0)

        if (match && match.confidence >= MATCH_THRESHOLD && match.slideIndex !== this.currentSlideIndex) {
            // Boost the candidate's accumulated score by normalised confidence
            const boost = match.confidence / 100
            this.accumulated[match.slideIndex] = (this.accumulated[match.slideIndex] || 0) + boost
        }

        // Check if any candidate has crossed the fire threshold
        let bestSlide = -1
        let bestAcc = CONFIDENCE_FIRE
        for (const [idxStr, acc] of Object.entries(this.accumulated)) {
            if (acc > bestAcc) {
                bestAcc = acc
                bestSlide = Number(idxStr)
            }
        }

        if (bestSlide >= 0) {
            const confidence = Math.min(100, Math.round((bestAcc / CONFIDENCE_FIRE) * (match?.confidence ?? 70)))
            this.decisionCb?.({ showId: this.showId, slideIndex: bestSlide, confidence })
            this.accumulated = {}
            this.cooldownUntil = now + COOLDOWN_MS
        }
    }

    get learnedCount() {
        return this._learnedCount
    }

    clearCurrentShow() {
        if (this.showId) {
            fingerprintDB.clear(this.showId)
            this._learnedCount = 0
        }
    }

    reset() {
        this.buffer = []
        this.accumulated = {}
        this.slideStartTs = 0
        this.cooldownUntil = 0
        this._learnedCount = this.showId ? fingerprintDB.countSlides(this.showId) : 0
    }
}
