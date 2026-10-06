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
    // Collection: catálogo de impressoras
    // doc: { _id, nodeid, nodeName, name, driver, port, portName, shared,
    //        shareName, published, default, workOffline, status, attrs,
    //        jobIdCount, portInfo, updatedAt }
    // key: nodeid + '\x00' + name
    // -------------------------------------------------------------------
    obj.printers = new Datastore({
        filename: meshserver.getConfigFilePath('plugin-spooler-printers.db'),
        autoload: true
    });
    obj.printers.setAutocompactionInterval(60000);
    obj.printers.ensureIndex({ fieldName: 'nodeid' });
    obj.printers.ensureIndex({ fieldName: 'name' });

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

    // ======================= PRINTERS =======================

    obj.upsertPrinters = function (nodeid, nodeName, printers) {
        var now = new Date();
        (printers || []).forEach(function (p) {
            p.nodeid = nodeid;
            p.nodeName = nodeName;
            p.updatedAt = now;
            obj.printers.update(
                { nodeid: nodeid, name: p.name },
                { $set: p },
                { upsert: true },
                function (err) { if (err) console.log('SPOOLER DB: upsertPrinters err=' + err.message); }
            );
        });
    };

    obj.markAbsent = function (nodeid, names) {
        // Marca impressoras que não aparecem mais no inventário
        obj.printers.find({ nodeid: nodeid }, function (err, docs) {
            if (err || !docs) return;
            docs.forEach(function (d) {
                if (names.indexOf(d.name) === -1) {
                    obj.printers.update({ _id: d._id }, { $set: { absent: true, updatedAt: new Date() } }, {});
                } else if (d.absent) {
                    obj.printers.update({ _id: d._id }, { $unset: { absent: true }, $set: { updatedAt: new Date() } }, {});
                }
            });
        });
    };

    obj.getPrintersByNode = function (nodeid, callback) {
        obj.printers.find({ nodeid: nodeid }).sort({ name: 1 }).exec(function (err, docs) {
            callback(docs || []);
        });
    };

    obj.getAllPrinters = function (callback) {
        obj.printers.find({ absent: { $ne: true } }).sort({ nodeName: 1, name: 1 }).exec(function (err, docs) {
            callback(docs || []);
        });
    };

    obj.removeNodePrinters = function (nodeid) {
        obj.printers.remove({ nodeid: nodeid }, { multi: true });
    };

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
