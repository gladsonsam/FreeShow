// Stores and retrieves spectral fingerprints per show slide.
// Persists to localStorage so fingerprints survive between sessions.

import { combinedSimilarity } from "./audioFingerprint"
import type { Fingerprint } from "./audioFingerprint"

const STORAGE_PREFIX = "fs_fp2_"  // fp2 to avoid collisions with old fp_ format
const MAX_SAMPLES = 15

export interface FingerprintMatch {
    slideIndex: number
    confidence: number // 0–100
}

interface StoredSample {
    shape: number[]
    texture: number[]
    logRms: number
}

type SlideDB = Record<number, StoredSample[]>

export class FingerprintDB {
    private cache: Record<string, SlideDB> = {}

    private load(showId: string): SlideDB {
        if (!this.cache[showId]) {
            try {
                const raw = localStorage.getItem(STORAGE_PREFIX + showId)
                this.cache[showId] = raw ? JSON.parse(raw) : {}
            } catch {
                this.cache[showId] = {}
            }
        }
        return this.cache[showId]
    }

    private persist(showId: string): void {
        try {
            localStorage.setItem(STORAGE_PREFIX + showId, JSON.stringify(this.cache[showId]))
        } catch {}
    }

    add(showId: string, slideIndex: number, fp: Fingerprint): void {
        const db = this.load(showId)
        if (!db[slideIndex]) db[slideIndex] = []
        db[slideIndex].push({ shape: Array.from(fp.shape), texture: Array.from(fp.texture), logRms: fp.logRms })
        if (db[slideIndex].length > MAX_SAMPLES) db[slideIndex].shift()
        this.persist(showId)
    }

    // Nearest-neighbour: best similarity across ALL stored samples, not the average.
    // Any single good example is enough to make a match — important for songs that
    // vary in intensity week to week.
    match(showId: string, fp: Fingerprint): FingerprintMatch | null {
        const db = this.load(showId)
        let bestIndex = -1
        let bestScore = 0

        for (const [idxStr, samples] of Object.entries(db)) {
            for (const s of samples) {
                const score = combinedSimilarity(fp, s)
                if (score > bestScore) {
                    bestScore = score
                    bestIndex = Number(idxStr)
                }
            }
        }

        if (bestIndex < 0) return null
        return { slideIndex: bestIndex, confidence: Math.round(bestScore * 100) }
    }

    countSlides(showId: string): number {
        return Object.keys(this.load(showId)).length
    }

    clear(showId: string): void {
        this.cache[showId] = {}
        try { localStorage.removeItem(STORAGE_PREFIX + showId) } catch {}
    }
}

export const fingerprintDB = new FingerprintDB()
