import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cloneBase } from "../src/clone-base.ts";
import { sessionHash } from "../src/base-registry.ts";

test("clones pinned base through a separate RPC process and refuses mutated source", async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "split-clone-"));
  const previous = process.env.PATH;
  t.after(() => { process.env.PATH = previous; fs.rmSync(cwd, { recursive: true, force: true }); });
  const bin = path.join(cwd, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "pi"), `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const file=process.argv[process.argv.indexOf('--session')+1];
let cloned=false,buf='';
process.stdin.on('data',data=>{buf+=data;const lines=buf.split('\\n');buf=lines.pop();for(const line of lines){const c=JSON.parse(line);let result;
if(c.type==='clone'){cloned=true;fs.writeFileSync(path.join(process.cwd(),'clone.jsonl'),fs.readFileSync(file));result={cancelled:false};}
else if(c.type==='get_state')result=cloned?{sessionId:'clone-1',sessionFile:path.join(process.cwd(),'clone.jsonl')}:{sessionId:'base-1',sessionFile:file};
console.log(JSON.stringify({type:'response',id:c.id,success:true,data:result}));}});
`, { mode: 0o700 });
  process.env.PATH = bin + path.delimiter + previous;
  const sessionFile = path.join(cwd, "base.jsonl"); fs.writeFileSync(sessionFile, "history\n");
  const base = { name: "docs", version: 1, task: "t", agent: "coder", session: "base-1", sessionFile, sha256: sessionHash(sessionFile), createdAt: "now" };
  const cloned = await cloneBase(cwd, base);
  assert.equal(cloned.session, "clone-1");
  assert.equal(fs.readFileSync(cloned.sessionFile, "utf8"), "history\n");
  assert.equal(sessionHash(sessionFile), base.sha256);
  fs.appendFileSync(sessionFile, "mutation\n");
  await assert.rejects(cloneBase(cwd, base), /missing or modified/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(cloneBase(cwd, base, abort.signal), /cancelled/);
});
