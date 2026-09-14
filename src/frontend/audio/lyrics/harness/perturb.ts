// Makes "a different performance" out of one recording: an ffmpeg filter chain plus the
// matching cue-time transform, so ground truth comes for free.
//
// It's the same take underneath, so this catches regressions rather than predicting
// real-world accuracy.

import type { Cue } from "./cues"

export interface Variant {
    name: string
    filters: string // ffmpeg -af chain ("" = untouched)
    mapCueMs: (ms: number) => number
}

const same = (ms: number) => ms

// atempo keeps pitch and scales duration by 1/factor
function tempo(factor: number): Variant {
    return { name: `tempo_${factor}x`, filters: `atempo=${factor}`, mapCueMs: (ms) => ms / factor }
}

// resampling shifts pitch and tempo together, atempo undoes the tempo half. Chroma is
// pitch-class based so this SHOULD degrade — it's here to measure the limit.
function transpose(semitones: number): Variant {
    const ratio = 2 ** (semitones / 12)
    return {
        name: `transpose_${semitones > 0 ? "+" : ""}${semitones}`,
        // Filters run before decodePcm's output -ar, so normalise arbitrary source
        // sample rates first; otherwise a 44.1 kHz MP3 gets a huge accidental shift.
        filters: `aresample=16000,asetrate=16000*${ratio},aresample=16000,atempo=${1 / ratio}`,
        mapCueMs: same
    }
}

// amix halves levels, hence the volume=2
function noise(snrDb: number): Variant {
    const amp = 10 ** (-snrDb / 20)
    return {
        name: `noise_${snrDb}dB`,
        filters: `anoisesrc=c=pink:a=${amp.toFixed(4)}:d=99999:s=20260914[n];[0:a][n]amix=inputs=2:duration=first,volume=2`,
        mapCueMs: same
    }
}

export const VARIANTS: Variant[] = [
    { name: "identity", filters: "", mapCueMs: same },
    tempo(0.9),
    tempo(0.95),
    tempo(1.05),
    tempo(1.1),
    { name: "quiet", filters: "volume=0.15", mapCueMs: same }, // low FOH send
    { name: "loud_clipped", filters: "volume=4,alimiter=limit=0.95", mapCueMs: same },
    noise(20),
    noise(10),
    noise(5),
    { name: "phone_mic", filters: "highpass=f=300,lowpass=f=3400", mapCueMs: same },
    { name: "boomy_room", filters: "bass=g=10,treble=g=-6", mapCueMs: same },
    transpose(-2),
    transpose(1)
]

export function applyVariant(cues: Cue[], variant: Variant): Cue[] {
    return cues.map((cue) => ({ ...cue, timeMs: Math.round(variant.mapCueMs(cue.timeMs)) }))
}
