#!/usr/bin/env -S node --import tsx
import fs from 'node:fs';
import { DesignerController } from './designer-controller.ts';
import { listSessions, getSession } from './session-store.ts';
import path from 'node:path';
import { createBrowser } from './browser.ts';
import { writeTastingHtml, serveAndOpen } from './tasting.ts';
import { sessionDir } from './artifact-store.ts';

const [, , cmd, ...rest] = process.argv;

type FlagValue = string | boolean | undefined;
interface Flags {
  _: string[];
  [k: string]: FlagValue | string[];
}

function parseFlags(args: string[]): Flags {
  const out: Flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (a.startsWith('--')) {
      const parts = a.slice(2).split('=');
      const k = parts[0] ?? '';
      const v = parts[1] ?? args[++i] ?? true;
      if (k) out[k] = v as FlagValue;
    } else {
      (out._ as string[]).push(a);
    }
  }
  return out;
}

const flags = parseFlags(rest);
const key = (flags.key as string) || 'default';

async function main(): Promise<void> {
  switch (cmd) {
    case 'open': {
      const c = new DesignerController({ key });
      console.log(JSON.stringify(await c.ensureReady(), null, 2));
      break;
    }
    case 'session': {
      const c = new DesignerController({ key });
      const action = (flags.action as 'status' | 'ensure_ready' | 'resume' | 'create') || 'status';
      const name = flags.name as string | undefined;
      const fidelity = flags.fidelity as 'wireframe' | 'highfi' | undefined;
      console.log(JSON.stringify(await c.session({ action, name, fidelity }), null, 2));
      break;
    }
    case 'prompt': {
      const prompt = flags._.join(' ');
      if (!prompt) throw new Error('Usage: designer prompt "<text>" [--key k] [--file "f.html"]');
      const c = new DesignerController({ key });
      const res = await c.iterate(prompt, {
        file: flags.file as string | undefined,
        timeoutMs: flags.timeoutMs ? Number(flags.timeoutMs) : undefined,
        stabilityMs: flags.stabilityMs ? Number(flags.stabilityMs) : undefined
      });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case 'create': {
      const name = (flags.name as string) || flags._[0];
      if (!name) throw new Error('Usage: designer create <name> [--fidelity wireframe|highfi] [--key k]');
      const fidelity = (flags.fidelity as 'wireframe' | 'highfi') || 'wireframe';
      const c = new DesignerController({ key });
      console.log(JSON.stringify(await c.createSession(name, fidelity), null, 2));
      break;
    }
    case 'resume': {
      const c = new DesignerController({ key });
      console.log(JSON.stringify(await c.resumeSession(), null, 2));
      break;
    }
    case 'snapshot': {
      const c = new DesignerController({ key });
      await c.ensureReady();
      const filename = flags.file as string | undefined;
      if (filename) await c.openFile(filename);
      const snap = await c.snapshotDesign();
      console.log(
        JSON.stringify(
          { file: filename ?? null, url: snap.url, htmlBytes: snap.html?.length || 0, screenshotPath: snap.screenshotPath },
          null,
          2
        )
      );
      break;
    }
    case 'status':
      console.log(JSON.stringify(getSession(key) || { key, empty: true }, null, 2));
      break;
    case 'list':
      console.log(JSON.stringify(listSessions(), null, 2));
      break;
    case 'projects': {
      const c = new DesignerController({ key });
      console.log(JSON.stringify(await c.listProjects(), null, 2));
      break;
    }
    case 'files': {
      const c = new DesignerController({ key });
      console.log(JSON.stringify(await c.listFiles(), null, 2));
      break;
    }
    case 'open-file': {
      const filename = flags._.join(' ');
      if (!filename) throw new Error('Usage: designer open-file "<name>.html" --key k');
      const c = new DesignerController({ key });
      console.log(JSON.stringify(await c.openFile(filename), null, 2));
      break;
    }
    case 'ask': {
      const prompt = flags._.join(' ');
      if (!prompt) throw new Error('Usage: designer ask "<text>" --key k');
      const c = new DesignerController({ key });
      const r = await c.ask(prompt, {
        file: flags.file as string | undefined,
        timeoutMs: flags.timeoutMs ? Number(flags.timeoutMs) : undefined,
        stabilityMs: flags.stabilityMs ? Number(flags.stabilityMs) : undefined
      });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'handoff': {
      const c = new DesignerController({ key });
      const r = await c.handoff({ openFile: flags.file as string | undefined });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'fetch': {
      const filename = flags._.join(' ');
      if (!filename) throw new Error('Usage: designer fetch "<name>.html" --key k [--out path]');
      const c = new DesignerController({ key });
      const r = await c.fetchFile(filename);
      if (flags.out) {
        fs.writeFileSync(flags.out as string, r.html);
        console.log(JSON.stringify({ file: r.file, htmlBytes: r.htmlBytes, written: flags.out }, null, 2));
      } else {
        console.log(
          JSON.stringify(
            { file: r.file, htmlBytes: r.htmlBytes, iframeSrc: r.iframeSrc, htmlPreview: r.html.slice(0, 200) },
            null,
            2
          )
        );
      }
      break;
    }
    case 'close': {
      await createBrowser({ session: `designer-${key}` }).close();
      console.log('closed');
      break;
    }
    case 'tasting': {
      const base = sessionDir(key);
      const handoffs = fs
        .readdirSync(base)
        .filter((e) => e.startsWith('handoff-'))
        .map((e) => path.join(base, e))
        .filter((p) => fs.statSync(p).isDirectory())
        .sort();
      const latest = handoffs[handoffs.length - 1];
      if (!latest) throw new Error(`No handoff bundle found for key=${key}. Run 'designer handoff --key ${key}' first.`);
      const slugDirs = fs
        .readdirSync(latest)
        .filter((e) => e !== 'bundle.tar.gz')
        .map((e) => path.join(latest, e))
        .filter((p) => fs.statSync(p).isDirectory());
      const slugDir = slugDirs[0];
      if (!slugDir) throw new Error('Bundle has no project subdirectory.');
      const projectDir = path.join(slugDir, 'project');
      if (!fs.existsSync(projectDir)) throw new Error(`Missing ${projectDir}`);

      const files = fs
        .readdirSync(projectDir)
        .filter((f) => f.endsWith('.html') && f !== 'tasting.html' && f !== 'index.html');
      if (files.length === 0) throw new Error('No .html variants found in bundle project dir.');

      const variants = files.map((f) => ({
        name: prettyName(f),
        file: f
      }));

      const tastingPath = writeTastingHtml({ projectDir, variants, title: key });
      const { url, port, pid } = await serveAndOpen(projectDir, { file: 'tasting.html' });
      console.log(JSON.stringify({ ok: true, tastingPath, url, port, serverPid: pid, variants }, null, 2));
      break;
    }
    default:
      console.log(`designer CLI
  session [--key k] [--action status|ensure_ready|resume|create] [--name N] [--fidelity wireframe|highfi]
                                               auto-orient / create / resume
  open [--key k]                               ensure browser on claude.ai/design
  create <name> [--key k] [--fidelity wireframe|highfi]
                                               create a new claude.ai/design project
  resume [--key k]                             navigate back into stored session url
  prompt "<text>" [--key k] [--file f.html] [--timeoutMs n] [--stabilityMs n]
                                               modify the design, wait, snapshot
  ask "<text>" [--key k] [--file f.html]       text-only Q&A with the assistant
  snapshot [--key k] [--file f.html]           capture current or switch+capture
  status [--key k]                             show stored state
  list                                         list locally-tracked sessions
  projects                                     list all Claude projects
  files [--key k]                              list files in the open project
  open-file "<name>.html" [--key k]            switch the open file
  fetch "<name>.html" [--key k] [--out path]   fetch a file's served HTML
  handoff [--key k] [--file "<name>.html"]     trigger Export→Handoff, download tar.gz, extract
  tasting [--key k]                            write tasting.html harness for the latest handoff bundle + serve + open
  close [--key k]                              close browser (state on disk preserved)

Env: DESIGNER_CDP=9222 attaches to Chrome at --remote-debugging-port=9222.`);
  }
}

function prettyName(filename: string): string {
  return filename
    .replace(/\.html$/i, '')
    .replace(/^(?:v\d+-|Philemon\s*[—-]\s*|.*?\s-\s)/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || filename;
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
