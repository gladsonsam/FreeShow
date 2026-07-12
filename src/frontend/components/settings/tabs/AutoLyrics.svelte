<script lang="ts">
    import { onMount } from "svelte"
    import { AudioMicrophone } from "../../../audio/audioMicrophone"
    import { autoLyricsController } from "../../../audio/lyrics/autoLyricsController"
    import { AUTO_LYRICS_DEFAULTS, type AutoLyricsSettings } from "../../../audio/lyrics/types"
    import { autoLyrics, special } from "../../../stores"
    import { translateText } from "../../../utils/language"
    import T from "../../helpers/T.svelte"
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

    let micOptions = [{ label: "—", value: "" }]
    onMount(async () => {
        try {
            const list = await AudioMicrophone.getList()
            micOptions = [{ label: translateText("settings.auto_lyrics_default_mic"), value: "" }, ...list.map((d) => ({ label: d.label || d.deviceId, value: d.deviceId }))]
        } catch (err) {
            console.error(err)
        }
    })

    const modeOptions = [
        { label: translateText("settings.auto_lyrics_suggest"), value: "suggest" },
        { label: translateText("settings.auto_lyrics_auto"), value: "auto" }
    ]

    $: statusText = translateText(`settings.auto_lyrics_status_${$autoLyrics.status.replace("-", "_")}`)
    $: follow = $autoLyrics.follow
    $: followStateText = follow && follow.state !== "idle" ? translateText(`settings.auto_lyrics_follow_${follow.state}`) : ""
</script>

<MaterialToggleSwitch label="settings.auto_lyrics_enable" checked={settings.enabled} defaultValue={false} on:change={(e) => update("enabled", e.detail)} />

{#if settings.enabled}
    <div class="status" class:error={$autoLyrics.status === "error"}>
        <T id="settings.auto_lyrics_status" />: <span>{statusText}</span>
        {#if $autoLyrics.status === "error" && $autoLyrics.errorMsg}<span class="msg">({$autoLyrics.errorMsg})</span>{/if}
    </div>

    <div class="note"><T id="settings.auto_lyrics_follow_note" /></div>

    <MaterialDropdown label="settings.auto_lyrics_mode" value={settings.mode} options={modeOptions} on:change={(e) => update("mode", e.detail)} />
    <MaterialDropdown label="settings.auto_lyrics_mic" value={settings.micId} options={micOptions} allowEmpty on:change={(e) => update("micId", e.detail)} />
    <MaterialNumberInput label="settings.auto_lyrics_lead" value={settings.leadMs} defaultValue={AUTO_LYRICS_DEFAULTS.leadMs} min={-1000} max={2000} step={100} on:change={(e) => update("leadMs", e.detail)} />
    <MaterialNumberInput label="settings.auto_lyrics_threshold" value={settings.threshold} defaultValue={AUTO_LYRICS_DEFAULTS.threshold} min={10} max={100} step={5} on:change={(e) => update("threshold", e.detail)} />

    {#if follow && follow.state !== "idle"}
        <div class="live">
            <span class="dot {follow.state}"></span>
            <span class="state">{followStateText}</span>
            {#if follow.songName}<span class="song">{follow.songName}</span>{/if}
            {#if follow.state === "following" || follow.state === "lost"}
                <span class="detail">{translateText("settings.auto_lyrics_slide")} {follow.slideIndex + 1}/{follow.slideCount} · {follow.confidence}%</span>
            {/if}
        </div>
        {#if follow.hasMap}
            <button class="text-btn" on:click={() => autoLyricsController.forgetCurrentSong()}><T id="settings.auto_lyrics_forget_song" /></button>
        {/if}
    {/if}

    <div class="learned">
        <T id="settings.auto_lyrics_saved_songs" />: <strong>{$autoLyrics.savedSongs ?? 0}</strong>
        {#if ($autoLyrics.savedSongs ?? 0) > 0}
            <button class="text-btn" on:click={() => autoLyricsController.forgetAllSongs()}><T id="settings.auto_lyrics_forget_all" /></button>
        {/if}
    </div>
{/if}

<style>
    .status {
        padding: 8px 0;
        opacity: 0.8;
        font-size: 0.9em;
    }
    .status span {
        font-weight: bold;
    }
    .status.error {
        color: #ff8a8a;
    }
    .status .msg {
        font-weight: normal;
        opacity: 0.7;
    }
    .note {
        margin-top: 4px;
        margin-bottom: 8px;
        font-size: 0.82em;
        opacity: 0.6;
        font-style: italic;
    }
    .live {
        margin-top: 10px;
        padding: 8px 10px;
        background-color: rgb(0 0 20 / 0.15);
        border-radius: 4px;
        font-size: 0.88em;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }
    .live .state {
        font-weight: bold;
    }
    .live .song {
        opacity: 0.85;
    }
    .live .detail {
        opacity: 0.65;
    }
    .dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        flex-shrink: 0;
    }
    .dot.learning {
        background-color: #e0a800;
    }
    .dot.following {
        background-color: #54c469;
    }
    .dot.lost {
        background-color: #888;
    }
    .learned {
        margin-top: 8px;
        font-size: 0.85em;
        opacity: 0.8;
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .text-btn {
        background: none;
        border: 1px solid var(--primary-lighter);
        border-radius: 3px;
        color: inherit;
        font-size: 0.85em;
        padding: 1px 8px;
        cursor: pointer;
        opacity: 0.7;
        width: fit-content;
        margin-top: 6px;
    }
    .text-btn:hover {
        opacity: 1;
    }
</style>
