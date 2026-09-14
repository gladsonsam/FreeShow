import { createReadStream } from "node:fs"
import { createServer } from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const host = "0.0.0.0"
const browserHost = "127.0.0.1"
const preferredPort = 4174
const html = join(dirname(fileURLToPath(import.meta.url)), "autoLyricsCueMaker.html")

const server = createServer((request, response) => {
    if (request.url !== "/" && request.url !== "/index.html") {
        response.writeHead(404)
        response.end("Not found")
        return
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    createReadStream(html).pipe(response)
})

server.on("error", (error) => {
    console.error(`Could not start cue maker: ${error.message}`)
    process.exit(1)
})

server.listen(preferredPort, host, () => {
    console.log(`Auto Lyrics cue maker: http://${browserHost}:${preferredPort}`)
    console.log("Open that address in your browser. Press Ctrl+C here when finished.")
})
