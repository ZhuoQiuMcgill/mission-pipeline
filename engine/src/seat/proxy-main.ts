// A metering proxy as its own process (design 6.5; startup self-check item 9 and §14 item 2
// use it to measure the proxy apart from a seat). Usage: proxy-main.ts <config.json>
//   { "launch": "...", "ledgerSocket": "...", "upstream"?: "https://api.anthropic.com",
//     "modelConfig"?: "/path/model_config.json" }
// Prints its base URL on the first line of stdout, then serves until terminated.

import { readFileSync } from 'node:fs';
import { id, type LaunchId } from '../common/ids.ts';
import { LedgerClient } from '../ledger/ipc.ts';
import { DEFAULT_MODEL_CONFIG, loadModelConfig } from './modelConfig.ts';
import { MeteringProxy, ledgerSpend } from './proxy.ts';

const configPath = process.argv[2];
if (configPath === undefined) {
  process.stderr.write('usage: proxy-main.ts <config.json>\n');
  process.exit(2);
}
const c = JSON.parse(readFileSync(configPath, 'utf8')) as { launch: string; ledgerSocket: string; upstream?: string; modelConfig?: string };
const launch = id<LaunchId>(c.launch);
const client = new LedgerClient(c.ledgerSocket);
const proxy = await MeteringProxy.start({
  launch,
  ledger: ledgerSpend(client, launch),
  config: c.modelConfig !== undefined ? loadModelConfig(c.modelConfig) : DEFAULT_MODEL_CONFIG,
  ...(c.upstream !== undefined ? { upstream: c.upstream } : {}),
  onFatal: (reason, detail) => process.stderr.write(`[proxy] fatal ${reason}: ${detail}\n`),
});
process.stdout.write(`${proxy.url}\n`);
const stop = (): void => {
  void proxy.close(5_000).then(() => {
    client.close();
    process.exit(0);
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
