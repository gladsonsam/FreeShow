// Syntax highlighting and search utilities for the IDE-like show text editor.
// The editor uses a transparent <textarea> stacked on top of highlight overlays,
// so these functions only produce the HTML that is painted *behind* the text.

// matches a textbox marker at the start of a line: [#1] or [#2:en]
const TEXTBOX_MARKER = /^\[#\d+(?::[^\]\n]+)?\]/
// a bracketed token that is not nested and stays on one line
const BRACKET = /\[[^[\]\n]*\]/g
// chords longer than this are treated as plain text (mirrors formatTextEditor.getChords)
const MAX_CHORD_LENGTH = 12
// zero width space keeps otherwise empty lines at a full line height in the overlay
export const EMPTY_LINE = "​"

export function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// --- SYNTAX HIGHLIGHTING ---

export function highlightLine(line: string): string {
    if (!line) return EMPTY_LINE

    const trimmed = line.trim()

    // whole line is a single [group] header (e.g. [Verse], [Chorus 1])
    if (!TEXTBOX_MARKER.test(trimmed) && /^\[[^[\]\n]+\]$/.test(trimmed)) {
        const start = line.indexOf("[")
        const end = line.lastIndexOf("]")
        return escapeHtml(line.slice(0, start)) + bracketSpan("te-group", line.slice(start + 1, end)) + escapeHtml(line.slice(end + 1))
    }

    let result = ""
    let rest = line

    // textbox marker at the start of the line
    const marker = line.match(TEXTBOX_MARKER)
    if (marker) {
        result += `<span class="te-meta">${escapeHtml(marker[0])}</span>`
        rest = line.slice(marker[0].length)
    }

    return result + highlightInline(rest)
}

function highlightInline(text: string): string {
    let result = ""
    let lastIndex = 0
    let match: RegExpExecArray | null

    BRACKET.lastIndex = 0
    while ((match = BRACKET.exec(text))) {
        result += escapeHtml(text.slice(lastIndex, match.index))
        const inner = match[0].slice(1, -1)
        if (inner.length <= MAX_CHORD_LENGTH) result += bracketSpan("te-chord", inner)
        else result += escapeHtml(match[0])
        lastIndex = match.index + match[0].length
    }
    result += escapeHtml(text.slice(lastIndex))

    return result || EMPTY_LINE
}

function bracketSpan(className: string, inner: string): string {
    return `<span class="${className}"><span class="te-bracket">[</span>${escapeHtml(inner)}<span class="te-bracket">]</span></span>`
}

// --- SEARCH ---

export interface SearchOptions {
    caseSensitive: boolean
    regex: boolean
    wholeWord: boolean
}

export interface Match {
    line: number
    start: number
    end: number
    globalStart: number
    globalEnd: number
}

function buildPattern(query: string, opts: SearchOptions, global: boolean): RegExp {
    let source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (opts.wholeWord) source = `\\b${source}\\b`

    let flags = global ? "g" : ""
    if (!opts.caseSensitive) flags += "i"

    return new RegExp(source, flags)
}

// find every match across all lines, keeping both per-line and global offsets
export function findMatches(lines: string[], query: string, opts: SearchOptions): Match[] {
    if (!query) return []

    let pattern: RegExp
    try {
        pattern = buildPattern(query, opts, true)
    } catch {
        return [] // invalid regex while typing
    }

    const matches: Match[] = []
    let globalBase = 0

    lines.forEach((line, lineIndex) => {
        pattern.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = pattern.exec(line))) {
            const start = match.index
            const end = match.index + match[0].length
            matches.push({ line: lineIndex, start, end, globalStart: globalBase + start, globalEnd: globalBase + end })
            if (match[0].length === 0) pattern.lastIndex++ // avoid infinite loop on zero-length matches
        }
        globalBase += line.length + 1 // + newline
    })

    return matches
}

// render a single line with its matches wrapped in <mark>, transparent text behind the syntax layer
export function matchLineHtml(line: string, matches: Match[], activeGlobalStart: number): string {
    if (!matches.length) return escapeHtml(line) || EMPTY_LINE

    let result = ""
    let last = 0
    matches.forEach((match) => {
        result += escapeHtml(line.slice(last, match.start))
        const active = match.globalStart === activeGlobalStart ? " active" : ""
        result += `<mark class="te-match${active}">${escapeHtml(line.slice(match.start, match.end)) || EMPTY_LINE}</mark>`
        last = match.end
    })
    result += escapeHtml(line.slice(last))

    return result || EMPTY_LINE
}

// --- REPLACE ---

function safeReplacement(replacement: string, opts: SearchOptions): string {
    // in regex mode keep $1 group references, otherwise treat $ literally
    return opts.regex ? replacement : replacement.replace(/\$/g, "$$$$")
}

export function replaceAllMatches(text: string, query: string, replacement: string, opts: SearchOptions): { result: string; count: number } {
    if (!query) return { result: text, count: 0 }

    let pattern: RegExp
    try {
        pattern = buildPattern(query, opts, true)
    } catch {
        return { result: text, count: 0 }
    }

    const count = (text.match(pattern) || []).length
    if (!count) return { result: text, count: 0 }

    return { result: text.replace(pattern, safeReplacement(replacement, opts)), count }
}

// replace a single match at the given range (supports regex group references)
export function replaceRange(text: string, start: number, end: number, query: string, replacement: string, opts: SearchOptions): string {
    let pattern: RegExp
    try {
        pattern = buildPattern(query, opts, false)
    } catch {
        return text
    }

    const matched = text.slice(start, end)
    const replaced = matched.replace(pattern, safeReplacement(replacement, opts))
    return text.slice(0, start) + replaced + text.slice(end)
}
