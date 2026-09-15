// Runs the real FollowEngine over decoded audio on a virtual clock — same extractor,
// follower and cooldowns as live, only the audio source and clock are faked.
//
// The engine persists maps through songMapStore, so an IndexedDB shim must be imported
// before this module (the CLI pulls in "fake-indexeddb/auto" first).

import { FollowEngine } from "../followEngine"
import { songMapKey, songMapStore } from "../songMap"
import type { Cue, CueSheet } from "./cues"
import { blocks, durationMs } from "./decode"

type SongIdentity = Partial<Pick<CueSheet, "showId" | "layoutId" | "songName">>

export interface Decision {
    timeMs: number
    slideIndex: number
    confidence: number
}

export interface PassResult {
    decisions: Decision[]
    timeline: { timeMs: number; slide: number }[] // live slide per 100 ms block
    learned: boolean
    durationMs: number
    keyShift: number
}

export interface EngineOptions {
    thresholdPct: number
    leadMs: number
}

export const resetStore = () => songMapStore.clearAll().catch(() => null)
export const getMap = (identity: SongIdentity = {}) => songMapStore.get(songMapKey(identity.showId || "harness-show", identity.layoutId || "harness-layout")).catch(() => null)

function newEngine(opts: EngineOptions) {
    const engine = new FollowEngine()
    engine.configure(opts)
    return engine
}

function song(slideCount: number, identity: SongIdentity) {
    return {
        showId: identity.showId || "harness-show",
        layoutId: identity.layoutId || "harness-layout",
        slideCount,
        textHash: "harness-hash",
        songName: identity.songName || "harness",
        outputIndex: 0
    }
}

// Replays the operator teaching the song: arm recording, navigate by hand at the
// cue times, then end the pass — which is what writes the map.
export async function runLearningPass(pcm: Float32Array, cues: Cue[], slideCount: number, opts: EngineOptions, identity: SongIdentity = {}): Promise<PassResult> {
    const engine = newEngine(opts)
    let learned = false
    engine.onLearned(() => (learned = true))

    await engine.setSong(song(slideCount, identity))
    engine.startTeaching()

    const timeline: PassResult["timeline"] = []
    let next = 0
    let slide = 0

    for (const block of blocks(pcm)) {
        while (next < cues.length && cues[next].timeMs <= block.timeMs) {
            slide = cues[next++].slideIndex
            engine.notifySlide(slide, true)
        }

        engine.handleBlock(block.pcm)
        timeline.push({ timeMs: block.timeMs, slide })
    }

    await engine.setSong(null)
    return {
        decisions: [],
        timeline,
        learned,
        durationMs: durationMs(pcm),
        keyShift: 0
    }
}

// The engine drives. Decisions are echoed back with notifySlide(_, false) because that's
// what autoLyricsController does after navigating, and the cooldowns depend on it.
export async function runFollowPass(pcm: Float32Array, slideCount: number, opts: EngineOptions, identity: SongIdentity = {}): Promise<PassResult> {
    const engine = newEngine(opts)

    const decisions: Decision[] = []
    let slide = 0
    let now = 0

    engine.onDecision((d) => {
        decisions.push({
            timeMs: now,
            slideIndex: d.slideIndex,
            confidence: d.confidence
        })
        slide = d.slideIndex
        engine.notifySlide(d.slideIndex, false)
    })

    await engine.setSong(song(slideCount, identity))

    const timeline: PassResult["timeline"] = []
    for (const block of blocks(pcm)) {
        now = block.timeMs
        engine.handleBlock(block.pcm)
        timeline.push({ timeMs: block.timeMs, slide })
    }

    const keyShift = engine.getKeyShift()
    await engine.setSong(null)
    return {
        decisions,
        timeline,
        learned: false,
        durationMs: durationMs(pcm),
        keyShift
    }
}
