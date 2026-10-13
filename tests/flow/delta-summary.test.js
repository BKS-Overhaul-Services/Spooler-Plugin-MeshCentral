'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMock, makeAgentConn } = require('../_helpers/mock-meshcentral');

const factory = require('../../spooler.js').spooler;

// =============================================================================
// Flow: getDelta legado → tratado como summary direto (v1.2, sem delta)
//
// O delta antigo comparava hash do frontend × cache do servidor: mudanças
// espontâneas no DISPOSITIVO (job novo, impressora offline) nunca apareciam —
// o cache só mudava quando o servidor consultava o agente, e ele só consultava
// se o hash mudasse. Loop fechado = painel congelado.
//
// v1.2 (padrão Tracer/NetAdapter): getDelta vira summary direto — on-demand
// com dado sempre vivo. Frontends antigos (que mandam getDelta) continuam
// funcionando: recebem o summary completo pelo mesmo method:'delta'.
// =============================================================================

function makeSetup() {
    const audits = [];
    const agentConn = makeAgentConn('node//domain/n1');
    const { parent, captured } = buildMock({
        wsagents: { 'node//domain/n1': agentConn },
        wssessions2: { 'sess-1': { user: { _id: 'u', name: 'admin', siteadmin: 0xFFFFFFFF } } }
    });
    const obj = factory(parent);
    obj.db = {
        addAudit: function (a) { audits.push(a); },
        getAudit: function (q, o, cb) { cb(audits); },
        getPrintersByNode: function (n, cb) { cb([]); },
        getAllPrinters: function (cb) { cb([]); },
        addEvent: function () {}
    };
    return { obj, agentConn, captured, audits };
}

test('getDelta legado é convertido em summary direto (on-demand vivo)', () => {
    const { obj, agentConn } = makeSetup();

    obj.serveraction(
        { action: 'plugin', plugin: 'spooler', pluginaction: 'getDelta', nodeid: 'node//domain/n1', hash: 'hash-velho' },
        { ws: { sessionId: 'sess-1' }, user: null }, null
    );

    assert.equal(agentConn.sent.length, 1);
    const cmd = agentConn.sent[0];
    assert.equal(cmd.pluginaction, 'summary');   // convertido
    assert.equal(cmd.plugin, 'spooler');
    assert.ok(cmd.reqid);
    assert.ok(obj.pending[cmd.reqid], 'pending criado (aguardando agente)');
});

test('summary direto segue funcionando igual', () => {
    const { obj, agentConn } = makeSetup();

    obj.serveraction(
        { action: 'plugin', plugin: 'spooler', pluginaction: 'summary', nodeid: 'node//domain/n1' },
        { ws: { sessionId: 'sess-1' }, user: null }, null
    );

    assert.equal(agentConn.sent.length, 1);
    assert.equal(agentConn.sent[0].pluginaction, 'summary');
});

test('agentResult de summary responde delta COMPLETO (nunca unchanged) e cacheia', () => {
    const { obj, agentConn, captured } = makeSetup();

    obj.serveraction(
        { action: 'plugin', plugin: 'spooler', pluginaction: 'summary', nodeid: 'node//domain/n1' },
        { ws: { sessionId: 'sess-1' }, user: null }, null
    );
    const reqid = agentConn.sent[0].reqid;

    // agente responde
    obj.serveraction({
        action: 'plugin', plugin: 'spooler', pluginaction: 'agentResult', reqid: reqid,
        op: 'summary', ok: true,
        result: { printers: [{ name: 'HP', jobCount: 2 }], spooler: 'Running' }
    }, agentConn, null);

    const delta = captured.sent.filter(function (m) { return m.data.method === 'delta'; });
    assert.equal(delta.length, 1);
    assert.equal(delta[0].data.unchanged, false);       // SEMPRE payload completo
    assert.equal(delta[0].data.printers.length, 1);
    assert.ok(delta[0].data.hash);                       // hash novo p/ compat de frontend
    assert.equal(obj.pending[reqid], undefined);         // consumido
    assert.ok(obj.cache['node//domain/n1']);             // cache atualizado (informativo)
});
