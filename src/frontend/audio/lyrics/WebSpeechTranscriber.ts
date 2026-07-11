// Web Speech API engine — cloud-based STT via Chrome/Electron's built-in recogniser.
// Handles its own audio capture (the AudioChunker is skipped for this engine).
// Uses the system default microphone; device selection is not supported by the API.
// Requires internet access (audio is sent to Google's speech service).

import type { AutoLyricsModel, LyricsTranscriber, TranscriptChunk } from "./types"

type StatusCb = (status: "loading" | "ready" | "running" | "stopped" | "error", detail?: string) => void

export class WebSpeechTranscriber implements LyricsTranscriber {
    readonly handlesOwnCapture = true

    private recognition: SpeechRecognition | null = null
    private language = ""
    private running = false
    private recentText = ""

    private transcriptCb: ((chunk: TranscriptChunk) => void) | null = null
    private statusCb: StatusCb | null = null
    private errorCb: ((err: Error) => void) | null = null

    onTranscript(cb: (chunk: TranscriptChunk) => void) {
        this.transcriptCb = cb
    }
    onStatus(cb: StatusCb) {
        this.statusCb = cb
    }
    onError(cb: (err: Error) => void) {
        this.errorCb = cb
    }

    init(opts: { model?: AutoLyricsModel; language?: string }): Promise<void> {
        const SR: typeof SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
        if (!SR) return Promise.reject(new Error("Web Speech API not available"))

        this.language = opts.language || ""

        const r = new SR()
        r.continuous = true
        r.interimResults = true
        r.maxAlternatives = 1
        if (this.language) r.lang = this.language

        r.onresult = (e: SpeechRecognitionEvent) => {
            for (let i = e.resultIndex; i < e.results.length; i++) {
                if (e.results[i].isFinal) {
                    this.recentText = (this.recentText + " " + e.results[i][0].transcript).trim()
                    // keep a rolling ~25-word window
                    const words = this.recentText.split(/\s+/)
                    if (words.length > 25) this.recentText = words.slice(-25).join(" ")
                }
            }
            const last = e.results[e.results.length - 1]
            const interim = last && !last.isFinal ? last[0].transcript : ""
            const text = (this.recentText + (interim ? " " + interim : "")).trim()
            if (text) this.transcriptCb?.({ text, final: false, ts: performance.now() })
        }

        r.onend = () => {
            if (!this.running) return
            // auto-restart after silence or the 60s browser timeout
            try {
                r.start()
            } catch {
                // ignore "already started" race
            }
        }

        r.onerror = (e: SpeechRecognitionErrorEvent) => {
            if (e.error === "no-speech" || e.error === "aborted") return
            if (e.error === "network") {
                this.errorCb?.(new Error("No network — Web Speech requires internet"))
                return
            }
            this.errorCb?.(new Error(e.error))
        }

        this.recognition = r
        this.statusCb?.("ready")
        return Promise.resolve()
    }

    start() {
        this.running = true
        try {
            this.recognition?.start()
        } catch {
            // ignore if already started
        }
        this.statusCb?.("running")
    }

    stop() {
        this.running = false
        this.recognition?.stop()
        this.statusCb?.("stopped")
    }

    // Web Speech handles its own capture; feed() is unused
    feed(_pcm: Float32Array, _sampleRate: number) {}

    dispose() {
        this.running = false
        this.recognition?.abort()
        this.recognition = null
        this.recentText = ""
        this.transcriptCb = null
        this.statusCb = null
        this.errorCb = null
    }
}
