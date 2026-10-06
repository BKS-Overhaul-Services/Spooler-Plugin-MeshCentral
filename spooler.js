/**
 * Spooler — Gerenciador de Impressoras — v1.0
 * Server-side. Padrão Tracer: serveraction + wsagents[nodeid].send + NeDB.
 *
 * Fluxo:
 *   frontend → ms.send({action:'plugin', plugin:'spooler', pluginaction, nodeid, ...})
 *   serveraction → valida + envia ao agente via wsagents[nodeid].send() com reqid
 *   agente (win-spooler.js) executa PowerShell e responde {pluginaction:'agentResult', reqid, ...}
 *   serveraction (msg sem sid = resposta do agente) → devolve ao frontend via wssessions2[sid]
 */
"use strict";

module.exports.spooler = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.debug = obj.meshServer.debug;
    obj.exports = ['onDeviceRefreshEnd'];
    obj.db = null;
    obj.mdb = obj.meshServer.db;
    obj.pending = {};   // reqid → { sid, nodeid, op, user, ts }

    function spError(context, err, extra) {
        console.log('SPOOLER ERROR: context=' + context + ' msg=' + (err && err.message ? err.message : String(err)));
        if (err && err.stack) console.log('SPOOLER ERROR: stack=' + err.stack);
        if (extra) try { console.log('SPOOLER ERROR: extra=' + JSON.stringify(extra)); } catch (e) {}
    }

    obj.server_startup = function () {
        try {
            obj.meshServer.pluginHandler.spooler_db = require(__dirname + '/db.js').CreateDB(obj.meshServer);
            obj.db = obj.meshServer.pluginHandler.spooler_db;
            console.log('SPOOLER: startup OK, db.printers=' + (obj.db.printers ? 'ok' : 'FAIL'));
            // limpeza de pendings antigos (>2 min)
            setInterval(function () {
                var now = Date.now();
                for (var r in obj.pending) {
                    if (now - obj.pending[r].ts > 120000) {
                        var p = obj.pending[r];
                        console.log('SPOOLER: reqid timeout op=' + p.op + ' node=' + p.nodeid);
                        obj.send(p.sid, { action: 'plugin', plugin: 'spooler', method: 'agentResult', op: p.op, nodeid: p.nodeid, ok: false, error: 'Timeout: agente não respondeu (offline?)', reqid: r });
                        delete obj.pending[r];
                    }
                }
            }, 30000);
        } catch (e) { spError('server_startup', e); }
    };

    // ---------------- helpers ----------------

    obj.newReqId = function () {
        return 'r' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    };

    obj.send = function (sid, data) {
        try {
            var wss2 = obj.meshServer.webserver.wssessions2;
            if (wss2 && sid && wss2[sid]) {
                wss2[sid].send(JSON.stringify(data));
                return true;
            }
            console.log('SPOOLER SEND: session not found sid=' + (sid ? sid.substring(0, 40) : 'null') + ' method=' + data.method);
        } catch (e) { spError('send', e, { sid: sid }); }
        return false;
    };

    obj.sendToAgent = function (nodeid, cmd) {
        try {
            var agent = obj.meshServer.webserver.wsagents ? obj.meshServer.webserver.wsagents[nodeid] : null;
            if (!agent) return { ok: false, error: 'Dispositivo offline ou agente não conectado' };
            agent.send(JSON.stringify(cmd));
            return { ok: true };
        } catch (e) {
            spError('sendToAgent', e, { nodeid: nodeid });
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
            obj.db.addAudit({
                user: user || '?',
                nodeid: nodeid || null,
                nodeName: nodeid ? obj.getNodeName(nodeid) : null,
                op: op,
                target: target || null,
                detail: detail || null,
                ok: ok !== false
            });
        } catch (e) { spError('audit', e); }
    };

    // Envia comando ao agente com correlação reqid
    obj.agentRequest = function (command, sid, user) {
        var nodeid = command.nodeid;
        if (!nodeid || typeof nodeid !== 'string') {
            obj.send(sid, { action: 'plugin', plugin: 'spooler', method: 'agentResult', op: command.pluginaction, ok: false, error: 'nodeid obrigatório' });
            return;
        }
        var reqid = obj.newReqId();
        obj.pending[reqid] = { sid: sid, nodeid: nodeid, op: command.pluginaction, user: user, ts: Date.now() };
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
            obj.send(sid, { action: 'plugin', plugin: 'spooler', method: 'agentResult', op: command.pluginaction, nodeid: nodeid, reqid: reqid, ok: false, error: r.error });
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

            // ---------- resposta do agente ----------
            if (isAgent || command.pluginaction === 'agentResult') {
                var reqid = command.reqid;
                var p = reqid ? obj.pending[reqid] : null;
                if (!p) {
                    console.log('SPOOLER: agentResult sem pending reqid=' + reqid + ' (timeout ou sessão fechada)');
                    return;
                }
                delete obj.pending[reqid];
                if (!command.ok) {
                    obj.audit(p.user, p.nodeid, p.op, command.target || null, command.error || 'erro no agente', false);
                }
                obj.send(p.sid, {
                    action: 'plugin', plugin: 'spooler', method: 'agentResult',
                    op: command.op || p.op, nodeid: p.nodeid, reqid: reqid,
                    ok: command.ok, result: command.result, error: command.error
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
                    console.log('SPOOLER: unknown pluginaction=' + command.pluginaction);
            }
        } catch (e) {
            spError('serveraction', e, { pluginaction: command ? command.pluginaction : 'N/A' });
        }
    };

    obj.handleAdminReq = function (req, res, user) {
        try {
            if (req.query.user == 1) {
                // aba do dispositivo
                return res.render('device', {
                    nodeid: req.query.nodeid || '',
                    nodeName: req.query.nodeid ? obj.getNodeName(req.query.nodeid) : 'Desconhecido'
                });
            }
            if (!user || (user.siteadmin & 0xFFFFFFFF) == 0) {
                res.sendStatus(401);
                return;
            }
            res.render('admin', {});
        } catch (e) {
            spError('handleAdminReq', e, { url: req.url });
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
            spError('onDeviceRefreshEnd', e);
        }
    };

    return obj;
};
