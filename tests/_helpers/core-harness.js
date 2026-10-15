'use strict';
// =============================================================================
// core-harness.js — Harness ponto a ponto com ARQUIVOS REAIS do core MeshCentral.
// =============================================================================
// FONTE REAL (nada de reimplementar roteamento):
//   <CORE>/meshuser.js       → CreateMeshUser + processWebSocketData + routeCommandToNode
//                              (meshuser.js:23 / :704 / :276) — ROTEAMENTO REAL
//   <CORE>/pluginHandler.js  → pluginHandler real (pluginHandler.js:24) — hooks,
//                              addMeshCoreModules, handleAdminReq — HOOKS REAIS
//   <CORE>/common.js         → validações reais (validateString etc.)
//
// ÚNICO STUB (pequeno, validado por contrato): webserver.GetNodeWithRights —
// a função real vive numa closure do boot completo (webserver.js:9748) e exige
// db+config bootados. O stub REPLICA O CONTRATO documentado :9748-9813
// (validação user/nodeid/domínio, resolução via user.links[meshid] e
// userGroups, MESHRIGHT_ADMIN). Testes de contrato (harness-contract.test.js)
// fixam esse comportamento contra casos do core real. NUNCA colocar lógica de
// plugin aqui.
//
// Plugins: os OBJETOS REAIS das factories dos plugins (ex.:
// require('<plugin>/nodebridge.js').nodebridge(parent)) são registrados no
// pluginHandler real (ph.plugins.<shortName> = <objeto real>) — o core despacha
// {action:'plugin'} via meshuser.js:4907-4920 exatamente como em produção.
//
// wsagents: fake WS CONTROLÁVEL — scriptável para close/no-resposta/resposta
// tardia/crash (Fase 3: 7 casos de falha).
//
// Uso:
//   const H = require('<plugin>/tests/_helpers/core-harness');
//   const h = H.create({ plugins: { nodebridge: require('../../nodebridge.js').nodebridge } });
//   await h.login();                                   // usuário admin por default
//   h.sendUser({ action:'plugin', plugin:'nodebridge', ... });  // browser → core
//   h.agents['node/domain/pc1'].emitFromAgent({...});  // agente → core
//   h.sent / h.agentSent                               // tráfego capturado
// =============================================================================
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const EventEmitter = require('events');

// Core real — caminho único, centralizado (mude aqui se a instalação mudar)
const MESHCENTRAL_ROOT = process.env.MC_CORE_ROOT ||
    path.resolve(__dirname, '../../../../Server/Open Source/MeshCentral/node_modules/meshcentral');

function loadCore(mod) {
    // cache-bypass: cada harness roda com seus próprios objetos
    const full = path.join(MESHCENTRAL_ROOT, mod);
    delete require.cache[require.resolve(full)];
    return require(full);
}

const DOMAIN_ID = 'domain';

// ---- agente fake WS controlável --------------------------------------------
function createFakeAgent(nodeid, meshid, opts) {
    const state = {
        nodeid: nodeid,
        dbNodeKey: nodeid,
        dbMeshKey: meshid,
        connected: true,
        closed: false,
        onConsoleAction: null,   // se setado: handler de {action:'plugin'} vindo do server
        sentToAgent: []          // tudo que o SERVER mandou ao agente
    };
    const agent = {
        nodeid: nodeid,
        dbNodeKey: nodeid,
        dbMeshKey: meshid,
        // chamado pelo routeCommandToNode real (meshuser.js:321)
        send: function (raw) {
            if (state.closed) return; // WS morto: silent drop (o core real faz try/catch :321)
            const msg = JSON.parse(raw);
            state.sentToAgent.push(msg);
            if (typeof state.onConsoleAction === 'function') {
                // replica o core do agente real: agents/meshcore.js:2067
                // require(data.plugin).consoleaction(data, data.rights, data.sessionid, this)
                setImmediate(function () {
                    if (state.closed || !state.onConsoleAction) return;
                    try { state.onConsoleAction(msg, msg.rights, msg.sessionid); } catch (e) { /* agente crashou */ }
                });
            }
        },
        // ---- API de script de falhas (Fase 3) ----
        close: function () { state.connected = false; state.closed = true; state.onConsoleAction = null; }, // WS cai
        crash: function () { state.onConsoleAction = function () { throw new Error('agente crashou'); }; },
        noReply: function () { state.onConsoleAction = null; },
        replyWith: function (fn) { state.onConsoleAction = fn; }
    };
    return { agent: agent, state: state };
}

// ---- GetNodeWithRights: stub de contrato (webserver.js:9748-9813) -----------
// Replica: validações (user/nodeid/domínio), links direto no mesh, links de
// userGroups, admin-full. db.Get é substituído por lookup no "banco" em memória
// do harness (nodes[]) — o comportamento de rights é o do contrato real.
function makeGetNodeWithRights(h) {
    return function (domain, user, nodeid, func) {
        if ((user == null) || (nodeid == null)) { func(null, 0, false); return; }
        if (typeof user === 'string') user = h.users[user] || null;
        if (user == null) { func(null, 0, false); return; }
        if (nodeid.length > 128) { func(null, 0, false); return; }
        const snode = nodeid.split('/');
        // formato real: node/<domain>/<id> (o core compara snode[1] == domain.id, webserver.js:9758)
        if ((snode.length !== 3) || (snode[0] !== 'node')) { func(null, 0, false); return; }
        if ((domain != null) && (snode[1] !== domain.id)) { func(null, 0, false); return; }
        const node = h.nodes[nodeid];
        if (node == null) { func(null, 0, false); return; }

        let rights = 0; let visible = false;
        // super user no domínio (webserver.js:9765)
        if (user.siteadmin === 0xFFFFFFFF && node.domain === user.domain) {
            func(node, 0xFFFFFFFF, true); return;
        }
        if (user.links == null) { func(null, 0, false); return; }
        // link direto no device group (webserver.js:9780-9784)
        const r = user.links[node.meshid];
        if (r != null) {
            if (r.rights === 0xFFFFFFFF) { func(node, 0xFFFFFFFF, true); return; }
            rights |= r.rights; visible = true;
        }
        // links de user groups (webserver.js:9787-9801)
        for (const i in user.links) {
            if (i.startsWith('ugrp/')) {
                const g = h.userGroups[i];
                if (g && g.links != null) {
                    const rg = g.links[node.meshid];
                    if (rg != null) {
                        if (rg.rights === 0xFFFFFFFF) { func(node, 0xFFFFFFFF, true); return; }
                        rights |= rg.rights; visible = true;
                    }
                    const rn = g.links[nodeid];
                    if (rn != null) {
                        if (rn.rights === 0xFFFFFFFF) { func(node, 0xFFFFFFFF, true); return; }
                        rights |= rn.rights; visible = true;
                    }
                }
            }
        }
        func(node, rights, visible);
    };
}

// ---- harness ---------------------------------------------------------------
function create(opts) {
    opts = opts || {};
    const datapath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-harness-'));
    const config = {
        settings: { plugins: { list: true }, managealldevicegroups: [] }, // meshuser.js:639 (admin-full) — array real
        domains: Object.assign({}, opts.domains)
    };
    if (!config.domains[DOMAIN_ID]) config.domains[DOMAIN_ID] = {};
    // meshuser.js:580/581 lê webCertificateFullHashs[domain.id] — hashes fake por domínio
    const certHashes = {};
    certHashes[DOMAIN_ID] = 'f'.repeat(96);
    // meshuser.js:642 lê webCertificateExpire[domain.id] (number) para admin-full
    const certExpire = {};
    certExpire[DOMAIN_ID] = 0;

    const h = {
        datapath: datapath,
        CORE_ROOT: MESHCENTRAL_ROOT,
        domain: Object.assign({ id: DOMAIN_ID, userconsentflags: 0, limits: {} }, opts.domain || {}),
        nodes: {},          // nodeid → doc do node (para GetNodeWithRights real-contract)
        meshes: {},         // meshid → doc do mesh
        users: {},          // userid → user
        userGroups: {},     // ugrpid → group
        sent: [],           // server → browser (todos os WS de user)
        agentSent: {},      // nodeid → msgs server → agente (alias de .state.sentToAgent)
        agents: {},         // nodeid → API do agente fake
        plugins: {}         // shortName → objeto real do plugin (serveraction etc.)
    };

    // usuário default: admin full no domínio (mesh admin rights 0xFFFFFFFF)
    const defaultUser = {
        _id: 'user//' + DOMAIN_ID + '//admin',
        name: 'admin', realname: 'Admin', domain: DOMAIN_ID,
        links: {}, consent: 0, siteadmin: 0xFFFFFFFF
    };
    h.users[defaultUser._id] = defaultUser;
    h.defaultUser = defaultUser;

    const parent = { // meshServer (o que o plugin chama de obj.meshServer / parent.parent)
        multiServer: null,
        config: config,
        pluginHandler: null,
        DispatchEvent: function () { },
        getServerWarnings: function () { return []; }, clearServerWarnings: function () { }, // meshuser.js:676
        platform: 'win32',
        connectivityByNode: {}
    };

    const serverParent = { // o "parent" do CreateMeshUser (webserver-like)
        common: loadCore('common.js'),
        crypto: crypto,
        certificates: { CommonName: 'harness-local' },
        args: {},
        webCertificateFullHashs: certHashes, webCertificateHashs: certHashes, webCertificateExpire: certExpire,
        defaultWebCertificateFullHash: '', defaultWebCertificateHash: '',
        getWebServerName: function () { return 'harness-local'; },
        wsagents: h.agents,      // routeCommandToNode real resolve agentes aqui (meshuser.js:282)
        meshes: h.meshes,        // mesh.consent real (meshuser.js:295)
        userGroups: h.userGroups,
        wssessions: {}, wssessions2: {}, users: h.users, // meshuser.js:681
        relaySessionCount: 0, wsrelays: {},
        getAgentStats: function () { return {}; },
        getDomainUserFeatures: function () { return {}; },
        subscribe: function () { return { unsubscribe: function () { } }; },
        GetNodeWithRights: null, // setado abaixo
        parent: parent
    };

    // GetNodeWithRights contrato-real (único stub — ver cabeçalho)
    serverParent.GetNodeWithRights = makeGetNodeWithRights(h);

    // meshServer expõe o webserver ao plugin (nodebridge.js:102 etc.) — MESMO objeto, MESMO estado vivo
    parent.webserver = serverParent;
    // o webserver REAL se autocita (webserver.js usa obj.* internamente); plugins alcançam
    // meshServer.webserver.* — mesmo objeto para os dois caminhos
    serverParent.webserver = serverParent;

    // pluginHandler REAL (instanciado com datapath temp; ph.plugins recebe os
    // OBJETOS REAIS dos plugins — despacho idêntico à produção)
    const phFactory = loadCore('pluginHandler.js').pluginHandler;
    const ph = phFactory({
        db: { getPlugins: function (cb) { cb(null, []); }, updatePlugin: function () { }, getPlugin: function (id, cb) { cb(null, null); } },
        args: {}, datapath: datapath, config: config,
        common: serverParent.common, path: path, fs: fs,
        pluginPath: path.resolve(__dirname, '../../../'),
        require: require, updateMeshCore: function () { }
    });
    parent.pluginHandler = ph;

    h.pluginHandler = ph;

    // registra plugins REAIS passados pelo teste
    for (const shortName in (opts.plugins || {})) {
        const factory = opts.plugins[shortName];
        ph.plugins[shortName] = factory(serverParent);
    }

    const MU = loadCore('meshuser.js');

    // sessão de "browser" (user WS) — usa CreateMeshUser REAL
    h.login = function (userOverrides) {
        const user = userOverrides ? Object.assign({}, h.defaultUser, userOverrides) : h.defaultUser;
        if (!h.users[user._id]) h.users[user._id] = user;
        const ws = Object.assign(new EventEmitter(), {
            send: function (raw) { h.sent.push(JSON.parse(raw)); },
            close: function () { },
            _socket: { resume: function () { } }
        });
        MU.CreateMeshUser(serverParent, null, ws, { clientIp: '127.0.0.1' }, {}, h.domain, user);
        h.userWs = ws;
        // emissão só é confiável após o sessionId real existir (randomBytes async, meshuser.js:412-415)
        return new Promise(function (resolve) {
            const check = setInterval(function () {
                if (ws.sessionId) { clearInterval(check); resolve(h); }
            }, 10);
        });
    };

    // browser → core: passa pelo processWebSocketData REAL (meshuser.js:704)
    h.sendUser = function (command) {
        h.userWs.emit('message', Buffer.from(JSON.stringify(command)));
    };

    // registra agente fake controlável
    h.addAgent = function (nodeid, meshid) {
        meshid = meshid || 'mesh/' + DOMAIN_ID + '/mesh1';
        if (!h.meshes[meshid]) h.meshes[meshid] = { _id: meshid, name: meshid, consent: 0, deleted: null };
        const fake = createFakeAgent(nodeid, meshid, opts);
        fake.agent.sentToAgent = fake.state.sentToAgent; // conveniência: agent.sentToAgent === h.agentSent[nodeid]
        h.agents[nodeid] = fake.agent;
        h.agentSent[nodeid] = fake.state.sentToAgent;
        h.nodes[nodeid] = { _id: nodeid, meshid: meshid, name: nodeid.split('/').pop(), domain: DOMAIN_ID };
        return fake.agent; // .close()/.crash()/.noReply()/.replyWith(fn)/.sentToAgent
    };

    // agente → core: replica meshagent.js:1592-1600 (canal REAL de plugin agente→server:
    // serveraction(command, obj=agentConn, parent=webserver); obj sem .ws → isAgent no plugin)
    h.agentMessage = function (nodeid, command) {
        const pluginObj = h.pluginHandler.plugins[command.plugin];
        if (!pluginObj) return;
        const conn = h.agents[nodeid] || null;
        pluginObj.serveraction(command, conn, serverParent);
    };

    h.stop = function () {
        try { fs.rmSync(datapath, { recursive: true, force: true }); } catch (e) { }
    };

    h.serverParent = serverParent; // webserver-like: wssessions2/wsagents VIVOS (Fase 2 adapter)

    return h;
}

module.exports = {
    create: create,
    DOMAIN_ID: DOMAIN_ID,
    MESHCENTRAL_ROOT: MESHCENTRAL_ROOT,
    // expostos p/ contrato do stub GetNodeWithRights (harness-contract.test.js)
    makeGetNodeWithRights: makeGetNodeWithRights
};
