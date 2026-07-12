<script lang="ts">
    import { autoLyricsController } from "../../audio/lyrics/autoLyricsController"
    import { autoLyrics, special } from "../../stores"
    import { translateText } from "../../utils/language"
    import Icon from "../helpers/Icon.svelte"
    import T from "../helpers/T.svelte"
    import MaterialButton from "../inputs/MaterialButton.svelte"

    // only shown in suggest mode (auto mode navigates without asking)
    $: suggestion = $special.autoLyrics?.mode === "auto" ? null : $autoLyrics.suggestion

    // compact live pill so the operator can see the follower working outside settings
    $: follow = $autoLyrics.status === "listening" ? $autoLyrics.follow : null
    $: showPill = !!follow && follow.state !== "idle"
</script>

{#if showPill && follow}
    <div class="pill" title={follow.songName}>
        <span class="dot {follow.state}"></span>
        <span class="state"><T id="settings.auto_lyrics_follow_{follow.state}" /></span>
        {#if follow.state === "following" || follow.state === "lost"}
            <span class="detail">{follow.slideIndex + 1}/{follow.slideCount}</span>
            <span class="confidence">{follow.confidence}%</span>
        {/if}
    </div>
{/if}

{#if suggestion}
    <div class="suggestion">
        <Icon id="lyrics" size={1.3} white />
        <div class="text">
            <span class="title"><T id="settings.auto_lyrics_suggest_slide" /></span>
            <span class="detail">{translateText("settings.auto_lyrics_slide")} {suggestion.slideIndex + 1} · {suggestion.label}</span>
        </div>
        <span class="confidence">{suggestion.confidence}%</span>

        <MaterialButton variant="contained" on:click={() => autoLyricsController.confirmSuggestion()}>
            <Icon id="check" right />
            <T id="actions.confirm" />
            <span class="key">Tab</span>
        </MaterialButton>
        <MaterialButton on:click={() => autoLyricsController.dismissSuggestion()} title="actions.close">
            <Icon id="close" />
        </MaterialButton>
    </div>
{/if}

<style>
    .pill {
        position: fixed;
        bottom: 12px;
        right: 12px;
        z-index: 4890;

        display: flex;
        align-items: center;
        gap: 7px;

        padding: 4px 10px;
        background-color: var(--primary-darkest);
        border: 1px solid var(--primary-lighter);
        border-radius: 20px;
        box-shadow: 0 2px 8px rgb(0 0 0 / 0.35);
        font-size: 0.8em;
        opacity: 0.92;
        pointer-events: none;
    }
    .pill .state {
        font-weight: bold;
    }
    .pill .detail {
        opacity: 0.75;
    }
    .dot {
        width: 8px;
        height: 8px;
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

    .suggestion {
        position: fixed;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 4900;

        display: flex;
        align-items: center;
        gap: 12px;

        padding: 10px 14px;
        background-color: var(--primary-darkest);
        border: 1px solid var(--primary-lighter);
        border-left: 4px solid var(--secondary);
        border-radius: 6px;
        box-shadow: 0 4px 16px rgb(0 0 0 / 0.4);

        max-width: 80vw;
    }
    .text {
        display: flex;
        flex-direction: column;
    }
    .title {
        font-weight: bold;
    }
    .suggestion .detail {
        opacity: 0.8;
        font-size: 0.9em;
        max-width: 40vw;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .confidence {
        opacity: 0.6;
        font-size: 0.85em;
    }
    .key {
        margin-left: 8px;
        padding: 1px 6px;
        border: 1px solid var(--primary-lighter);
        border-radius: 3px;
        font-size: 0.8em;
        opacity: 0.8;
    }
</style>
