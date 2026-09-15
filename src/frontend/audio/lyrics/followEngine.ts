// Teach & Follow engine — the default auto-lyrics mode.
//
// Per song (show + layout):
//   1. Nothing stored yet -> READY: the song is loaded but nothing is recorded.
//      The operator explicitly teaches it once (startTeaching), navigating as usual
//      while the engine records chroma + slide changes, then finishes (finishTeaching)
//      to save the pass as the song's map. Nothing is ever learned implicitly.
//   2. Map exists -> FOLLOWING: run the SongFollower against the map and fire slide
//      navigation as the tracked position crosses the learned slide boundaries
//      (with a configurable lead so lyrics can appear slightly early).
//
// Follow passes are never recorded and never overwrite the map: timing only changes
// through an explicit re-teach (startTeaching while following, then finishTeaching).
// The operator always wins: manual navigation re-anchors the follower and pauses
// decisions briefly. No network, no models — everything runs locally.

import { ChromaExtractor, CHROMA_FPS } from "./chromaFeatures"
import { SongFollower } from "./songFollower"
import { PassRecorder, shouldReplaceMap } from "./songLearner"
import type { SongMap } from "./songMap"
import { dequantizeChroma, dequantizeEnergy, mapCoveredSlides, SONG_MAP_FEATURE_VERSION, songMapKey, songMapStore } from "./songMap"

export interface FollowSongContext {
    showId: string
    layoutId: string
    slideCount: number
    textHash: string
    songName: string
    outputIndex: number
}

export type FollowState = "idle" | "ready" | "learning" | "following" | "lost"

export interface FollowRuntime {
    state: FollowState
    songName: string
    slideIndex: number
    slideCount: number
    confidence: number // 0-100
    hasMap: boolean
    passSeconds: number // audio recorded in the current pass
    passSlides: number // distinct slides covered in the current pass
    passUsable: boolean // current pass is good enough to be saved as a map
}

export interface LearnedEvent {
    songName: string
    firstPass: boolean // true = first map for this song, false = timing refined
}

export interface FollowDecision {
    slideIndex: number
    confidence: number // 0-100
}

const FIRE_COOLDOWN_FRAMES = CHROMA_FPS * 2 // after our own navigation
const MANUAL_COOLDOWN_FRAMES = CHROMA_FPS * 3 // after the operator navigates
const NATURAL_STABLE_FRAMES = 3 // adjacent-next-slide moves: 0.3s of agreement
const JUMP_STABLE_FRAMES = 15 // backward/skip moves: 1.5s of agreement
const FINAL_REWIND_STABLE_FRAMES = CHROMA_FPS * 5 // avoid noisy outros jumping back into the song
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
    private mapMeta: { locked: boolean; passCount: number; coveredSlides: number } | null = null
    private songToken = 0

    private state: FollowState = "idle"
    private lastOutputIndex = -1
    private learnArmed = false
    private cooldownFrames = 0
    private candidateSlide = -1
    private candidateFrames = 0
    private lostFrames = 0
    private lastConfidence = 0
    private framesSinceRuntimePush = 0

    private decisionCb: ((d: FollowDecision) => void) | null = null
    private runtimeCb: ((r: FollowRuntime) => void) | null = null
    private learnedCb: ((e: LearnedEvent) => void) | null = null

    private minConfidence = 0.55
    private leadFrames = Math.round((400 / 1000) * CHROMA_FPS)

    onDecision(cb: (d: FollowDecision) => void) {
        this.decisionCb = cb
    }
    onRuntime(cb: (r: FollowRuntime) => void) {
        this.runtimeCb = cb
    }
    onLearned(cb: (e: LearnedEvent) => void) {
        this.learnedCb = cb
    }

    configure(opts: { thresholdPct?: number; leadMs?: number }) {
        if (typeof opts.thresholdPct === "number") this.minConfidence = Math.max(0.1, Math.min(1, opts.thresholdPct / 100))
        if (typeof opts.leadMs === "number") this.leadFrames = Math.round((opts.leadMs / 1000) * CHROMA_FPS)
    }

    // The active output moved to a different song (or was cleared: ctx = null).
    // Moving on while teaching auto-saves the pass when it is usable. Teaching is
    // per song: the new song always starts unarmed, so passing through an already
    // learned song can never silently replace its timing.
    async setSong(ctx: FollowSongContext | null) {
        const token = ++this.songToken
        await this.finishPass()
        this.learnArmed = false
        if (token !== this.songToken) return

        this.song = ctx
        this.follower = null
        this.followerMarks = []
        this.recorder = null
        this.hasMap = false
        this.mapMeta = null
        this.extractor.reset()
        this.resetDecisionState()

        if (!ctx) {
            this.learnArmed = false
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
        if (map && (map.featureVersion !== SONG_MAP_FEATURE_VERSION || map.slideCount !== ctx.slideCount || map.textHash !== ctx.textHash)) {
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
            this.mapMeta = { locked: !!map.locked, passCount: map.passCount || 1, coveredSlides: mapCoveredSlides(map.marks) }
            this.state = "following"
        } else {
            this.state = "ready"
        }

        this.pushRuntime(true)
    }

    // Start explicitly recording the current song. Works both for a first teach
    // (ready -> learning) and a re-teach (following -> learning, replacing the map
    // on finish). Nothing records unless this is called — navigating on your own
    // never trains the model.
    startTeaching() {
        if (!this.song || this.state === "learning") return
        this.learnArmed = true
        // a re-teach drops live following while the operator drives; the stored map
        // stays untouched until finishTeaching(true) overwrites it
        this.follower = null
        this.followerMarks = []
        this.beginTeachingPass()
        this.state = "learning"
        this.pushRuntime(true)
    }

    // Stop teaching. save=true keeps the pass when it is usable (first map, or a
    // re-teach that improves on the stored one); save=false discards it. Either way
    // the engine resumes following the stored map when there is one.
    async finishTeaching(save: boolean): Promise<{ saved: boolean; songName: string }> {
        const songName = this.song?.songName || ""
        this.learnArmed = false
        if (!this.song) {
            this.state = "idle"
            this.pushRuntime(true)
            return { saved: false, songName }
        }
        if (!save) this.recorder = null

        const saved = await this.finishPass()

        // reload whatever is stored now (new map, replaced map, or the untouched one)
        const ctx = this.song
        this.song = null
        await this.setSong(ctx)
        return { saved, songName }
    }

    private beginTeachingPass() {
        this.recorder = new PassRecorder()
        this.recorder.markSlide(this.lastOutputIndex, true)
        this.state = "learning"
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
            const finalSlide = this.followerMarks[this.followerMarks.length - 1]?.slideIndex
            const leavingFinalSlide = this.lastOutputIndex === finalSlide && target !== finalSlide
            const neededFrames = leavingFinalSlide ? FINAL_REWIND_STABLE_FRAMES : natural ? NATURAL_STABLE_FRAMES : JUMP_STABLE_FRAMES
            const neededConfidence = natural && !leavingFinalSlide ? this.minConfidence : Math.min(0.98, this.minConfidence + JUMP_EXTRA_CONFIDENCE)

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

    // Save the in-progress teaching pass when it taught us something. Returns whether
    // a map was written. Follow passes are never recorded, so this only ever fires
    // for explicit teaching.
    private async finishPass(): Promise<boolean> {
        const recorder = this.recorder
        const song = this.song
        const existing = this.mapMeta
        const firstPass = !this.hasMap
        this.recorder = null
        if (!recorder || !song || !recorder.isUsable()) return false

        if (!shouldReplaceMap(existing, { manualMoves: recorder.manualMoves, coveredSlides: recorder.coveredSlides() })) return false

        try {
            await songMapStore.put(
                recorder.toSongMap({
                    showId: song.showId,
                    layoutId: song.layoutId,
                    slideCount: song.slideCount,
                    textHash: song.textHash,
                    manualPass: firstPass,
                    passCount: (existing?.passCount || 0) + 1
                })
            )
            this.hasMap = true
            this.mapMeta = { locked: existing?.locked || false, passCount: (existing?.passCount || 0) + 1, coveredSlides: recorder.coveredSlides() }
            this.learnedCb?.({ songName: song.songName, firstPass })
            return true
        } catch (err) {
            console.error("Auto Lyrics: could not save song map", err)
            return false
        }
    }

    async forgetAllSongs() {
        const ctx = this.song
        this.song = null // discard the in-progress pass too
        this.learnArmed = false
        try {
            await songMapStore.clearAll()
        } catch (err) {
            console.error("Auto Lyrics: could not clear song maps", err)
        }
        await this.setSong(ctx)
    }

    // keep the loaded map's lock state in sync when the operator toggles it in the UI
    setCurrentMapLocked(locked: boolean) {
        if (this.mapMeta) this.mapMeta.locked = locked
    }

    getKeyShift() {
        return this.follower?.keyShift ?? 0
    }

    async forgetCurrentSong() {
        if (!this.song) return
        try {
            await songMapStore.delete(songMapKey(this.song.showId, this.song.layoutId))
        } catch (err) {
            console.error("Auto Lyrics: could not delete song map", err)
        }
        // start over: drop any in-progress teaching pass so forgetting can't
        // accidentally re-save it. The song reloads unmapped (ready); teaching
        // resumes only when explicitly started again.
        this.recorder = null
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
        this.mapMeta = null
        this.learnArmed = false
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
            hasMap: this.hasMap,
            passSeconds: this.recorder ? Math.round(this.recorder.frames / CHROMA_FPS) : 0,
            passSlides: this.recorder ? this.recorder.coveredSlides() : 0,
            passUsable: this.recorder?.isUsable() || false
        })
    }
}
