'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// =============================================================================
// F2 — varredura universal (9100+631+515) com identificação POR PORTA.
// Pinos de fonte: a falha histórica do discover é SILENCIOSA (v1.1.10: 0 IPs
// varridos; F2: ConnectAsync(string, port) tratava "ip:porta" como HOSTNAME →
// todas as tasks faultavam → resultado vazio ok:true). O único teste que pega
// essa classe de bug sem rede real é o pin da fonte PS gerada.
// =============================================================================

const AGENT = path.resolve(__dirname, '../../modules_meshcore/spooler.js');
const src = fs.readFileSync(AGENT, 'utf8');

test('F2: onda única de varredura usa 3 portas de impressão (9100+631+515)', () => {
    assert.ok(src.includes('$ports = @(9100,631,515)'), 'portas 9100+631+515 na onda');
    // 1 processo PS, sem Start-Job (anti-BSOD v1.1.8)
    const tcpIdx = src.indexOf("mode === 'tcp'");
    const nextMode = src.indexOf("mode === 'mdns'", tcpIdx);
    assert.ok(!src.slice(tcpIdx, nextMode).includes('Start-Job'), 'nenhum Start-Job no modo tcp');
});

test('F2: ConnectAsync usa IPAddress parseado — NUNCA a chave "ip:porta" como hostname', () => {
    // Bug real (POC 2026-10-16): ConnectAsync($t, $p2) com $t="ip:porta" → DNS
    // de hostname inválido → todas as tasks faultam → [] com ok:true.
    assert.ok(src.includes('[System.Net.IPAddress]::Parse($ipx)'), 'IP parseado por host');
    assert.ok(src.includes('$c.ConnectAsync($ipo, $p2)'), 'overload (IPAddress, int)');
    assert.ok(!src.includes('ConnectAsync($t,'), 'sem ConnectAsync por string "ip:porta"');
});

test('F2: identificação por porta — IPP só na 631, PJL só na 9100, LPD só na 515', () => {
    assert.ok(src.includes('if ($hp2 -contains 631) {'), 'gate IPP na 631');
    assert.ok(src.includes('$hp2 -contains 9100'), 'gate PJL na 9100');
    assert.ok(src.includes("if (-not $name2 -and $hp2 -contains 515"), 'gate LPD na 515');
    // probe LPD read-only: cmd 3 (Send-queue) + fila + LF; nunca cmd 1/2 (recv)
    assert.ok(/ASCII\.GetBytes\('print'\) \+ \[byte\]10/.test(src), 'RFC 1179: queue state (cmd 3) com \\n');
});

test('F2: orçamento de enriquecimento existe, é limitado e hosts fora dele saem com ports[]', () => {
    const m = src.match(/var enrBudget = ([^;]+);/);
    assert.ok(m, 'enrBudget declarado');
    assert.ok(/Math\.min\(Math\.max\(/.test(m[1]), 'clamp min/max');
    assert.ok(src.includes('$deadline.Elapsed.TotalSeconds -ge $budget'), 'gate pelo orçamento');
    assert.ok(src.includes("ports=@($hp2)"), 'ports[] no output (inclusive overflow)');
});

test('F2: frontend trata ports[] e modelSource lpd', () => {
    const view = fs.readFileSync(path.resolve(__dirname, '../../views/device.handlebars'), 'utf8');
    assert.ok(view.includes("lpd:'LPD'"), 'badge LPD');
    assert.ok(view.includes('f.ports.indexOf(9100)>=0?9100:f.ports[0]'), 'prefill de porta por host');
    assert.ok(/portas: '\+f\.ports\.join/.test(view), 'portas no card');
});
