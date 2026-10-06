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
var SP_DEBUG = true;

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
    obj.db = null;
    obj.mdb = obj.meshServer.db;
    obj.pending = {};   // reqid → { sid, nodeid, op, user, ts }

    obj.server_startup = function () {
        try {
            SP_LOG.info('server_startup: init');
            obj.meshServer.pluginHandler.spooler_db = require(__dirname + '/db.js').CreateDB(obj.meshServer);
            obj.db = obj.meshServer.pluginHandler.spooler_db;
            SP_LOG.info('server_startup: db initialized db=' + (obj.db.printers ? 'ok' : 'FAIL'));
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

    // myparent = conexão (frontend ou agente)
    obj.serveraction = function (command, myparent, gp) {
        try {
            if (command.plugin !== 'spooler') return;
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
                SP_LOG.raw('agentResult op=' + (command.op || p.op) + ' ok=' + (command.ok === true) +
                    (command.error ? (' error=' + String(command.error).substring(0, 300)) : '') +
                    ' result=' + JSON.stringify(command.result == null ? null :
                        (Array.isArray(command.result) ? command.result.slice(0, 3) : command.result)).substring(0, 300));
                if (!command.ok) {
                    obj.audit(p.user, p.nodeid, p.op, command.target || null, command.error || 'erro no agente', false);
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

            switch (command.pluginaction) {

                // ---- inventário / catálogo ----
                case 'inventory':
                case 'getPrinters':
                    obj.agentRequest(command, sid, user);
                    break;

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
                case 'getCatalog':
                    obj.db.getPrintersByNode(command.nodeid, function (docs) {
                        obj.send(sid, { action: 'plugin', plugin: 'spooler', method: 'catalog', nodeid: command.nodeid, data: docs });
                    });
                    break;

                case 'getAllCatalog':
                    obj.db.getAllPrinters(function (docs) {
                        obj.send(sid, { action: 'plugin', plugin: 'spooler', method: 'allCatalog', data: docs });
                    });
                    break;

                case 'getAudit':
                    obj.db.getAudit({}, { nodeid: command.nodeid, limit: command.limit || 200 }, function (docs) {
                        obj.send(sid, { action: 'plugin', plugin: 'spooler', method: 'audit', data: docs });
                    });
                    break;

                default:
                    SP_LOG.error('serveraction: unknown pluginaction=' + command.pluginaction, null);
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
                return res.render('device', {
                    nodeid: req.query.nodeid || '',
                    nodeName: req.query.nodeid ? obj.getNodeName(req.query.nodeid) : 'Desconhecido'
                });
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
