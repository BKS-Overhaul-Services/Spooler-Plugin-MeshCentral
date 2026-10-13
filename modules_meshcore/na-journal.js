/**
 * na-journal.js — Journal de resultados de mutação (store-and-forward)
 * =============================================================================
 * Extraído do padrão do session-tracer (plugin Tracer v4). Usado pelo NetAdapter
 * (e reaproveitável pelo Spooler) para o problema: mutações que DERRUBAM a conexão
 * do agente (disableAdapter, setIp, setMac...) executam com sucesso no dispositivo,
 * mas o agentResult nunca chega → servidor responde TIMEOUT e o audit registra
 * um "timeout" falso.
 *
 * Fluxo (agente):
 *   1. intent(reqid, op, params)   ← write-ahead ANTES de executar
 *   2. executa (a conexão pode morrer aqui)
 *   3. result(reqid, ok, error, …) ← write-ahead DEPOIS de executar
 *   4. reply normal (agentResult); se o túnel caiu, o resultado fica no journal
 *   5. drain() envia resultados não-ackados; ack(ids) remove do journal
 *
 * Boot: intents sem result viram resultados sintéticos
 *   { ok:false, error:'agente reiniciou durante a mutação (resultado desconhecido)' }
 * — o servidor audita a incerteza em vez de perder o evento.
 *
 * Sem side effects no load: timers só via startDrainTimer(). Testável em Node puro.
 * JSONL append-only; crash-safety: linhas parciais descartadas na carga.
 * Cap: entradas excedentes são descartadas (as mais antigas primeiro) — é um
 * journal de results, não um histórico: o servidor deduplica por reqid.
 */
"use strict";

module.exports.Create = function (opts) {
    opts = opts || {};
    var FILE = opts.file || 'netadapter-mutations.journal';
    var CAP = opts.cap || 500;

    var fs = null; try { fs = require('fs'); } catch (e) {}
    var entries = [];        // [{id, k:'i'|'r', ...}]
    var ackSet = {};         // reqids confirmados pelo servidor (in-memory)
    var _timers = [];

    var obj = {
        file: FILE,
        _entries: function () { return entries; },
        _timers: _timers
    };

    // ---------------- carga / persistência ----------------

    obj.load = function () {
        entries = [];
        ackSet = {};
        if (!fs) return obj;
        var raw = null;
        try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) { raw = null; }
        if (!raw) return obj;
        var lines = raw.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            var doc = null;
            try { doc = JSON.parse(line); } catch (e) { continue; } // linha parcial (crash) → descarta
            if (doc && doc.id && doc.k) entries.push(doc);
        }
        obj._synthesizeInterrupted();
        return obj;
    };

    obj._save = function () {
        if (!fs) return;
        var out = [];
        for (var i = 0; i < entries.length; i++) out.push(JSON.stringify(entries[i]));
        try {
            fs.writeFileSync(FILE + '.tmp', out.join('\n') + (out.length ? '\n' : ''), 'utf8');
            try { fs.unlinkSync(FILE); } catch (e) {}
            try { fs.renameSync(FILE + '.tmp', FILE); } catch (e2) {
                fs.writeFileSync(FILE, out.join('\n') + (out.length ? '\n' : ''), 'utf8');
            }
        } catch (e3) {}
    };

    function append(doc) {
        entries.push(doc);
        // cap: descarta as mais antigas; mantém ao menos o doc atual
        while (entries.length > CAP) entries.shift();
        obj._save();
        return doc;
    }

    // ---------------- API de escrita ----------------

    // Write-ahead da INTENÇÃO (antes de executar a mutação)
    obj.intent = function (reqid, op, params) {
        return append({ id: reqid, k: 'i', op: op, params: params || null, ts: Date.now() });
    };

    // Write-ahead do RESULTADO (depois de executar)
    obj.result = function (reqid, op, ok, error, target) {
        return append({ id: reqid, k: 'r', op: op, ok: ok === true, error: error || null, target: target || null, ts: Date.now() });
    };

    // Boot: intents sem result → resultado sintético de incerteza
    obj._synthesizeInterrupted = function () {
        var hasResult = {};
        entries.forEach(function (e) { if (e.k === 'r') hasResult[e.id] = true; });
        var synthetic = [];
        entries.forEach(function (e) {
            if (e.k === 'i' && !hasResult[e.id]) {
                synthetic.push(e);
            }
        });
        var changed = false;
        synthetic.forEach(function (i) {
            append({
                id: i.id, k: 'r', op: i.op, ok: false,
                error: 'agente reiniciou durante a mutação (resultado desconhecido)',
                target: (i.params && (i.params.name || i.params.host || i.params.infPath)) || null,
                ts: Date.now(), synthetic: true
            });
            changed = true;
        });
        if (changed) obj._save();
        return synthetic.length;
    };

    // ---------------- drain / ack ----------------

    // Resultados prontos para envio (ainda não confirmados pelo servidor),
    // mais antigos primeiro. REENVIA até receber ack (at-least-once):
    // o envio NÃO marca nada — só o ack(id) do servidor tira do journal.
    obj.pending = function () {
        var out = [];
        entries.forEach(function (e) {
            if (e.k === 'r' && !ackSet[e.id]) out.push(e);
        });
        return out;
    };

    // Envia todos os pendentes via sendFn(cmd) — retorna a lista enviada ([] se nada/erro).
    obj.drain = function (sendFn) {
        var pend = obj.pending();
        if (!pend.length || typeof sendFn !== 'function') return [];
        var cmd = {
            action: 'plugin', plugin: opts.plugin || 'netadapter', from: 'agent',
            cmd: 'mutresults', results: pend
        };
        try {
            sendFn(cmd);
        } catch (e) { return []; }
        return pend;
    };

    // Servidor confirmou processamento → marca e remove do journal.
    obj.ack = function (ids) {
        (ids || []).forEach(function (id) { ackSet[id] = true; });
        entries = entries.filter(function (e) { return e.k !== 'r' || !ackSet[e.id]; });
        obj._save();
    };

    // Limpa journal inteiro (uso: troca de reqid space, testes)
    obj.clear = function () { entries = []; ackSet = {}; obj._save(); };

    obj.startDrainTimer = function (sendFn, ms) {
        var t = setInterval(function () { obj.drain(sendFn); }, ms || 60000);
        _timers.push(t);
        return t;
    };

    obj.stopTimers = function () {
        _timers.forEach(function (t) { try { clearInterval(t); } catch (e) {} });
        _timers = [];
        obj._timers = _timers;
    };

    return obj;
};
