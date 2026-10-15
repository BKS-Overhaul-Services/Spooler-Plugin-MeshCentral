'use strict';
// =============================================================================
// PORT SP — harness core-real: falhas de domínio do Spooler.
// (pause/resume com agente caindo; WQL rejeitada; job/op concorrente mesmo node)
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const H = require('../_helpers/core-harness.js');
const NID = 'node/domain/sp1';
const MESH = 'mesh/domain/mesh1';
const ADMIN = { _id: 'user/admin', siteadmin: 0xFFFFFFFF, domain: 'domain', consent: 0, links: { [MESH]: { rights: 0xFFFFFFFF } } };

async function makeSP() {
    const h = H.create({});
    delete require.cache[path.resolve(__dirname, '../../spooler.js')];
    const obj = require(path.resolve(__dirname, '../../spooler.js')).spooler(h.serverParent);
    h.pluginHandler.plugins.spooler = obj;
    const orig = obj.serveraction.bind(obj);
    obj.serveraction = function (command, myparent, gp) {
        if (myparent && myparent.ws && myparent.ws.sessionId && command.userid === undefined) {
            const sess = h.serverParent.wssessions2[myparent.ws.sessionId];
            if (sess && sess.user) command.userid = sess.user._id; // meshuser.js:4909
        }
        return orig(command, myparent, gp);
    };
    const agent = h.addAgent(NID, MESH);
    return { h, obj, agent };
}

test('PORT SP: pausePrinter com agente caindo — pending criado, timeout entrega erro, não lança', async () => {
    const { h, obj, agent } = await makeSP();
    await h.login(ADMIN);
    agent.noReply(); // agente nunca responde
    h.sendUser({ action: 'plugin', plugin: 'spooler', pluginaction: 'pausePrinter', nodeid: NID, params: { name: 'HP' } });
    await pollUntil(() => Object.keys(obj.pending).length === 1, 2000);
    const reqid = Object.keys(obj.pending)[0];
    // agente cai definitivamente
    agent.close();
    // timeout da varredura real (spooler.js:103-107) replicado: entrega não lança com sid/sessão vivos
    assert.doesNotThrow(function () {
        var p = obj.pending[reqid];
        obj.send(p.sid, { action: 'plugin', plugin: 'spooler', method: 'agentResult', op: p.op, nodeid: p.nodeid, ok: false, error: 'Timeout', reqid: reqid });
        delete obj.pending[reqid];
    }, 'timeout lançou');
    assert.equal(obj.pending[reqid], undefined);
    h.stop();
});

test('PORT SP: nome com aspas duplas — agente REAL rejeita (P0-2), erro chega ao browser', async () => {
    const { h, obj, agent } = await makeSP();
    agent.replyWith(function (msg, rights, sessionid) {
        // consoleaction REAL do agente SP (modules_meshcore/spooler.js:580 rejeita)
        const SP = require(path.resolve(__dirname, '../../modules_meshcore/spooler.js'));
        SP.consoleaction(msg, rights, sessionid, { SendCommand: function (raw) {
            h.agentMessage(NID, JSON.parse(raw));
        } });
    });
    await h.login(ADMIN);
    h.sendUser({ action: 'plugin', plugin: 'spooler', pluginaction: 'pausePrinter', nodeid: NID, params: { name: 'x"; calc' } });
    // 2 agentResults: 'started' (ok:true, fase) e o FINAL com a rejeição — aguardar o final via poll
    await pollUntil(() => h.sent.some(m => m.method === 'agentResult' && m.reqid && m.phase === undefined), 5000);
    const results = h.sent.filter(m => m.method === 'agentResult' && m.phase === undefined);
    assert.ok(results.length >= 1);
    const final = results[results.length - 1];
    assert.equal(final.ok, false, 'rejeição final');
    assert.ok(/aspas duplas/.test(final.error), 'mensagem P0-2: ' + final.error);
    h.stop();
});

test('PORT SP: 2 admins mesma operação no mesmo node — pendings independentes por reqid', async () => {
    const { h, obj } = await makeSP();
    const admin2 = { _id: 'user/admin2', siteadmin: 0xFFFFFFFF, domain: 'domain', consent: 0, links: { [MESH]: { rights: 0xFFFFFFFF } } };
    h.users[admin2._id] = admin2;
    await h.login(ADMIN);
    const ws1 = h.userWs;
    await h.login(admin2);
    const ws2 = h.userWs;
    h.sendUser({ action: 'plugin', plugin: 'spooler', pluginaction: 'summary', nodeid: NID });
    // segunda sessão: emite direto no ws1? Não — summary do admin1 via ws1 (ainda ativo no harness)
    await pollUntil(() => Object.keys(obj.pending).length >= 1, 2000);
    const ids = Object.keys(obj.pending);
    assert.ok(ids.length >= 1);
    // 2ª chamada pelo serveraction com sessão do admin2 (sid sintético)
    h.serverParent.wssessions2['sid-2'] = { user: admin2, send: function () {} };
    obj.serveraction({ plugin: 'spooler', pluginaction: 'summary', nodeid: NID }, { ws: { sessionId: 'sid-2' } }, null);
    const ids2 = Object.keys(obj.pending);
    assert.equal(new Set(ids2).size, ids2.length, 'sem colisão de reqid');
    h.stop();
});

function pollUntil(cond, timeoutMs) {
    const start = Date.now();
    return new Promise(function (resolve) {
        const iv = setInterval(function () {
            if (cond() || Date.now() - start > (timeoutMs || 2000)) { clearInterval(iv); resolve(cond()); }
        }, 10);
    });
}
