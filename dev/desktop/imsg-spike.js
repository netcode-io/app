import { spawn } from "node:child_process"
import { platform } from "node:os"

const [command, ...rest] = process.argv.slice(2)
const toFlag = rest.indexOf("--to")
const textFlag = rest.indexOf("--text")
const to = toFlag >= 0 ? rest[toFlag + 1] : ""
const text = textFlag >= 0 ? rest[textFlag + 1] : "shellular ping"

if (platform() !== "darwin") {
  console.error("imsg-plus only works on a Mac signed into Messages. This machine cannot send the spike.")
  process.exit(1)
}

if (command !== "send" && command !== "watch") {
  console.error("Usage:")
  console.error("  node dev/desktop/imsg-spike.js send --to +14155551212")
  console.error("  node dev/desktop/imsg-spike.js send --to you@icloud.com")
  console.error("  node dev/desktop/imsg-spike.js watch")
  console.error("A phone number and an Apple ID email are both valid. imsg-plus turns a US number into +1 E.164.")
  process.exit(1)
}

if (command === "send" && !to) {
  console.error("send needs --to <phone-or-email>")
  process.exit(1)
}

const args = command === "send"
  ? ["send", "--to", to, "--text", text]
  : ["watch", "--json"]

const child = spawn("imsg-plus", args, { stdio: "inherit" })
child.on("exit", (code) => process.exit(code ?? 1))
