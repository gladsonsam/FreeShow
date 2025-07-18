<script lang="ts">
    import { actions, activePage, activePopup, activeShow, dictionary, groups, guideActive, outLocked, outputs, overlayTimers, playingAudio, playingMetronome, slideTimers, special, styles } from "../../../stores"
    import { formatSearch } from "../../../utils/search"
    import { previewCtrlShortcuts, previewShortcuts } from "../../../utils/shortcuts"
    import { runAction } from "../../actions/actions"
    import { getSlideText } from "../../edit/scripts/textStyle"
    import Icon from "../../helpers/Icon.svelte"
    import T from "../../helpers/T.svelte"
    import { getActiveOutputs, isOutCleared, outputSlideHasContent, setOutput } from "../../helpers/output"
    import { getLayoutRef } from "../../helpers/show"
    import { getFewestOutputLines, getItemWithMostLines, playNextGroup, updateOut } from "../../helpers/showActions"
    import { _show } from "../../helpers/shows"
    import { newSlideTimer } from "../../helpers/tick"
    import Button from "../../inputs/Button.svelte"
    import ShowActions from "../ShowActions.svelte"
    import Audio from "../tools/Audio.svelte"
    import MediaControls from "../tools/MediaControls.svelte"
    import NextTimer from "../tools/NextTimer.svelte"
    import Overlay from "../tools/Overlay.svelte"
    import Show from "../tools/Show.svelte"
    import AudioMeter from "./AudioMeter.svelte"
    import ClearButtons from "./ClearButtons.svelte"
    import MultiOutputs from "./MultiOutputs.svelte"
    import PreviewOutputs from "./PreviewOutputs.svelte"

    $: allActiveOutputs = getActiveOutputs($outputs, true, true, true)
    $: outputId = allActiveOutputs[0]
    let currentOutput: any = {}
    $: currentOutput = outputId ? $outputs[outputId] || {} : {}

    $: backgroundOutputId = allActiveOutputs.find((id) => getLayersFromId(id).includes("background")) || outputId
    $: currentBgOutput = backgroundOutputId ? $outputs[backgroundOutputId] || null : null

    function getLayersFromId(id: string) {
        const layers = $styles[$outputs[id]?.style || ""]?.layers
        if (Array.isArray(layers)) return layers
        return ["background"]
    }

    let numberKeyTimeout: NodeJS.Timeout | null = null
    let previousNumberKey = ""
    function keydown(e: KeyboardEvent) {
        if ($guideActive || $activePopup === "assign_shortcut") return
        if ((e.ctrlKey || e.metaKey || e.altKey) && previewCtrlShortcuts[e.key]) {
            e.preventDefault()
            previewCtrlShortcuts[e.key]()
        }

        const functionKey = /^F(?:[1-9]|1[0-9]|2[0-4])$/
        if ((e.target?.closest("input") || e.target?.closest(".edit")) && !functionKey.test(e.key)) return

        // start action with custom shortcut key
        // /^[A-Z]{1}$/i.test(e.key) &&
        if (!e.ctrlKey && !e.metaKey && actionKeyActivate(e.key.toUpperCase())) {
            e.preventDefault()
            return
        }

        // group shortcuts
        if ((outSlide?.id || $activeShow) && !e.ctrlKey && !e.metaKey && !$outLocked) {
            // play slide with custom shortcut key
            let layoutRef = getLayoutRef(outSlide?.id || "active")
            let slideShortcutMatch = layoutRef.findIndex((ref) => ref.data?.actions?.slide_shortcut?.key === e.key)
            if (slideShortcutMatch > -1 && !e.altKey && !e.shiftKey) {
                playSlideAtIndex(slideShortcutMatch)
                e.preventDefault()
                return
            }

            // play group with custom shortcut keys
            // /^[A-Z]{1}$/i.test(e.key) &&
            if (checkGroupShortcuts(e)) {
                e.preventDefault()
                return
            }

            // play slide with number keys
            if ($special.numberKeys && e.key !== " " && !isNaN(e.key as any)) {
                previousNumberKey += e.key

                if (numberKeyTimeout) clearTimeout(numberKeyTimeout)
                numberKeyTimeout = setTimeout(() => {
                    let slideIndex = Number(previousNumberKey) - 1
                    playSlideAtIndex(slideIndex)

                    numberKeyTimeout = null
                    previousNumberKey = ""
                }, 300)

                return
            }

            // play slide based on first text letter
            if ($special.autoLetterShortcut) {
                const isSpecial = [".", ",", "-", "+", "/", "*", "<", ">", "|", "\\", "¨", "'"].includes(e.key)
                if (e.key.trim().length === 1 && isNaN(e.key as any) && !isSpecial) {
                    const firstLetterMatch = layoutRef.findIndex((ref) => {
                        const slide = _show().get("slides")?.[ref.id]
                        const slideText = formatSearch(getSlideText(slide)).replace(/\d+/g, "").trim()
                        return slideText[0]?.toLowerCase() === e.key.toLowerCase()
                    })

                    if (firstLetterMatch > -1 && !e.altKey && !e.shiftKey) {
                        playSlideAtIndex(firstLetterMatch)
                        e.preventDefault()
                        return
                    }
                }
            }
        }

        if (previewShortcuts[e.key]) {
            if (previewShortcuts[e.key](e)) e.preventDefault()
            return
        }
    }

    function actionKeyActivate(key: string) {
        let actionTriggered = false

        Object.values($actions).forEach((action) => {
            if (action.keypressActivate?.toUpperCase() === key) {
                runAction(action)
                actionTriggered = true
            }
        })

        return actionTriggered
    }

    function checkGroupShortcuts(e: any) {
        let currentShowId = outSlide?.id || ($activeShow !== null ? ($activeShow.type === undefined || $activeShow.type === "show" ? $activeShow.id : null) : null)
        if (!currentShowId) return

        let showRef = getLayoutRef(currentShowId)
        let groupIds = showRef.map((a) => a.id)
        let showGroups = groupIds.length ? _show(currentShowId).slides(groupIds).get() : []
        if (!showGroups.length) return

        let globalGroupIds: string[] = []
        Object.entries($groups).forEach(([groupId, group]) => {
            if (!group.shortcut || group.shortcut.toLowerCase() !== e.key.toLowerCase()) return
            showGroups.forEach((slide) => {
                if (slide.globalGroup === groupId) globalGroupIds.push(slide.id)
            })
        })

        return playNextGroup(globalGroupIds, { showRef, outSlide, currentShowId }, !e.altKey)
    }

    function playSlideAtIndex(index: number) {
        let slideRef = getLayoutRef()
        if (index === -1) index = slideRef.length - 1
        if (!slideRef[index]) return

        updateOut("active", index, slideRef)
        setOutput("slide", { id: $activeShow?.id, layout: _show().get("settings.activeLayout"), index, line: 0 })
    }

    // active menu
    let activeClear: string | null = null
    let autoChange = true
    $: if (outputId) autoChange = true
    $: if (autoChange && ($outputs || $overlayTimers || $playingMetronome)) {
        let active = getActiveClear(
            !isOutCleared("transition"),
            Object.keys($playingAudio).length || $playingMetronome,
            !isOutCleared("overlays") || !isOutCleared("effects"),
            !isOutCleared("slide") && (outputSlideHasContent(currentOutput) || isOutCleared("background")),
            !isOutCleared("background")
        )
        if (active !== activeClear) activeClear = active
    }
    // enable autochange again if active has no value
    $: if (!autoChange && ($outputs || $playingAudio || $playingMetronome || $overlayTimers)) checkStillActive()
    function checkStillActive() {
        if (activeClear === "nextTimer" && isOutCleared("transition")) autoChange = true
        else if (activeClear === "audio" && !Object.keys($playingAudio).length && !$playingMetronome) autoChange = true
        else if (activeClear === "overlays" && isOutCleared("overlays") && isOutCleared("effects")) autoChange = true
        else if (activeClear === "slide" && !(!isOutCleared("slide") && (outputSlideHasContent(currentOutput) || isOutCleared("background")))) autoChange = true
        else if (activeClear === "background" && isOutCleared("background")) autoChange = true
    }

    // don't update instantly in case it changes back quickly like slide timers
    let updatedActiveClear: string | null = null
    let updateActiveClearTimeout: NodeJS.Timeout | null = null
    $: if (activeClear !== undefined) updateActiveClear()
    function updateActiveClear() {
        if (updateActiveClearTimeout) clearTimeout(updateActiveClearTimeout)
        updateActiveClearTimeout = setTimeout(() => {
            updatedActiveClear = activeClear
        })
    }

    function getActiveClear(slideTimer: any, audio: any, overlays: any, slide: any, background: any) {
        if (slideTimer) return "nextTimer"
        if (audio) return "audio"
        if (overlays) return "overlays"
        if (slide) return "slide"
        if (background) return "background"
        return null
    }

    // slide timer
    let timer: any = {}
    $: timer = outputId && $slideTimers[outputId] ? $slideTimers[outputId] : {}
    $: Object.entries($outputs).forEach(([id, output]) => {
        if ((Object.keys($outputs)?.length > 1 && !output.enabled) || output.keyOutput || output.stageOutput) return
        if (!output.out?.transition || $slideTimers[id]?.timer) return

        newSlideTimer(id, output.out.transition.duration)
    })

    // $: currentStyle = $styles[currentOutput?.style] || {}

    // LINES

    $: outSlide = currentOutput.out?.slide
    $: ref = outSlide ? (outSlide?.id === "temp" ? [{ temp: true, items: outSlide.tempItems, id: "" }] : _show(outSlide.id).layouts([outSlide.layout]).ref()[0]) : []
    let linesIndex: null | number = null
    let maxLines: null | number = null
    $: amountOfLinesToShow = getFewestOutputLines($outputs)
    $: showSlide = outSlide?.index !== undefined && ref ? _show(outSlide.id).slides([ref[outSlide.index]?.id]).get()[0] : null
    $: slideLines = showSlide ? getItemWithMostLines(showSlide) : null
    $: maxLines = slideLines && amountOfLinesToShow && amountOfLinesToShow < slideLines ? Math.ceil(slideLines / amountOfLinesToShow) : null
    $: outputLine = amountOfLinesToShow && outSlide ? outSlide.line || 0 : null
    $: linesPercentage = slideLines && outputLine !== null ? outputLine / slideLines : 0
    $: linesIndex = maxLines !== null ? Math.floor(maxLines * linesPercentage) : 0

    // HIDE PREVIEW

    let enablePreview = true

    // hide preview in draw page
    // $: enablePreview = ["show", "edit", "settings"].includes($activePage)
    // $: if ($activePage === "draw") enablePreview = false
</script>

<svelte:window on:keydown={keydown} />

<div id="previewArea" class="main">
    {#if enablePreview}
        <PreviewOutputs bind:currentOutputId={outputId} />

        <div class="top">
            <Button class="hide" on:click={() => (enablePreview = false)} style="z-index: 2;" title={$dictionary.preview?._hide_preview} center>
                <Icon id="hide" white />
            </Button>
            <!-- disable before hiding: disableTransitions={!enablePreview} -->
            <MultiOutputs />
            <AudioMeter />
        </div>
    {:else}
        <Button on:click={() => (enablePreview = true)} style="width: 100%;" center dark>
            <Icon id="eye" right />
            <T id="preview.show_preview" />
        </Button>
    {/if}

    {#if enablePreview}
        <ShowActions {currentOutput} {ref} {linesIndex} {maxLines} />
    {/if}

    {#if $activePage === "show"}
        <ClearButtons bind:autoChange activeClear={updatedActiveClear} on:update={(e) => (activeClear = e.detail)} />

        {#if updatedActiveClear === "background"}
            <MediaControls currentOutput={currentBgOutput} outputId={backgroundOutputId} />
        {:else if updatedActiveClear === "slide"}
            <Show {currentOutput} {ref} {linesIndex} {maxLines} />
        {:else if updatedActiveClear === "overlays"}
            <Overlay {currentOutput} />
        {:else if updatedActiveClear === "audio"}
            <Audio />
        {:else if updatedActiveClear === "nextTimer"}
            <NextTimer {currentOutput} timer={timer?.timer ? timer : { time: 0, paused: true, timer: {} }} />
            <!-- WIP display overlay timer time -->
        {/if}
    {/if}
</div>

<style>
    .main {
        /* max-height: 50%; */
        flex: 1;
        min-width: 50%;
    }

    .top {
        display: flex;
        position: relative;
    }
    /* button {
    background-color: inherit;
    color: inherit;
    border: none;
  } */

    .top :global(.hide) {
        position: absolute;
        top: 10px;
        inset-inline-end: 16px;
        z-index: 1;
        background-color: rgb(0 0 0 / 0.6) !important;
        border: 1px solid rgb(255 255 255 / 0.3);
        width: 40px;
        height: 40px;
        opacity: 0;
        transition: opacity 0.2s;
    }
    .top:hover > :global(.hide) {
        opacity: 1;
    }
</style>
