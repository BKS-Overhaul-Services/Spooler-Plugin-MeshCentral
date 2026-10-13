'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// =============================================================================
// Unit: na-journal.js — journal de resultados de mutação (store-and-forward)
//
// Padrão extraído do session-tracer (Tracer v4). Problema que resolve:
// mutações que derrubam a conexão do agente (disableAdapter, setIp, setMac...)
// executam no dispositivo mas o agentResult se perde → audit registra timeout
// falso. Com o journal: intent write-ahead → resultado write-ahead → drain
// com ack no reconnect → servidor audita a verdade.
//
// Contratos pinados:
//   - intent ANTES da execução; result DEPOIS; ambos sobrevivem a crash
//   - boot sintetiza resultado de incerteza p/ intents sem result (reboot no meio)
//   - drain envia não-ackados mais antigos primeiro; ack(ids) remove exatamente o batch
//   - JSONL append-only; linha parcial (crash) descartada na carga
//   - cap: descarta mais antigos; nunca excede
//   - zero side effects no load (timers só via startDrainTimer)
// =============================================================================

const MODULE = path.resolve(__dirname, '../../modules_meshcore/na-journal.js');
const FILE = 'sp-test.journal';

let _origCwd = null;

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sp-journal-')); }

function loadIn(dir) {
    _origCwd = _origCwd || process.cwd();
    process.chdir(dir);
    delete require.cache[MODULE];
    const mod = require(MODULE).Create({ plugin: 'netadapter', file: FILE, cap: 100 });
    mod.load();
    return mod;
}

function back(mod) {
    mod.stopTimers();
    delete require.cache[MODULE];
    try { process.chdir(_origCwd); } catch (e) {}
}

// =============================================================================

test('journal: intent + result persistem em JSONL; pending() retorna resultado não-ackado', () => {
    const dir = tmpdir();
    const j = loadIn(dir);
    try {
        j.intent('r1', 'disableAdapter', { name: 'Ethernet 2' });
        j.result('r1', 'disableAdapter', true, null, 'Ethernet 2');
        const pend = j.pending();
        assert.equal(pend.length, 1);
        assert.equal(pend[0].id, 'r1');
        assert.equal(pend[0].ok, true);
        assert.equal(pend[0].target, 'Ethernet 2');
        assert.ok(fs.existsSync(path.join(dir, FILE)));
    } finally { back(j); }
});

test('journal: boot sintetiza resultado de incerteza p/ intent sem result (reboot no meio)', () => {
    const dir = tmpdir();
    // simula crash: intent gravada, execução interrompida, result nunca gravado
    fs.writeFileSync(path.join(dir, FILE),
        JSON.stringify({ id: 'rX', k: 'i', op: 'setIp', params: { name: 'Wi-Fi' }, ts: 1 }) + '\n', 'utf8');

    const j = loadIn(dir);
    try {
        const pend = j.pending();
        assert.equal(pend.length, 1);
        assert.equal(pend[0].id, 'rX');
        assert.equal(pend[0].ok, false);
        assert.match(pend[0].error, /reiniciou durante a muta/);
        assert.equal(pend[0].synthetic, true);
        assert.equal(pend[0].target, 'Wi-Fi'); // target derivado da intent
    } finally { back(j); }
});

test('journal: linha parcial (crash no write) é descartada sem quebrar o resto', () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, FILE), [
        JSON.stringify({ id: 'a', k: 'i', op: 'setMac', params: { name: 'LAN' }, ts: 1 }),
        JSON.stringify({ id: 'a', k: 'r', op: 'setMac', ok: true, error: null, target: 'LAN', ts: 2 }),
        '{"id":"b","k":"r","op":"dis'   // ← crash no meio do write
    ].join('\n') + '\n', 'utf8');

    const j = loadIn(dir);
    try {
        const pend = j.pending();
        assert.equal(pend.length, 1);
        assert.equal(pend[0].id, 'a'); // parcial descartada
    } finally { back(j); }
});

test('journal: drain envia batch e ack remove exatamente o batch ackado', () => {
    const dir = tmpdir();
    const j = loadIn(dir);
    try {
        j.intent('r1', 'disableAdapter', { name: 'E1' });
        j.result('r1', 'disableAdapter', true, null, 'E1');
        j.intent('r2', 'setIp', { name: 'E2' });
        j.result('r2', 'setIp', false, 'placa ocupada', 'E2');

        const sent = [];
        const drained = j.drain(function (cmd) { sent.push(cmd); });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].action, 'plugin');
        assert.equal(sent[0].plugin, 'netadapter');
        assert.equal(sent[0].cmd, 'mutresults');
        assert.deepEqual(drained.map(function (r) { return r.id; }), ['r1', 'r2']);

        // sem ack: drain reenvia (at-least-once)
        assert.equal(j.drain(function () {}).length, 2);

        // ack do servidor: sai do journal
        j.ack(['r1', 'r2']);
        assert.equal(j.pending().length, 0);
    } finally { back(j); }
});

test('journal: drain falha (túnel caído) → nada é marcado como enviado', () => {
    const dir = tmpdir();
    const j = loadIn(dir);
    try {
        j.intent('r1', 'setMac', { name: 'LAN' });
        j.result('r1', 'setMac', true, null, 'LAN');
        const drained = j.drain(function () { throw new Error('tunnel down'); });
        assert.equal(drained.length, 0);
        assert.equal(j.pending().length, 1); // intacto
    } finally { back(j); }
});

test('journal: cap descarta os mais antigos (é journal de results, não histórico)', () => {
    const dir = tmpdir();
    const j = loadIn(dir);
    try {
        // cap interno 100 via opts; força estouro usando o módulo direto
        for (let i = 0; i < 120; i++) {
            j.intent('r' + i, 'op', null);
            j.result('r' + i, 'op', true, null, null);
        }
        assert.ok(j.pending().length <= 100, 'cap respeitado');
        // os mais antigos foram descartados: r0 não está mais pendente
        assert.equal(j.pending().some(function (r) { return r.id === 'r0'; }), false);
        assert.equal(j.pending().some(function (r) { return r.id === 'r119'; }), true);
    } finally { back(j); }
});

test('journal: ack parcial reenvia o que ficou de fora', () => {
    const dir = tmpdir();
    const j = loadIn(dir);
    try {
        j.intent('r1', 'op', null); j.result('r1', 'op', true, null, null);
        j.intent('r2', 'op', null); j.result('r2', 'op', false, 'err', null);
        j.drain(function () {});
        j.ack(['r1']); // servidor só processou r1 (ex.: r2 inválido)
        const pend = j.pending();
        assert.deepEqual(pend.map(function (r) { return r.id; }), ['r2']);
    } finally { back(j); }
});

