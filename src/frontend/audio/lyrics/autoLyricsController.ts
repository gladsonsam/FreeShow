// Orchestrates the auto-lyrics feature: mic capture -> transcription -> matching -> action.
//
// Lifecycle is driven by the "special.autoLyrics" settings (applySettings) and the runtime
// state is published to the "autoLyrics" store for the UI. Designed to run continuously during
// a live service without blocking the main thread (inference is offloaded by the engine).

import { get } from "svelte/store"
import { newToast } from "../../utils/common"
import { _show } from "../../components/helpers/shows"
import { setOutput } from "../../components/helpers/output"
import { updateOut } from "../../components/helpers/showActions"
import { autoLyrics, outLocked, outputs } from "../../stores"
import { AudioChunker } from "./audioChunker"
import { FingerprintEngine } from "./FingerprintEngine"
import { createTranscriber } from "./LyricsTranscriber"
import { LyricsMatcher } from "./lyricsMatcher"
import { AUTO_LYRICS_DEFAULTS, type AutoLyricsSettings, type AutoLyricsStatus, type LyricsTranscriber } from "./types"

class AutoLyricsControllerClass {
    private settings: AutoLyricsSettings = { ...AUTO_LYRICS_DEFAULTS }
    private chunker: AudioChunker | null = null
    private transcriber: LyricsTranscriber | null = null
    private matcher = new LyricsMatcher()
    private fpEngine: FingerprintEngine | null = null
    private active = false

    private selfNavigating = false
    private lastOutIndex: number | null = null
    private lastOutShowId: string | null = null
    private outputsUnsub: (() => void) | null = null

    async applySettings(next: Partial<AutoLyricsSettings> | undefined) {
        const prev = this.settings
        this.settings = { ...AUTO_LYRICS_DEFAULTS, ...(next || {}) }

        if (!this.settings.enabled) {
            if (this.active) this.disable()
            return
        }

        const needsRestart = this.active && (prev.micId !== this.settings.micId || prev.model !== this.settings.model || prev.engine !== this.settings.engine || prev.language !== this.settings.language)
        if (needsRestart) this.disable()

        if (!this.active) await this.enable()
    }

    async enable() {
        if (this.active) return
        this.active = true
        this.matcher.reset()
        this.setStatus("loading-model")

        try {
            if (this.settings.engine === "fingerprint") {
                await this.enableFingerprint()
            } else {
                await this.enableTranscriber()
            }
            this.watchNavigation()
            this.setStatus("listening")
        } catch (err) {
            this.fail(err instanceof Error ? err.message : String(err))
        }
    }

    private async enableTranscriber() {
        this.transcriber = createTranscriber(this.settings.engine)
        this.transcriber.onError((err) => this.fail(err.message))
        this.transcriber.onTranscript((chunk) => this.handleTranscript(chunk.text))
        await this.transcriber.init({ model: this.settings.model, language: this.settings.language })

        if (!this.transcriber.handlesOwnCapture) {
            this.chunker = new AudioChunker({
                onWindow: (pcm, sampleRate) => this.transcriber?.feed(pcm, sampleRate),
                onError: (err) => this.fail(err.message)
            })
            await this.chunker.start(this.settings.micId)
        }
        this.transcriber.start()
    }

    private async enableFingerprint() {
        this.fpEngine = new FingerprintEngine()
        this.fpEngine.onDecision((d) => this.handleFingerprintDecision(d.showId, d.slideIndex, d.confidence))
        this.fpEngine.onScore((score) => autoLyrics.update((s) => (s.fpScore === score ? s : { ...s, fpScore: score })))

        // seed the engine with the current slide so it starts learning immediately
        const out = this.getActiveOutput()
        if (out?.slide?.id) {
            this.fpEngine.reset()
            this.fpEngine.notifySlide(out.slide.id, out.slide.index ?? 0, performance.now())
            this.lastOutShowId = out.slide.id
            this.lastOutIndex = out.slide.index ?? 0
        }
        this.updateLearnedCount()

        this.chunker = new AudioChunker({
            onWindow: (pcm) => {
                this.fpEngine?.handleChunk(pcm, performance.now())
                this.updateLearnedCount()
            },
            onError: (err) => this.fail(err.message)
        })
        await this.chunker.start(this.settings.micId)
    }

    disable() {
        this.active = false
        this.chunker?.stop()
        this.chunker = null
        this.transcriber?.dispose()
        this.transcriber = null
        this.fpEngine = null
        this.outputsUnsub?.()
        this.outputsUnsub = null
        this.lastOutIndex = null
        this.lastOutShowId = null
        this.setStatus("off")
        autoLyrics.update((s) => ({ ...s, suggestion: null }))
    }

    private fail(msg: string) {
        console.error("Auto Lyrics:", msg)
        this.chunker?.stop()
        this.chunker = null
        this.transcriber?.dispose()
        this.transcriber = null
        this.fpEngine = null
        this.active = false
        autoLyrics.update((s) => ({ ...s, status: "error", errorMsg: msg, suggestion: null }))
        newToast("toast.auto_lyrics_error")
    }

    private setStatus(status: AutoLyricsStatus) {
        autoLyrics.update((s) => ({ ...s, status, errorMsg: undefined }))
    }

    private updateLearnedCount() {
        const count = this.fpEngine?.learnedCount ?? 0
        autoLyrics.update((s) => (s.learnedCount === count ? s : { ...s, learnedCount: count }))
    }

    private getActiveOutput(): { id: string; slide: any } | null {
        const all = get(outputs)
        const entries = Object.entries(all).filter(([, o]: any) => o?.enabled && !o?.stageOutput)
        const active = entries.find(([, o]: any) => o?.active) || entries[0]
        if (!active) return null
        return { id: active[0], slide: (active[1] as any)?.out?.slide }
    }

    private handleTranscript(text: string) {
        autoLyrics.update((s) => ({ ...s, lastTranscript: text }))

        const out = this.getActiveOutput()
        const slide = out?.slide
        const decision = this.matcher.evaluate({
            transcript: text,
            currentShowId: slide?.id || "",
            currentLayoutId: slide?.layout || "",
            currentIndex: slide?.index ?? -1,
            detectSongSwitch: this.settings.detectSongSwitch,
            threshold: this.settings.threshold,
            stableWindows: this.settings.stableWindows,
            cooldownMs: this.settings.cooldownMs,
            now: performance.now()
        })

        if (decision.type === "none") return

        if (decision.type === "different-song") {
            newToast("toast.auto_lyrics_song_switch")
            autoLyrics.update((s) => ({ ...s, suggestion: decision }))
            this.matcher.notifyNavigation(performance.now(), this.settings.cooldownMs)
            return
        }

        if (this.settings.mode === "auto") {
            this.navigateToSlide(decision.showId, slide?.layout || "", decision.slideIndex!)
            autoLyrics.update((s) => ({ ...s, suggestion: null }))
        } else {
            autoLyrics.update((s) => ({ ...s, suggestion: decision }))
        }
    }

    private handleFingerprintDecision(showId: string, slideIndex: number, confidence: number) {
        const out = this.getActiveOutput()
        const layout = out?.slide?.layout || ""
        const label = `Slide ${slideIndex + 1}`
        const suggestion = { type: "same-show-slide" as const, showId, slideIndex, label, confidence }

        if (this.settings.mode === "auto") {
            this.navigateToSlide(showId, layout, slideIndex)
            autoLyrics.update((s) => ({ ...s, suggestion: null }))
        } else {
            autoLyrics.update((s) => ({ ...s, suggestion }))
        }
    }

    confirmSuggestion() {
        const suggestion = get(autoLyrics).suggestion
        if (!suggestion) return false
        if (suggestion.type === "same-show-slide" && suggestion.slideIndex !== undefined) {
            const out = this.getActiveOutput()
            this.navigateToSlide(suggestion.showId, out?.slide?.layout || "", suggestion.slideIndex)
        }
        autoLyrics.update((s) => ({ ...s, suggestion: null }))
        return true
    }

    dismissSuggestion() {
        if (!get(autoLyrics).suggestion) return false
        autoLyrics.update((s) => ({ ...s, suggestion: null }))
        return true
    }

    clearFingerprints() {
        this.fpEngine?.clearCurrentShow()
        this.updateLearnedCount()
    }

    private navigateToSlide(showId: string, layoutId: string, index: number) {
        if (get(outLocked)) return
        const out = this.getActiveOutput()
        const outputId = out?.id || ""
        const layout = layoutId || _show(showId).get("settings")?.activeLayout
        const layoutRef = _show(showId).layouts([layout]).ref()[0]
        if (!layoutRef) return

        this.selfNavigating = true
        setOutput("slide", { id: showId, layout, index }, false, outputId)
        updateOut(showId, index, layoutRef, true, outputId)

        this.matcher.notifyNavigation(performance.now(), this.settings.cooldownMs)
        this.lastOutIndex = index
        setTimeout(() => (this.selfNavigating = false), 100)
    }

    private watchNavigation() {
        this.outputsUnsub = outputs.subscribe(() => {
            const out = this.getActiveOutput()
            const slide = out?.slide
            const index = slide?.index ?? null
            const showId = slide?.id || ""
            if (index === null) return

            const slideChanged = index !== this.lastOutIndex || showId !== this.lastOutShowId

            if (slideChanged && !this.selfNavigating) {
                // notify text matcher to back off
                this.matcher.notifyNavigation(performance.now(), this.settings.cooldownMs)
                autoLyrics.update((s) => ({ ...s, suggestion: null }))
            }

            // notify fingerprint engine of every slide change (learns from manual navigation too)
            if (slideChanged && this.fpEngine && showId) {
                this.fpEngine.notifySlide(showId, index, performance.now())
                this.updateLearnedCount()
            }

            this.lastOutIndex = index
            this.lastOutShowId = showId
        })
    }

    isActive() {
        return this.active
    }
}

export const autoLyricsController = new AutoLyricsControllerClass()
