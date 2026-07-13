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
import { translateText } from "../../utils/language"
import { autoLyrics, outLocked, outputs, shows, showsCache } from "../../stores"
import { AudioChunker } from "./audioChunker"
import { FollowEngine, type FollowSongContext } from "./followEngine"
import { hashSongText, songMapKey, songMapStore } from "./songMap"
import { AUTO_LYRICS_DEFAULTS, type AutoLyricsSettings, type AutoLyricsStatus } from "./types"

const MIC_RETRY_MS = 5000 // reconnect attempt interval after the mic drops
const SUGGESTION_TTL_MS = 15000 // a suggestion the operator ignores goes stale

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

    private reconnectTimer: NodeJS.Timeout | null = null
    private micErrorToasted = false
    private suggestionTimer: NodeJS.Timeout | null = null

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

        this.followEngine = new FollowEngine()
        this.followEngine.configure({ thresholdPct: this.settings.threshold, leadMs: this.settings.leadMs })
        this.followEngine.onDecision((d) => this.handleFollowDecision(d.slideIndex, d.confidence))
        this.followEngine.onRuntime((r) => autoLyrics.update((s) => ({ ...s, follow: r })))
        this.followEngine.onLearned(({ songName, firstPass }) => {
            this.updateSavedSongs()
            const key = firstPass ? "toast.auto_lyrics_learned" : "toast.auto_lyrics_refined"
            newToast(translateText(key) + (songName ? `: ${songName}` : ""))
        })

        this.chunker = new AudioChunker({
            onBlock: (pcm) => this.followEngine?.handleBlock(pcm),
            onError: (err) => this.handleMicError(err)
        })
        this.updateSavedSongs()
        this.watchNavigation()

        await this.tryStartMic()
    }

    disable() {
        this.active = false
        this.clearReconnect()
        this.micErrorToasted = false
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
        this.setSuggestion(null)
        autoLyrics.update((s) => ({ ...s, follow: null }))
    }

    private async tryStartMic() {
        const chunker = this.chunker
        if (!this.active || !chunker) return

        try {
            await chunker.start(this.settings.micId)
        } catch (err) {
            if (this.chunker === chunker) this.handleMicError(err instanceof Error ? err : new Error(String(err)))
            return
        }

        // disabled (or restarted with another mic) while the mic was being opened
        if (!this.active || this.chunker !== chunker) {
            chunker.stop()
            return
        }

        this.clearReconnect()
        if (this.micErrorToasted) newToast("toast.auto_lyrics_mic_back")
        this.micErrorToasted = false
        this.setStatus("listening")
    }

    // Mic could not start or dropped mid-service. Keep the follow engine (and any
    // in-progress learning pass) alive and retry — a USB interface coming back should
    // not require the operator to do anything.
    private handleMicError(err: Error) {
        if (!this.active) return
        console.error("Auto Lyrics:", err)

        this.chunker?.stop()
        autoLyrics.update((s) => ({ ...s, status: "error", errorMsg: err.message }))
        if (!this.micErrorToasted) {
            newToast("toast.auto_lyrics_error")
            this.micErrorToasted = true
        }

        // no permission: retrying would just re-trigger the system prompt
        if ((err as any)?.name === "NotAllowedError") return

        this.clearReconnect()
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            this.tryStartMic()
        }, MIC_RETRY_MS)
    }

    private clearReconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
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
            this.setSuggestion(null)
        } else {
            this.setSuggestion({ showId, slideIndex, label: this.slideLabel(showId, layoutId || "", slideIndex), confidence })
        }
    }

    // Suggestions expire on their own: if the operator ignored it, acting on it a
    // minute later (possibly during another verse) would be wrong.
    private setSuggestion(suggestion: { showId: string; slideIndex: number; label: string; confidence: number } | null) {
        if (this.suggestionTimer) clearTimeout(this.suggestionTimer)
        this.suggestionTimer = null

        autoLyrics.update((s) => (s.suggestion === suggestion ? s : { ...s, suggestion }))
        if (!suggestion) return

        this.suggestionTimer = setTimeout(() => {
            this.suggestionTimer = null
            autoLyrics.update((s) => (s.suggestion ? { ...s, suggestion: null } : s))
        }, SUGGESTION_TTL_MS)
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

    // Delete one learned song map. If it belongs to the song currently followed,
    // the engine reloads so it starts learning fresh instead of following a ghost.
    async forgetSong(showId: string, layoutId: string) {
        if (this.followEngine && showId === this.lastOutShowId && layoutId === (this.lastOutLayoutId || "")) {
            await this.followEngine.forgetCurrentSong()
        } else {
            await songMapStore.delete(songMapKey(showId, layoutId)).catch(() => null)
        }
        this.updateSavedSongs()
    }

    async setSongLocked(showId: string, layoutId: string, locked: boolean) {
        await songMapStore.setLocked(songMapKey(showId, layoutId), locked).catch(() => null)
        if (showId === this.lastOutShowId && layoutId === (this.lastOutLayoutId || "")) this.followEngine?.setCurrentMapLocked(locked)
    }

    async forgetAllSongs() {
        if (this.followEngine) await this.followEngine.forgetAllSongs()
        else await songMapStore.clearAll().catch(() => null)
        this.updateSavedSongs()
    }

    refreshSavedSongs() {
        this.updateSavedSongs()
    }

    confirmSuggestion() {
        const suggestion = get(autoLyrics).suggestion
        if (!suggestion) return false
        const out = this.getActiveOutput()
        this.navigateToSlide(suggestion.showId, out?.slide?.layout || "", suggestion.slideIndex)
        this.setSuggestion(null)
        return true
    }

    dismissSuggestion() {
        if (!get(autoLyrics).suggestion) return false
        this.setSuggestion(null)
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
            if (slideChanged && !this.selfNavigating && get(autoLyrics).suggestion) {
                this.setSuggestion(null)
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

export const autoLyricsController = new AutoLyricsControllerClass()
