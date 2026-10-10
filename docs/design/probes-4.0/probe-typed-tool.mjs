// Probe: a seat with no built-in tools and only one in-process typed tool; account connectors must stay absent.
const sdk = await import(process.argv[2]);
const { z } = await import(process.argv[3]);
const calls = [];
const seat = sdk.createSdkMcpServer({ name: "seat", version: "1.0.0", tools: [
  sdk.tool("submit_verdict", "Submit this seat's verdict to the pipeline program", { verdict: z.enum(["PASS", "FAIL"]), reason: z.string() },
    async (args) => { calls.push(args); return { content: [{ type: "text", text: "recorded" }] }; }),
]});
let init = "", answer = "";
const asked = [];
for await (const m of sdk.query({ prompt: "Call the submit_verdict tool once with verdict PASS and a one-sentence reason. Then, in one line, list every tool you can call and say whether you can run shell commands.", options: {
  cwd: process.argv[4], settingSources: [], tools: [], strictMcpConfig: true, mcpServers: { seat }, model: "haiku",
  canUseTool: async (name, input) => { asked.push(name); return name === "mcp__seat__submit_verdict" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "not this seat's tool" }; },
}})) {
  if (m.type === "system" && m.subtype === "init") init = `tools=${JSON.stringify(m.tools)} mcp=${JSON.stringify(m.mcp_servers)}`;
  if (m.type === "result") answer = m.result ?? "";
}
await new Promise(r => setTimeout(r, 100));
console.log(init); console.log("canUseTool asked:", JSON.stringify(asked)); console.log("handler calls:", JSON.stringify(calls)); console.log("answer:", answer);
process.exit(calls.length === 1 && calls[0].verdict === "PASS" && !/claude_ai/.test(init) ? 0 : 1);
