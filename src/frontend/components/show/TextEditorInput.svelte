<script lang="ts">
    import { createEventDispatcher, onMount, tick } from "svelte"
    import { transposeText } from "../../utils/chordTranspose"
    import { translateText } from "../../utils/language"
    import Icon from "../helpers/Icon.svelte"
    import { findMatches, highlightLine, matchLineHtml, replaceAllMatches, replaceRange, type Match, type SearchOptions } from "./textEditorHighlight"

    export let value = ""
    export let placeholder = ""
    export let disabled = false
    export let fontSize = 1 // em
    export let lineNumbers = true

    const dispatch = createEventDispatcher()

    let textarea: HTMLTextAreaElement
    let syntaxLayer: HTMLDivElement
    let matchLayer: HTMLDivElement

    let text = value
    let committed = value
    let focused = false

    // the textarea reserves gutter space for its scrollbar (scrollbar-gutter: stable);
    // the overlays must reserve the same width or the wrapping will diverge once it overflows
    let scrollbarWidth = 0
    onMount(async () => {
        await tick()
        if (textarea) scrollbarWidth = textarea.offsetWidth - textarea.clientWidth
    })

    // find & replace is a small editing session that should not be interrupted by re-derived show text
    $: editing = focused || findOpen
    $: if (!editing && value !== text) {
        text = value
        committed = value
        // a different show/text was loaded — the old undo history no longer applies
        undoStack = []
        redoStack = []
    }

    $: lines = text.split("\n")

    // --- highlighting (rendered on stacked overlays behind the transparent textarea) ---
    $: syntaxLines = lines.map(highlightLine)

    function commit() {
        if (disabled || text === committed) return
        committed = text
        dispatch("change", text)
    }

    async function setText(newText: string, selStart: number, selEnd = selStart) {
        text = newText
        await tick()
        textarea.focus()
        textarea.setSelectionRange(selStart, selEnd)
    }

    // --- editor-local undo/redo (isolated from the app's slide history) ---
    interface Snapshot {
        content: string
        start: number
        end: number
    }
    let undoStack: Snapshot[] = []
    let redoStack: Snapshot[] = []
    let lastRecordTime = 0
    let lastRecordCategory = ""
    const HISTORY_LIMIT = 300
    const COALESCE_MS = 400

    function snapshot(): Snapshot {
        return { content: text, start: textarea?.selectionStart ?? text.length, end: textarea?.selectionEnd ?? text.length }
    }

    // record the state *before* a change; consecutive typing of the same kind is coalesced into one undo step
    function recordHistory(category: "insert" | "delete" | "op", breakGroup = false) {
        const now = Date.now()
        const coalesce = !breakGroup && category !== "op" && category === lastRecordCategory && now - lastRecordTime < COALESCE_MS
        if (!coalesce) {
            undoStack.push(snapshot())
            if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
            redoStack = []
        }
        lastRecordTime = now
        lastRecordCategory = breakGroup ? "op" : category
    }

    function onBeforeInput(e: InputEvent) {
        if (disabled) return
        const inputType = e.inputType || ""
        const category = inputType.startsWith("delete") ? "delete" : "insert"
        const isLineBreak = inputType === "insertLineBreak" || inputType === "insertParagraph"
        recordHistory(category, isLineBreak)
    }

    async function applySnapshot(snap: Snapshot) {
        text = snap.content
        lastRecordCategory = "op" // start a fresh group after undo/redo
        await tick()
        textarea.focus()
        textarea.setSelectionRange(snap.start, snap.end)
        syncScroll()
    }

    function undo() {
        if (!undoStack.length) return
        redoStack.push(snapshot())
        applySnapshot(undoStack.pop()!)
    }

    function redo() {
        if (!redoStack.length) return
        undoStack.push(snapshot())
        applySnapshot(redoStack.pop()!)
    }

    // --- keyboard shortcuts ---
    function onKeydown(e: KeyboardEvent) {
        const ctrl = e.ctrlKey || e.metaKey
        const key = e.key

        if (ctrl && !e.shiftKey && !e.altKey && key.toLowerCase() === "f") {
            e.preventDefault()
            e.stopPropagation()
            openFind(false)
            return
        }
        if (ctrl && key.toLowerCase() === "h") {
            e.preventDefault()
            e.stopPropagation()
            openFind(true)
            return
        }
        if (key === "Escape" && findOpen) {
            e.preventDefault()
            closeFind()
            return
        }

        // undo / redo — use the editor's own history, never the app's slide history
        if (ctrl && key.toLowerCase() === "z") {
            e.preventDefault()
            e.stopPropagation()
            if (!disabled) e.shiftKey ? redo() : undo()
            return
        }
        if (ctrl && key.toLowerCase() === "y") {
            e.preventDefault()
            e.stopPropagation()
            if (!disabled) redo()
            return
        }
        // keep Ctrl+A as native "select all text", not the global "select all slides"
        if (ctrl && !e.shiftKey && !e.altKey && key.toLowerCase() === "a") {
            e.stopPropagation()
            return
        }

        if (disabled) return

        // transpose chords
        if (ctrl && e.shiftKey && (key === "ArrowUp" || key === "ArrowDown")) {
            e.preventDefault()
            e.stopPropagation()
            recordHistory("op", true)
            text = transposeText(text, key === "ArrowUp" ? 1 : -1)
            commit()
            return
        }
        // move / duplicate current line(s)
        if (e.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
            e.preventDefault()
            e.stopPropagation()
            if (e.shiftKey) duplicateLines(key === "ArrowUp" ? -1 : 1)
            else moveLines(key === "ArrowUp" ? -1 : 1)
            return
        }
        // insert / wrap chord brackets
        if (ctrl && key.toLowerCase() === "k") {
            e.preventDefault()
            e.stopPropagation()
            insertChord()
            return
        }
        // indent / outdent selected lines
        if (key === "Tab") {
            e.preventDefault()
            e.stopPropagation()
            if (e.shiftKey) indentLines(-1)
            else indentLines(1)
            return
        }
    }

    function lineBounds() {
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const startLine = text.slice(0, start).split("\n").length - 1
        const endLine = text.slice(0, end).split("\n").length - 1
        return { startLine, endLine }
    }

    function offsetOfLine(arr: string[], index: number) {
        let offset = 0
        for (let i = 0; i < index; i++) offset += arr[i].length + 1
        return offset
    }

    function moveLines(dir: number) {
        const arr = text.split("\n")
        const { startLine, endLine } = lineBounds()
        if (dir < 0 && startLine === 0) return
        if (dir > 0 && endLine === arr.length - 1) return

        recordHistory("op", true)
        const block = arr.splice(startLine, endLine - startLine + 1)
        const insertAt = dir < 0 ? startLine - 1 : startLine + 1
        arr.splice(insertAt, 0, ...block)

        const selStart = offsetOfLine(arr, insertAt)
        const selEnd = offsetOfLine(arr, insertAt + block.length - 1) + arr[insertAt + block.length - 1].length
        setText(arr.join("\n"), selStart, selEnd)
    }

    function duplicateLines(dir: number) {
        const arr = text.split("\n")
        const { startLine, endLine } = lineBounds()
        recordHistory("op", true)
        const block = arr.slice(startLine, endLine + 1)
        const insertAt = dir < 0 ? startLine : endLine + 1
        arr.splice(insertAt, 0, ...block)

        const selStart = offsetOfLine(arr, insertAt)
        const selEnd = offsetOfLine(arr, insertAt + block.length - 1) + arr[insertAt + block.length - 1].length
        setText(arr.join("\n"), selStart, selEnd)
    }

    function indentLines(dir: number) {
        const arr = text.split("\n")
        const { startLine, endLine } = lineBounds()
        recordHistory("op", true)
        const indent = "  "

        for (let i = startLine; i <= endLine; i++) {
            if (dir > 0) arr[i] = indent + arr[i]
            else if (arr[i].startsWith(indent)) arr[i] = arr[i].slice(indent.length)
            else arr[i] = arr[i].replace(/^\s+/, "")
        }

        const selStart = offsetOfLine(arr, startLine)
        const selEnd = offsetOfLine(arr, endLine) + arr[endLine].length
        setText(arr.join("\n"), selStart, selEnd)
    }

    function insertChord() {
        recordHistory("op", true)
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        if (start !== end) {
            const newText = text.slice(0, start) + "[" + text.slice(start, end) + "]" + text.slice(end)
            setText(newText, start + 1, end + 1)
        } else {
            const newText = text.slice(0, start) + "[]" + text.slice(start)
            setText(newText, start + 1)
        }
    }

    // --- find & replace ---
    let findOpen = false
    let replaceShown = false
    let findQuery = ""
    let replaceQuery = ""
    let caseSensitive = false
    let regexMode = false
    let wholeWord = false
    let findInput: HTMLInputElement
    let activeMatchIndex = 0

    $: options = { caseSensitive, regex: regexMode, wholeWord } as SearchOptions
    $: matches = findOpen && findQuery ? findMatches(lines, findQuery, options) : ([] as Match[])
    $: if (activeMatchIndex > matches.length - 1) activeMatchIndex = Math.max(0, matches.length - 1)
    $: activeStart = matches[activeMatchIndex]?.globalStart ?? -1
    $: matchesByLine = matches.reduce((map: Record<number, Match[]>, m) => ((map[m.line] ||= []).push(m), map), {})

    async function openFind(withReplace: boolean) {
        replaceShown = withReplace || replaceShown

        // seed the query from a single-line selection
        if (textarea) {
            const sel = text.slice(textarea.selectionStart, textarea.selectionEnd)
            if (sel && !sel.includes("\n")) findQuery = sel
        }

        findOpen = true
        await tick()
        findInput?.focus()
        findInput?.select()
        selectClosestMatch()
    }

    function closeFind() {
        findOpen = false
        textarea?.focus()
    }

    function onQueryChange() {
        activeMatchIndex = 0
        tick().then(selectClosestMatch)
    }

    // jump to the first match at or after the caret
    function selectClosestMatch() {
        if (!matches.length || !textarea) return
        const caret = textarea.selectionStart
        const index = matches.findIndex((m) => m.globalStart >= caret)
        activeMatchIndex = index < 0 ? 0 : index
        revealActiveMatch()
    }

    function step(dir: number) {
        if (!matches.length) return
        activeMatchIndex = (activeMatchIndex + dir + matches.length) % matches.length
        revealActiveMatch()
    }

    // scroll the active match into view without stealing focus from the find input
    async function revealActiveMatch() {
        await tick()
        const match = matches[activeMatchIndex]
        if (!match || !syntaxLayer || !textarea) return

        const lineEl = syntaxLayer.children[match.line] as HTMLElement | undefined
        if (!lineEl) return

        const pad = 24
        const top = lineEl.offsetTop
        const bottom = top + lineEl.offsetHeight
        if (top < textarea.scrollTop) textarea.scrollTop = Math.max(0, top - pad)
        else if (bottom > textarea.scrollTop + textarea.clientHeight) textarea.scrollTop = bottom - textarea.clientHeight + pad
        syncScroll()
    }

    function replaceCurrent() {
        if (disabled) return
        const match = matches[activeMatchIndex]
        if (!match) return
        recordHistory("op", true)
        text = replaceRange(text, match.globalStart, match.globalEnd, findQuery, replaceQuery, options)
        commit()
        tick().then(() => {
            if (matches.length) step(0)
            revealActiveMatch()
        })
    }

    function replaceAll() {
        if (disabled) return
        const { result, count } = replaceAllMatches(text, findQuery, replaceQuery, options)
        if (!count) return
        recordHistory("op", true)
        text = result
        commit()
    }

    function onFindKeydown(e: KeyboardEvent) {
        if (e.key === "Enter") {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
        } else if (e.key === "Escape") {
            e.preventDefault()
            closeFind()
        }
    }

    function onReplaceKeydown(e: KeyboardEvent) {
        if (e.key === "Enter") {
            e.preventDefault()
            if (e.ctrlKey || e.metaKey) replaceAll()
            else replaceCurrent()
        } else if (e.key === "Escape") {
            e.preventDefault()
            closeFind()
        }
    }

    // --- scroll sync between the textarea and the overlays ---
    function syncScroll() {
        if (!textarea) return
        const top = textarea.scrollTop
        const left = textarea.scrollLeft
        if (syntaxLayer) {
            syntaxLayer.scrollTop = top
            syntaxLayer.scrollLeft = left
        }
        if (matchLayer) {
            matchLayer.scrollTop = top
            matchLayer.scrollLeft = left
        }
    }
</script>

<div class="te-editor" class:disabled class:no-numbers={!lineNumbers} style="font-size: {fontSize}em; --te-sbw: {scrollbarWidth}px;">
    <div class="te-area">
        {#if lineNumbers}
            <div class="te-gutter-bg" aria-hidden="true"></div>
        {/if}

        {#if matches.length}
            <div class="te-layer te-matchlayer" aria-hidden="true" bind:this={matchLayer}>
                {#each lines as line, i}
                    <div class="te-row">
                        {#if lineNumbers}<span class="te-rownum"></span>{/if}
                        <span class="te-content">{@html matchLineHtml(line, matchesByLine[i] || [], activeStart)}</span>
                    </div>
                {/each}
            </div>
        {/if}

        <div class="te-layer te-syntaxlayer" aria-hidden="true" bind:this={syntaxLayer}>
            {#each syntaxLines as line, i}
                <div class="te-row">
                    {#if lineNumbers}<span class="te-rownum">{i + 1}</span>{/if}
                    <span class="te-content">{@html line}</span>
                </div>
            {/each}
        </div>

        <textarea
            bind:this={textarea}
            bind:value={text}
            class="te-input edit context #editbox_text"
            {placeholder}
            {disabled}
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            on:beforeinput={onBeforeInput}
            on:input={() => syncScroll()}
            on:scroll={syncScroll}
            on:change={commit}
            on:keydown={onKeydown}
            on:focus={() => (focused = true)}
            on:blur={() => {
                focused = false
                commit()
            }}
        />

        {#if findOpen}
            <div class="te-find">
                <div class="te-find-row">
                    <input
                        bind:this={findInput}
                        bind:value={findQuery}
                        on:input={onQueryChange}
                        on:keydown={onFindKeydown}
                        class:invalid={regexMode && findQuery && !matches.length}
                        placeholder={translateText("actions.find")}
                    />
                    <span class="te-count">{matches.length ? `${activeMatchIndex + 1}/${matches.length}` : findQuery ? translateText("actions.no_results") : ""}</span>
                    <button class="te-toggle" class:active={caseSensitive} title={translateText("actions.case_sensitive")} on:click={() => (caseSensitive = !caseSensitive)}>Aa</button>
                    <button class="te-toggle" class:active={wholeWord} title={translateText("actions.whole_word")} on:click={() => (wholeWord = !wholeWord)}>|W|</button>
                    <button class="te-toggle" class:active={regexMode} title={translateText("actions.use_regex")} on:click={() => (regexMode = !regexMode)}>.*</button>
                    <div class="te-divider"></div>
                    <button title={translateText("actions.previous")} disabled={!matches.length} on:click={() => step(-1)}><Icon id="arrow_up" size={0.9} white /></button>
                    <button title={translateText("actions.next")} disabled={!matches.length} on:click={() => step(1)}><Icon id="arrow_down" size={0.9} white /></button>
                    <button title={translateText(replaceShown ? "actions.hide_replace" : "actions.show_replace")} on:click={() => (replaceShown = !replaceShown)}>
                        <Icon id={replaceShown ? "up" : "down"} size={0.9} white />
                    </button>
                    <button title={translateText("actions.close")} on:click={closeFind}><Icon id="close" size={0.9} white /></button>
                </div>

                {#if replaceShown}
                    <div class="te-find-row">
                        <input bind:value={replaceQuery} on:keydown={onReplaceKeydown} placeholder={translateText("actions.replace")} {disabled} />
                        <button class="te-text-btn" disabled={disabled || !matches.length} on:click={replaceCurrent}>{translateText("actions.replace")}</button>
                        <button class="te-text-btn" disabled={disabled || !matches.length} on:click={replaceAll}>{translateText("actions.replace_all")}</button>
                    </div>
                {/if}
            </div>
        {/if}
    </div>
</div>

<style>
    .te-editor {
        --te-lh: 1.6;
        --te-pad-y: 14px;
        --te-pad-x: 18px;
        --te-gutter-w: 2.5ch;
        --te-gutter-gap: 16px;

        position: relative;
        display: flex;
        flex: 1;
        width: 100%;
        height: 100%;
        overflow: hidden;
        font-family: "JetBrains Mono", "Cascadia Code", "Fira Code", Consolas, "Courier New", monospace;
    }
    .te-editor.no-numbers {
        --te-gutter-w: 0px;
        --te-gutter-gap: 0px;
    }
    .te-editor.disabled {
        opacity: 0.5;
    }

    /* editor area holds the gutter backdrop, stacked overlays and the textarea */
    .te-area {
        position: relative;
        flex: 1;
        overflow: hidden;
    }

    .te-gutter-bg {
        position: absolute;
        top: 0;
        left: 0;
        bottom: 0;
        z-index: 0;
        width: calc(var(--te-pad-x) + var(--te-gutter-w) + 8px);
        background-color: var(--primary-darker);
        border-inline-end: 1px solid var(--primary-lighter);
        pointer-events: none;
    }

    .te-layer,
    .te-input {
        margin: 0;
        font: inherit;
        line-height: var(--te-lh);
        letter-spacing: normal;
        tab-size: 2;
        box-sizing: border-box;
    }

    .te-layer {
        position: absolute;
        inset: 0;
        overflow: hidden;
        padding: var(--te-pad-y) calc(var(--te-pad-x) + var(--te-sbw, 0px)) var(--te-pad-y) var(--te-pad-x);
        pointer-events: none;
    }
    .te-row {
        display: flex;
    }
    .te-rownum {
        flex: 0 0 var(--te-gutter-w);
        width: var(--te-gutter-w);
        margin-inline-end: var(--te-gutter-gap);
        text-align: end;
        color: var(--text);
        opacity: 0.4;
        user-select: none;
        font-variant-numeric: tabular-nums;
    }
    .te-content {
        flex: 1 1 auto;
        min-width: 0;
        white-space: pre-wrap;
        overflow-wrap: break-word;
        word-break: break-word;
    }

    .te-matchlayer {
        z-index: 1;
        color: transparent;
    }
    .te-syntaxlayer {
        z-index: 2;
    }

    .te-input {
        position: absolute;
        inset: 0;
        z-index: 3;
        width: 100%;
        height: 100%;
        padding: var(--te-pad-y) var(--te-pad-x) var(--te-pad-y) calc(var(--te-pad-x) + var(--te-gutter-w) + var(--te-gutter-gap));
        border: none;
        outline: none;
        resize: none;
        background: transparent;
        color: transparent;
        caret-color: var(--text);
        white-space: pre-wrap;
        overflow-wrap: break-word;
        word-break: break-word;
        overflow-y: auto;
        overflow-x: hidden;
        scrollbar-gutter: stable;
    }
    .te-input::placeholder {
        color: var(--text);
        opacity: 0.4;
    }
    .te-input::selection {
        background-color: var(--secondary-opacity);
    }

    /* syntax colors */
    .te-syntaxlayer :global(.te-chord) {
        color: #4fc3a1;
        font-weight: 600;
    }
    .te-syntaxlayer :global(.te-group) {
        color: #e0a458;
        font-weight: 700;
    }
    .te-syntaxlayer :global(.te-meta) {
        color: #8a7fe0;
        font-weight: 600;
    }
    .te-syntaxlayer :global(.te-bracket) {
        opacity: 0.5;
        font-weight: 400;
    }

    /* search matches */
    .te-matchlayer :global(.te-match) {
        color: transparent;
        background-color: rgba(240, 200, 60, 0.35);
        border-radius: 2px;
    }
    .te-matchlayer :global(.te-match.active) {
        background-color: var(--secondary);
    }

    /* find & replace bar */
    .te-find {
        position: absolute;
        top: 8px;
        inset-inline-end: 16px;
        z-index: 10;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 5px;
        background-color: var(--primary-darker);
        border: 1px solid var(--primary-lighter);
        border-radius: 4px;
        box-shadow: 0 4px 14px rgb(0 0 0 / 0.45);
        font-size: 0.8rem;
        font-family: sans-serif;
    }
    .te-find-row {
        display: flex;
        align-items: center;
        gap: 2px;
    }
    .te-find input {
        width: 190px;
        padding: 5px 7px;
        color: var(--text);
        background-color: var(--primary-darkest);
        border: 1px solid transparent;
        border-radius: 3px;
        outline: none;
        font-size: inherit;
    }
    .te-find input:focus {
        border-color: var(--secondary);
    }
    .te-find input.invalid {
        border-color: #e0554f;
    }
    .te-count {
        min-width: 52px;
        padding: 0 6px;
        text-align: center;
        white-space: nowrap;
        opacity: 0.6;
    }
    .te-find button {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 26px;
        height: 26px;
        padding: 0 5px;
        color: var(--text);
        background: transparent;
        border: none;
        border-radius: 3px;
        cursor: pointer;
        font-size: inherit;
    }
    .te-find button:hover:not(:disabled) {
        background-color: var(--hover);
    }
    .te-find button:disabled {
        opacity: 0.35;
        cursor: default;
    }
    .te-find button.active {
        color: var(--secondary-text);
        background-color: var(--secondary);
    }
    .te-toggle {
        font-family: monospace;
        font-weight: 600;
        font-size: 0.75rem;
    }
    .te-text-btn {
        padding: 0 10px !important;
    }
    .te-divider {
        width: 1px;
        height: 18px;
        margin: 0 3px;
        background-color: var(--primary-lighter);
    }
</style>
