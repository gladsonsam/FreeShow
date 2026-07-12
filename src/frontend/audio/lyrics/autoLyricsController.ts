// Orchestrates the auto-lyrics feature: mic capture -> Learn & Follow engine ->
// decision -> navigation/suggestion.
//
// Lifecycle is driven by the "special.autoLyrics" settings (applySettings) and the runtime
// state is published to the "autoLyrics" store for the UI. Designed to run continuously
// during a live service without blocking the main thread.

import { get } from "svelte/store"
import { getTextLines } from "../../components/edit/scripts/textStyle"
import { setOutput } from "../../components/helpers/output"
import { updateOut } from "../../components/helpers/showActions"
import { _show } from "../../components/helpers/shows"
import { newToast } from "../../utils/common"
import { autoLyrics, outLocked, outputs, shows, showsCache } from "../../stores"
import { AudioChunker } from "./audioChunker"
import { FollowEngine, type FollowSongContext } from "./followEngine"
import { hashSongText, songMapStore } from "./songMap"
import { AUTO_LYRICS_DEFAULTS, type AutoLyricsSettings, type AutoLyricsStatus } from "./types"

class AutoLyricsControllerClass {
    private settings: AutoLyricsSettings = { ...AUTO_LYRICS_DEFAULTS }
    private chunker: AudioChunker | null = null
    private followEngine: FollowEngine | null = null
    private active = false

    private selfNavigating = false
    private lastOutIndex: number | null = null
    private lastOutShowId: string | null = null
    private lastOutLayoutId: string | null = null
    private outputsUnsub: (() => void) | null = null

    async applySettings(next: Partial<AutoLyricsSettings> | undefined) {
        const prev = this.settings
        this.settings = { ...AUTO_LYRICS_DEFAULTS, ...(next || {}) }

        if (!this.settings.enabled) {
            if (this.active) this.disable()
            return
        }

        const needsRestart = this.active && prev.micId !== this.settings.micId
        if (needsRestart) this.disable()

        // live-tunable settings
        this.followEngine?.configure({ thresholdPct: this.settings.threshold, leadMs: this.settings.leadMs })

        if (!this.active) await this.enable()
    }

    async enable() {
        if (this.active) return
        this.active = true
        this.setStatus("loading-model")

        try {
            cleanupLegacyFingerprints()

            this.followEngine = new FollowEngine()
            this.followEngine.configure({ thresholdPct: this.settings.threshold, leadMs: this.settings.leadMs })
            this.followEngine.onDecision((d) => this.handleFollowDecision(d.slideIndex, d.confidence))
            this.followEngine.onRuntime((r) => autoLyrics.update((s) => ({ ...s, follow: r })))

            this.chunker = new AudioChunker({
                onBlock: (pcm) => this.followEngine?.handleBlock(pcm),
                onError: (err) => this.fail(err.message)
            })
            await this.chunker.start(this.settings.micId)
            this.updateSavedSongs()

            this.watchNavigation()
            this.setStatus("listening")
        } catch (err) {
            this.fail(err instanceof Error ? err.message : String(err))
        }
    }

    disable() {
        this.active = false
        this.chunker?.stop()
        this.chunker = null
        this.followEngine?.dispose()
        this.followEngine = null
        this.outputsUnsub?.()
        this.outputsUnsub = null
        this.lastOutIndex = null
        this.lastOutShowId = null
        this.lastOutLayoutId = null
        this.setStatus("off")
        autoLyrics.update((s) => ({ ...s, suggestion: null, follow: null }))
    }

    private fail(msg: string) {
        console.error("Auto Lyrics:", msg)
        this.chunker?.stop()
        this.chunker = null
        this.followEngine?.dispose()
        this.followEngine = null
        this.active = false
        autoLyrics.update((s) => ({ ...s, status: "error", errorMsg: msg, suggestion: null, follow: null }))
        newToast("toast.auto_lyrics_error")
    }

    private setStatus(status: AutoLyricsStatus) {
        autoLyrics.update((s) => ({ ...s, status, errorMsg: undefined }))
    }

    private updateSavedSongs() {
        songMapStore
            .count()
            .then((count) => autoLyrics.update((s) => (s.savedSongs === count ? s : { ...s, savedSongs: count })))
            .catch(() => null)
    }

    private getActiveOutput(): { id: string; slide: any } | null {
        const all = get(outputs)
        const entries = Object.entries(all).filter(([, o]: any) => o?.enabled && !o?.stageOutput)
        const active = entries.find(([, o]: any) => o?.active) || entries[0]
        if (!active) return null
        return { id: active[0], slide: (active[1] as any)?.out?.slide }
    }

    private buildSongContext(): FollowSongContext | null {
        const out = this.getActiveOutput()
        const slide = out?.slide
        if (!slide?.id) return null

        const showId: string = slide.id
        const show = get(showsCache)[showId]
        if (!show) return null

        const layoutId: string = slide.layout || show.settings?.activeLayout || ""
        const layoutRef = _show(showId).layouts([layoutId]).ref()[0] || []
        if (!layoutRef.length) return null

        const texts = layoutRef.map((ref) => getTextLines(show.slides?.[ref.id] || { items: [] }).join("\n"))
        return {
            showId,
            layoutId,
            slideCount: layoutRef.length,
            textHash: hashSongText(texts),
            songName: show.name || (get(shows)[showId] as any)?.name || "",
            outputIndex: slide.index ?? 0
        }
    }

    private handleFollowDecision(slideIndex: number, confidence: number) {
        const showId = this.lastOutShowId
        const layoutId = this.lastOutLayoutId
        if (!showId) return

        if (this.settings.mode === "auto") {
            this.navigateToSlide(showId, layoutId || "", slideIndex)
            autoLyrics.update((s) => ({ ...s, suggestion: null }))
        } else {
            const suggestion = { showId, slideIndex, label: this.slideLabel(showId, layoutId || "", slideIndex), confidence }
            autoLyrics.update((s) => ({ ...s, suggestion }))
        }
    }

    private slideLabel(showId: string, layoutId: string, index: number): string {
        const show = get(showsCache)[showId]
        const ref = (_show(showId).layouts([layoutId]).ref()[0] || [])[index]
        const firstLine = ref ? getTextLines(show?.slides?.[ref.id] || { items: [] }).find((l) => !!l) : ""
        return firstLine || `Slide ${index + 1}`
    }

    async forgetCurrentSong() {
        await this.followEngine?.forgetCurrentSong()
        this.updateSavedSongs()
    }

    async forgetAllSongs() {
        if (this.followEngine) await this.followEngine.forgetAllSongs()
        else await songMapStore.clearAll().catch(() => null)
        this.updateSavedSongs()
    }

    confirmSuggestion() {
        const suggestion = get(autoLyrics).suggestion
        if (!suggestion) return false
        const out = this.getActiveOutput()
        this.navigateToSlide(suggestion.showId, out?.slide?.layout || "", suggestion.slideIndex)
        autoLyrics.update((s) => ({ ...s, suggestion: null }))
        return true
    }

    dismissSuggestion() {
        if (!get(autoLyrics).suggestion) return false
        autoLyrics.update((s) => ({ ...s, suggestion: null }))
        return true
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

        this.lastOutIndex = index
        setTimeout(() => (this.selfNavigating = false), 100)
    }

    private watchNavigation() {
        this.outputsUnsub = outputs.subscribe(() => {
            const out = this.getActiveOutput()
            const slide = out?.slide
            const index = slide?.index ?? null
            const showId = slide?.id || ""
            const layoutId = slide?.layout || ""

            const songChanged = showId !== this.lastOutShowId || (!!showId && layoutId !== this.lastOutLayoutId)
            const slideChanged = index !== this.lastOutIndex || songChanged

            // drop any stale suggestion when the operator navigates
            if (slideChanged && !this.selfNavigating) {
                autoLyrics.update((s) => (s.suggestion ? { ...s, suggestion: null } : s))
            }

            if (this.followEngine) {
                if (songChanged) {
                    const ctx = showId ? this.buildSongContext() : null
                    this.followEngine.setSong(ctx).then(() => this.updateSavedSongs())
                } else if (slideChanged && index !== null) {
                    this.followEngine.notifySlide(index, !this.selfNavigating)
                }
            }

            this.lastOutIndex = index
            this.lastOutShowId = showId || null
            this.lastOutLayoutId = layoutId || null
        })
    }

    isActive() {
        return this.active
    }
}

// remove data stored by the old (pre-rework) fingerprint engine
function cleanupLegacyFingerprints() {
    try {
        const stale: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (key && (key.startsWith("fs_fp_") || key.startsWith("fs_fp2_"))) stale.push(key)
        }
        stale.forEach((key) => localStorage.removeItem(key))
    } catch (err) {
        // localStorage unavailable — nothing to clean
    }
}

export const autoLyricsController = new AutoLyricsControllerClass()
