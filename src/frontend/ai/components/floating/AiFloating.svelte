<script lang="ts">
    import { onDestroy } from "svelte"
    import { fade } from "svelte/transition"
    import Icon from "../../../components/helpers/Icon.svelte"
    import MaterialButton from "../../../components/inputs/MaterialButton.svelte"
    import MaterialToggleSwitch from "../../../components/inputs/MaterialToggleSwitch.svelte"
    import Tabs from "../../../components/main/Tabs.svelte"
    import { activePage, activePopup, ai, aiSmartAction, aiSttStatus, autoLyrics, language, mediaDownloads, popupData, settingsTab, special, sttTempDisabled, sttTranscript } from "../../../stores"
    import { translateText } from "../../../utils/language"
    import { audioLevelStore, resolveSttEngine, SpeechToText } from "../../stt/stt"
    import AiChat from "./AiChat.svelte"
    import AiRing from "./AiRing.svelte"
    import AiTranscription from "./AiTranscription.svelte"
    import AiVisual from "./AiVisual.svelte"
    import SmartAction from "./SmartAction.svelte"

    let state: "loading" | "inactive" | "error" | "listening" | "processing" = "loading"

    // Active tab state
    let activeTab: "transcription" | "chat" = "transcription"
    $: tabs = {
        transcription: { name: "ai.transcription", icon: "microphone" }
    }

    let isOpen = false
    function toggleExpand() {
        // close any visible actions
        aiSmartAction.set(null)

        setTimeout(() => (isOpen = !isOpen))

        if (!$sttTempDisabled) enableListening()
    }

    // try to enable every time a download finishes
    let downloadingCount = 0
    $: currentlyDownloading = $mediaDownloads
    $: if (state !== "listening" && currentlyDownloading) {
        if (currentlyDownloading.size < downloadingCount) enableListening()
        downloadingCount = currentlyDownloading.size
    }

    // word confirmation animation updates
    let wordConfirmTick = 0
    let wordConfirmDurationMs = 260
    let previousWordCount = -1
    let burstWords = 0
    let burstTimer: NodeJS.Timeout | null = null
    $: updateWordConfirmation($sttTranscript.finalized, $sttTranscript.unprocessed)

    function updateWordConfirmation(finalizedText: string, unprocessedText: string) {
        const fullText = (finalizedText + (finalizedText && unprocessedText ? " " : "") + unprocessedText).trim()
        const nextCount = countRegisteredWords(fullText)

        if (previousWordCount < 0) {
            previousWordCount = nextCount
            return
        }

        const newWords = nextCount - previousWordCount
        previousWordCount = nextCount
        if (newWords <= 0) return

        burstWords += newWords
        if (!burstTimer) {
            // merge nearby rapid words
            burstTimer = setTimeout(flushWordPulseBurst, 120)
        }
    }

    function flushWordPulseBurst() {
        const wordsInBurst = burstWords
        burstWords = 0
        burstTimer = null
        if (!wordsInBurst) return

        wordConfirmDurationMs = Math.min(800, 260 + Math.max(0, wordsInBurst - 1) * 120)
        wordConfirmTick += 1
    }

    function countRegisteredWords(text: string) {
        const words = text.match(/\S+/g)
        return words?.length || 0
    }

    // STATE & SYNCHRONIZATION
    $: isEnabled = $ai.enabled
    $: micDeviceId = $ai.stt?.micDeviceId

    let lastMic = ""
    let lastEngine = ""

    $: engineId = resolveEngineId($ai.stt?.engine, $language)
    function resolveEngineId(explicit: string | undefined, _locale: string): string {
        return explicit || resolveSttEngine()
    }

    let sessionToken = 0
    $: syncSession(isEnabled, micDeviceId, engineId)
    async function syncSession(enabled: boolean | undefined, mic: string | undefined, engine: string) {
        const currentLock = ++sessionToken
        const shouldBeActive = Boolean(enabled && mic)
        const micChanged = (mic || "") !== lastMic
        const engineChanged = engine !== lastEngine

        if (shouldBeActive) {
            const isCurrentlyActive = state === "listening" || state === "processing" || state === "loading"
            if (isCurrentlyActive && !micChanged && !engineChanged) return

            const wasInactive = state === "inactive"
            state = "loading"

            lastMic = mic || ""
            lastEngine = engine

            if (wasInactive) {
                const result = await SpeechToText.enable()
                if (currentLock !== sessionToken || result.aborted) return
                state = result.ok ? "listening" : "error"
            } else {
                const capture = micChanged ? await SpeechToText.restartCapture() : { ok: true }
                if (currentLock !== sessionToken || capture.aborted) return

                const engineResult = engineChanged ? await SpeechToText.restartEngine() : { ok: true }
                if (currentLock !== sessionToken || engineResult.aborted) return

                if (!capture.ok || !engineResult.ok) state = "error"
                else state = "listening"
            }
            return
        }

        lastMic = mic || ""
        lastEngine = engine

        if (state !== "inactive") {
            SpeechToText.disable()
            if (currentLock === sessionToken) {
                state = "inactive"
            }
        }
    }

    $: if (state === "listening" && $aiSttStatus.state === "error") {
        state = "error"
        SpeechToText.stopCapture()
    }

    $: audioLevel = $audioLevelStore

    onDestroy(() => {
        if (burstTimer) clearTimeout(burstTimer)
        if (state !== "inactive") SpeechToText.disable()
    })

    // LISTEN TOGGLE
    function toggleListening() {
        if (isListening) {
            sttTempDisabled.set(true)
            SpeechToText.stopCapture()
            state = "inactive"
        } else {
            sttTempDisabled.set(false)
            enableListening()
        }
    }

    $: isListening = state === "listening"
    $: isStarting = state === "processing"

    async function enableListening() {
        if (isStarting || !isEnabled || !micDeviceId) return
        if (isListening) return

        const result = await SpeechToText.enable()
        if (result.aborted) return
        if (isEnabled && micDeviceId) state = result.ok ? "listening" : "error"
    }

    function openSettings() {
        isOpen = false
        settingsTab.set("ai")
        activePage.set("settings")
    }

    // AUTO LYRICS BADGE (shares this circle instead of its own pill)
    $: lyricsEnabled = !!$special.autoLyrics?.enabled
    $: lyricsError = lyricsEnabled && $autoLyrics.status === "error"
    $: lyricsLive = lyricsEnabled && $autoLyrics.status === "listening"
    $: lyricsFollow = lyricsLive ? $autoLyrics.follow : null
    $: showLyricsBadge = !isOpen && (lyricsLive || lyricsError)

    function formatLyricsTime(totalSeconds: number) {
        const m = Math.floor(totalSeconds / 60)
        const s = Math.floor(totalSeconds % 60)
        return `${m}:${s.toString().padStart(2, "0")}`
    }

    $: lyricsTitle = lyricsError
        ? $autoLyrics.errorMsg || "Error"
        : lyricsFollow
          ? `${lyricsFollow.songName || ""}\n${translateText(`settings.auto_lyrics_follow_${lyricsFollow.state}`)}${lyricsFollow.state === "learning" ? ` · ${formatLyricsTime(lyricsFollow.passSeconds || 0)}` : lyricsFollow.state === "following" || lyricsFollow.state === "lost" ? ` · ${translateText("settings.auto_lyrics_slide")} ${lyricsFollow.slideIndex + 1}/${lyricsFollow.slideCount} · ${lyricsFollow.confidence}%` : ""}${lyricsFollow.held ? `\n${translateText("settings.auto_lyrics_holding")}` : ""}`
          : translateText("settings.auto_lyrics_waiting_song")

    function openLyricsPopup(e: MouseEvent) {
        e.stopPropagation()
        popupData.set({})
        activePopup.set("auto_lyrics")
    }
</script>

<svelte:window on:keydown={(e) => isOpen && e.key === "Escape" && toggleExpand()} />

{#if isOpen}
    <div class="backdrop" on:mousedown|self={toggleExpand} transition:fade={{ duration: 250 }}></div>
{/if}

{#if !isOpen && state !== "inactive"}
    <SmartAction />
{/if}

<div class="speech-widget {isOpen ? 'is-open' : 'is-closed'}">
    {#if showLyricsBadge}
        <button class="lyrics-badge state-{lyricsFollow?.state || 'idle'}" class:error={lyricsError} title={lyricsTitle} on:click={openLyricsPopup} aria-label="Auto Lyrics">
            <Icon id="lyrics" size={0.85} white />
        </button>
    {/if}
    <AiRing {state} {audioLevel} borderRadius={isOpen ? "20px" : "50%"} opacity={state === "inactive" || isOpen ? 0.8 : 0.4} fill {wordConfirmTick} {wordConfirmDurationMs}>
        {#if !isOpen}
            <AiVisual {state} on:click={toggleExpand} />
        {:else}
            <div class="modal-view" transition:fade={{ duration: 100 }}>
                <div class="card-header">
                    <Tabs {tabs} bind:active={activeTab} />

                    <div class="headerActions">
                        {#if activeTab === "transcription"}
                            <MaterialToggleSwitch label="" checked={isListening} disabled={state !== "inactive" && state !== "listening"} style="margin-right: 5px;" on:change={toggleListening} small />
                        {/if}

                        <MaterialButton icon="settings" title="menu.settings" style="padding: 10px;" on:click={openSettings} />

                        <MaterialButton class="popup-close" icon="close" iconSize={1.2} title="actions.close" style="padding: 8px;" on:click={toggleExpand} />
                    </div>
                </div>

                {#if activeTab === "transcription"}
                    <AiTranscription {state} />
                {:else if activeTab === "chat"}
                    <AiChat />
                {/if}
            </div>
        {/if}
    </AiRing>
</div>

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(8px);
        z-index: 5000;
    }

    .speech-widget {
        position: fixed;
        z-index: 5000;
        font-family:
            system-ui,
            -apple-system,
            sans-serif;
        transition:
            top 0.4s cubic-bezier(0.16, 1, 0.3, 1),
            left 0.4s cubic-bezier(0.16, 1, 0.3, 1),
            right 0.4s cubic-bezier(0.16, 1, 0.3, 1),
            bottom 0.4s cubic-bezier(0.16, 1, 0.3, 1),
            width 0.4s cubic-bezier(0.16, 1, 0.3, 1),
            height 0.4s cubic-bezier(0.16, 1, 0.3, 1),
            transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .speech-widget.is-closed {
        bottom: 45px;
        right: 45px;
        width: 62px;
        height: 62px;
        transform: translate(0, 0);
    }

    /* auto-lyrics status badge sharing the STT circle (no separate pill) */
    .lyrics-badge {
        position: absolute;
        top: -7px;
        left: -7px;
        z-index: 2;

        width: 26px;
        height: 26px;
        border-radius: 50%;
        background-color: rgb(17 24 39 / 0.95);
        border: 2px solid #888;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
        cursor: pointer;

        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        color: inherit;
    }
    .lyrics-badge:hover {
        transform: scale(1.12);
    }
    .lyrics-badge.state-ready {
        border-color: #7cc7ff;
    }
    .lyrics-badge.state-learning {
        border-color: #e0a800;
        animation: lyricsPulse 1.2s ease-in-out infinite;
    }
    .lyrics-badge.state-following {
        border-color: #54c469;
    }
    .lyrics-badge.state-lost {
        border-color: #888;
    }
    .lyrics-badge.error {
        border-color: #ff5050;
    }
    @keyframes lyricsPulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.45;
        }
    }
    .speech-widget.is-open {
        bottom: 50%;
        right: 50%;
        transform: translate(50%, 50%);
        width: 560px;
        height: 400px;
        max-width: 90vw;
        max-height: 85vh;
    }

    .modal-view {
        display: flex;
        flex-direction: column;
        height: 100%;
    }

    .card-header {
        padding: 5px 10px 5px 15px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid #1e293b;
        background-color: rgb(0 0 0 / 0.1);
    }

    .card-header :global(.tabs) {
        background-color: transparent;
    }
    .card-header :global(.tabs button) {
        padding: 8px 12px;
    }
    .card-header :global(.tabs button.isActive) {
        background-color: rgb(0 0 0 / 0.15) !important;
    }

    .headerActions {
        display: flex;
        align-items: center;
        gap: 2px;
    }
</style>
