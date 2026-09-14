<script lang="ts">
    import { onDestroy, onMount } from "svelte"
    import { AudioMicrophone } from "../../../audio/audioMicrophone"
    import { autoLyricsController } from "../../../audio/lyrics/autoLyricsController"
    import { cueRecorder, cueRecording } from "../../../audio/lyrics/harness/cueRecorder"
    import { mapCoveredSlides, type SongMap } from "../../../audio/lyrics/songMap"
    import { songMapStore } from "../../../audio/lyrics/songMap"
    import { AUTO_LYRICS_DEFAULTS, type AutoLyricsSettings } from "../../../audio/lyrics/types"
    import { activePage, activePopup, activeShow, autoLyrics, isDev, shows, showsCache, special } from "../../../stores"
    import { translateText } from "../../../utils/language"
    import Icon from "../../helpers/Icon.svelte"
    import T from "../../helpers/T.svelte"
    import { dateToString } from "../../helpers/time"
    import HRule from "../../input/HRule.svelte"
    import MaterialButton from "../../inputs/MaterialButton.svelte"
    import MaterialDropdown from "../../inputs/MaterialDropdown.svelte"
    import MaterialNumberInput from "../../inputs/MaterialNumberInput.svelte"
    import MaterialToggleSwitch from "../../inputs/MaterialToggleSwitch.svelte"

    $: settings = { ...AUTO_LYRICS_DEFAULTS, ...($special.autoLyrics || {}) } as AutoLyricsSettings

    function update(key: keyof AutoLyricsSettings, value: any) {
        special.update((a) => {
            a.autoLyrics = { ...AUTO_LYRICS_DEFAULTS, ...(a.autoLyrics || {}), [key]: value }
            return a
        })
        autoLyricsController.applySettings(($special as any).autoLyrics)
    }

    // MICROPHONES

    let micOptions = [{ label: "—", value: "" }]
    async function loadMics() {
        try {
            const list = await AudioMicrophone.getList()
            micOptions = [{ label: translateText("settings.auto_lyrics_default_mic"), value: "" }, ...list.map((d) => ({ label: d.label || d.deviceId, value: d.deviceId }))]
        } catch (err) {
            console.error(err)
        }
    }

    onMount(() => {
        loadMics()
        loadSongs()
        navigator.mediaDevices?.addEventListener?.("devicechange", loadMics)
    })
    onDestroy(() => {
        navigator.mediaDevices?.removeEventListener?.("devicechange", loadMics)
        if (recordingTimer) clearInterval(recordingTimer)
    })

    const modeOptions = [
        { label: translateText("settings.auto_lyrics_suggest"), value: "suggest" },
        { label: translateText("settings.auto_lyrics_auto"), value: "auto" }
    ]

    // LIVE STATE

    $: statusText = translateText(`settings.auto_lyrics_status_${$autoLyrics.status.replace("-", "_")}`)
    $: follow = $autoLyrics.follow
    $: followStateText = follow && follow.state !== "idle" ? translateText(`settings.auto_lyrics_follow_${follow.state}`) : ""

    function formatTime(totalSeconds: number) {
        const m = Math.floor(totalSeconds / 60)
        const s = Math.floor(totalSeconds % 60)
        return `${m}:${s.toString().padStart(2, "0")}`
    }

    // DEVELOPMENT CUE RECORDER

    let cueError = ""
    let recorderNow = performance.now()
    let recordingTimer: NodeJS.Timeout | null = null
    $: cueElapsedMs = $cueRecording.startedAt ? Math.max(0, ($cueRecording.recording ? recorderNow : $cueRecording.stoppedAt) - $cueRecording.startedAt) : 0
    $: if ($cueRecording.recording && !recordingTimer) {
        recordingTimer = setInterval(() => (recorderNow = performance.now()), 250)
    } else if (!$cueRecording.recording && recordingTimer) {
        clearInterval(recordingTimer)
        recordingTimer = null
    }

    function startCueRecording() {
        cueError = ""
        try {
            cueRecorder.start()
            recorderNow = performance.now()
        } catch (err) {
            cueError = err instanceof Error ? err.message : String(err)
        }
    }

    function exportRecordedCues() {
        cueError = ""
        try {
            cueRecorder.download()
        } catch (err) {
            cueError = err instanceof Error ? err.message : String(err)
        }
    }

    // LEARNED SONGS

    let songMaps: SongMap[] = []
    let songsLoaded = false
    async function loadSongs() {
        try {
            songMaps = (await songMapStore.getAll()).sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0))
        } catch (err) {
            console.error("Auto Lyrics: could not list song maps", err)
        }
        songsLoaded = true
    }

    // reload when a song gets learned/updated while the popup is open
    // (the store updates constantly while listening — only react to the count changing)
    let lastSavedCount = -1
    $: if (($autoLyrics.savedSongs ?? 0) !== lastSavedCount) {
        lastSavedCount = $autoLyrics.savedSongs ?? 0
        loadSongs()
    }

    $: orphaned = songMaps.filter((map) => !$shows[map.showId])

    // a show can have one map per layout — disambiguate those rows
    $: layoutCounts = songMaps.reduce((counts: { [showId: string]: number }, map) => ({ ...counts, [map.showId]: (counts[map.showId] || 0) + 1 }), {})
    function layoutLabel(map: SongMap) {
        if ((layoutCounts[map.showId] || 0) < 2) return ""
        return $showsCache[map.showId]?.layouts?.[map.layoutId]?.name || translateText("tools.layout")
    }

    async function deleteSong(map: SongMap) {
        await autoLyricsController.forgetSong(map.showId, map.layoutId)
        loadSongs()
    }

    async function toggleLock(map: SongMap) {
        await autoLyricsController.setSongLocked(map.showId, map.layoutId, !map.locked)
        loadSongs()
    }

    async function cleanupOrphans() {
        await Promise.all(orphaned.map((map) => songMapStore.delete(map.key).catch(() => null)))
        autoLyricsController.refreshSavedSongs()
        loadSongs()
    }

    let confirmForgetAll = false
    let confirmTimeout: NodeJS.Timeout | null = null
    async function forgetAll() {
        if (!confirmForgetAll) {
            confirmForgetAll = true
            confirmTimeout = setTimeout(() => (confirmForgetAll = false), 3000)
            return
        }

        if (confirmTimeout) clearTimeout(confirmTimeout)
        confirmForgetAll = false
        await autoLyricsController.forgetAllSongs()
        loadSongs()
    }

    // dumps a learned map's marks as a fixture cue sheet for scripts/autoLyricsHarness.ts
    function exportCueSheet(map: SongMap) {
        const sheet = {
            songName: $shows[map.showId]?.name || map.showId,
            slideCount: map.slideCount,
            cues: map.marks.map((mark) => ({ timeMs: Math.round((mark.frame / map.fps) * 1000), slideIndex: mark.slideIndex }))
        }

        const url = URL.createObjectURL(new Blob([JSON.stringify(sheet, null, 2)], { type: "application/json" }))
        const link = document.createElement("a")
        link.href = url
        link.download = "cues.json"
        link.click()
        URL.revokeObjectURL(url)
    }

    function openShow(map: SongMap) {
        if (!$shows[map.showId]) return
        activeShow.set({ id: map.showId, type: "show" })
        activePage.set("show")
        activePopup.set(null)
    }
</script>

<MaterialToggleSwitch label="settings.auto_lyrics_enable" checked={settings.enabled} defaultValue={false} on:change={(e) => update("enabled", e.detail)} />

{#if settings.enabled}
    <div class="status" class:error={$autoLyrics.status === "error"}>
        <span class="dot status-{$autoLyrics.status}"></span>
        <span class="state">{statusText}</span>
        {#if $autoLyrics.status === "error" && $autoLyrics.errorMsg}<span class="msg">({$autoLyrics.errorMsg})</span>{/if}

        {#if follow && follow.state !== "idle"}
            <span class="divider">·</span>
            <span class="dot {follow.state}"></span>
            <span class="state">{followStateText}</span>
            {#if follow.songName}<span class="song">{follow.songName}</span>{/if}
            {#if follow.state === "learning"}
                <span class="detail">{formatTime(follow.passSeconds || 0)}</span>
                {#if follow.passUsable}<span class="detail ok"><Icon id="check" size={0.8} /> <T id="settings.auto_lyrics_pass_ok" /></span>{/if}
            {:else if follow.state === "following" || follow.state === "lost"}
                <span class="detail">{translateText("settings.auto_lyrics_slide")} {follow.slideIndex + 1}/{follow.slideCount} · {follow.confidence}%</span>
            {/if}
        {/if}
    </div>

    <div class="note"><T id="settings.auto_lyrics_follow_note" /></div>

    <MaterialDropdown label="settings.auto_lyrics_mode" value={settings.mode} options={modeOptions} on:change={(e) => update("mode", e.detail)} />
    <MaterialDropdown label="settings.auto_lyrics_mic" value={settings.micId} options={micOptions} allowEmpty on:change={(e) => update("micId", e.detail)} />
    <MaterialNumberInput label="settings.auto_lyrics_lead" value={settings.leadMs} defaultValue={AUTO_LYRICS_DEFAULTS.leadMs} min={-1000} max={2000} step={100} on:change={(e) => update("leadMs", e.detail)} />
    <MaterialNumberInput label="settings.auto_lyrics_threshold" value={settings.threshold} defaultValue={AUTO_LYRICS_DEFAULTS.threshold} min={10} max={100} step={5} on:change={(e) => update("threshold", e.detail)} />
{/if}

{#if $isDev}
    <HRule title="Cue sheet recorder (test harness)" />
    <div class="cueRecorder">
        <div class="recorderStatus" class:recording={$cueRecording.recording}>
            <span class="dot"></span>
            <strong>{$cueRecording.recording ? "Recording slide changes" : $cueRecording.cues.length ? "Recording stopped" : "Ready to record"}</strong>
            {#if $cueRecording.startedAt}<span>{formatTime(cueElapsedMs / 1000)} · {$cueRecording.cues.length} cues</span>{/if}
            {#if $cueRecording.songName}<span>· {$cueRecording.songName}</span>{/if}
        </div>
        <p class="recorderHelp">Put the first lyric slide on the audience output, start recording, play the MP3, then run the slideshow normally. You may close this popup while recording.</p>
        {#if cueError}<p class="recorderError">{cueError}</p>{/if}
        <div class="recorderActions">
            {#if $cueRecording.recording}
                <MaterialButton variant="contained" on:click={() => cueRecorder.stop()} red>Stop recording</MaterialButton>
            {:else}
                <MaterialButton variant="contained" on:click={startCueRecording}>Start recording</MaterialButton>
            {/if}
            <MaterialButton on:click={exportRecordedCues} disabled={$cueRecording.cues.length < 2}>Export cues.json</MaterialButton>
            {#if $cueRecording.cues.length}<MaterialButton on:click={() => cueRecorder.reset()}>Discard</MaterialButton>{/if}
        </div>
    </div>
{/if}

<HRule title="settings.auto_lyrics_saved_songs" />

{#if songMaps.length}
    <div class="songs">
        {#each songMaps as map (map.key)}
            {@const showName = $shows[map.showId]?.name}
            {@const layout = layoutLabel(map)}
            <div class="songRow" class:orphan={!showName}>
                <button class="name" disabled={!showName} on:click={() => openShow(map)}>
                    <Icon id="lyrics" size={0.9} />
                    <span class="text">{showName || translateText("settings.auto_lyrics_deleted_show")}</span>
                    {#if layout}<span class="layout">{layout}</span>{/if}
                </button>

                <span class="meta">
                    {formatTime(map.frameCount / map.fps)} · {mapCoveredSlides(map.marks)}/{map.slideCount}
                    <T id="settings.auto_lyrics_slides" />
                    {#if (map.passCount || 1) > 1}· <T id="settings.auto_lyrics_refined_badge" /> ×{map.passCount}{/if}
                    · {dateToString(map.recordedAt, true)}
                </span>

                <MaterialButton title={map.locked ? "settings.auto_lyrics_unlock" : "settings.auto_lyrics_lock"} on:click={() => toggleLock(map)} white={!!map.locked}>
                    <Icon id={map.locked ? "locked" : "unlocked"} size={0.9} white={!!map.locked} />
                </MaterialButton>
                {#if $isDev}
                    <MaterialButton title="Export cue sheet (harness fixture)" on:click={() => exportCueSheet(map)}>
                        <Icon id="export" size={0.9} />
                    </MaterialButton>
                {/if}
                <MaterialButton title="settings.auto_lyrics_forget_song" on:click={() => deleteSong(map)} red>
                    <Icon id="delete" size={0.9} />
                </MaterialButton>
            </div>
        {/each}
    </div>

    <div class="actions">
        {#if orphaned.length}
            <MaterialButton variant="outlined" icon="delete" info={"" + orphaned.length} on:click={cleanupOrphans} small>
                <T id="settings.auto_lyrics_cleanup" />
            </MaterialButton>
        {/if}
        <MaterialButton variant="outlined" icon="delete" on:click={forgetAll} red={confirmForgetAll} small>
            {#if confirmForgetAll}<T id="settings.auto_lyrics_forget_all_confirm" />{:else}<T id="settings.auto_lyrics_forget_all" />{/if}
        </MaterialButton>
    </div>
{:else if songsLoaded}
    <div class="note"><T id="settings.auto_lyrics_no_songs" /></div>
{/if}

<style>
    .status {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;

        margin-top: 10px;
        padding: 8px 10px;
        background-color: rgb(0 0 20 / 0.15);
        border-radius: 4px;
        font-size: 0.85em;
    }
    .status.error {
        color: #ff8a8a;
    }
    .status .state {
        font-weight: bold;
    }
    .status .msg {
        opacity: 0.7;
    }
    .status .song {
        opacity: 0.85;
    }
    .status .detail {
        opacity: 0.65;
    }
    .status .detail.ok {
        color: #54c469;
        opacity: 1;
        display: flex;
        align-items: center;
        gap: 4px;
    }
    .status .divider {
        opacity: 0.4;
    }

    .dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        flex-shrink: 0;
    }
    .dot.status-listening,
    .dot.following {
        background-color: #54c469;
    }
    .dot.status-loading_model,
    .dot.learning {
        background-color: #e0a800;
    }
    .dot.status-error {
        background-color: #ff5050;
    }
    .dot.status-off,
    .dot.lost {
        background-color: #888;
    }

    .note {
        margin-top: 8px;
        margin-bottom: 8px;
        font-size: 0.8em;
        opacity: 0.6;
        font-style: italic;
    }

    .cueRecorder {
        padding: 10px;
        border: 1px solid rgb(128 128 128 / 0.35);
        border-radius: 5px;
    }
    .recorderStatus,
    .recorderActions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }
    .recorderStatus {
        font-size: 0.85em;
    }
    .recorderStatus > span:not(.dot) {
        opacity: 0.7;
    }
    .recorderStatus .dot {
        background-color: #888;
    }
    .recorderStatus.recording .dot {
        background-color: #ff5050;
        box-shadow: 0 0 0 3px rgb(255 80 80 / 0.2);
    }
    .recorderHelp {
        margin: 8px 0;
        font-size: 0.8em;
        opacity: 0.7;
    }
    .recorderError {
        color: #ff8a8a;
        font-size: 0.8em;
    }

    .songs {
        display: flex;
        flex-direction: column;
    }

    .songRow {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 2px 0;
    }
    .songRow:nth-child(even) {
        background-color: rgb(0 0 20 / 0.08);
    }
    .songRow.orphan {
        opacity: 0.65;
    }

    .songRow .name {
        display: flex;
        align-items: center;
        gap: 8px;

        background: none;
        border: none;
        color: inherit;
        font: inherit;
        text-align: left;
        padding: 4px 6px;
        cursor: pointer;

        flex: 1;
        min-width: 0;
    }
    .songRow .name:disabled {
        cursor: default;
        font-style: italic;
    }
    .songRow .name:not(:disabled):hover .text {
        text-decoration: underline;
    }
    .songRow .name .text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .songRow .name .layout {
        opacity: 0.6;
        font-size: 0.8em;
        flex-shrink: 0;
    }

    .songRow .meta {
        opacity: 0.6;
        font-size: 0.75em;
        white-space: nowrap;
        flex-shrink: 0;
    }

    .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
    }
</style>
