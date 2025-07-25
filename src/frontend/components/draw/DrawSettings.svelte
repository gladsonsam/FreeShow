<script lang="ts">
    import { drawSettings, drawTool, paintCache } from "../../stores"
    import Icon from "../helpers/Icon.svelte"
    import T from "../helpers/T.svelte"
    import { clone } from "../helpers/array"
    import Button from "../inputs/Button.svelte"
    import Checkbox from "../inputs/Checkbox.svelte"
    import Color from "../inputs/Color.svelte"
    import CombinedInput from "../inputs/CombinedInput.svelte"
    import NumberInput from "../inputs/NumberInput.svelte"
    import { clearDrawing } from "../output/clear"
    import Panel from "../system/Panel.svelte"

    const defaults = {
        focus: {
            color: "#000000",
            opacity: 0.8,
            size: 300,
            radius: 50,
            glow: true,
            hold: false
        },
        pointer: {
            color: "#FF0000",
            opacity: 0.8,
            size: 100,
            radius: 50,
            glow: false,
            hollow: true,
            hold: false
        },
        zoom: {
            size: 200
        },
        particles: {
            color: "#1e1eb4",
            opacity: 0.8,
            size: 20,
            radius: 25,
            glow: false,
            hollow: false,
            hold: false
        },
        fill: {
            color: "#000000",
            opacity: 0.8,
            rainbow: false
        },
        paint: {
            color: "#ffffff",
            size: 10,
            straight: false,
            // not saved:
            threed: false,
            dots: false,
            link_to_slide: false,
            hold: true // always true
        }
    }

    $: tool = $drawTool

    const change = (e: any, key: string) => update(key, e.detail)
    const check = (e: any, key: string) => update(key, e.target.checked)

    const update = (key: string, value: any) => {
        drawSettings.update((a) => {
            a[tool][key] = value
            return a
        })
    }

    function reset() {
        drawSettings.update((a) => {
            a[tool] = clone(defaults[tool] || {})
            return a
        })
    }

    // $: if (!Object.keys($drawSettings[tool] || {}).length) reset()
    $: if (tool) adddMissingSettings()
    function adddMissingSettings() {
        drawSettings.update((a) => {
            if (!a[tool]) a[tool] = clone(defaults[tool])
            else {
                Object.entries(defaults[tool]).forEach(([key, value]) => {
                    if (a[tool][key] === undefined) a[tool][key] = value
                })
            }
            return a
        })
    }
</script>

<div class="main border">
    <div class="padding">
        <Panel>
            {#key tool}
                <h6>
                    <Icon id={tool} white right />
                    <T id="draw.{tool}" />
                </h6>

                <div class="options">
                    {#key $drawSettings}
                        {#if $drawSettings[tool]}
                            {#each Object.entries($drawSettings[tool]) as [key, value]}
                                {#if key !== "clear" && (key !== "hold" || tool !== "paint")}
                                    <CombinedInput>
                                        {#if key !== "clear" && (key !== "hold" || tool !== "paint")}
                                            <p><T id="draw.{key}" /></p>
                                        {/if}
                                        {#if key === "color"}
                                            <Color {value} on:input={(e) => change(e, key)} style="width: 100%;" />
                                        {:else if ["glow", "hold", "rainbow", "hollow", "straight", "dots", "threed", "link_to_slide"].includes(key)}
                                            <div class="alignRight">
                                                <Checkbox checked={value} on:change={(e) => check(e, key)} />
                                            </div>
                                        {:else if key === "opacity"}
                                            <NumberInput {value} step={0.1} decimals={1} max={1} inputMultiplier={10} on:change={(e) => change(e, key)} />
                                        {:else if key === "radius"}
                                            <NumberInput {value} step={0.5} decimals={1} max={50} inputMultiplier={2} on:change={(e) => change(e, key)} />
                                        {:else if key !== "clear" && key !== "hold"}
                                            <NumberInput {value} min={1} max={2000} on:change={(e) => change(e, key)} />
                                        {:else}
                                            <div class="empty" id={key}></div>
                                        {/if}
                                    </CombinedInput>
                                {/if}
                            {/each}
                        {/if}
                    {/key}
                </div>
            {/key}
        </Panel>
    </div>

    <div class="bottom">
        {#if tool === "paint"}
            <Button style="flex: 1;padding: 10px;" on:click={clearDrawing} disabled={!$paintCache?.length} red={!!$paintCache?.length} dark center>
                <Icon id="clear" size={2} right />
                <T id="clear.drawing" />
            </Button>
        {/if}

        <Button style="flex: 1;" on:click={reset} dark center>
            <Icon id="reset" right />
            <T id="actions.reset" />
        </Button>
    </div>
</div>

<style>
    .main {
        display: flex;
        flex-direction: column;
        overflow: hidden;
        height: 100%;
    }

    h6 {
        display: flex;
        align-items: center;
        justify-content: center;

        font-weight: 600;
        letter-spacing: 0.5px;

        padding: 0.3em 0.5em;
        background-color: var(--primary-darkest);
        border-radius: var(--border-radius);

        /* font-size: 0.9em; */
        text-transform: none !important;
        margin: 0 !important;
    }

    .padding {
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        overflow-x: hidden;
        height: 100%;
    }

    .options {
        padding: 10px;
    }

    .bottom {
        display: flex;
        flex-direction: column;
    }

    .empty {
        background-color: var(--primary);
        width: 100%;
    }
</style>
