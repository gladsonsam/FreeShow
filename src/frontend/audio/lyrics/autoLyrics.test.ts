// Unit tests for the auto-lyrics core: song follower tracking (synthetic, time-warped
// performances), chroma extraction sanity, and song-map quantization.

import { describe, expect, it } from "vitest"
import { CHROMA_DIM, ChromaExtractor } from "./chromaFeatures"
import { SongFollower, type FollowerReference } from "./songFollower"
import { shouldReplaceMap } from "./songLearner"
import { dequantizeChroma, hashSongText, mapCoveredSlides, quantizeVec } from "./songMap"

const FPS = 10

// ---------- synthetic song generation ----------

// deterministic RNG (mulberry32)
function rng(seed: number) {
    let a = seed
    return () => {
        a |= 0
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function normalize(v: Float32Array): Float32Array {
    let n = 0
    for (const x of v) n += x * x
    n = Math.sqrt(n) || 1
    return v.map((x) => x / n) as Float32Array
}

// a "chord": 3 strong pitch classes
function makeChord(rand: () => number): Float32Array {
    const v = new Float32Array(CHROMA_DIM)
    for (let i = 0; i < 3; i++) v[Math.floor(rand() * CHROMA_DIM)] += 0.5 + rand() * 0.5
    return normalize(v)
}

// a section = sequence of chords, 2s each, rendered to per-frame ideal chroma
function makeSection(rand: () => number, seconds: number): Float32Array[] {
    const chordCount = Math.max(1, Math.round(seconds / 2))
    const chords = Array.from({ length: chordCount }, () => makeChord(rand))
    const frames: Float32Array[] = []
    for (let f = 0; f < seconds * FPS; f++) {
        frames.push(chords[Math.min(chordCount - 1, Math.floor(f / (2 * FPS)))])
    }
    return frames
}

function addNoise(frame: Float32Array, rand: () => number, amount: number): Float32Array {
    const v = new Float32Array(CHROMA_DIM)
    for (let d = 0; d < CHROMA_DIM; d++) v[d] = frame[d] * (1 - amount) + rand() * amount
    return normalize(v)
}

interface Song {
    ideal: Float32Array[] // per-frame clean chroma
    ref: FollowerReference
    sectionStart: number[] // frame where each section begins
}

// sections: seconds per section; slides: slide index shown during each section.
// Repeated slide indices with `sharedWith` produce *identical* music (verse/chorus repeats).
function buildSong(seed: number, sections: { seconds: number; slide: number; sharedWith?: number }[]): Song {
    const rand = rng(seed)
    const sectionFrames: Float32Array[][] = []
    sections.forEach((s, i) => {
        sectionFrames.push(s.sharedWith !== undefined ? sectionFrames[s.sharedWith] : makeSection(rand, s.seconds))
    })

    const ideal: Float32Array[] = []
    const marks: { frame: number; slideIndex: number }[] = []
    const sectionStart: number[] = []
    sectionFrames.forEach((frames, i) => {
        sectionStart.push(ideal.length)
        marks.push({ frame: ideal.length, slideIndex: sections[i].slide })
        ideal.push(...frames)
    })

    // reference = ideal + light recording noise
    const refRand = rng(seed + 999)
    const chroma = new Float32Array(CHROMA_DIM * ideal.length)
    ideal.forEach((f, i) => chroma.set(addNoise(f, refRand, 0.1), i * CHROMA_DIM))
    const energy = new Float32Array(ideal.length).fill(0.6)

    return { ideal, ref: { fps: FPS, frameCount: ideal.length, chroma, energy, marks }, sectionStart }
}

// live performance = ideal score resampled at `warp`x speed + performance noise
function makeLive(song: Song, warp: number, seed: number): { chroma: Float32Array; energy: number }[] {
    const rand = rng(seed)
    const frames: { chroma: Float32Array; energy: number }[] = []
    const liveLen = Math.floor(song.ideal.length / warp)
    for (let i = 0; i < liveLen; i++) {
        const refIndex = Math.min(song.ideal.length - 1, Math.round(i * warp))
        frames.push({ chroma: addNoise(song.ideal[refIndex], rand, 0.25), energy: 0.5 })
    }
    return frames
}

const STANDARD_SECTIONS = [
    { seconds: 20, slide: 0 }, // verse 1
    { seconds: 16, slide: 1 }, // chorus
    { seconds: 20, slide: 2 }, // verse 2
    { seconds: 16, slide: 1, sharedWith: 1 }, // chorus again (identical music!)
    { seconds: 12, slide: 3 } // bridge
]

function trackingError(song: Song, warp: number, seed: number): { meanErrSec: number; slideSequence: number[] } {
    const follower = new SongFollower(song.ref)
    const live = makeLive(song, warp, seed)
    const warmup = 4 * FPS

    let errSum = 0
    let count = 0
    const slideSequence: number[] = []
    live.forEach((frame, i) => {
        const update = follower.step(frame.chroma, frame.energy)
        if (slideSequence[slideSequence.length - 1] !== update.slideIndex) slideSequence.push(update.slideIndex)
        if (i < warmup) return
        errSum += Math.abs(update.position - i * warp) / FPS
        count++
    })
    return { meanErrSec: errSum / count, slideSequence }
}

describe("SongFollower", () => {
    it("tracks a same-tempo performance and fires slides in order", () => {
        const song = buildSong(1, STANDARD_SECTIONS)
        const { meanErrSec, slideSequence } = trackingError(song, 1.0, 42)
        expect(meanErrSec).toBeLessThan(1.5)
        expect(slideSequence).toEqual([0, 1, 2, 1, 3])
    })

    it("tracks a slower performance (band at 0.85x)", () => {
        const song = buildSong(2, STANDARD_SECTIONS)
        const { meanErrSec, slideSequence } = trackingError(song, 0.85, 43)
        expect(meanErrSec).toBeLessThan(2)
        expect(slideSequence).toEqual([0, 1, 2, 1, 3])
    })

    it("tracks a faster performance (band at 1.2x)", () => {
        const song = buildSong(3, STANDARD_SECTIONS)
        const { meanErrSec, slideSequence } = trackingError(song, 1.2, 44)
        expect(meanErrSec).toBeLessThan(2)
        expect(slideSequence).toEqual([0, 1, 2, 1, 3])
    })

    it("stays in the FIRST chorus region while the first chorus plays (repeat disambiguation)", () => {
        const song = buildSong(4, STANDARD_SECTIONS)
        const follower = new SongFollower(song.ref)
        const live = makeLive(song, 1.0, 45)

        const chorus1Start = song.sectionStart[1]
        const chorus2Start = song.sectionStart[3]
        for (let i = 0; i < chorus2Start - 2 * FPS; i++) {
            const update = follower.step(live[i].chroma, live[i].energy)
            // while inside the first chorus (with 2s settle margins), we must not sit in chorus 2
            if (i > chorus1Start + 2 * FPS && i < song.sectionStart[2] - FPS) {
                expect(update.position).toBeLessThan(chorus2Start - 5 * FPS)
            }
        }
    })

    it("re-locks after anchoring to a slide mid-song (operator override)", () => {
        const song = buildSong(5, STANDARD_SECTIONS)
        const follower = new SongFollower(song.ref)
        follower.anchorToSlide(2) // operator jumps to verse 2

        const verse2Start = song.sectionStart[2]
        const live = makeLive(song, 1.0, 46).slice(verse2Start) // band is already at verse 2
        live.forEach((frame, i) => {
            const update = follower.step(frame.chroma, frame.energy)
            if (i > 3 * FPS && i < 10 * FPS) {
                expect(Math.abs(update.position - (verse2Start + i))).toBeLessThan(2.5 * FPS)
            }
        })
    })

    it("recovers when the band skips ahead (verse 1 straight to bridge)", () => {
        const song = buildSong(6, STANDARD_SECTIONS)
        const follower = new SongFollower(song.ref)
        const live = makeLive(song, 1.0, 47)

        const verse1 = live.slice(0, song.sectionStart[1])
        const bridge = live.slice(song.sectionStart[4])

        verse1.forEach((f) => follower.step(f.chroma, f.energy))
        let lockedFrame = -1
        bridge.forEach((f, i) => {
            const update = follower.step(f.chroma, f.energy)
            if (lockedFrame < 0 && update.slideIndex === 3 && update.confidence > 0.4) lockedFrame = i
        })
        expect(lockedFrame).toBeGreaterThanOrEqual(0)
        expect(lockedFrame).toBeLessThan(8 * FPS) // recovered within 8s of the jump
    })

    it("keeps the right slide through an unexpected quiet gap and re-locks afterwards", () => {
        const song = buildSong(7, STANDARD_SECTIONS)
        const follower = new SongFollower(song.ref)
        const live = makeLive(song, 1.0, 48)

        const gapStart = song.sectionStart[1] + 5 * FPS // 5s into chorus 1
        let posBeforeGap = 0
        for (let i = 0; i < gapStart; i++) posBeforeGap = follower.step(live[i].chroma, live[i].energy).position

        // 3s unexpected silence: position may drift a little (and may sit in the *identical*
        // second chorus region — indistinguishable by audio), but the SLIDE must stay correct
        const silent = new Float32Array(CHROMA_DIM)
        let update = follower.step(silent, 0.01)
        for (let i = 1; i < 3 * FPS; i++) update = follower.step(silent, 0.01)
        expect(Math.abs(update.position - posBeforeGap)).toBeLessThan(5 * FPS)
        expect(update.slideIndex).toBe(1) // still on the chorus slide

        // band resumes where it left off and plays through into verse 2:
        // by the end the follower must be tracking verse 2 (slide 2) at the right spot
        const verse2End = song.sectionStart[3]
        for (let i = gapStart; i < verse2End - 2; i++) {
            update = follower.step(live[i].chroma, live[i].energy)
            if (i > verse2End - 5 * FPS) {
                expect(update.slideIndex).toBe(2)
                expect(Math.abs(update.position - i)).toBeLessThan(3 * FPS)
            }
        }
    })
})

describe("ChromaExtractor", () => {
    it("maps a 440 Hz tone to pitch class A", () => {
        const extractor = new ChromaExtractor()
        const sampleRate = 16000
        const block = new Float32Array(sampleRate) // 1s of audio
        for (let i = 0; i < block.length; i++) block[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5

        const frames = extractor.push(block)
        expect(frames.length).toBeGreaterThan(0)
        const last = frames[frames.length - 1]
        const maxDim = last.chroma.indexOf(Math.max(...Array.from(last.chroma)))
        expect(maxDim).toBe(9) // A = pitch class 9
        expect(last.energy).toBeGreaterThan(0.5)
    })
})

describe("songMap helpers", () => {
    it("quantization roundtrip stays within 1/255 per component", () => {
        const rand = rng(9)
        const v = normalize(new Float32Array(CHROMA_DIM).map(() => rand()) as Float32Array)
        const back = dequantizeChroma(quantizeVec(v))
        for (let d = 0; d < CHROMA_DIM; d++) expect(Math.abs(back[d] - v[d])).toBeLessThanOrEqual(1 / 255)
    })

    it("text hash changes when lyrics change", () => {
        const a = hashSongText(["amazing grace", "how sweet the sound"])
        const b = hashSongText(["amazing grace", "how sweet the sounds"])
        expect(a).not.toBe(b)
        expect(a).toBe(hashSongText(["amazing grace", "how sweet the sound"]))
    })

    it("counts distinct covered slides from marks", () => {
        expect(
            mapCoveredSlides([
                { frame: 0, slideIndex: 0 },
                { frame: 100, slideIndex: 1 },
                { frame: 200, slideIndex: 0 }
            ])
        ).toBe(2)
    })
})

describe("shouldReplaceMap", () => {
    it("saves the first usable pass when no map exists", () => {
        expect(shouldReplaceMap(null, { manualMoves: 0, coveredSlides: 3 })).toBe(true)
    })

    it("never replaces a locked map, even after many corrections", () => {
        expect(shouldReplaceMap({ locked: true, coveredSlides: 5 }, { manualMoves: 5, coveredSlides: 5 })).toBe(false)
    })

    it("keeps the map when the follower needed no (or one) correction", () => {
        expect(shouldReplaceMap({ coveredSlides: 5 }, { manualMoves: 0, coveredSlides: 5 })).toBe(false)
        expect(shouldReplaceMap({ coveredSlides: 5 }, { manualMoves: 1, coveredSlides: 5 })).toBe(false)
    })

    it("replaces after corrections when the new pass covers a comparable share of the song", () => {
        expect(shouldReplaceMap({ coveredSlides: 5 }, { manualMoves: 2, coveredSlides: 4 })).toBe(true)
        expect(shouldReplaceMap({ coveredSlides: 5 }, { manualMoves: 2, coveredSlides: 3 })).toBe(true)
    })

    it("does not trade a full map for a partial pass (operator joined mid-song)", () => {
        expect(shouldReplaceMap({ coveredSlides: 8 }, { manualMoves: 3, coveredSlides: 2 })).toBe(false)
    })
})
