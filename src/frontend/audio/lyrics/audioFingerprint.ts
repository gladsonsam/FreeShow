// Spectral fingerprinting — represents an audio window as three complementary descriptors:
//   shape   — L2-normalised mean sub-band energies (spectral shape, energy-invariant)
//   texture — L2-normalised variance of sub-band energies (how "busy" each band is over time)
//   logRms  — log10 of RMS amplitude (absolute energy level)
//
// Using all three lets the matcher distinguish sections that have the same spectral shape
// (same chords, same instruments) but different energy or rhythmic density — which is the
// typical verse-vs-chorus situation in worship music.

const FFT_SIZE = 2048
const NUM_BANDS = 32
const MIN_BIN = 10   // ~80 Hz  at 16 kHz / 2048
const MAX_BIN = 900  // ~7031 Hz

const HANN = new Float32Array(FFT_SIZE)
for (let i = 0; i < FFT_SIZE; i++) HANN[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)))

const BAND_BINS: number[] = []
for (let i = 0; i <= NUM_BANDS; i++) {
    BAND_BINS.push(Math.round(MIN_BIN * Math.pow(MAX_BIN / MIN_BIN, i / NUM_BANDS)))
}

export interface Fingerprint {
    shape: Float32Array   // L2-normalised mean per-band energy (32 dims)
    texture: Float32Array // L2-normalised variance per-band energy (32 dims)
    logRms: number        // log10(rms), typically -3 to 0
}

function l2normalise(v: Float32Array): Float32Array {
    let norm = 0
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i]
    norm = Math.sqrt(norm)
    if (norm < 1e-9) return v
    const out = new Float32Array(v.length)
    for (let i = 0; i < v.length; i++) out[i] = v[i] / norm
    return out
}

function fft(re: Float32Array, im: Float32Array): void {
    const n = re.length
    let j = 0
    for (let i = 1; i < n; i++) {
        let bit = n >> 1
        for (; j & bit; bit >>= 1) j ^= bit
        j ^= bit
        if (i < j) {
            const tr = re[i]; re[i] = re[j]; re[j] = tr
            const ti = im[i]; im[i] = im[j]; im[j] = ti
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len
        const wRe = Math.cos(ang)
        const wIm = Math.sin(ang)
        for (let i = 0; i < n; i += len) {
            let curRe = 1, curIm = 0
            const half = len >> 1
            for (let k = 0; k < half; k++) {
                const uRe = re[i + k], uIm = im[i + k]
                const vRe = re[i + k + half] * curRe - im[i + k + half] * curIm
                const vIm = re[i + k + half] * curIm + im[i + k + half] * curRe
                re[i + k] = uRe + vRe; im[i + k] = uIm + vIm
                re[i + k + half] = uRe - vRe; im[i + k + half] = uIm - vIm
                const nr = curRe * wRe - curIm * wIm
                curIm = curRe * wIm + curIm * wRe
                curRe = nr
            }
        }
    }
}

function frameBandEnergies(pcm: Float32Array, offset: number): Float32Array | null {
    const re = new Float32Array(FFT_SIZE)
    const im = new Float32Array(FFT_SIZE)
    const end = Math.min(offset + FFT_SIZE, pcm.length)
    let energy = 0
    for (let i = 0; i < end - offset; i++) {
        re[i] = pcm[offset + i] * HANN[i]
        energy += re[i] * re[i]
    }
    if (energy < 1e-8) return null  // silent frame — skip
    fft(re, im)
    const bands = new Float32Array(NUM_BANDS)
    for (let b = 0; b < NUM_BANDS; b++) {
        let sum = 0
        for (let k = BAND_BINS[b]; k < BAND_BINS[b + 1]; k++) sum += re[k] * re[k] + im[k] * im[k]
        bands[b] = sum / Math.max(1, BAND_BINS[b + 1] - BAND_BINS[b])
    }
    return bands
}

// Compute fingerprint from a PCM window.
// Uses only the most recent half of the window to reduce boundary blur
// (a 4-second chunk from the chunker gives effectively a 2-second fingerprint
//  of the most recent audio, with a 1-second hop).
export function computeFingerprint(pcm: Float32Array): Fingerprint | null {
    // Use the second half so the fingerprint reflects current audio, not 4s-ago audio
    const slice = pcm.subarray(Math.floor(pcm.length / 2))
    const hop = FFT_SIZE >> 1

    const frameList: Float32Array[] = []
    for (let offset = 0; offset + FFT_SIZE <= slice.length; offset += hop) {
        const f = frameBandEnergies(slice, offset)
        if (f) frameList.push(f)
    }
    if (frameList.length < 2) return null

    // Mean and variance per band
    const means = new Float32Array(NUM_BANDS)
    const m2 = new Float32Array(NUM_BANDS)  // running M2 for Welford variance

    for (let n = 0; n < frameList.length; n++) {
        for (let b = 0; b < NUM_BANDS; b++) {
            const delta = frameList[n][b] - means[b]
            means[b] += delta / (n + 1)
            m2[b] += delta * (frameList[n][b] - means[b])
        }
    }
    const variances = new Float32Array(NUM_BANDS)
    for (let b = 0; b < NUM_BANDS; b++) variances[b] = m2[b] / frameList.length

    // Overall RMS of the slice
    let sumSq = 0
    for (let i = 0; i < slice.length; i++) sumSq += slice[i] * slice[i]
    const rms = Math.sqrt(sumSq / slice.length)
    const logRms = Math.log10(rms + 1e-9)

    return {
        shape: l2normalise(means),
        texture: l2normalise(variances),
        logRms
    }
}

export function combinedSimilarity(a: { shape: ArrayLike<number>; texture: ArrayLike<number>; logRms: number }, b: { shape: ArrayLike<number>; texture: ArrayLike<number>; logRms: number }): number {
    const shapeSim = cosineSimilarity(a.shape, b.shape)
    const textureSim = cosineSimilarity(a.texture, b.texture)
    // Energy similarity: 3 log10 units apart → 0; same energy → 1
    const rmsSim = Math.max(0, 1 - Math.abs(a.logRms - b.logRms) / 3)
    return 0.35 * shapeSim + 0.45 * textureSim + 0.20 * rmsSim
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i]
        na += a[i] * a[i]
        nb += b[i] * b[i]
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb)
    return denom > 0 ? dot / denom : 0
}
