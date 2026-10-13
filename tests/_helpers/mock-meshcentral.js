'use strict';

// Mock mínimo do MeshCentral para testes server-side do NetAdapter.
// Mesmo padrão do Tracer (tests/_helpers/mock-meshcentral.js), enxuto.

const path = require('path');

function buildMock(opts = {}) {
    const captured = { sent: [], audits: [] };

    const webserver = {
        wssessions2: opts.wssessions2 || {},
        wsagents: opts.wsagents || {},
        send: function () {}
    };
    Object.keys(webserver.wssessions2).forEach(function (sid) {
        if (typeof webserver.wssessions2[sid].send !== 'function') {
            webserver.wssessions2[sid].send = function (data) {
                captured.sent.push({ sid: sid, data: typeof data === 'string' ? JSON.parse(data) : data });
            };
        }
    });

    const meshServer = {
        debug: function () {},
        webserver: webserver,
        parent: { config: { settings: {} } },
        db: opts.mdb || { Get: function (nid, cb) { cb(null, []); } },
        parentpath: path.resolve(__dirname, '../../node_modules')
    };

    const parent = {
        parent: meshServer,
        registerPermissions: function () {},
        getAccessPermissions: function () { return Promise.resolve(function () { return false; }); },
        pluginPermissions: null,
        wrapFunctionCall: function () {}
    };

    return { parent, meshServer, webserver, captured };
}

function makeDb(audits) {
    return {
        addAudit: function (a) { audits.push(a); },
        getAudit: function (q, o, cb) { cb(audits); },
        getAdaptersByNode: function (n, cb) { cb([]); },
        getAllAdapters: function (cb) { cb([]); },
        upsertAdapters: function () {},
        markAbsent: function () {}
    };
}

function makeAgentConn(nodeid) {
    const conn = {
        nodeid: nodeid,
        sent: [],
        send: function (d) { conn.sent.push(typeof d === 'string' ? JSON.parse(d) : d); }
    };
    return conn;
}

module.exports = { buildMock, makeDb, makeAgentConn };
