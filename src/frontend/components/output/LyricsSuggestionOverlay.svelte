<script lang="ts">
    import { autoLyricsController } from "../../audio/lyrics/autoLyricsController"
    import { autoLyrics, special } from "../../stores"
    import { translateText } from "../../utils/language"
    import Icon from "../helpers/Icon.svelte"
    import T from "../helpers/T.svelte"
    import MaterialButton from "../inputs/MaterialButton.svelte"

    // only shown in suggest mode (auto mode navigates without asking)
    $: suggestion = $special.autoLyrics?.mode === "auto" ? null : $autoLyrics.suggestion
</script>

{#if suggestion}
    <div class="suggestion" class:song={suggestion.type === "different-song"}>
        <Icon id="lyrics" size={1.3} white />
        <div class="text">
            {#if suggestion.type === "same-show-slide"}
                <span class="title"><T id="settings.auto_lyrics_suggest_slide" /></span>
                <span class="detail">{translateText("settings.auto_lyrics_slide")} {(suggestion.slideIndex ?? 0) + 1} · {suggestion.label}</span>
            {:else}
                <span class="title"><T id="settings.auto_lyrics_suggest_song" /></span>
                <span class="detail">{suggestion.label}</span>
            {/if}
        </div>
        <span class="confidence">{suggestion.confidence}%</span>

        {#if suggestion.type === "same-show-slide"}
            <MaterialButton variant="contained" on:click={() => autoLyricsController.confirmSuggestion()}>
                <Icon id="check" right />
                <T id="actions.confirm" />
                <span class="key">Tab</span>
            </MaterialButton>
        {/if}
        <MaterialButton on:click={() => autoLyricsController.dismissSuggestion()} title="actions.close">
            <Icon id="close" />
        </MaterialButton>
    </div>
{/if}

<style>
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
    .suggestion.song {
        border-left-color: #e0a800;
    }
    .text {
        display: flex;
        flex-direction: column;
    }
    .title {
        font-weight: bold;
    }
    .detail {
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
