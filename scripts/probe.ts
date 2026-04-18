#!/usr/bin/env -S node --import tsx
import { createBrowser } from '../browser.ts';

const cmd = process.argv[2];
const arg = process.argv[3];

const browser = createBrowser({ headed: true });
if (!process.env.DESIGNER_CDP) {
  console.error(
    '[probe] DESIGNER_CDP not set — using agent-browser-managed session (may be blocked by Cloudflare/SSO). Prefer: export DESIGNER_CDP=9222 and relaunch Chrome with --remote-debugging-port=9222.'
  );
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'login':
      console.log('Opening claude.ai/design in a headed browser window.');
      console.log('Complete Cloudflare + sign in. Session state auto-persists to ~/.agent-browser/.');
      await browser.open('https://claude.ai/design');
      break;
    case 'url':
      console.log(await browser.url());
      break;
    case 'title':
      console.log(await browser.title());
      break;
    case 'snapshot':
      console.log(await browser.snapshotText({ interactive: true, scope: arg }));
      break;
    case 'snapshot-json':
      console.log(JSON.stringify(await browser.snapshot({ interactive: true, scope: arg }), null, 2));
      break;
    case 'screenshot': {
      const p = arg || `./logs/probe-${Date.now()}.png`;
      await browser.screenshot(p, { full: true });
      console.log(p);
      break;
    }
    case 'eval':
      if (!arg) throw new Error('Usage: probe.ts eval <js>');
      console.log(await browser.eval(arg));
      break;
    case 'open':
      await browser.open(arg || 'https://claude.ai/design');
      console.log(await browser.url());
      break;
    case 'close':
      await browser.close();
      break;
    default:
      console.log(`Usage:
  probe.ts login                  open headed window for manual login
  probe.ts open <url>             navigate
  probe.ts url                    print current url
  probe.ts title                  print current title
  probe.ts snapshot [scope]       interactive a11y tree (text)
  probe.ts snapshot-json [scope]  interactive a11y tree (JSON)
  probe.ts screenshot [path]      full-page screenshot
  probe.ts eval <js>              evaluate JS in page
  probe.ts close                  close browser`);
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
