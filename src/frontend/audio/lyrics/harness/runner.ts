// Drives the real FollowEngine over decoded audio on a virtual clock.
//
// This is the production engine, not a stand-in: same ChromaExtractor, same SongFollower,
// same cooldown/stability gates. Only the audio source and the clock are faked, so a
// regression here is a regression live.
//
// Requires an IndexedDB shim to be installed before FollowEngine is imported (the CLI
// imports "fake-indexeddb/auto" first) because the engine persists maps via songMapStore.

import { blocks, durationMs } from "./decode"
import type { Cue } from "./cues"
import { FollowEngine, type FollowSongContext } from "../followEngine"
import { songMapStore } from "../songMap"

export interface Decision {
    timeMs: number
    slideIndex: number
    confidence: number
}

export interface PassResult {
    decisions: Decision[]
    // slide considered live at each 100 ms block, after applying decisions/cues
    timeline: { timeMs: number; slide: number }[]
    learned: boolean
    durationMs: number
}

export interface EngineOptions {
    thresholdPct: number
    leadMs: number
}

const FIXTURE_SHOW_ID = "harness-show"
const FIXTURE_LAYOUT_ID = "harness-layout"

function context(slideCount: number, songName: string, textHash: string): FollowSongContext {
    return { showId: FIXTURE_SHOW_ID, layoutId: FIXTURE_LAYOUT_ID, slideCount, textHash, songName, outputIndex: 0 }
}

export async function resetStore() {
    await songMapStore.clearAll().catch(() => null)
}

export async function hasMap() {
    return !!(await songMapStore.get(`${FIXTURE_SHOW_ID}::${FIXTURE_LAYOUT_ID}`).catch(() => null))
}

export async function getMap() {
    return songMapStore.get(`${FIXTURE_SHOW_ID}::${FIXTURE_LAYOUT_ID}`).catch(() => null)
}

// LEARNING pass: replays the operator navigating by hand at the cue times, exactly as
// PassRecorder would see it live. Ends the pass so the map is written.
export async function runLearningPass(pcm: Float32Array, cues: Cue[], slideCount: number, opts: EngineOptions): Promise<PassResult> {
    const engine = new FollowEngine()
    engine.configure({ thresholdPct: opts.thresholdPct, leadMs: opts.leadMs })

    let learned = false
    engine.onLearned(() => (learned = true))

    await engine.setSong(context(slideCount, "harness", "hash"))

    const timeline: PassResult["timeline"] = []
    let cueIndex = 0
    let liveSlide = 0

    for (const block of blocks(pcm)) {
        while (cueIndex < cues.length && cues[cueIndex].timeMs <= block.timeMs) {
            liveSlide = cues[cueIndex].slideIndex
            engine.notifySlide(liveSlide, true)
            cueIndex++
        }

        engine.handleBlock(block.pcm)
        timeline.push({ timeMs: block.timeMs, slide: liveSlide })
    }

    // finishPass() runs on setSong -> this is what persists the map
    await engine.setSong(null)

    return { decisions: [], timeline, learned, durationMs: durationMs(pcm) }
}

// FOLLOW pass: the engine drives. Every decision is echoed back via notifySlide(_, false),
// which is what autoLyricsController does after it navigates — the cooldowns depend on it.
export async function runFollowPass(pcm: Float32Array, slideCount: number, opts: EngineOptions): Promise<PassResult> {
    const engine = new FollowEngine()
    engine.configure({ thresholdPct: opts.thresholdPct, leadMs: opts.leadMs })

    const decisions: Decision[] = []
    let liveSlide = 0
    let now = 0

    engine.onDecision((d) => {
        decisions.push({ timeMs: now, slideIndex: d.slideIndex, confidence: d.confidence })
        liveSlide = d.slideIndex
        engine.notifySlide(d.slideIndex, false)
    })

    await engine.setSong(context(slideCount, "harness", "hash"))

    const timeline: PassResult["timeline"] = []
    for (const block of blocks(pcm)) {
        now = block.timeMs
        engine.handleBlock(block.pcm)
        timeline.push({ timeMs: block.timeMs, slide: liveSlide })
    }

    await engine.setSong(null)

    return { decisions, timeline, learned: false, durationMs: durationMs(pcm) }
}
