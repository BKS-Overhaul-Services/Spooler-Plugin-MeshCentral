'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMock, makeDb, makeAgentConn } = require('../_helpers/mock-meshcentral');

const factory = require('../../spooler.js').spooler;

// =============================================================================
// Flow: reconciliação de resultados de mutação recuperados do journal
// (serveraction branch from:'agent' + cmd:'mutresults')
//
// Cenário: admin executa pausePrinter → agente executa com sucesso → a
// conexão cai → agentResult se perde → servidor responderia TIMEOUT e o audit
// registraria mentira. Com o result-journal, o agente drena o resultado no
// reconnect e o servidor:
//   - pending aberto  → fecha com o resultado REAL + notifica o browser
//   - pending fechado (timeout já respondeu) → audit apenas
//   - reqid já auditado (caminho normal chegou antes) → dedup, só ack
//   - mutação → invalida cache do catálogo
//   - SEMPRE responde mutack com os ids processados (JSON string p/ o agente)
// =============================================================================

function makeSetup(opts) {
    opts = opts || {};
    const audits = [];
    const user = opts.user || { _id: 'user//domain/admin', siteadmin: 0xFFFFFFFF, name: 'admin' };
    const agentConn = makeAgentConn('node//domain/n1');
    const { parent, captured } = buildMock({
        wsagents: { 'node//domain/n1': agentConn },
        wssessions2: opts.wssessions2 || { 'sess-1': { user: user } }
    });
    const obj = factory(parent);
    obj.db = makeDb(audits);
    return { obj, agentConn, captured, audits };
}

function mutResults(obj, conn, results) {
    obj.serveraction({
        action: 'plugin', plugin: 'spooler', from: 'agent',
        cmd: 'mutresults', results: results
    }, conn, null);
}

test('mutresults: pending aberto → fecha com resultado real, audita, notifica browser e acka', () => {
    const { obj, agentConn, captured, audits } = makeSetup();
    // simula request em andamento (agente executando a mutação)
    obj.pending['sp-r1'] = { sid: 'sess-1', nodeid: 'node//domain/n1', op: 'pausePrinter', user: user(), ts: Date.now(), mut: true };
    obj.cache['node//domain/n1'] = { adapters: [], ts: Date.now() };

    mutResults(obj, agentConn, [
        { id: 'sp-r1', k: 'r', op: 'pausePrinter', ok: true, error: null, target: 'HP LaserJet', ts: Date.now() }
    ]);

    // pending fechado
    assert.equal(obj.pending['sp-r1'], undefined);
    // browser recebeu o resultado REAL (não timeout)
    const toBrowser = captured.sent.filter(function (m) { return m.data.method === 'agentResult'; });
    assert.equal(toBrowser.length, 1);
    assert.equal(toBrowser[0].data.ok, true);
    assert.equal(toBrowser[0].data.op, 'pausePrinter');
    assert.equal(toBrowser[0].data.reqid, 'sp-r1');
    assert.equal(toBrowser[0].data._journal, true);
    // audit com a verdade
    assert.equal(audits.length, 1);
    assert.equal(audits[0].ok, true);
    assert.match(audits[0].detail, /recuperado via journal/);
    assert.equal(audits[0].target, 'HP LaserJet');
    // cache de catálogo invalidado (mutação)
    assert.equal(obj.cache['node//domain/n1'], undefined);
    // ack p/ o agente (mock parseia a JSON string; contrato servidor→agente é string)
    assert.ok(agentConn.sent.length >= 1);
    const ack = agentConn.sent[0];
    assert.equal(ack.cmd, 'mutack');
    assert.deepEqual(ack.ids, ['sp-r1']);

    function user() { return { _id: 'user//domain/admin', name: 'admin' }; }
});

test('mutresults: pending fechado (timeout já respondeu) → audit apenas, sem browser', () => {
    const { obj, agentConn, captured, audits } = makeSetup();
    // sem pending: o sweeper de timeout já removeu e respondeu ao browser

    mutResults(obj, agentConn, [
        { id: 'sp-r2', k: 'r', op: 'setIp', ok: false, error: 'acesso negado', target: 'LAN', ts: Date.now() }
    ]);

    const toBrowser = captured.sent.filter(function (m) { return m.data.method === 'agentResult'; });
    assert.equal(toBrowser.length, 0); // ninguém para notificar
    assert.equal(audits.length, 1);
    assert.equal(audits[0].ok, false);
    assert.equal(audits[0].detail, 'acesso negado (recuperado via journal)');
    assert.equal(audits[0].nodeid, 'node//domain/n1'); // deriva da conexão do agente
    assert.deepEqual(agentConn.sent[0].ids, ['sp-r2']);
});

test('mutresults: resultado sintético (reboot no meio da mutação) é marcado no audit', () => {
    const { obj, agentConn, audits } = makeSetup();

    mutResults(obj, agentConn, [
        { id: 'sp-r3', k: 'r', op: 'setMac', ok: false, error: 'agente reiniciou durante a mutação (resultado desconhecido)', target: 'LAN', ts: Date.now(), synthetic: true }
    ]);

    assert.equal(audits.length, 1);
    assert.match(audits[0].detail, /\[agente reiniciou no meio da mutação\]/);
    assert.equal(audits[0].ok, false);
});

test('mutresults: dedup — reqid já auditado via caminho normal não re-audita', () => {
    const { obj, agentConn, audits } = makeSetup();
    obj._markMutAudited('na-done'); // caminho normal (agentResult com pending) chegou antes

    mutResults(obj, agentConn, [
        { id: 'na-done', k: 'r', op: 'pausePrinter', ok: true, error: null, target: 'E1', ts: Date.now() }
    ]);

    assert.equal(audits.length, 0);           // sem dupla auditoria
    assert.deepEqual(agentConn.sent[0].ids, ['na-done']); // mas acka (agente pode apagar)
});

test('mutresults: batch misto (pendings + dups + inválidos) processa o que dá e acka os válidos', () => {
    const { obj, agentConn, audits } = makeSetup();
    obj.pending['na-a'] = { sid: 'sess-1', nodeid: 'node//domain/n1', op: 'setMtu', user: null, ts: Date.now(), mut: true };
    obj._markMutAudited('na-b');

    mutResults(obj, agentConn, [
        { id: 'na-a', k: 'r', op: 'setMtu', ok: true, error: null, target: 'E1', ts: 1 },
        { id: 'na-b', k: 'r', op: 'setMtu', ok: true, error: null, target: 'E1', ts: 2 },   // dup
        { k: 'r', op: 'sem-id' },                                                            // inválido
        { id: 'na-c', k: 'r', op: 'resetMac', ok: true, error: null, target: 'E2', ts: 3 }   // sem pending
    ]);

    assert.equal(audits.length, 2); // na-a e na-c
    const ack = agentConn.sent[0];
    assert.deepEqual(ack.ids.sort(), ['na-a', 'na-b', 'na-c']); // inválido fora, dups dentro
});

test('mutresults: envelope inesperado (sem results) não quebra e não acka', () => {
    const { obj, agentConn, audits } = makeSetup();
    mutResults(obj, agentConn, null);
    mutResults(obj, agentConn, []);
    assert.equal(audits.length, 0);
    assert.equal(agentConn.sent.length, 0);
});

