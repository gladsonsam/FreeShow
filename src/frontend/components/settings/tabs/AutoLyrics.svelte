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
    const engineOptions = [
        { label: translateText("settings.auto_lyrics_engine_fingerprint"), value: "fingerprint" },
        { label: translateText("settings.auto_lyrics_engine_whisper"), value: "whisper-wasm" },
        { label: translateText("settings.auto_lyrics_engine_web_speech"), value: "web-speech" }
    ]
    const modelOptions = [
        { label: "Whisper Tiny (~40 MB)", value: "tiny" },
        { label: "Whisper Base (~75 MB)", value: "base" }
    ]
    const languageOptions = [
        { label: translateText("settings.auto_lyrics_language_auto"), value: "" },
        { label: "English", value: "en" },
        { label: "Spanish", value: "es" },
        { label: "Portuguese", value: "pt" },
        { label: "French", value: "fr" },
        { label: "German", value: "de" },
        { label: "Italian", value: "it" },
        { label: "Dutch", value: "nl" },
        { label: "Korean", value: "ko" },
        { label: "Chinese", value: "zh" },
        { label: "Hindi", value: "hi" },
        { label: "Tagalog", value: "tl" }
    ]

    $: isWebSpeech = settings.engine === "web-speech"
    $: isFingerprint = settings.engine === "fingerprint"
    $: statusText = translateText(`settings.auto_lyrics_status_${$autoLyrics.status.replace("-", "_")}`)
</script>

<MaterialToggleSwitch label="settings.auto_lyrics_enable" checked={settings.enabled} defaultValue={false} on:change={(e) => update("enabled", e.detail)} />

{#if settings.enabled}
    <div class="status" class:error={$autoLyrics.status === "error"}>
        <T id="settings.auto_lyrics_status" />: <span>{statusText}</span>
        {#if $autoLyrics.status === "error" && $autoLyrics.errorMsg}<span class="msg">({$autoLyrics.errorMsg})</span>{/if}
    </div>

    <MaterialDropdown label="settings.auto_lyrics_mode" value={settings.mode} options={modeOptions} on:change={(e) => update("mode", e.detail)} />
    <MaterialDropdown label="settings.auto_lyrics_engine" value={settings.engine} options={engineOptions} on:change={(e) => update("engine", e.detail)} />
    {#if isFingerprint}
        <div class="note"><T id="settings.auto_lyrics_fingerprint_note" /></div>
        <MaterialDropdown label="settings.auto_lyrics_mic" value={settings.micId} options={micOptions} allowEmpty on:change={(e) => update("micId", e.detail)} />
        {#if $autoLyrics.status === "listening"}
            <div class="learned">
                <T id="settings.auto_lyrics_learned" />: <strong>{$autoLyrics.learnedCount ?? 0}</strong>
                {#if ($autoLyrics.learnedCount ?? 0) > 0}
                    <button class="clear-btn" on:click={() => autoLyricsController.clearFingerprints()}><T id="clear.general" /></button>
                {/if}
            </div>
            {#if ($autoLyrics.learnedCount ?? 0) > 0}
                <div class="fp-score">
                    <T id="settings.auto_lyrics_match_score" />: <strong>{$autoLyrics.fpScore ?? 0}%</strong>
                </div>
            {/if}
        {/if}
    {:else if isWebSpeech}
        <div class="note"><T id="settings.auto_lyrics_web_speech_note" /></div>
    {:else}
        <MaterialDropdown label="settings.auto_lyrics_mic" value={settings.micId} options={micOptions} allowEmpty on:change={(e) => update("micId", e.detail)} />
        <MaterialDropdown label="settings.auto_lyrics_model" value={settings.model} options={modelOptions} on:change={(e) => update("model", e.detail)} />
        <MaterialDropdown label="settings.auto_lyrics_language" value={settings.language} options={languageOptions} on:change={(e) => update("language", e.detail)} />
    {/if}
    <MaterialNumberInput label="settings.auto_lyrics_threshold" value={settings.threshold} defaultValue={AUTO_LYRICS_DEFAULTS.threshold} min={10} max={100} step={5} on:change={(e) => update("threshold", e.detail)} />
    <MaterialToggleSwitch label="settings.auto_lyrics_detect_song" checked={settings.detectSongSwitch} defaultValue={true} on:change={(e) => update("detectSongSwitch", e.detail)} />

    {#if $autoLyrics.lastTranscript}
        <div class="transcript"><T id="settings.auto_lyrics_heard" />: <i>{$autoLyrics.lastTranscript}</i></div>
    {/if}
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
    .transcript {
        margin-top: 12px;
        padding: 8px 10px;
        background-color: rgb(0 0 20 / 0.15);
        border-radius: 4px;
        font-size: 0.85em;
        opacity: 0.8;
    }
    .note {
        margin-top: 4px;
        font-size: 0.82em;
        opacity: 0.6;
        font-style: italic;
    }
    .learned {
        margin-top: 6px;
        font-size: 0.85em;
        opacity: 0.8;
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .clear-btn {
        background: none;
        border: 1px solid var(--primary-lighter);
        border-radius: 3px;
        color: inherit;
        font-size: 0.85em;
        padding: 1px 8px;
        cursor: pointer;
        opacity: 0.7;
    }
    .clear-btn:hover {
        opacity: 1;
    }
    .fp-score {
        margin-top: 4px;
        font-size: 0.82em;
        opacity: 0.6;
    }
</style>
