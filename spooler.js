/**
 * Spooler — Gerenciador de Impressoras
 * Server-side. Padrão Tracer: serveraction + wsagents[nodeid].send + NeDB.
 *
 * Fluxo:
 *   frontend → ms.send({action:'plugin', plugin:'spooler', pluginaction, nodeid, ...})
 *   serveraction → valida + envia ao agente via wsagents[nodeid].send() com reqid
 *   agente (win-spooler.js) executa PowerShell e responde {pluginaction:'agentResult', reqid, ...}
 *   serveraction (msg sem sid = resposta do agente) → devolve ao frontend via wssessions2[sid]
 */
"use strict";

// Ops de mutação (mesma lista do agente) — timeout estendido p/ fila+driver stage
var MUTATION_SERVER_OPS = ['addPrinter', 'addFoundPrinter', 'deletePrinter', 'renamePrinter',
    'setDefaultPrinter', 'setPrinterConfig', 'pausePrinter', 'resumePrinter',
    'deletePort', 'jobAction', 'clearQueue', 'spoolerAction'];

// Configurável: gate de logs de diagnóstico (error sempre ativo)
var SP_DEBUG = false;

// P0-1 — ACL backport (padrão Tracer v3.5.83, helper compartilhado com
// NetAdapter/NodeBridge → semente da futura plugin-lib/).
var SP_ACL = require(__dirname + '/vendor/plugin-lib/plugin-acl.js'); // plugin-lib v0.3.0 (fonte única; vendor gerado — NÃO EDITAR)

// Categorias de log (padrão Tracer UT_LOG)
var SP_LOG = {
    error: function (ctx, err, extra) {
        try {
            var msg = '[SP ERROR] ' + ctx + ': ' + (err && err.message ? err.message : String(err));
            if (extra) msg += ' extra=' + JSON.stringify(extra);
            if (SP_DEBUG) msg += ' stack=' + (err && err.stack ? err.stack : '(no stack)');
            console.log(msg);
        } catch (_) {}
    },
    debug: function () {
        if (!SP_DEBUG) return;
        try { console.log('[SP DEBUG] ' + Array.prototype.slice.call(arguments).join(' ')); } catch (_) {}
    },
    info: function () {
        if (!SP_DEBUG) return;
        try { console.log('[SP INFO] ' + Array.prototype.slice.call(arguments).join(' ')); } catch (_) {}
    },
    raw: function () {
        if (!SP_DEBUG) return;
        try { console.log('[SP] ' + Array.prototype.slice.call(arguments).join(' ')); } catch (_) {}
    }
};

module.exports.spooler = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.debug = obj.meshServer.debug;
    obj.exports = ['onDeviceRefreshEnd'];
    // P0-1 — erro estruturado de volta ao iframe (nada executa no agente).
    obj._sendPluginError = function (sid, pluginaction, nodeid, error, status) {
        obj.send(sid, { action: 'plugin', plugin: 'spooler', method: 'pluginError',
            pluginaction: pluginaction, nodeid: nodeid || null, ok: false,
            error: error, status: status || 403 });
    };

    // P0-1 — ACL p/ comandos do frontend: mutações (MUTATION_SERVER_OPS)
    // exigem DEVICEDETAILS+REMOTECONTROL; leituras, DEVICEDETAILS. Admin
    // full bypassa (helper). // P2-c: menção a getAllCatalog removida (função morta eliminada)
    obj._authorizeFrontend = function (command, sid, myparent, cb) {
        var user = SP_ACL.getUser(myparent, command.userid, obj);
        var MUT_REQUIRED = SP_ACL.MESHRIGHT_DEVICEDETAILS | SP_ACL.MESHRIGHT_REMOTECONTROL;
        SP_ACL.checkNodeRights(obj, user, command.nodeid, function (ok, rights) {
            if (!ok) {
                SP_LOG.raw('ACL DENIED op=' + command.pluginaction + ' node=' + command.nodeid +
                    ' user=' + (user ? user._id : 'null') + ' rights=0x' + (rights || 0).toString(16));
                obj._sendPluginError(sid, command.pluginaction, command.nodeid, 'access denied', 403);
                return cb(false);
            }
            cb(true);
        }, { requiredBits: (MUTATION_SERVER_OPS.indexOf(command.pluginaction) !== -1) ? MUT_REQUIRED : SP_ACL.MESHRIGHT_DEVICEDETAILS });
    };
    obj.db = null;
    obj.pending = {};   // reqid → { sid, nodeid, op, user, ts }
    obj.cache = {};     // nodeid → { hash, printers[], spooler, ts } (cache delta, v1.1.15)

    // hash curto p/ delta (não é crypto, é change detection)
    obj.fastHash = function (s) {
        var h = 5381, i = String(s == null ? '' : s).length;
        while (i) h = (h * 33) ^ String(s).charCodeAt(--i);
        return (h >>> 0).toString(36);
    };
    obj.computeHash = function (printers, spooler) {
        return obj.fastHash(JSON.stringify(printers) + '|' + spooler);
    };

    obj.server_startup = function () {
        try {
            SP_LOG.info('server_startup: init v' + (require('./config.json').version || '?') + ' (getDelta=' + (typeof obj.handleGetDelta) + ')');
            obj.meshServer.pluginHandler.spooler_db = require(__dirname + '/db.js').CreateDB(obj.meshServer);
            obj.db = obj.meshServer.pluginHandler.spooler_db;
            // P2-c: era obj.db.printers (coleção de catálogo REMOVIDA — logava FAIL sempre)
            SP_LOG.info('server_startup: db initialized db=' + (obj.db.audit ? 'ok' : 'FAIL'));
            // limpeza de pendings antigos (>2 min)
            setInterval(function () {
                var now = Date.now();
                for (var r in obj.pending) {
                    if (now - obj.pending[r].ts > (obj.pending[r].mut ? 360000 : 120000)) {
                        var p = obj.pending[r];
                        SP_LOG.raw('reqid timeout op=' + p.op + ' node=' + p.nodeid + (p.mut ? ' (mutação)' : ''));
                        obj.send(p.sid, { action: 'plugin', plugin: 'spooler', method: 'agentResult', op: p.op, nodeid: p.nodeid, ok: false, error: 'Timeout: agente não concluiu a operação (fila/driver stage?)', reqid: r, _batch: p.batch || undefined });
                        delete obj.pending[r];
                    }
                }
            }, 30000);
        } catch (e) { SP_LOG.error('server_startup', e, { step: 'init' }); }
    };

    // ---------------- helpers ----------------

    obj.newReqId = function () {
        return 'r' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    };

    obj.send = function (sid, data) {
        try {
            var wss2 = obj.meshServer.webserver.wssessions2;
            if (wss2 && sid && wss2[sid]) {
                SP_LOG.raw('send method=' + data.method + ' sid=' + sid.substring(0, 40));
                wss2[sid].send(JSON.stringify(data));
                return true;
            }
            SP_LOG.raw('send: session not found sid=' + (sid ? sid.substring(0, 40) : 'null') + ' method=' + data.method);
        } catch (e) { SP_LOG.error('send', e, { sid: sid }); }
        return false;
    };

    obj.sendToAgent = function (nodeid, cmd) {
        try {
            var agent = obj.meshServer.webserver.wsagents ? obj.meshServer.webserver.wsagents[nodeid] : null;
            if (!agent) {
                SP_LOG.raw('sendToAgent: agent offline node=' + nodeid);
                return { ok: false, error: 'Dispositivo offline ou agente não conectado' };
            }
            agent.send(JSON.stringify(cmd));
            SP_LOG.raw('sendToAgent: op=' + cmd.pluginaction + ' reqid=' + cmd.reqid + ' node=' + nodeid);
            return { ok: true };
        } catch (e) {
            SP_LOG.error('sendToAgent', e, { nodeid: nodeid });
            return { ok: false, error: 'Falha ao enviar comando ao agente: ' + e.message };
        }
    };

    obj.getNodeName = function (nid) {
        try {
            if (obj.meshServer.webserver.wsagents && obj.meshServer.webserver.wsagents[nid]) {
                return obj.meshServer.webserver.wsagents[nid].name || nid;
            }
        } catch (e) {}
        return nid;
    };

    obj.audit = function (user, nodeid, op, target, detail, ok) {
        try {
            if (!obj.db) return;
            SP_LOG.raw('audit user=' + user + ' node=' + obj.getNodeName(nodeid) + ' op=' + op + ' target=' + target + ' ok=' + (ok !== false) + (detail ? (' detail=' + detail) : ''));
            obj.db.addAudit({
                user: user || '?',
                nodeid: nodeid || null,
                nodeName: nodeid ? obj.getNodeName(nodeid) : null,
                op: op,
                target: target || null,
                detail: detail || null,
                ok: ok !== false
            });
        } catch (e) { SP_LOG.error('audit', e); }
    };

    // Envia comando ao agente com correlação reqid
    obj.agentRequest = function (command, sid, user) {
        var nodeid = command.nodeid;
        if (!nodeid || typeof nodeid !== 'string') {
            obj.send(sid, { action: 'plugin', plugin: 'spooler', method: 'agentResult', op: command.pluginaction, ok: false, error: 'nodeid obrigatório' });
            return;
        }
        var reqid = obj.newReqId();
        var isMut = MUTATION_SERVER_OPS.indexOf(command.pluginaction) !== -1;
        obj.pending[reqid] = { sid: sid, nodeid: nodeid, op: command.pluginaction, user: user, ts: Date.now(), mut: isMut, batch: (command.params && command.params._batch) ? { done: 0 } : null };
        SP_LOG.raw('agentRequest op=' + command.pluginaction + ' node=' + obj.getNodeName(nodeid) + ' reqid=' + reqid + ' params=' + JSON.stringify(command.params || {}).substring(0, 200));
        var r = obj.sendToAgent(nodeid, {
            action: 'plugin',
            plugin: 'spooler',
            pluginaction: command.pluginaction,
            reqid: reqid,
            params: command.params || {}
        });
        if (!r.ok) {
            delete obj.pending[reqid];
            obj.audit(user, nodeid, command.pluginaction, command.params && (command.params.name || command.params.ip || ''), r.error, false);
            obj.send(sid, { action: 'plugin', plugin: 'spooler', method: 'agentResult', op: command.pluginaction, nodeid: nodeid, reqid: reqid, ok: false, error: r.error, _batch: (command.params && command.params._batch) || undefined });
        }
    };

    // ---------------- hooks ----------------

    // v1.2 — dedup de audit para resultados de mutação (normal OU recuperado via journal)
    obj._mutAudited = {};
    obj._mutAuditedCap = 5000;
    obj._markMutAudited = function (reqid) {
        obj._mutAudited[reqid] = true;
        var keys = Object.keys(obj._mutAudited);
        if (keys.length > obj._mutAuditedCap) {
            keys.slice(0, keys.length - obj._mutAuditedCap).forEach(function (k) { delete obj._mutAudited[k]; });
        }
    };

    // v1.2 — resultados de mutação recuperados do journal do agente
    // (mutação executou mas o agentResult se perdeu numa queda de túnel)
    // Envelope: { action:'plugin', plugin:'spooler', from:'agent', cmd:'mutresults', results:[{id,op,ok,error,target,ts,synthetic?}] }
    obj._handleMutResults = function (command, agentConn) {
        try {
            var results = Array.isArray(command.results) ? command.results : [];
            var ackIds = [];
            var agentNodeid = null;
            try { agentNodeid = agentConn && agentConn.nodeid; } catch (_) {}
            results.forEach(function (r) {
                try {
                    if (!r || !r.id || !r.op) return;
                    ackIds.push(r.id); // acka tudo que processou OU dedupou (agente pode apagar)
                    if (obj._mutAudited[r.id]) return; // já auditado via caminho normal
                    obj._markMutAudited(r.id);
                    var p = obj.pending[r.id];
                    var nodeid, user, sid, op;
                    if (p) {
                        // pendente ainda aberto (timeout ainda não estourou) → fecha com o resultado REAL
                        delete obj.pending[r.id];
                        nodeid = p.nodeid; user = p.user; sid = p.sid; op = p.op;
                    } else {
                        // timeout já respondeu ao browser → auditoria é o que falta
                        nodeid = agentNodeid; user = null; sid = null; op = r.op;
                    }
                    var detail = (r.ok ? 'executado' : (r.error || 'erro')) + ' (recuperado via journal)';
                    if (r.synthetic) detail += ' [agente reiniciou no meio da mutação]';
                    obj.audit(user, nodeid, op, r.target || null, detail, r.ok === true);
                    if (obj.cache[nodeid]) { delete obj.cache[nodeid]; } // mutação → invalida cache delta
                    if (sid) {
                        obj.send(sid, {
                            action: 'plugin', plugin: 'spooler', method: 'agentResult',
                            op: op, nodeid: nodeid, reqid: r.id,
                            ok: r.ok === true, result: null, error: r.error || null,
                            _journal: true
                        });
                    }
                    SP_LOG.info('mutresults reqid=' + r.id + ' op=' + op + ' ok=' + (r.ok === true) + ' pending=' + (p ? 'fechado' : 'não (timeout/sessão)'));
                } catch (e) {
                    SP_LOG.error('_handleMutResults:item', e, { id: r && r.id });
                }
            });
            // ack de volta ao agente (JSON string — protocolo servidor→agente)
            try {
                if (agentConn && typeof agentConn.send === 'function' && ackIds.length) {
                    agentConn.send(JSON.stringify({ action: 'plugin', plugin: 'spooler', cmd: 'mutack', ids: ackIds }));
                }
            } catch (e) { SP_LOG.error('_handleMutResults:ack', e); }
        } catch (e) {
            SP_LOG.error('_handleMutResults', e);
        }
    };

    // myparent = conexão (frontend ou agente)
    obj.serveraction = function (command, myparent, gp) {
        try {
            if (command.plugin !== 'spooler') return;
            // v1.2 — journal drain do agente: agentConn NÃO tem .ws.sessionId;
            // precisa vir antes do branch de sid (mesmo padrão do Tracer/NetAdapter)
            if (command.from === 'agent' && command.cmd === 'mutresults') {
                return obj._handleMutResults(command, myparent);
            }
            var isAgent = false;
            var sid = null;
            try {
                sid = myparent.ws.sessionId;
            } catch (e) {
                // conexão de agente não tem ws.sessionId → é resposta do agente
                isAgent = true;
            }
            SP_LOG.raw('serveraction action=' + command.pluginaction + ' from=' + (isAgent ? 'AGENT' : 'frontend') + ' node=' + (command.nodeid ? obj.getNodeName(command.nodeid) : '-'));

            // ---------- resposta do agente ----------
            if (isAgent || command.pluginaction === 'agentResult') {
                var reqid = command.reqid;
                var p = reqid ? obj.pending[reqid] : null;
                if (!p) {
                    SP_LOG.raw('agentResult sem pending reqid=' + reqid + ' (timeout ou sessão fechada)');
                    return;
                }
                // fase 'started': agente aceitou a mutação (fila) — NÃO consome o pending
                if (command.phase === 'started') {
                    SP_LOG.raw('agentResult STARTED op=' + (command.op || p.op) + ' reqid=' + reqid);
                    obj.send(p.sid, {
                        action: 'plugin', plugin: 'spooler', method: 'agentResult',
                        op: command.op || p.op, nodeid: p.nodeid, reqid: reqid,
                        ok: true, phase: 'started', _batch: p.batch || undefined
                    });
                    return;
                }
                delete obj.pending[reqid];
                if (p.mut) obj._markMutAudited(reqid); // v1.2: journal drain depois não re-audita
                SP_LOG.raw('agentResult op=' + (command.op || p.op) + ' ok=' + (command.ok === true) +
                    (command.error ? (' error=' + String(command.error).substring(0, 300)) : '') +
                    ' result=' + JSON.stringify(command.result == null ? null :
                        (Array.isArray(command.result) ? command.result.slice(0, 3) : command.result)).substring(0, 300));
                if (!command.ok) {
                    obj.audit(p.user, p.nodeid, p.op, command.target || null, command.error || 'erro no agente', false);
                }
                // summary: atualiza cache e responde com hash (fluxo delta, v1.1.15)
                if ((command.op || p.op) === 'summary' && command.ok && command.result) {
                    var printers = command.result.printers || [];
                    var spooler = command.result.spooler || 'Unknown';
                    var hash = obj.computeHash(printers, spooler);
                    obj.cache[p.nodeid] = { hash: hash, printers: printers, spooler: spooler, ts: Date.now() };
                    obj.send(p.sid, {
                        action: 'plugin', plugin: 'spooler', method: 'delta',
                        nodeid: p.nodeid, unchanged: false, hash: hash,
                        printers: printers, spooler: spooler
                    });
                    return;
                }
                // mutação concluída: invalida o cache do node (próximo delta refetcha)
                if (p.mut && obj.cache[p.nodeid]) {
                    delete obj.cache[p.nodeid];
                    SP_LOG.raw('cache invalidado (mutação) node=' + p.nodeid);
                }
                obj.send(p.sid, {
                    action: 'plugin', plugin: 'spooler', method: 'agentResult',
                    op: command.op || p.op, nodeid: p.nodeid, reqid: reqid,
                    ok: command.ok, result: command.result, error: command.error,
                    _batch: p.batch || undefined
                });
                return;
            }

            // ---------- comandos do frontend ----------
            var user = command.userid || '?';

            // P0-1 — ACL antes de qualquer dispatch (ver _authorizeFrontend).
            obj._authorizeFrontend(command, sid, myparent, function (allowed) {
                if (!allowed) return;
                spDispatch();
            });

            function spDispatch() {

                switch (command.pluginaction) {

                // ---- inventário / catálogo ----
                case 'inventory':
                case 'getPrinters':
                    obj.agentRequest(command, sid, user);
                    break;

                // ---- polling leve (v1.2: summary direto, SEM delta) ----
                // O delta antigo comparava o hash do FRONTEND com o cache do
                // SERVIDOR — mudanças espontâneas no dispositivo (job novo,
                // impressora offline) nunca mudavam esse cache → painel congelado.
                // Padrão Tracer/NetAdapter: on-demand direto, dado sempre vivo.
                case 'getDelta':
                case 'summary':
                case 'getPrinter':
                case 'getStatus':
                    if (command.pluginaction === 'getDelta') { command.pluginaction = 'summary'; }
                    obj.agentRequest(command, sid, user);
                    break;

                // unknown: responde ao frontend (que pode desligar features novas) em vez de só logar
                default: {
                    SP_LOG.error('serveraction: unknown pluginaction=' + command.pluginaction, null);
                    obj.send(sid, {
                        action: 'plugin', plugin: 'spooler', method: 'agentResult',
                        op: command.pluginaction, nodeid: command.nodeid || null,
                        ok: false, error: 'Ação não suportada pelo servidor (server JS desatualizado? reinstale o plugin): ' + command.pluginaction
                    });
                }

                // ---- CRUD impressoras ----
                case 'addPrinter':
                case 'deletePrinter':
                case 'renamePrinter':
                case 'setDefaultPrinter':
                case 'setPrinterConfig':
                case 'pausePrinter':
                case 'resumePrinter':
                case 'testPage':
                    obj.agentRequest(command, sid, user);
                    if (command.pluginaction === 'deletePrinter') {
                        obj.audit(user, command.nodeid, 'deletePrinter', command.params && command.params.name, null, true);
                    }
                    break;

                // ---- portas / drivers ----
                case 'listDrivers':
                case 'listPorts':
                case 'deletePort':
                    obj.agentRequest(command, sid, user);
                    break;

                // ---- descoberta de rede ----
                case 'discover':
                case 'addFoundPrinter':
                    obj.agentRequest(command, sid, user);
                    break;

                // ---- filas ----
                case 'getJobs':
                case 'jobAction':
                case 'clearQueue':
                    obj.agentRequest(command, sid, user);
                    break;

                // ---- serviço spooler ----
                case 'spoolerStatus':
                case 'spoolerAction':
                    obj.agentRequest(command, sid, user);
                    break;

                // ---- painel web da impressora ----
                case 'webPanel':
                    obj.agentRequest(command, sid, user);
                    break;

                // ---- diagnóstico (v1.1.5) ----
                case 'psInfo':
                    obj.agentRequest(command, sid, user);
                    break;

                // debug agent-side ligável remotamente (grava spooler-plugin.txt no cliente)
                case 'setDebug':
                    obj.sendToAgent(command.nodeid, {
                        action: 'plugin', plugin: 'spooler',
                        pluginaction: 'setDebug', params: command.params || {}
                    });
                    obj.send(sid, { action: 'plugin', plugin: 'spooler', method: 'agentResult', op: 'setDebug', nodeid: command.nodeid, ok: true, result: { debug: (command.params && command.params.value) === 'true' } });
                    break;

                // ---- dados locais (sem agente) ----
                case 'getAudit':
                    obj.db.getAudit({}, { nodeid: command.nodeid, limit: command.limit || 200 }, function (docs) {
                        obj.send(sid, { action: 'plugin', plugin: 'spooler', method: 'audit', data: docs });
                    });
                    break;
                }
            }
        } catch (e) {
            SP_LOG.error('serveraction', e, { pluginaction: command ? command.pluginaction : 'N/A' });
        }
    };

    obj.handleAdminReq = function (req, res, user) {
        try {
            SP_LOG.raw('handleAdminReq url=' + req.url + ' user=' + (user ? user.name : 'null'));
            if (req.query.user == 1) {
                // aba do dispositivo
                // P0-1 — ACL por node antes do render (padrão Tracer :439-475;
                // não confiar em ?user=1). Fail-closed: 403 sem direito.
                var aclUser = SP_ACL.getUser({ user: user }, user && user._id);
                var aclNid = req.query.nodeid;
                if (!aclNid) { res.sendStatus(400); return; }
                SP_ACL.checkNodeRights(obj, aclUser, aclNid, function (ok) {
                    if (!ok) {
                        SP_LOG.raw('handleAdminReq: 403 device tab node=' + aclNid + ' user=' + (aclUser ? aclUser._id : 'null'));
                        res.sendStatus(403);
                        return;
                    }
                    res.render('device', {
                        nodeid: aclNid,
                        nodeName: obj.getNodeName(aclNid)
                    });
                });
                return;
            }
            if (!user || (user.siteadmin & 0xFFFFFFFF) == 0) {
                SP_LOG.raw('handleAdminReq: 401 para ' + (user ? user.name : 'anônimo'));
                res.sendStatus(401);
                return;
            }
            res.render('admin', {});
        } catch (e) {
            SP_LOG.error('handleAdminReq', e, { url: req.url });
        }
    };

    obj.onDeviceRefreshEnd = function () {
        try {
            if (typeof currentNode === 'undefined' || !currentNode) return;
            if (currentNode.osdesc && currentNode.osdesc.toLowerCase().indexOf('windows') === -1) return;
            if (typeof pluginHandler === 'undefined' || !pluginHandler) return;
            pluginHandler.registerPluginTab({ tabTitle: 'Impressoras', tabId: 'pluginSpoolerTab' });
            QA('pluginSpoolerTab', '<iframe id="pluginIframeSpooler" style="width:100%;height:600px;overflow:auto" scrolling="yes" frameBorder=0 src="/pluginadmin.ashx?pin=spooler&nodeid=' + encodeURIComponent(currentNode._id) + '&user=1" />');
        } catch (e) {
            SP_LOG.error('onDeviceRefreshEnd', e);
        }
    };

    return obj;
};
