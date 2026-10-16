'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMock, makeDb, makeAgentConn } = require('../_helpers/mock-meshcentral');
const factory = require('../../spooler.js').spooler;

// =============================================================================
// F4 — passthrough do servidor: campos partial/warnings do agentResult do
// discover chegam ao browser (e NÃO poluem outras ops).
// Orquestrador em si (hidden→tcp→wsd→mdns, merge, orçamento 90s) roda no
// AGENTE — validado ao vivo (bench 2026-10-16, 4 resultados reais); aqui
// prova-se o contrato de transporte server→frontend.
// =============================================================================

function makeSetup() {
    const audits = [];
    const user = { _id: 'user//domain/admin', siteadmin: 0xFFFFFFFF, name: 'admin' };
    const agentConn = makeAgentConn('node//domain/n1');
    const { parent, captured } = buildMock({
        wsagents: { 'node//domain/n1': agentConn },
        wssessions2: { 'sess-1': { user: user } }
    });
    const obj = factory(parent);
    obj.db = makeDb(audits);
    obj.pending['sp-auto1'] = { sid: 'sess-1', nodeid: 'node//domain/n1', op: 'discover', user: { _id: 'user//domain/admin', name: 'admin' }, ts: Date.now(), mut: false };
    return { obj, agentConn, captured };
}

test('F4: agentResult discover com partial/warnings → campos chegam ao browser', () => {
    const { obj, agentConn, captured } = makeSetup();
    obj.serveraction({
        action: 'plugin', plugin: 'spooler', from: 'agent',
        reqid: 'sp-auto1', op: 'discover', ok: true, partial: true,
        warnings: ['wsd: não executado (orçamento de 90s)'],
        result: [{ ip: '192.168.0.16', source: 'tcp' }]
    }, agentConn, null);
    const toBrowser = captured.sent.filter(m => m.data.method === 'agentResult');
    assert.equal(toBrowser.length, 1);
    assert.equal(toBrowser[0].data.partial, true);
    assert.deepEqual(toBrowser[0].data.warnings, ['wsd: não executado (orçamento de 90s)']);
    assert.equal(toBrowser[0].data.ok, true);
});

test('F4: agentResult discover sem partial/warnings → campos ausentes (não null)', () => {
    const { obj, agentConn, captured } = makeSetup();
    obj.serveraction({
        action: 'plugin', plugin: 'spooler', from: 'agent',
        reqid: 'sp-auto1', op: 'discover', ok: true,
        result: [{ ip: '192.168.0.16', source: 'tcp' }]
    }, agentConn, null);
    const toBrowser = captured.sent.filter(m => m.data.method === 'agentResult');
    assert.equal(toBrowser.length, 1);
    assert.equal(toBrowser[0].data.partial, undefined);
    assert.equal(toBrowser[0].data.warnings, undefined);
});

test('F4: passthrough não vaza partial/warnings para ops que não são discover', () => {
    const { obj, agentConn, captured } = makeSetup();
    obj.pending['sp-sum1'] = { sid: 'sess-1', nodeid: 'node//domain/n1', op: 'summary', user: { _id: 'user//domain/admin', name: 'admin' }, ts: Date.now(), mut: false };
    obj.serveraction({
        action: 'plugin', plugin: 'spooler', from: 'agent',
        reqid: 'sp-sum1', op: 'summary', ok: true,
        partial: true, warnings: ['x'],
        result: { printers: [], spooler: 'Running' }
    }, agentConn, null);
    const toBrowser = captured.sent.filter(m => m.data.method === 'delta');
    assert.equal(toBrowser.length, 1); // summary segue o fluxo delta, sem os campos
    assert.equal(toBrowser[0].data.partial, undefined);
    assert.equal(toBrowser[0].data.warnings, undefined);
});
