'use strict';
// =============================================================================
// FASE 2 — adapter _nbmock → harness core-real (API compatível).
// buildMock(opts) devolve { parent, meshServer, webserver, captured } — MESMA
// interface do _nbmock antigo — mas tudo aponta para o harness core-real:
//   parent.parent      = meshServer do harness (com pluginHandler REAL)
//   parent.webserver?  não é usado pelas suites
//   meshServer.webserver = serverParent do harness (wssessions2/wsagents VIVOS)
//   captured.sent      = msgs enviadas aos sids (shape {sid, data} mantida)
// O plugin factory é registrado no pluginHandler REAL, então rotas do core
// (processWebSocketData → case 'plugin') também funcionam sobre ele.
// GetNodeWithRights custom (opts.GetNodeWithRights) NÃO é suportado aqui:
// suites que dependem disso continuam no _nbmock clássico.
// =============================================================================
const path = require('path');
const H = require('./core-harness.js');

function buildMock(opts = {}) {
    opts = opts || {};
    if (typeof opts.GetNodeWithRights === 'function') return null; // wrapper decide

    const h = H.create({ plugins: {} });
    const captured = { sent: [] };

    // sid → sessão real. login por sid; msgs ao sid caem em captured.sent.
    // USER RESOLUTION (fallback REAL): plugin-acl getUser lê
    // webserver.users[command.userid]; o core injeta command.userid=user._id
    // (meshuser.js:4909). O fallback wssessions2[sid].user do acl NUNCA dispara
    // com core real (meshuser.js:416 grava o ws-handler, sem .user) — artefato
    // do mock antigo (achado registrado em memorias-geral).
    const sids = Object.keys(opts.wssessions2 || {});
    let ready = Promise.resolve();
    const userBySid = {};
    for (const sid of sids) {
        const u = (opts.wssessions2[sid] || {}).user;
        if (u) { h.users[u._id] = u; userBySid[sid] = u; } else { userBySid[sid] = h.defaultUser; }
    }
    ready = (async () => {
        for (const sid of sids) {
            await h.login(userBySid[sid]);
            const realSid = h.userWs.sessionId;
            const sess = h.serverParent.wssessions2[realSid];
            if (sess) {
                delete h.serverParent.wssessions2[realSid];
                h.serverParent.wssessions2[sid] = sess;
                sess.send = function (raw) { captured.sent.push({ sid: sid, data: JSON.parse(raw) }); };
            }
        }
    })();

    const serverParent = h.serverParent;
    const meshServer = h.serverParent.parent; // obj.meshServer dos plugins (com .webserver vivo)

    // replica meshuser.js:4909 (core injeta command.userid=user._id antes do serveraction) — o acl
    // getUser usa fallback 3 (webserver.users[command.userid]) com esse id.
    const mock = {

        __harness: h,
        __ready: ready,
        parent: serverParent,   // o que as suites passam como factory(mock.parent)
        meshServer: meshServer, // compat: alguns testes leem mock.meshServer
        webserver: serverParent, // suites fazem mock.webserver.wsagents[nid] = fake — VIVO (core lê)
        captured: captured,
        wsagentsProxy: serverParent.wsagents
    };
    mock.serveractionWrapper = function (obj) {
        const orig = obj.serveraction.bind(obj);
        obj.serveraction = function (command, myparent, gp) {
            if (myparent && myparent.ws && myparent.ws.sessionId && command.userid === undefined) {
                const u = userBySid[myparent.ws.sessionId];
                if (u) command.userid = u._id; // meshuser.js:4909
            }
            return orig(command, myparent, gp);
        };
    };
    return mock;
}

module.exports = { buildMock };
