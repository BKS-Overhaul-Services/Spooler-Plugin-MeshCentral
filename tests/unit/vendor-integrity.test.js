'use strict';
// =============================================================================
// P2 — Integridade do vendor/plugin-lib (padrão k8s diff).
// Recomputa o sha384 do CORPO de cada arquivo vendorizado (sem o cabeçalho
// gerado de 4 linhas) e compara ao hash gravado no próprio cabeçalho.
// Cópia editada à mão ou defasada em relação à fonte FALHA aqui.
// Gerado pelo passo 5 do P2; conteúdo idêntico nos 4 consumers.
// =============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// consume os MESMOS módulos que o sync.js distribui para este plugin
const VENDOR_FILES = ['plugin-acl.js', 'pending.js', 'journal.js'];
const VENDOR_DIR = path.resolve(__dirname, '../../vendor/plugin-lib');

function checkVendor(relPath) {
    const full = path.join(VENDOR_DIR, relPath);
    const raw = fs.readFileSync(full, 'utf8');
    const m = raw.match(/^\/\/ ARQUIVO GERADO por plugin-lib v([^\s]+) — NÃO EDITAR\.\n\/\/ sha384: ([0-9a-f]{96})\n/);
    assert.ok(m, relPath + ': cabeçalho GERADO ausente ou malformado');
    const body = raw.replace(/^\/\/ ARQUIVO GERADO[\s\S]*?\n\n/, ''); // header GERADO (3 linhas + blank)
    const actual = crypto.createHash('sha384').update(body, 'utf8').digest('hex');
    assert.equal(actual, m[2], relPath + ': corpo diverge do sha384 do cabeçalho (editado à mão ou sync pendente)');
    return m[1]; // versão da lib
}

test('vendor/plugin-lib: todos os arquivos batem com o sha384 do próprio cabeçalho', () => {
    const versions = {};
    for (const f of VENDOR_FILES) {
        versions[f] = checkVendor(f);
    }
    // todos os módulos vieram da MESMA versão da lib (bump atômico)
    const uniq = [...new Set(Object.values(versions))];
    assert.equal(uniq.length, 1, 'versões misturadas no vendor: ' + JSON.stringify(versions));
});

test('vendor/plugin-lib: acl é idêntico entre consumers que o usam (fonte única)', () => {
    // o corpo do acl vendido a este plugin DEVE ser o mesmo da fonte plugin-lib
    const libSrc = path.resolve(__dirname, '../../../plugin-lib/src/plugin-acl.js');
    if (!fs.existsSync(libSrc)) return; // ambiente sem o repo da lib (zip de instalação): sha do header basta
    const srcBody = fs.readFileSync(libSrc, 'utf8');
    const raw = fs.readFileSync(path.join(VENDOR_DIR, 'plugin-acl.js'), 'utf8');
    const body = raw.replace(/^\/\/ ARQUIVO GERADO[\s\S]*?\n\n/, '');
    assert.equal(body, srcBody, 'vendor/plugin-lib/plugin-acl.js diverge da fonte plugin-lib/src — rode tools/sync.js');
});
