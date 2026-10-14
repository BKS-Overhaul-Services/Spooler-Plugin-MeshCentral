// ARQUIVO GERADO por plugin-lib v0.3.0 — NÃO EDITAR.
// sha384: 23e86857159de25841f44b9ee20974268ad7433faf489dfcc0b1cfd955f4f0a8d632367b007f4ac6b1db2832a97bb101
// Fonte: repo Plugins/plugin-lib (edite src/ e rode tools/sync.js).

/**
 * pending.js — Esqueleto reqid/pending server-side (fonte única plugin-lib)
 * =============================================================================
 * Extraído do NetAdapter (netadapter.js:107 + :138-146 + :156-158 + :221-239),
 * que é o superset do padrão usado por NetAdapter/Spooler/NodeBridge.
 *
 * O que a lib CONHECE: o mecanismo — criar reqid, guardar entrada, expirar por
 * timeout, fechar/consumir. O que a lib NÃO conhece: negócio de plugin nenhum.
 * Auditoria, invalidação de cache/catálogo, envio ao browser etc. são HOOKS do
 * consumer.
 *
 * Uso (consumer):
 *   var Pending = require('./vendor/plugin-lib/pending.js');
 *   obj.pending = Pending.create({
 *       prefix: 'na',                          // prefixo do reqid ('na','sp','nb','nbs'...)
 *       scanInterval: 30000,                   // housekeeping (default 30s; .unref())
 *       log: function (msg) { ... },           // opcional
 *       timeoutFor: function (entry) {         // timeout por entrada (ms)
 *           return entry.mut ? (SLOW_OPS.indexOf(entry.op) >= 0 ? 480000 : 360000) : 120000;
 *       },
 *       onTimeout: function (reqid, entry) {   // chamado ANTES de remover
 *           obj.send(entry.sid, { ...method:'agentResult', ok:false, error:'Timeout...' });
 *           // audit/invalidação aqui, se o op for mutação
 *       }
 *   });
 *   ...
 *   var reqid = obj.pending.create({ sid, nodeid, op, user, mut });  // cria + retorna reqid
 *   var entry = obj.pending.get(reqid);        // sem consumir
 *   var entry = obj.pending.take(reqid);       // consome (fecha)
 *   obj.pending.close(reqid);                  // consome sem retornar
 *
 * Notas:
 * - `take`/`close`/`get` são síncronos — o fluxo do NA (agentResult, journal
 *   drain "pending aberto vs timeout já respondido") usa exatamente essa
 *   semântica (netadapter.js:449-464, :390-394).
 * - O timer de housekeeping usa .unref() (padrão Tracer usertracer.js:117) —
 *   não segura o event loop de testes.
 * - ES5-friendly (o core MeshCentral roda em Node antigo).
 */
"use strict";

var DEFAULT_SCAN_INTERVAL = 30000;
var DEFAULT_TIMEOUT = 120000;

function create(opts) {
    opts = opts || {};
    var map = {};                          // reqid → entry
    var prefix = String(opts.prefix || 'pl');
    var log = opts.log || function () {};
    var timeoutFor = opts.timeoutFor || function () { return DEFAULT_TIMEOUT; };
    var onTimeout = opts.onTimeout || function (reqid, entry) {
        log('pending timeout reqid=' + reqid + ' (sem onTimeout configurado)');
    };
    var timer = null;
    var stopped = false;

    function scan() {
        if (stopped) return;
        var now = Date.now();
        for (var r in map) {
            var entry = map[r];
            var max = timeoutFor(entry);
            if (typeof max !== 'number' || !(max > 0)) max = DEFAULT_TIMEOUT;
            if (now - entry.ts > max) {
                log('reqid timeout reqid=' + r + (entry.op ? ' op=' + entry.op : '') + (entry.mut ? ' (mutação)' : ''));
                delete map[r];                     // remove ANTES do hook: hook não pode re-expirar
                try { onTimeout(r, entry); } catch (e) { log('onTimeout error reqid=' + r + ': ' + (e && e.message)); }
            }
        }
    }

    var api = {
        // cria entrada + devolve reqid novo (prefixo + base36 + aleatório —
        // formato idêntico ao dos plugins: netadapter.js:156-158)
        create: function (entry) {
            var reqid = prefix + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
            entry = entry || {};
            if (typeof entry.ts !== 'number') entry.ts = Date.now(); // consumer pode trazer ts retroativo (journal/migração)
            map[reqid] = entry;
            return reqid;
        },
        // consulta sem consumir
        get: function (reqid) { return map[reqid] || null; },
        // consome (fecha) e devolve a entrada — null se inexistente/já fechada
        take: function (reqid) {
            var e = map[reqid];
            if (e) delete map[reqid];
            return e || null;
        },
        // consome sem retornar (boolean: existia?)
        close: function (reqid) { return api.take(reqid) !== null; },
        size: function () { return Object.keys(map).length; },
        // para testes: avança o scan manualmente (sem depender do interval)
        scan: scan,
        stop: function () {
            stopped = true;
            if (timer && typeof timer.unref === 'function') { clearInterval(timer); timer = null; }
        }
    };

    if (opts.autoScan !== false) {
        timer = setInterval(scan, opts.scanInterval || DEFAULT_SCAN_INTERVAL);
        if (timer && typeof timer.unref === 'function') timer.unref();
    }

    return api;
}

module.exports = { create: create };
