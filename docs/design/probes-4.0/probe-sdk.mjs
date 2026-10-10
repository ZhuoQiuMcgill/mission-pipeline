// Probe Agent SDK seat isolation. Usage: node probe-sdk.mjs <path to sdk.mjs>
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const sdk = await import(process.argv[2]);
const dir = mkdtempSync(join(tmpdir(), "seat-probe-"));
writeFileSync(join(dir, "CLAUDE.md"), "# Project rules\nThe secret project word is PELICAN-42.\n");
const prompt = "1) Without reading any file, give the project CLAUDE.md secret word from your context, or NONE. " +
  "2) With the Bash tool run 'echo hi', then as a separate call 'touch sdk-made.txt'. 3) List every tool name you can call.";
for (const [label, extra] of [["no strictMcpConfig", {}], ["strictMcpConfig", { strictMcpConfig: true, mcpServers: {} }]]) {
  const asked = [];
  let answer = "", init = "";
  for await (const m of sdk.query({ prompt, options: {
    cwd: dir, settingSources: [], tools: ["Bash"], model: "haiku", ...extra,
    canUseTool: async (name, input) => {
      const ok = name === "Bash" && /^echo(\s|$)/.test(String(input.command ?? "").trim());
      asked.push(`${name}:${ok ? "allow" : "deny"}`);
      return ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Not in this seat's command set" };
    },
  } })) {
    if (m.type === "system" && m.subtype === "init") init = `tools=${JSON.stringify(m.tools)} mcp=${JSON.stringify(m.mcp_servers)} apiKeySource=${m.apiKeySource}`;
    if (m.type === "result") answer = m.result ?? "";
  }
  console.log(`== ${label}\n${init}\ncanUseTool: ${asked.join(", ")}\nfile created: ${existsSync(join(dir, "sdk-made.txt"))}\nanswer: ${answer}\n`);
  rmSync(join(dir, "sdk-made.txt"), { force: true });
}
rmSync(dir, { recursive: true, force: true });
