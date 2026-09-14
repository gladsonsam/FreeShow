// Developer harness helper: records operator-driven output navigation as a cue sheet.
// It deliberately runs independently of Auto Lyrics and microphone capture so a tester
// can play a reference MP3, present the show normally, and export ground truth.

import { get, writable } from "svelte/store"
import { _show } from "../../../components/helpers/shows"
import { outputs, shows, showsCache } from "../../../stores"
import type { CueSheet } from "./cues"

export interface CueRecordingState {
    recording: boolean
    startedAt: number
    stoppedAt: number
    showId: string
    layoutId: string
    songName: string
    slideCount: number
    cues: CueSheet["cues"]
}

const EMPTY: CueRecordingState = {
    recording: false,
    startedAt: 0,
    stoppedAt: 0,
    showId: "",
    layoutId: "",
    songName: "",
    slideCount: 0,
    cues: []
}

export const cueRecording = writable<CueRecordingState>({ ...EMPTY })

class CueRecorder {
    private state: CueRecordingState = { ...EMPTY }
    private outputId = ""
    private lastIndex = -1
    private outputsUnsub: (() => void) | null = null

    start() {
        const entries = Object.entries(get(outputs)).filter(([, output]: any) => output?.enabled && !output?.stageOutput)
        const active = entries.find(([, output]: any) => output?.active) || entries[0]
        const slide: any = active?.[1]?.out?.slide
        if (!active || !slide?.id || !Number.isInteger(slide.index)) throw new Error("Put the song's first slide on an enabled output before recording.")

        const showId: string = slide.id
        const show = get(showsCache)[showId]
        if (!show) throw new Error("The active output is not displaying a loaded FreeShow show.")

        const layoutId: string = slide.layout || show.settings?.activeLayout || ""
        const slideCount = (_show(showId).layouts([layoutId]).ref()[0] || []).length
        if (!slideCount) throw new Error("The active show layout has no slides.")

        this.outputsUnsub?.()
        this.outputId = active[0]
        this.lastIndex = slide.index
        this.state = {
            recording: true,
            startedAt: performance.now(),
            stoppedAt: 0,
            showId,
            layoutId,
            songName: show.name || (get(shows)[showId] as any)?.name || showId,
            slideCount,
            cues: [{ timeMs: 0, slideIndex: slide.index }]
        }
        cueRecording.set(this.copyState())

        this.outputsUnsub = outputs.subscribe((all) => {
            if (!this.state.recording) return
            const current: any = all[this.outputId]?.out?.slide
            if (!current || current.id !== this.state.showId || (current.layout || this.state.layoutId) !== this.state.layoutId || !Number.isInteger(current.index) || current.index === this.lastIndex) return

            this.lastIndex = current.index
            this.state.cues.push({ timeMs: Math.round(performance.now() - this.state.startedAt), slideIndex: current.index })
            cueRecording.set(this.copyState())
        })
    }

    stop() {
        if (!this.state.recording) return
        this.state.recording = false
        this.state.stoppedAt = performance.now()
        this.outputsUnsub?.()
        this.outputsUnsub = null
        cueRecording.set(this.copyState())
    }

    reset() {
        this.outputsUnsub?.()
        this.outputsUnsub = null
        this.outputId = ""
        this.lastIndex = -1
        this.state = { ...EMPTY, cues: [] }
        cueRecording.set(this.copyState())
    }

    download() {
        if (this.state.recording) this.stop()
        if (this.state.cues.length < 2) throw new Error("Run through at least two slides before exporting.")

        const sheet = {
            songName: this.state.songName,
            slideCount: this.state.slideCount,
            showId: this.state.showId,
            layoutId: this.state.layoutId,
            cues: this.state.cues
        }
        const url = URL.createObjectURL(new Blob([JSON.stringify(sheet, null, 2)], { type: "application/json" }))
        const link = document.createElement("a")
        link.href = url
        link.download = "cues.json"
        link.click()
        URL.revokeObjectURL(url)
    }

    private copyState(): CueRecordingState {
        return { ...this.state, cues: [...this.state.cues] }
    }
}

export const cueRecorder = new CueRecorder()
