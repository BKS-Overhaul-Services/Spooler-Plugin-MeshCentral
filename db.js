/**
 * Spooler — Database module
 * Catálogo de impressoras (por dispositivo) + log de auditoria de operações.
 * NeDB com fallback chain (padrão Tracer/ScriptTask).
 */
"use strict";

module.exports.CreateDB = function (meshserver) {
    var obj = {};
    var Datastore = null;

    // Push node_modules path for NeDB resolution
    module.paths.push(require('path').join(meshserver.parentpath, 'node_modules'));

    // NeDB fallback chain
    try { Datastore = require('@seald-io/nedb'); } catch (ex) {}
    if (Datastore == null) {
        try { Datastore = require('@yetzt/nedb'); } catch (ex) {}
        if (Datastore == null) { Datastore = require('nedb'); }
    }


    // -------------------------------------------------------------------
    // Collection: log de auditoria
    // doc: { _id, nodeid, nodeName, user, op, target, detail, ok, time }
    // -------------------------------------------------------------------
    obj.audit = new Datastore({
        filename: meshserver.getConfigFilePath('plugin-spooler-audit.db'),
        autoload: true
    });
    obj.audit.setAutocompactionInterval(60000);
    obj.audit.ensureIndex({ fieldName: 'nodeid' });
    obj.audit.ensureIndex({ fieldName: 'time' });

    // P2-c — coleção "printers" e funções de catálogo REMOVIDAS: sem call sites
    // (o inventário vivo vem do agente via summary/delta; o catálogo nunca foi
    // populado — upsertPrinters não tinha chamador). plugin-spooler-printers.db
    // pode ser apagado do datapath em deploy.
    // ======================= AUDIT =======================

    obj.addAudit = function (entry) {
        entry.time = new Date();
        if (obj.audit.insert) obj.audit.insert(entry);
    };

    obj.getAudit = function (query, opts, callback) {
        if (typeof opts === 'function') { callback = opts; opts = {}; }
        var limit = (opts && opts.limit) || 500;
        var q = query || {};
        if (opts && opts.nodeid) q.nodeid = opts.nodeid;
        obj.audit.find(q).sort({ time: -1 }).limit(limit).exec(function (err, docs) {
            callback(docs || []);
        });
    };

    return obj;
};
