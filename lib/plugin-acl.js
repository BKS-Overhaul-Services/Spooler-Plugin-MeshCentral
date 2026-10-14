/**
 * plugin-acl.js — Helper de ACL compartilhado (semente da futura plugin-lib/)
 * =============================================================================
 * Backport do padrão Tracer v3.5.83 (usertracer.js:_filterAccessibleNodeIds,
 * :994-1054 e handleAdminReq :439-475) para NetAdapter/Spooler/NodeBridge.
 *
 * Problema: o core entrega {action:'plugin'} ao plugin SEM checar direitos do
 * nó (meshuser.js:4906-4916 atribui command.userid=user._id e despacha). A
 * autorização por dispositivo é responsabilidade do plugin.
 *
 * Uso no serveraction (browser → plugin):
 *   var user = NA_ACL.getUser(myparent, command.userid);
 *   NA_ACL.checkNodeRights(obj, user, command.nodeid, function (ok, rights) {
 *       if (!ok) return obj.send(sid, {action:'plugin', plugin:..., method:'pluginError',
 *                                      pluginaction:command.pluginaction, nodeid:command.nodeid,
 *                                      error:'access denied', status:403});
 *       // ... prossegue
 *   });
 *
 * Decisão de design (P0-1): SEM direito → erro estruturado de volta ao iframe
 * ({method:'pluginError', error:'access denied', status:403}) em vez de silêncio;
 * a aba device (HTTP) responde 403. Nada executa no agente.
 *
 * Right exigido: MESHRIGHT_DEVICEDETAILS (0x00100000) — mesmo bit do Tracer
 * (core/webserver.js:272) — para leitura; para MUTAÇÃO exige também
 * MESHRIGHT_REMOTECONTROL (0x00000008), alinhado com routeCommandToNode do core
 * (meshuser.js:288-290). Admin full (siteadmin 0xFFFFFFFF ou -1) = bypass.
 *
 * Sem GetNodeWithRights disponível (core antigo/mocked): DENY por padrão
 * (fail-closed). Documentar em deploy: exige MeshCentral >= 1.1.x com a API.
 */
"use strict";

var MESHRIGHT_REMOTECONTROL = 0x00000008;
var MESHRIGHT_DEVICEDETAILS = 0x00100000;
var MESHRIGHT_ADMIN = 0xFFFFFFFF;

module.exports = {
    MESHRIGHT_REMOTECONTROL: MESHRIGHT_REMOTECONTROL,
    MESHRIGHT_DEVICEDETAILS: MESHRIGHT_DEVICEDETAILS,

    // Extrai o usuário da conexão (myparent.user) com fallback ao userid do
    // comando (injetado pelo core em meshuser.js:4909). Resolve via webserver.users.
    // `plugin` é o obj da factory (tem .meshServer); passado 2º p/ compat os
    // call sites antigos seguem funcionando (myparent 1º).
    getUser: function (myparent, commandUserid, plugin) {
        try {
            var u = myparent && myparent.user;
            if (u) return u;
        } catch (_) {}
        try {
            var meshServer = (plugin && plugin.meshServer) || (myparent && myparent.parent);
            var ws = myparent && myparent.ws;
            // Fallback 1: sessão do browser → wssessions2[sid].user (fonte do core)
            if (ws && ws.sessionId && meshServer && meshServer.webserver &&
                meshServer.webserver.wssessions2) {
                var sess = meshServer.webserver.wssessions2[ws.sessionId];
                if (sess && sess.user) return sess.user;
            }
            // Fallback 2: userid injetado pelo core (meshuser.js:4909) → webserver.users
            var uid = (commandUserid && typeof commandUserid === 'string') ? commandUserid
                : (ws && ws.userid) || null;
            if (uid && meshServer && meshServer.webserver &&
                meshServer.webserver.users && meshServer.webserver.users[uid]) {
                return meshServer.webserver.users[uid];
            }
        } catch (_) {}
        return null;
    },

    // Admin full = bypass (mesma semântica do Tracer _isAdminFull).
    isAdminFull: function (user) {
        return !!user && (user.siteadmin === MESHRIGHT_ADMIN || user.siteadmin === -1);
    },

    // Resolve o OBJETO de domínio do core (webserver.js:9758 compara domain.id).
    // user.domain é string ('' para o default); command.domainId não existe —
    // derivamos do próprio nodeid (split('/')[1]).
    _domainObj: function (plugin, nodeid, user) {
        try {
            var meshServer = plugin.meshServer;
            var domains = meshServer && meshServer.parent && meshServer.parent.config &&
                meshServer.parent.config.domains;
            if (!domains) return null;
            var domId = '';
            if (typeof nodeid === 'string' && nodeid.indexOf('node/') === 0) {
                var parts = nodeid.split('/');
                if (parts.length >= 2) domId = parts[1];
            }
            if (!domId && user && typeof user.domain === 'string') domId = user.domain;
            return domains[domId] || null; // undefined p/ domínio inexistente
        } catch (_) { return null; }
    },

    /**
     * Checa direitos do user sobre UM nodeid.
     * cb(ok, rights) — ok=true se: admin full OU (visible && rights>0 &&
     * (rights & requiredBits) == requiredBits). requiredBits: DEVICEDETAILS
     * para leitura; DEVICEDETAILS|REMOTECONTROL para mutação.
     * Fail-closed: user nulo, nodeid ausente/inválido, API ausente, timeout.
     */
    checkNodeRights: function (plugin, user, nodeid, cb, opts) {
        var required = (opts && opts.requiredBits) || MESHRIGHT_DEVICEDETAILS;
        if (!user) { cb(false, 0); return; }
        if (this.isAdminFull(user)) { cb(true, MESHRIGHT_ADMIN); return; }
        if (!nodeid || typeof nodeid !== 'string' || nodeid.indexOf('node/') !== 0) { cb(false, 0); return; }
        var webserver = plugin.meshServer && plugin.meshServer.webserver;
        if (!webserver || typeof webserver.GetNodeWithRights !== 'function') { cb(false, 0); return; }
        var domain = this._domainObj(plugin, nodeid, user);
        var done = false;
        var timer = setTimeout(function () {
            if (!done) { done = true; cb(false, 0); }
        }, 3000);
        try {
            webserver.GetNodeWithRights(domain, user, nodeid, function (node, rights, visible) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                var r = rights || 0;
                var ok = !!(visible && r > 0 && (r & required) === required);
                cb(ok, r);
            });
        } catch (e) {
            if (!done) { done = true; clearTimeout(timer); cb(false, 0); }
        }
    }
};
