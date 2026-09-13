// Synthesizes "a different performance" from a single source recording.
//
// Each variant is an ffmpeg filter chain plus the matching transform for the cue sheet,
// so ground truth comes for free — no second annotation pass. This measures robustness
// against the things that actually differ week to week (tempo, FOH level, room noise,
// desk EQ), not against a genuinely different take: same musicians, same room, same
// performance underneath. Treat it as a regression harness, not an accuracy oracle.

import type { Cue } from "./cues"

export interface Variant {
    name: string
    filters: string // ffmpeg -af chain ("" = untouched)
    // maps a source cue time onto the variant's timeline
    mapCueMs: (ms: number) => number
    note: string
}

// atempo keeps pitch and scales duration by 1/factor
function tempo(factor: number): Variant {
    return {
        name: `tempo_${factor}x`,
        filters: `atempo=${factor}`,
        mapCueMs: (ms) => ms / factor,
        note: `band plays ${factor < 1 ? "slower" : "faster"}`
    }
}

// resampling shifts pitch and tempo together; atempo undoes the tempo half, leaving a
// key change. Chroma is pitch-class based, so this SHOULD degrade — it measures the limit.
function transpose(semitones: number): Variant {
    const ratio = Math.pow(2, semitones / 12)
    return {
        name: `transpose_${semitones > 0 ? "+" : ""}${semitones}`,
        filters: `asetrate=16000*${ratio},aresample=16000,atempo=${1 / ratio}`,
        mapCueMs: (ms) => ms,
        note: `band plays ${Math.abs(semitones)} semitone(s) ${semitones > 0 ? "up" : "down"}`
    }
}

function noise(snrDb: number): Variant {
    // anoisesrc is mixed under the source; amix halves levels so compensate
    const noiseAmp = Math.pow(10, -snrDb / 20)
    return {
        name: `noise_${snrDb}dB`,
        filters: `anoisesrc=c=pink:a=${noiseAmp.toFixed(4)}:d=99999[n];[0:a][n]amix=inputs=2:duration=first,volume=2`,
        mapCueMs: (ms) => ms,
        note: `congregation / PA hiss at ${snrDb} dB SNR`
    }
}

export const VARIANTS: Variant[] = [
    { name: "identity", filters: "", mapCueMs: (ms) => ms, note: "same audio (upper bound)" },
    tempo(0.9),
    tempo(0.95),
    tempo(1.05),
    tempo(1.1),
    { name: "quiet", filters: "volume=0.15", mapCueMs: (ms) => ms, note: "low FOH send level" },
    { name: "loud_clipped", filters: "volume=4,alimiter=limit=0.95", mapCueMs: (ms) => ms, note: "hot input, squashed dynamics" },
    noise(20),
    noise(10),
    noise(5),
    { name: "phone_mic", filters: "highpass=f=300,lowpass=f=3400", mapCueMs: (ms) => ms, note: "narrowband capture" },
    { name: "boomy_room", filters: "bass=g=10,treble=g=-6", mapCueMs: (ms) => ms, note: "different desk EQ / room" },
    transpose(-2),
    transpose(1)
]

export function applyVariant(cues: Cue[], variant: Variant): Cue[] {
    return cues.map((cue) => ({ ...cue, timeMs: Math.round(variant.mapCueMs(cue.timeMs)) }))
}

export function findVariant(name: string): Variant | undefined {
    return VARIANTS.find((v) => v.name === name)
}
