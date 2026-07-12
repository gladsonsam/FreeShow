// Streaming chroma (pitch-class energy) extraction — the acoustic feature the song
// follower learns and tracks. Chroma describes *harmony* (which notes are sounding),
// which stays stable between performances of the same song even when the mix, key
// voicing intensity, or vocalist changes — unlike raw spectra.
//
// Input: mono PCM blocks at 16 kHz (from the mic capture).
// Output: one smoothed 12-dim unit chroma vector + relative energy every 100 ms.

import { fft, hannWindow, l2Normalize } from "./dsp"

export const CHROMA_FPS = 10
export const CHROMA_DIM = 12
// Frames below this relative energy are treated as "quiet" by the learner/follower
export const LOW_ENERGY = 0.06

const SAMPLE_RATE = 16000
const HOP = SAMPLE_RATE / CHROMA_FPS // 1600 samples = 100 ms
const FFT_SIZE = 4096 // ~3.9 Hz/bin: enough to resolve semitones from ~80 Hz up
const MIN_FREQ = 60
const MAX_FREQ = 4200
const SMOOTH_FRAMES = 5 // output = mean of last 0.5s (CENS-like robustness)
// Running mic-level reference half-life, in frames (~10 min): adapts to FOH send level
const ENERGY_DECAY = Math.pow(0.5, 1 / (CHROMA_FPS * 600))

const HANN = hannWindow(FFT_SIZE)

// Precomputed FFT-bin -> pitch-class mapping (-1 = outside the analysed range)
const BIN_PITCH_CLASS: Int8Array = (() => {
    const table = new Int8Array(FFT_SIZE / 2).fill(-1)
    for (let k = 1; k < FFT_SIZE / 2; k++) {
        const freq = (k * SAMPLE_RATE) / FFT_SIZE
        if (freq < MIN_FREQ || freq > MAX_FREQ) continue
        const midi = Math.round(69 + 12 * Math.log2(freq / 440))
        table[k] = ((midi % 12) + 12) % 12
    }
    return table
})()

export interface ChromaFrame {
    chroma: Float32Array // 12-dim, unit length (all zeros when silent)
    energy: number // 0..1, relative to the recent loudest level
}

export class ChromaExtractor {
    // ring buffer of the last FFT_SIZE samples (writePos = oldest sample once filled)
    private ring = new Float32Array(FFT_SIZE)
    private writePos = 0
    private filled = 0
    private sinceHop = 0
    private hopSumSq = 0
    private runningMax = 1e-4
    private recent: Float32Array[] = []
    // reused FFT scratch buffers (one frame every 100 ms — avoid re-allocating)
    private re = new Float32Array(FFT_SIZE)
    private im = new Float32Array(FFT_SIZE)

    // Feed a PCM block (any length); returns 0..n completed frames
    push(block: Float32Array): ChromaFrame[] {
        const frames: ChromaFrame[] = []

        for (let i = 0; i < block.length; i++) {
            this.ring[this.writePos] = block[i]
            this.writePos = (this.writePos + 1) % FFT_SIZE
            if (this.filled < FFT_SIZE) this.filled++
            this.hopSumSq += block[i] * block[i]
            this.sinceHop++

            if (this.sinceHop < HOP) continue
            this.sinceHop = 0

            const rms = Math.sqrt(this.hopSumSq / HOP)
            this.hopSumSq = 0

            if (this.filled < FFT_SIZE) continue // still warming up (first 0.25s)

            this.runningMax = Math.max(this.runningMax * ENERGY_DECAY, rms, 1e-4)
            const energy = Math.min(1, rms / this.runningMax)
            frames.push(this.computeFrame(energy))
        }

        return frames
    }

    private computeFrame(energy: number): ChromaFrame {
        const re = this.re
        const im = this.im
        im.fill(0)
        // unroll the ring into chronological order, windowed
        for (let i = 0; i < FFT_SIZE; i++) re[i] = this.ring[(this.writePos + i) % FFT_SIZE] * HANN[i]
        fft(re, im)

        const raw = new Float32Array(CHROMA_DIM)
        let total = 0
        for (let k = 1; k < FFT_SIZE / 2; k++) {
            const pc = BIN_PITCH_CLASS[k]
            if (pc < 0) continue
            const mag2 = re[k] * re[k] + im[k] * im[k]
            raw[pc] += mag2
            total += mag2
        }

        // relative distribution + log compression, so loudness doesn't matter
        if (total > 1e-12) {
            for (let p = 0; p < CHROMA_DIM; p++) raw[p] = Math.log1p((1000 * raw[p]) / total)
        }
        l2Normalize(raw)

        // temporal smoothing over the last SMOOTH_FRAMES frames
        this.recent.push(raw)
        if (this.recent.length > SMOOTH_FRAMES) this.recent.shift()
        const smooth = new Float32Array(CHROMA_DIM)
        for (const f of this.recent) for (let p = 0; p < CHROMA_DIM; p++) smooth[p] += f[p]
        l2Normalize(smooth)

        return { chroma: smooth, energy }
    }

    reset() {
        this.filled = 0
        this.sinceHop = 0
        this.hopSumSq = 0
        this.recent = []
        // keep runningMax: mic level is a property of the setup, not the song
    }
}
