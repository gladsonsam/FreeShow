// Small shared DSP helpers for the auto-lyrics audio pipeline.

// In-place radix-2 FFT (re/im must be power-of-two length)
export function fft(re: Float32Array, im: Float32Array): void {
    const n = re.length
    let j = 0
    for (let i = 1; i < n; i++) {
        let bit = n >> 1
        for (; j & bit; bit >>= 1) j ^= bit
        j ^= bit
        if (i < j) {
            const tr = re[i]
            re[i] = re[j]
            re[j] = tr
            const ti = im[i]
            im[i] = im[j]
            im[j] = ti
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len
        const wRe = Math.cos(ang)
        const wIm = Math.sin(ang)
        for (let i = 0; i < n; i += len) {
            let curRe = 1
            let curIm = 0
            const half = len >> 1
            for (let k = 0; k < half; k++) {
                const uRe = re[i + k]
                const uIm = im[i + k]
                const vRe = re[i + k + half] * curRe - im[i + k + half] * curIm
                const vIm = re[i + k + half] * curIm + im[i + k + half] * curRe
                re[i + k] = uRe + vRe
                im[i + k] = uIm + vIm
                re[i + k + half] = uRe - vRe
                im[i + k + half] = uIm - vIm
                const nr = curRe * wRe - curIm * wIm
                curIm = curRe * wIm + curIm * wRe
                curRe = nr
            }
        }
    }
}

export function hannWindow(size: number): Float32Array {
    const w = new Float32Array(size)
    for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)))
    return w
}

export function l2Normalize(v: Float32Array): Float32Array {
    let norm = 0
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i]
    norm = Math.sqrt(norm)
    if (norm < 1e-9) return v
    for (let i = 0; i < v.length; i++) v[i] /= norm
    return v
}

// Cosine similarity for unit-normalised vectors reduces to a dot product,
// but stay safe for non-normalised input.
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i]
        na += a[i] * a[i]
        nb += b[i] * b[i]
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb)
    return denom > 0 ? dot / denom : 0
}
