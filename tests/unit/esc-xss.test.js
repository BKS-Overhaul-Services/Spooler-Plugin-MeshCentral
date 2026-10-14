'use strict';
// =============================================================================
// P2-b — esc() dos views escapa apóstrofo (anti-XSS em onclick/attr JS).
// Extrai a função esc() do FONTE de cada view e asserita neutralização dos
// vetores: onclick='...' com apóstrofo, attribute breakout com aspa dupla.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VIEWS = [
    ['SP device', '../../views/device.handlebars'],
    ['SP admin', '../../views/admin.handlebars'],
    ['TR device', '../../../Tracer-Plugin-MeshCentral/views/device.handlebars'],
    ['TR admin', '../../../Tracer-Plugin-MeshCentral/views/admin.handlebars'],
    ['NA device', '../../../NetAdapter-Plugin-MeshCentral/views/device.handlebars'],
    ['NA admin', '../../../NetAdapter-Plugin-MeshCentral/views/admin.handlebars'] // P2-b
];

function extractEsc(src) {
    const m = /function esc\(s\)\{([\s\S]*?)\}/.exec(src);
    assert.ok(m, 'esc() encontrada');
    // corpo capturado já contém "return ..." completo
    return new Function('s', m[1]);
}

VIEWS.forEach(function ([label, rel]) {
    test('P2-b esc(): ' + label + ' escapa apóstrofo e aspas', () => {
        const src = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
        const esc = extractEsc(src);
        // vetor 1: quebra onclick='...' via apóstrofo
        assert.equal(esc("x'); alert(1); ('"), "x&#39;); alert(1); (&#39;");
        // vetor 2: quebra attr="..." via aspa dupla
        assert.equal(esc('" onmouseover="alert(1)'), '&quot; onmouseover=&quot;alert(1)');
        // vetor 3: apóstrofo tipográfico do XSSs clássico
        assert.equal(esc("d'Artagnan"), 'd&#39;Artagnan');
        // sem regressão: escaping básico preservado
        assert.equal(esc('<script>'), '&lt;script&gt;');
        assert.equal(esc('a&b'), 'a&amp;b');
        assert.equal(esc(null), '');
    });
});

test('P2-b: nenhum onclick inline com interpolação dinâmica resta nos views', () => {
    const checks = [
        '../../views/device.handlebars',
        '../../views/admin.handlebars',
        '../../../Tracer-Plugin-MeshCentral/views/admin.handlebars',
        '../../../NetAdapter-Plugin-MeshCentral/views/admin.handlebars', // P2-b
        '../../../NetAdapter-Plugin-MeshCentral/views/device.handlebars' // P2-b
    ];
    checks.forEach(function (rel) {
        const src = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
        const lines = src.split('\n');
        lines.forEach(function (l, i) {
            // P2-b: onchange/oninput dinâmicos são o MESMO vetor do onclick
            if (/(onclick|onchange|oninput)=/.test(l) && /\+'/.test(l)) {
                // onclick com concatenação JS: só é aceitável se NÃO interpola valor dinâmico
                // (chamadas estáticas do tipo onclick="fn()" sem aspas escapadas)
                assert.ok(!/\\''\s*\+/.test(l),
                    path.basename(rel) + ':' + (i + 1) + ' ainda tem handler inline com valor dinâmico: ' + l.trim().substring(0, 80));
            }
        });
    });
});

test('P2-b: delegadores data-act presentes (SP device/admin, TR admin, NA device/admin)', () => {
    const needs = [
        ['../../views/device.handlebars', "addEventListener('click'"],
        ['../../views/admin.handlebars', "addEventListener('click'"],
        ['../../../Tracer-Plugin-MeshCentral/views/admin.handlebars', "addEventListener('click'"],
        ['../../../NetAdapter-Plugin-MeshCentral/views/device.handlebars', "addEventListener('click'"],
        ['../../../NetAdapter-Plugin-MeshCentral/views/admin.handlebars', "addEventListener('click'"] // P2-b
    ];
    needs.forEach(function ([rel, marker]) {
        const src = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
        assert.ok(src.indexOf(marker) >= 0, rel + ' tem delegador de clicks');
        assert.ok(/data-act=/.test(src), rel + ' usa data-act');
    });
});
