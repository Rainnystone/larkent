import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A real stdio peer: validates ordering and configuration, never runs a model. */
export const DEVIN_ACP_FIXTURE_SOURCE = String.raw`
async function serveDevinAcp(script, hooks = {}) {
  const { createInterface } = await import('node:readline');
  const { writeFileSync, appendFileSync, existsSync } = await import('node:fs');
  let promptRequest;
  let modeSet = false;
  let sessionId = script.sessionId || script.exportSessionId || 'fixture-session';
  const calls = [];
  let record = { argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, calls,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(LARK_CHANNEL|LARKSUITE_CLI_CONFIG_DIR)/.test(key))) };
  const save = () => { if (hooks.recordPath) writeFileSync(hooks.recordPath, JSON.stringify(record)); };
  const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const respond = (id, result) => send({ id, result });
  const update = u => send({ method: 'session/update', params: { sessionId, update: u } });
  const sandbox = process.argv.includes('--sandbox');
  const modes = sandbox ? ['autonomous', 'plan'] : ['accept-edits', 'smart', 'ask', 'plan', 'bypass'];
  const configs = [
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: modes[0], options: modes.map(value => ({ value, name: value })) },
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'swe-2-high', options: ['adaptive','swe-2-high','swe-1-6','claude-opus-5-5-medium','claude-sonnet-5-5-medium'].map(value => ({ value, name: value })) },
    { id: 'thought_level', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: script.thoughtLevel || 'high', options: ['medium','high','max'].map(value => ({ value, name: value })) },
  ];
  const sessionResult = () => script.legacyModes ? { modes: { currentModeId: modes[0], availableModes: modes.map(id => ({id,name:id})) } } : { configOptions: configs };
  if (script.ignoreTerm) process.on('SIGTERM', () => {});
  if (script.ignoreEof) setInterval(() => {},1000);
  const rl = createInterface({ input: process.stdin });
  rl.on('close', () => { if (!script.ignoreEof && !script.holdAfterLines) process.exit(script.exitCode || 0); });
  rl.on('line', line => { void handle(JSON.parse(line)).catch(error => { console.error(error); process.exit(2); }); });
  async function handle(m) {
    if (!m.method) { record.permissionResponse = m; save(); if (promptRequest) respond(promptRequest.id, {stopReason:'end_turn'}); return; }
    calls.push({ method: m.method, params: m.params }); save();
    if (m.method === 'initialize') { respond(m.id, {protocolVersion:1, agentCapabilities:{loadSession:true}, authMethods:[]}); return; }
    if (m.method === 'session/new' || m.method === 'session/load') {
      if (hooks.onSession) hooks.onSession(m);
      if (m.method === 'session/load') {
        if (script.loadError) { send({id:m.id,error:{code:-32602,message:'Session missing'}}); return; }
        sessionId = m.params.sessionId;
        for (const u of script.replay || []) update(u);
      }
      respond(m.id, { ...(m.method === 'session/new' ? {sessionId} : {}), ...sessionResult() }); return;
    }
    if (m.method === 'session/set_config_option') {
      const c = configs.find(c => c.id === m.params.configId);
      if (script.configError || !c || !c.options.some(o => o.value === m.params.value)) { send({id:m.id,error:{code:-32602,message:'Invalid configuration'}}); return; }
      c.currentValue = m.params.value; if (c.id === 'mode') modeSet = true;
      respond(m.id, {configOptions:configs}); return;
    }
    if (m.method === 'session/set_mode') { modeSet = modes.includes(m.params.modeId); respond(m.id, {}); return; }
    if (m.method === 'session/cancel') { if (!script.ignoreCancel && promptRequest) respond(promptRequest.id, {stopReason:'cancelled'}); return; }
    if (m.method !== 'session/prompt') throw new Error('Unexpected method ' + m.method);
    if (!modeSet) throw new Error('Prompt reached peer before permissions were applied');
    promptRequest = m;
    if (script.spawnDescendant) {
      const { spawn } = await import('node:child_process');
      const code = script.descendantIgnoreTerm ? "process.on('SIGTERM', () => {}); process.send('ready'); process.disconnect(); setInterval(() => {},1000)" : 'setInterval(() => {},1000)';
      const escaped = spawn(process.execPath, ['-e',code], {stdio:script.descendantIgnoreTerm ? ['ignore','ignore','ignore','ipc'] : script.holdPipe ? ['ignore','inherit','ignore'] : 'ignore'});
      if (script.descendantIgnoreTerm) await new Promise(resolve => escaped.once('message', resolve));
      record.descendantPid = escaped.pid; escaped.unref();
    }
    record.stdin = m.params.prompt.map(c => c.text || '').join(''); save();
    if (script.recordAppendPath) appendFileSync(script.recordAppendPath, JSON.stringify(record) + '\n');
    if (script.readyPath) writeFileSync(script.readyPath, String(process.pid));
    if (script.stderr) process.stderr.write(script.stderr);
    if (script.permission) { send({id:'permission-1',method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:'blocked',title:'Run command',kind:'execute',rawInput:{command:'lark-cli auth login'}},options:[{optionId:'yes',name:'Allow',kind:'allow_once'},{optionId:'no',name:'Reject',kind:'reject_once'}]}}); return; }
    if (script.hang) return;
    if (script.releasePath) while (!existsSync(script.releasePath)) await new Promise(resolve => setTimeout(resolve,10));
    if (script.exitCode) { process.exit(script.exitCode); return; }
    const custom = hooks.onPrompt ? await hooks.onPrompt(record.stdin, update, record) : undefined;
    const updates = script.updates || (script.lines || []).map(line => typeof line === 'string' ? {sessionUpdate:'agent_message_chunk',content:{type:'text',text:line}} : line);
    for (const u of updates) update(u);
    if (custom !== undefined) update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:custom}});
    if (script.malformed) { process.stdout.write('{invalid\n'); return; }
    if (script.exitAfterUpdates !== undefined) { process.stdout.write('', () => process.exit(script.exitAfterUpdates)); return; }
    respond(m.id, {stopReason:script.stopReason || 'end_turn',usage:{inputTokens:12,outputTokens:3,totalTokens:15}});
    if (script.exitAfterTurn !== undefined) { process.stdout.write('', () => process.exit(script.exitAfterTurn)); return; }
    if (script.closeStdoutAfterLines) { process.stdout.end(); if (script.holdAfterLines) setInterval(() => {},1000); return; }
    if (script.holdAfterLines) setInterval(() => {},1000);
  }
}
`;

export async function installDevinAcpCli(root: string, script: Record<string, unknown> = {}) {
  const binary = join(root, 'devin-fixture.mjs');
  const recordPath = join(root, 'acp-calls.json');
  await writeFile(binary, `#!${process.execPath}\n${DEVIN_ACP_FIXTURE_SOURCE}\nawait serveDevinAcp(${JSON.stringify(script)}, {recordPath:${JSON.stringify(recordPath)}});\n`, { mode: 0o755 });
  return { binary, recordPath };
}
