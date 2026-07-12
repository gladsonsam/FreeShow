// Learn & Follow engine — the default auto-lyrics mode.
//
// Per song (show + layout):
//   1. No stored map yet -> LEARNING: record chroma + the operator's slide changes.
//      When the song ends with a usable pass, save it as the song's map.
//   2. Map exists -> FOLLOWING: run the SongFollower against the map and fire slide
//      navigation as the tracked position crosses the learned slide boundaries
//      (with a configurable lead so lyrics can appear slightly early). A new pass is
//      still recorded; if the operator had to correct the follower, the new pass
//      replaces the map so next week's timing is better.
//
// The operator always wins: manual navigation re-anchors the follower and pauses
// decisions briefly. No network, no models — everything runs locally.

import { ChromaExtractor, CHROMA_FPS } from "./chromaFeatures"
import { SongFollower } from "./songFollower"
import { PassRecorder } from "./songLearner"
import type { SongMap } from "./songMap"
import { dequantizeChroma, dequantizeEnergy, songMapKey, songMapStore } from "./songMap"

export interface FollowSongContext {
    showId: string
    layoutId: string
    slideCount: number
    textHash: string
    songName: string
    outputIndex: number
}

export type FollowState = "idle" | "learning" | "following" | "lost"

export interface FollowRuntime {
    state: FollowState
    songName: string
    slideIndex: number
    slideCount: number
    confidence: number // 0-100
    hasMap: boolean
}

export interface FollowDecision {
    slideIndex: number
    confidence: number // 0-100
}

const FIRE_COOLDOWN_FRAMES = CHROMA_FPS * 2 // after our own navigation
const MANUAL_COOLDOWN_FRAMES = CHROMA_FPS * 3 // after the operator navigates
const NATURAL_STABLE_FRAMES = 3 // adjacent-next-slide moves: 0.3s of agreement
const JUMP_STABLE_FRAMES = 8 // backward/skip moves: 0.8s of agreement
const JUMP_EXTRA_CONFIDENCE = 0.15
const MIN_FIRE_QUALITY = 0.5
const LOST_QUALITY = 0.45
const LOST_CONFIDENCE = 0.35
const LOST_AFTER_FRAMES = CHROMA_FPS * 3

export class FollowEngine {
    private extractor = new ChromaExtractor()
    private follower: SongFollower | null = null
    private followerMarks: SongMap["marks"] = []
    private recorder: PassRecorder | null = null
    private song: FollowSongContext | null = null
    private hasMap = false
    private songToken = 0

    private state: FollowState = "idle"
    private lastOutputIndex = -1
    private cooldownFrames = 0
    private candidateSlide = -1
    private candidateFrames = 0
    private lostFrames = 0
    private lastConfidence = 0
    private framesSinceRuntimePush = 0

    private decisionCb: ((d: FollowDecision) => void) | null = null
    private runtimeCb: ((r: FollowRuntime) => void) | null = null

    private minConfidence = 0.55
    private leadFrames = Math.round((400 / 1000) * CHROMA_FPS)

    onDecision(cb: (d: FollowDecision) => void) {
        this.decisionCb = cb
    }
    onRuntime(cb: (r: FollowRuntime) => void) {
        this.runtimeCb = cb
    }

    configure(opts: { thresholdPct?: number; leadMs?: number }) {
        if (typeof opts.thresholdPct === "number") this.minConfidence = Math.max(0.1, Math.min(1, opts.thresholdPct / 100))
        if (typeof opts.leadMs === "number") this.leadFrames = Math.round((opts.leadMs / 1000) * CHROMA_FPS)
    }

    // The active output moved to a different song (or was cleared: ctx = null)
    async setSong(ctx: FollowSongContext | null) {
        const token = ++this.songToken
        await this.finishPass()
        if (token !== this.songToken) return

        this.song = ctx
        this.follower = null
        this.followerMarks = []
        this.recorder = null
        this.hasMap = false
        this.extractor.reset()
        this.resetDecisionState()

        if (!ctx) {
            this.state = "idle"
            this.pushRuntime(true)
            return
        }

        this.lastOutputIndex = ctx.outputIndex

        let map: SongMap | null = null
        try {
            map = await songMapStore.get(songMapKey(ctx.showId, ctx.layoutId))
        } catch (err) {
            console.error("Auto Lyrics: could not read song map", err)
        }
        if (token !== this.songToken) return

        // lyrics or structure changed since the map was learned -> re-learn
        if (map && (map.slideCount !== ctx.slideCount || map.textHash !== ctx.textHash)) {
            songMapStore.delete(map.key).catch(() => null)
            map = null
        }

        if (map) {
            this.follower = new SongFollower({
                fps: map.fps,
                frameCount: map.frameCount,
                chroma: dequantizeChroma(map.chroma),
                energy: dequantizeEnergy(map.energy),
                marks: map.marks
            })
            this.followerMarks = map.marks
            this.follower.anchorToSlide(ctx.outputIndex)
            this.hasMap = true
            this.state = "following"
        } else {
            this.state = "learning"
        }

        this.recorder = new PassRecorder()
        this.recorder.markSlide(ctx.outputIndex, true)
        this.pushRuntime(true)
    }

    // Output slide index changed within the current song
    notifySlide(index: number, manual: boolean) {
        if (!this.song || index === this.lastOutputIndex) return
        this.lastOutputIndex = index
        this.recorder?.markSlide(index, manual)

        if (manual && this.follower) {
            // the operator knows best: re-lock there and back off briefly
            this.follower.anchorToSlide(index)
            this.cooldownFrames = MANUAL_COOLDOWN_FRAMES
            this.resetCandidate()
        } else if (!manual) {
            this.cooldownFrames = Math.max(this.cooldownFrames, FIRE_COOLDOWN_FRAMES)
        }
        this.pushRuntime(true)
    }

    handleBlock(pcm: Float32Array) {
        if (!this.song) return
        const frames = this.extractor.push(pcm)
        for (const frame of frames) {
            this.recorder?.record(frame)
            if (this.follower) this.stepFollower(frame.chroma, frame.energy)
            else if (++this.framesSinceRuntimePush >= CHROMA_FPS) this.pushRuntime(true)
        }
    }

    private stepFollower(chroma: Float32Array, energy: number) {
        const update = this.follower!.step(chroma, energy)
        this.lastConfidence = update.confidence

        // lost tracking? (bad audio match for a sustained period)
        if (update.quality < LOST_QUALITY && update.confidence < LOST_CONFIDENCE) {
            if (++this.lostFrames >= LOST_AFTER_FRAMES && this.state === "following") this.state = "lost"
        } else {
            this.lostFrames = 0
            if (this.state === "lost") this.state = "following"
        }

        if (this.cooldownFrames > 0) this.cooldownFrames--

        const target = this.follower!.slideAt(update.position + this.leadFrames)
        if (target !== this.lastOutputIndex && this.state === "following") {
            if (target === this.candidateSlide) this.candidateFrames++
            else {
                this.candidateSlide = target
                this.candidateFrames = 1
            }

            const natural = this.isNaturalNext(update.position, target)
            const neededFrames = natural ? NATURAL_STABLE_FRAMES : JUMP_STABLE_FRAMES
            const neededConfidence = natural ? this.minConfidence : this.minConfidence + JUMP_EXTRA_CONFIDENCE

            if (this.candidateFrames >= neededFrames && this.cooldownFrames <= 0 && update.confidence >= neededConfidence && update.quality >= MIN_FIRE_QUALITY) {
                this.cooldownFrames = FIRE_COOLDOWN_FRAMES
                this.resetCandidate()
                this.decisionCb?.({ slideIndex: target, confidence: Math.round(update.confidence * 100) })
            }
        } else {
            this.resetCandidate()
        }

        if (++this.framesSinceRuntimePush >= Math.round(CHROMA_FPS / 2)) this.pushRuntime()
    }

    // is `target` simply the slide of the next learned mark after the current position?
    private isNaturalNext(position: number, target: number): boolean {
        const marks = this.followerMarks
        for (let i = 0; i < marks.length; i++) {
            if (marks[i].frame > position) return marks[i].slideIndex === target
        }
        return false
    }

    // Save (or replace) the song map if this pass taught us something
    private async finishPass() {
        const recorder = this.recorder
        const song = this.song
        const wasFollowing = !!this.follower
        this.recorder = null
        if (!recorder || !song || !recorder.isUsable()) return

        const replaceWorthy = !wasFollowing || recorder.manualMoves >= 2
        if (!replaceWorthy) return

        try {
            await songMapStore.put(recorder.toSongMap({ showId: song.showId, layoutId: song.layoutId, slideCount: song.slideCount, textHash: song.textHash, manualPass: !wasFollowing }))
        } catch (err) {
            console.error("Auto Lyrics: could not save song map", err)
        }
    }

    async forgetAllSongs() {
        const ctx = this.song
        this.song = null // discard the in-progress pass too
        try {
            await songMapStore.clearAll()
        } catch (err) {
            console.error("Auto Lyrics: could not clear song maps", err)
        }
        await this.setSong(ctx)
    }

    async forgetCurrentSong() {
        if (!this.song) return
        try {
            await songMapStore.delete(songMapKey(this.song.showId, this.song.layoutId))
        } catch (err) {
            console.error("Auto Lyrics: could not delete song map", err)
        }
        // relearn from now on
        const ctx = this.song
        this.song = null
        await this.setSong(ctx)
    }

    async dispose() {
        await this.finishPass()
        this.songToken++
        this.song = null
        this.follower = null
        this.followerMarks = []
        this.recorder = null
        this.state = "idle"
        this.resetDecisionState()
    }

    private resetCandidate() {
        this.candidateSlide = -1
        this.candidateFrames = 0
    }

    private resetDecisionState() {
        this.resetCandidate()
        this.cooldownFrames = 0
        this.lostFrames = 0
        this.lastConfidence = 0
        this.lastOutputIndex = -1
        this.framesSinceRuntimePush = 0
    }

    private pushRuntime(force = false) {
        this.framesSinceRuntimePush = 0
        if (!this.runtimeCb) return
        if (!force && !this.song) return
        this.runtimeCb({
            state: this.state,
            songName: this.song?.songName || "",
            slideIndex: this.follower ? this.follower.slideAt(this.follower.position) : this.lastOutputIndex,
            slideCount: this.song?.slideCount || 0,
            confidence: Math.round(this.lastConfidence * 100),
            hasMap: this.hasMap
        })
    }
}
