# KNOWLEDGE-BASE.md — Engenharia de Plugins MeshCentral

> **Documento de conhecimento consolidado** — tudo o que foi aprendido desenvolvendo, depurando
> e validando em produção os plugins **User-Device Tracer** (v3.5.97) e **Spooler** (v1.1.11)
> para MeshCentral, incluindo análise do código-fonte do MeshCentral e do MeshAgent.
>
> Autor: Misael Filho · Outubro/2026 · BKS Overhaul Services
> Repositórios: [Spooler](https://github.com/BKS-Overhaul-Services/Spooler-Plugin-MeshCentral) · [Tracer](https://github.com/jukmisael/Tracer-Plugin-MeshCentral) · [MeshCentral](https://github.com/Ylianst/MeshCentral) · [MeshAgent](https://github.com/Ylianst/MeshAgent)

---

## Sumário

1. [Arquitetura do MeshCentral](#1-arquitetura-do-meshcentral)
2. [Anatomia de um plugin](#2-anatomia-de-um-plugin)
3. [Ciclo de vida e hooks](#3-ciclo-de-vida-e-hooks)
4. [Protocolo WebSocket frontend ↔ server ↔ agente](#4-protocolo-websocket)
5. [O MeshAgent NÃO é Node.js — o shim child_process](#5-o-meshagent-não-é-nodejs)
6. [PowerShell dentro do agente: receita validada](#6-powershell-dentro-do-agente)
7. [Banco de dados (NeDB/MongoDB)](#7-banco-de-dados)
8. [Frontend: views, iframe e o trap do pluginHandler](#8-frontend)
9. [Segurança: ACL nativa e sanitização](#9-segurança)
10. [Estudo de caso Spooler: 11 versões de bugs reais](#10-estudo-de-caso-spooler)
11. [Estudo de caso Tracer: scanner, Gantt e races](#11-estudo-de-caso-tracer)
12. [Descoberta de impressoras: protocolos na prática](#12-descoberta-de-impressoras)
13. [Testes: estratégia e ferramentas](#13-testes)
14. [Depuração em produção](#14-depuração-em-produção)
15. [Checklist de revisão de plugin](#15-checklist)
16. [Bibliografia e links](#16-bibliografia)

---

## 1. Arquitetura do MeshCentral

### 1.1 Cadeia de objetos no servidor

O plugin é uma fábrica que recebe o `pluginHandler` e guarda referências. A cadeia **exata**
(validada por debug em produção com o Tracer v3.2, ver `MESHCENTRAL-PLUGIN-GUIDE.md` §1):

```javascript
module.exports.spooler = function (parent) {      // parent = pluginHandler (singleton)
    var obj = {};
    obj.parent = parent;                          // pluginHandler
    obj.meshServer = parent.parent;               // meshServer ("main server")
    // obj.meshServer.webserver = CreateWebServer() → rotas Express, wsagents, wssessions2
    // obj.meshServer.db         = abstração NeDB/Mongo/SQL do MeshCentral
    // obj.meshServer.getConfigFilePath(name) → <datapath>/<name>
    return obj;
};
```

| Tentativa | Resultado | Alternativa correta |
|---|---|---|
| `meshServer.parent` | `undefined` | não existe; só descendo via `obj` |
| `meshServer.parent.agents` | `TypeError` | `meshServer.webserver.wsagents` |
| `res.render(__dirname + '/views/admin')` | `Failed to lookup view` | `res.render('admin')` (o webserver troca o `views` dir para o do plugin) |

**Fonte:** `pluginHandler.js` (Ylianst/MeshCentral master, ~297 linhas) — carregamento em
`obj.plugins[sn] = require(pluginPath + '/' + sn + '/' + sn + '.js')[sn](obj);`.
O nome exportado da fábrica **deve** ser idêntico ao `shortName` do `config.json`.

### 1.2 Estruturas-chave do webserver (em memória)

```javascript
obj.meshServer.webserver.wsagents      // { nodeid → agentSession }  — agentes conectados
obj.meshServer.webserver.wssessions2   // { 'user//dom/user/rnd' → browserSession }
obj.meshServer.webserver.wssessions    // { userId → [sessions] }
obj.meshServer.webserver.users         // cache in-memory de usuários
obj.meshServer.webserver.meshes        // cache in-memory de device groups
```

Uma `agentSession` tem: `.nodeid`, `.name`, `.agentInfo` (computerName, agentVersion...),
`.dbNodeKey` (`node/<dom>/<id>`), `.remoteaddr`, `.send()`.
Uma sessão browser tem: `.ws.sessionId` (= chave em `wssessions2`), `.user`, `.send()`, `.domain`.

### 1.3 Rotas HTTP de plugin (webserver.js:6895-6920, 7463-7467)

```
GET  /pluginadmin.ashx?pin=<shortName>[&user=1&nodeid=...]  → pluginHandler.handleAdminReq
POST /pluginadmin.ashx?pin=<shortName>                      → pluginHandler.handleAdminPostReq
GET  /pluginHandler.js                                      → prepExports() serializado
```

Antes do handler: validações de IP, sessão, usuário e `pin` alfanumérico.
O webserver **troca o diretório de views** para `<pluginPath>/<pin>/views` antes de chamar
o handler — por isso `res.render('admin')` resolve `views/admin.handlebars` do plugin.

---

## 2. Anatomia de um plugin

```
spooler/
├── config.json                 # manifesto (validado por isValidConfig)
├── spooler.js                  # server-side: fábrica + hooks
├── db.js                       # NeDB/MongoDB próprio (opcional)
├── modules_meshcore/
│   └── spooler.js              # código injetado no AGENTE (ver §5)
└── views/
    ├── admin.handlebars        # painel global (?pin=spooler)
    └── device.handlebars       # aba do dispositivo (?pin=spooler&user=1&nodeid=...)
```

### 2.1 config.json mínimo (campos validados em pluginHandler.js:103-108)

```json
{
  "name": "Spooler — Gerenciador de Impressoras",
  "shortName": "spooler",
  "version": "1.1.11",
  "author": "...",
  "description": "...",
  "hasAdminPanel": true,
  "homepage": "https://github.com/...",
  "changelogUrl": "https://raw.githubusercontent.com/.../changelog.md",
  "configUrl": "https://raw.githubusercontent.com/.../config.json",
  "downloadUrl": "https://github.com/.../archive/refs/heads/main.zip",
  "repository": { "type": "git", "url": "https://github.com/....git" },
  "meshCentralCompat": ">=1.0.0"
}
```

**Armadilha de distribuição (Tracer v3.5.89):** o `downloadUrl` apontando para o ZIP do repo
inteiro faz o MeshCentral extrair `analysis/`, `tests/`, `node_modules` dentro de
`meshcentral-data/plugins/<sn>/` — na atualização seguinte esses arquivos ficam com
permissão travada e a extração falha com `EPERM`. Solução do Tracer: GitHub Action
(`.github/workflows/release.yml`) que monta ZIP **limpo** (só runtime) e publica como
release asset com nome fixo: `releases/latest/download/usertracer.zip`.

### 2.2 O módulo do agente DEVE se chamar igual ao shortName

**Bug crítico real (Spooler v1.1.1):** o módulo agent-side se chamava `win-spooler.js`
(pensando na convenção de prefixos do `addMeshCoreModules`). O dispatcher do core do agente,
porém, resolve o módulo por `command.plugin`:

```javascript
// agents/meshcore.js (handleServerCommand), trecho conceptual:
var m = require(command.plugin);   // require('spooler')
m.consoleaction(command, rights, sessionid, parent);
```

Como o arquivo era `win-spooler.js`, `require('spooler')` falhava silenciosamente:
`Module: spooler (NOT FOUND)` e o agente **nunca respondia**. Fix: renomear para
`spooler.js` (o guarda `process.platform === 'win32'` protege Linux). Referência: o
plugin comunitário `printercontrol` usa exatamente esse padrão.

**Segundo bug na mesma sequência (v1.1.2):** a função `consoleaction` existia mas não
estava exportada → `TypeError: undefined not callable (property 'consoleaction')` a cada
comando. Fix obrigatório:

```javascript
module.exports = { consoleaction: consoleaction };
```

---

## 3. Ciclo de vida e hooks

### 3.1 Sequência de carregamento (pluginHandler.js:142-189, 207-219)

```
installPlugin(id)
  ├─ db.getPlugin(id)
  ├─ download ZIP → extrair em <datapath>/plugins/<shortName>/
  ├─ db.setPluginStatus(id, 1)
  ├─ require(.../<shortName>.js)[shortName](obj)
  ├─ if (server_startup) server_startup()
  └─ parent.updateMeshCore()      ← RECOMPÕE os cores dos agentes
```

**Consequências práticas:**
- Mudou `modules_meshcore/`? Precisa **restart do MeshCentral + reconexão dos agentes**
  (o core é entregue na conexão).
- Mudou só `spooler.js` (server)? "Reload" no admin basta (`reloadPlugin` limpa `require.cache`).
- Mudou `views/`? Basta F5 no browser.
- Mudou `config.json` do plugin? Reinstalar (não reload).

### 3.2 Hooks server-side usados em produção

| Hook | Quando | Assinatura | Uso real |
|---|---|---|---|
| `server_startup` | após load/reload | `()` | init DB, timers, registerPermissions |
| `serveraction` | **toda** msg `action:'plugin'` de browser OU agente | `(command, myparent, gp)` | dispatcher principal |
| `handleAdminReq` | `GET /pluginadmin.ashx?pin=` | `(req, res, user)` | render das views |
| `hook_agentCoreIsStable` | agente conectou e core pronto | `(myparent, gp)` | Tracer: scan imediato |
| `hook_processAgentData` | msg do agente não consumida pelo core | `(data, nodeid)` | Tracer: scan debounced |
| `onDeviceRefreshEnd` (frontend) | aba do device renderizada | `()` | registrar plugin tab |

Código real do Spooler (`spooler.js`) — dispatcher com distinção browser/agente:

```javascript
obj.serveraction = function (command, myparent, gp) {
    if (command.plugin !== 'spooler') return;
    var isAgent = false, sid = null;
    try { sid = myparent.ws.sessionId; } catch (e) { isAgent = true; }
    // conexão de agente NÃO tem ws.sessionId → msg veio do agente (resposta)

    if (isAgent || command.pluginaction === 'agentResult') {
        var p = obj.pending[command.reqid];       // correlação reqid
        if (!p) return;                            // timeout/sessão fechada
        delete obj.pending[command.reqid];
        obj.send(p.sid, { action:'plugin', plugin:'spooler',
            method:'agentResult', op: command.op, ok: command.ok,
            result: command.result, error: command.error });
        return;
    }
    switch (command.pluginaction) { /* ... */ }
};
```

**Armadilha do `nodeid` (Tracer §15):** em `hook_processAgentData`, o `nodeid` pode chegar
como string, objeto ou número dependendo do path interno. Normalizar sempre:

```javascript
var nid = (typeof nodeid === 'string') ? nodeid
        : (nodeid && typeof nodeid === 'object' ? (nodeid.nodeid || nodeid._id) : null);
```

### 3.3 registerPermissions (RBAC, pluginHandler.js:234-281)

```javascript
obj.parent.registerPermissions('usertracer', {
    can_view_history:  { title: '...', desc: '...', default: 'allowed' },
    can_purge_history: { title: '...', desc: '...', default: 'denied' }
});
// avaliação: obj.parent.getAccessPermissions('usertracer', user, { nodeid })
//   → Promise<function(permission)>
```

Cascata: nodeOverride → meshOverride → global allowed/denied → default. Site-admin
(`user.siteadmin === 0xFFFFFFFF`) sempre passa.

---

## 4. Protocolo WebSocket

### 4.1 Envelope universal

```json
{ "action": "plugin", "plugin": "<shortName>", "pluginaction": "<verbo>", "...": "..." }
```

O core injeta `command.userid` nas mensagens de browser. Fluxos:

```
Browser → Server:   ms.send({action:'plugin', plugin:'spooler', pluginaction:'inventory', nodeid, params})
Server  → Agent:    wsagents[nodeid].send(JSON.stringify({...mesmo envelope, reqid}))
Agent   → Server:   mesh.SendCommand(JSON.stringify({..., pluginaction:'agentResult', reqid}))
Server  → Browser:  wssessions2[sid].send(JSON.stringify({..., method:'agentResult'}))
```

### 4.2 Correlação de respostas (reqid — padrão Spooler/PrinterControl)

```javascript
// server-side
obj.pending[reqid] = { sid, nodeid, op, user, ts: Date.now() };
// timer de 30s varre pendings > 120s e responde timeout ao browser
// agentResult chegando: obj.pending[reqid] → roteia para p.sid
```

Alternativas históricas: `sessionid` do browser embutido no comando ao agente
(RegEdit/EventLog) ou `sessionid: true` no `hook_agentCoreIsStable` (roteamento nativo).
O reqid é superior: não vaza sessão para o agente e permite múltiplas requisições
paralelas da mesma sessão.

### 4.3 Frontend: listener RAW no socket

**Regra de ouro (Tracer v3.5.54, v3.5.90):** nunca sobrescrever `ms.socket.onmessage`
nem confiar só em `pluginHandler.<shortName>.<method>`:

```javascript
// device.handlebars (padrão atual do Spooler — mas ver §8 para o bug do onmessage)
ms.socket.addEventListener('message', function (ev) {
    try {
        var d = JSON.parse(ev.data);
        if (d.action === 'plugin' && d.plugin === 'spooler' && d.method === 'agentResult') handleResult(d);
    } catch (e) {}
});
```

E **todo `method`** que o server envia deve existir como no-op em `obj.exports` — senão
o dispatcher upstream (`default.handlebars:4172`) lança `TypeError` em páginas que
recebem a mensagem sem ter o handler (bug real do Tracer v3.5.90):

```javascript
obj.exports = ['onDeviceRefreshEnd', 'currentUsers', 'timeline', 'deviceNames', 'userNames'];
obj.currentUsers = function () {};   // no-op stubs para o dispatcher upstream
obj.timeline = function () {};
```

### 4.4 Anti-stale: `_reqSeq`

Quando responses podem chegar fora de ordem (múltiplos filtros, refetch rápido), o cliente
manda `_reqSeq` incremental e **descarta** responses cujo seq não é o último enviado
(Tracer v3.5.54 — "victor.portes sobrescrevendo alexandre.matias").

---

## 5. O MeshAgent NÃO é Node.js

**A descoberta mais importante deste projeto** (Spooler v1.1.6 — causa raiz de "todos os
comandos PS voltavam vazios via agente mas funcionavam local").

O MeshAgent embarca um motor **Duktape (ECMAScript 5)** com módulos implementados em C:
`microscript/ILibDuktape_ChildProcess.c` + `microstack/ILibProcessPipe.c` (Ylianst/MeshAgent).
Diferenças fatais vs Node real:

| Aspecto | Node.js real | Shim do MeshAgent |
|---|---|---|
| Callback do `execFile` | `(error, stdout, stderr)` | evento `exit` → **`(exitCode, signal)`** |
| Captura de stdout | no callback / stream | **só** via `p.stdout.on('data')` |
| `options.timeout` | respeitado | **ignorado** |
| `options.maxBuffer` | respeitado | **ignorado** (não existe) |
| `execSync`/`spawnSync` | existem | **não existem** |
| quoting de args | automático | **nenhum** (args com espaço quebram) |
| GC pega child vivo | processo continua | **finalizador mata o processo** |

### 5.1 Por que meu stdout era vazio (o bug da v1.1.5-)

Código ingênuo (Node-style) dentro do agente:

```javascript
child.execFile(ps, [...args, '-Command', '-'], { timeout: 120000, maxBuffer: 8*1024*1024 },
    function (err, stdout, stderr) {   // ← no agente: stdout === signal === null, err === exitCode 0 (falsy)
        callback(err, stdout, stderr); // → "exit 0, stdout vazio" sem erro aparente
    });
p.stdin.write(script); p.stdin.end();
```

Sintoma em produção (`spooler-plugin.txt` do agente):
`runJson stdout.len=0 stderr=null err=null` em ~130ms, para **todo** comando.

### 5.2 Receita correta (padrão do próprio core — agents/meshcore.js:1512)

```javascript
function runPS(script, callback) {
    var stdout = '', stderr = '', done = false, timer = null;
    var p = child.execFile(ps, ['-NoLogo','-NoProfile','-NonInteractive',
                                '-ExecutionPolicy','Bypass','-Command','-'], {},
        function (err) {                       // 'exit' → err = exitCode (number) no shim
            if (done) return; done = true;
            if (timer) { clearTimeout(timer); timer = null; }
            var code = 0;
            if (err) {
                if (typeof err === 'number') code = err;            // shim agente
                else if (typeof err.code === 'number') code = err.code; // Node real
                else code = 1;
            }
            callback(code ? { code: code, message: '...' } : null, stdout, stderr);
        });
    if (p.stdout && p.stdout.on) p.stdout.on('data', function (c) { stdout += String(c); });
    if (p.stderr && p.stderr.on) p.stderr.on('data', function (c) { stderr += String(c); });
    try { if (p.stdin && p.stdin.on) p.stdin.on('error', function () {}); } catch (e) {}
    p.stdin.write(script + '\r\nexit\r\n');   // core usa cmd + '\r\nexit\r\n'
    p.stdin.end();
    timer = setTimeout(function () {          // timeout MANUAL (shim ignora options.timeout)
        if (done) return; done = true;
        try { p.kill(); } catch (e) {}
        callback({ code: 'TIMEOUT', message: 'PowerShell timeout' }, stdout, stderr);
    }, 120000);
}
```

Pontos que o padrão do core ensina:
- **`exit\r\n` embutido** no fim do script (PowerShell `-Command -` lê stdin até EOF/exit).
- **Listeners `data` ANTES do write** — no shim, sem listener a pipe fica pausada
  (`ReadableStream.c:448-454`, dados retidos em `paused_data`).
- **Manter referência do child** até o exit (GC do Duktape finaliza processo vivo).
- `-Command -` + stdin é obrigatório porque o shim **não faz quoting** de args.

### 5.3 fs/path/child_process disponíveis no agente

`fs.existsSync` existe (implementado via `statSync` try/catch — usado para escolher
`Sysnative` vs `System32` no PowerShell 64-bit a partir de agente 32-bit).
`require('MeshAgent')` dá acesso ao host (`.SendCommand`, `.info._id`).

---

## 6. PowerShell dentro do agente

### 6.1 PS 5.1 é o piso — sintaxe PS7 quebra silencioso

**Bug real (v1.1.5):** handler com `$_ && $_.Exception ? a : b` (PS7) → **parse error não
mata o processo**: o PS 5.1 reporta no stderr, pula o body inteiro e executa o
`Write-Output` final com `$out` vazio → sentinela `[]` → handler interpretava como
"serviço não encontrado". Regras:

- Nunca usar `&&`, `||`, ternário `? :`, `Set-StrictMode` recente.
- `$ErrorActionPreference='SilentlyContinue'` + `try/catch` explícito **com captura do erro**
  (`$svcErr = $_.Exception.Message`) para diagnóstico real.

### 6.2 Execução e saída

```javascript
// PowerShell 64-bit a partir de agente 32-bit (Windows):
var sysnative = process.env['windir'] + '\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe';
var ps = fs.existsSync(sysnative) ? sysnative
       : (process.env['windir'] + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
```

### 6.3 Pipeline JSON com sentinela (runJson — v1.1.3+)

```javascript
var SENTINEL = '__SPJSON__';
var PS_HEAD = "$ErrorActionPreference='SilentlyContinue'; " +
    "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; ";

var script = PS_HEAD + body +
    "\n$__json = '[]'; if ($out) { $__json = @($out) | ConvertTo-Json -Depth 5 -Compress } " +
    "Write-Output ('" + SENTINEL + "' + $__json);";
```

Motivação de cada peça (todas nascidas de bugs reais):
- **Sentinela**: isola banners/ruído de profile no stdout.
- **`@()` em volta de `$out`**: `ConvertTo-Json` do PS 5.1 imprime **nada** para array vazio.
- **UTF-8 no head**: acentos corretos.
- **`[]` com stderr não-vazio = erro**: parse falhou no meio (ver §6.1) — antes a v1.1.5
  mascarava como `ok:true, []`.
- **Sentinela ausente = erro** com stdout/stderr anexados (diagnóstico no arquivo do agente).

### 6.4 Sanitização de parâmetros

```javascript
function q(s) {  // uso dentro de aspas simples PS: duplica aspas simples, remove controle
    return String(s == null ? '' : s).replace(/'/g, "''")
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}
```

Mais allow-list de ações no dispatcher do agente (`ALLOWED.indexOf(op) === -1 → 'DENIED'`)
e loop-guard (`pluginaction === 'agentResult' → return 'OK'`) para o agente nunca
processar a própria resposta.

---

## 7. Banco de dados

### 7.1 NeDB com fallback chain + recovery (padrão Tracer/ScriptTask)

```javascript
try { Datastore = require('@seald-io/nedb'); } catch (ex) {}
if (!Datastore) try { Datastore = require('@yetzt/nedb'); } catch (ex) {}
if (!Datastore) Datastore = require('nedb');
module.paths.push(path.join(meshserver.parentpath, 'node_modules'));  // resolução

obj.events = new Datastore({
    filename: meshserver.getConfigFilePath('plugin-usertracer-events.db'),
    autoload: true,
    corruptAlertThreshold: 0.5     // Tracer v3.5.93: default 10% causava crash-loop
});
obj.events.setAutocompactionInterval(300000);   // 5min: menos write contention
```

**Crash-loop de corrupção (Tracer v3.5.93):** restart abrupto durante compaction →
`11% of data file is corrupt > threshold (10%)` → NeDB recusa carregar → MeshCentral
morre em loop de 5s. Fix triplo: `corruptAlertThreshold: 0.5`, autocompaction 300s e
recovery path que deleta `.db`/`.db~` e reinicializa (flag `_nedbRecovered`).

### 7.2 TTL

```javascript
// NeDB
obj.events.ensureIndex({ fieldName: 'detectedAt', expireAfterSeconds: 90*24*3600 });
// MongoDB
obj.events.createIndex({ detectedAt: 1 }, { expireAfterSeconds: TTL_S });
```

### 7.3 Leitura sempre callback-style, escrita com try/catch interno

`db.Get(id, cb)` do MeshCentral devolve **array** (0..1 docs). Padrão Tracer: `addEvent`
captura erro internamente e loga — jamais deixa a exceção subir para o scanner
(mataria o `setInterval`).

---

## 8. Frontend

### 8.1 Tema MeshCentral (consistência visual)

```css
body { font-family: "Trebuchet MS",Arial; background: #d3d9d6; }
.header h1 { color: #003366; }
.badge.ok { background: #c8e6c9; color: #1b5e20; }
```

### 8.2 Acesso ao WebSocket dentro do iframe

```javascript
var ms = (typeof top !== 'undefined' && top.meshserver) ||
         (typeof parent !== 'undefined' && parent.meshserver) || window.meshserver;
```

### 8.3 Bug real: hook em cadeia de `onmessage` (Spooler device.handlebars)

O device view do Spooler encadeou **duas** vezes `ms.socket.onmessage = function...`
(segunda usa `prevHook = ms.socket.onmessage`). Funciona, mas o padrão do Tracer
(v3.5.54: "Triple WS execution") mostrou que encadear `onmessage` + `addEventListener`
+ pluginHandler executa mensagens 2-3×. Regra: **um único `addEventListener`** por view
e no-op stubs nas exports (§4.3).

### 8.4 Navegação para dispositivo (padrão validado no Tracer v3.5.4/v3.5.5)

```javascript
// parent.goDevice / postMessage NÃO existem — painel admin abre standalone.
if (nid.indexOf('node//') === 0) nid = nid.substring(6);
window.location.href = '/?viewmode=10&gotonode=' + encodeURIComponent(nid);
```

### 8.5 CSP: sem CDN, sem script externo

MeshCentral tem Content-Security-Policy restritiva. Toda dependência (vis.js, jQuery)
via CDN é bloqueada (Tracer v1.0.4). Inline `<script>` nos `.handlebars` é o caminho.

### 8.6 `textContent` é propriedade, não método

Bug real (Spooler v1.1.4): `$('webIp').textContent()` → `TypeError` silencioso no
handler do painel web. Nada escapa do básico.

---

## 9. Segurança

### 9.1 ACL nativa do MeshCentral (Tracer v3.5.83 — ADR-002)

Nunca reinventar permissão. Três camadas nativas:

```javascript
// 1. Direitos do node (GetNodeWithRights — webserver, com cache TTL 10s)
webserver.GetNodeWithRights(domain, user, nodeid, function (node, rights, visible) {
    var canSeeDetails = (rights & 0x00100000) === 0x00100000;  // MESHRIGHT_DEVICEDETAILS
});

// 2. RBAC do plugin (registerPermissions/getAccessPermissions)
obj.parent.getAccessPermissions('usertracer', user, { nodeid })
    .then(function (has) { if (!has('can_view_history')) { res.sendStatus(403); } });

// 3. Bypass explícito e antecipado para site-admin
if (user && (user.siteadmin === 0xFFFFFFFF || user.siteadmin === -1)) { /* render */ }
```

Aplicado em: `handleAdminReq` (401/403 antes do render), `_filterAccessibleNodeIds`
(filtra nodeIds antes de consultas), respostas WS (dado filtrado server-side —
frontend nunca decide permissão).

### 9.2 Sanitização em todas as camadas

| Camada | Risco | Defesa Spooler |
|---|---|---|
| frontend → server | nodeid/action forjada | switch fechado de `pluginaction`s |
| server → agente | params maliciosos | `q()` (escape PS) + validação de tipos (parseInt) + allow-list |
| agente → PS | injection em comando | aspas simples duplicadas, sem interpolação de input em flags |
| server → browser | XSS | `esc()` em toda interpolação HTML |

### 9.3 PII em logs (Tracer)

`_utRedactUser()`: `BKSSERVICES\fabiana` → `BKSSERVICES\f***a` nos logs de produção.
`[UT ERROR]` sempre ativo; resto gateado por `UT_DEBUG`.

---

## 10. Estudo de caso Spooler

Histórico completo de versões (cada uma com causa raiz e fix) — `changelog.md`:

| Versão | Bug | Causa raiz | Fix |
|---|---|---|---|
| 1.0.1 | crash loop no boot 5s | `obj.exports` listava hook sem implementar | remover do exports |
| 1.0.2 | inventário não carrega | switch sem `case 'inventory'` | case adicionado |
| 1.1.1 | agente ignora comandos | módulo `win-spooler.js` ≠ `command.plugin` | renomear p/ `spooler.js` |
| 1.1.2 | `consoleaction` undefined | sem `module.exports` | exportar |
| 1.1.3 | "JSON invalido" | pipeline vazio + ruído stdout | sentinela `__SPJSON__` + `@()` + UTF-8 |
| 1.1.4 | filas/painel web/link device quebrados | `$name` (PS) no JS; `textContent()`; `parent.goDevice` inexistente | fixes pontuais |
| 1.1.5 | "Spooler nao encontrado" genérico | PS7 syntax no PS5.1 + `[]` mascarado como ok | `psInfo`, erros com stderr |
| **1.1.6** | **todos os comandos vazios via agente** | **shim child_process do MeshAgent não é Node** | stream `data` + `exit\r\n` + timeout manual |
| 1.1.7 | discover timeout 2min | DNS reverso síncrono sem timeout | `BeginGetHostEntry` + `WaitOne(1500)` |
| **1.1.8** | **BSOD no cliente** | `Start-Job` × 254 = 254 processos PS simultâneos → kernel pool exaurido (driver HP/Epson) | TCP async, 1 processo |
| 1.1.9 | TCP não achava nada / pedido de método nativo | (ver 1.1.10) + falta de WSD/AD | modos wsd/ad/tcp |
| **1.1.10** | **TCP scan varria 0 IPs desde 1.1.8** | `$_` vazio em `foreach` (é variável de *pipeline*!) → IP = `"192.168.0."` ; `WaitAll` abortava com task faulted; auto-detect pegava vEthernet Hyper-V | `$i`; try/catch no WaitAll; rota default |
| **1.1.11** | só IP na descoberta | falta enriquecimento | IPP/IPPS/PJL/HTTP → model, printerName, firmware |

### Lições condensadas

1. **Diferença foreach vs pipeline no PowerShell**: `foreach ($i in 1..254) { "$range.$_" }`
   gera `"192.168.0."` — `$_` só existe em `ForEach-Object`/pipeline. Classico.
2. **Flood de processos é inaceitável em agente de gerência**: `Start-Job` = 1 processo PS
   por job. Qualquer loop `1..N` com Start-Job é uma bomba em máquina de cliente.
   Substituto: sockets async (`ConnectAsync`) + `Task.WaitAll` **com try/catch**
   (AggregateException quando alguma task faulta).
3. **Auto-detect de interface**: `Get-NetIPAddress | Select -First 1` pega vEthernet
   (Hyper-V/WSL). Correto: interface da rota default:
   ```powershell
   $ips = Get-NetIPAddress -AddressFamily IPv4 | Where { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' -and $_.InterfaceAlias -notlike '*vEthernet*' }
   $defaultIf = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort RouteMetric | Select -First 1).InterfaceAlias
   $ip = ($ips | Where { $_.InterfaceAlias -eq $defaultIf } | Select -First 1).IPAddress
   ```
4. **Sempre instrumentar antes de teorizar**: a v1.1.5 (`psInfo` + logs com stdout.len/stderr)
   transformou "não funciona" em "exit 0, stdout.len=0 em 130ms" — que apontou direto
   para o §5.

---

## 11. Estudo de caso Tracer

### 11.1 Scanner de usuários (diff de estado)

O MeshCentral já coleta `doc.users` (logados) e `doc.lusers` (com sessão bloqueada) do
agente — o Tracer **não** consulta o agente: faz diff a cada 30s (`scanNow` → `checkNode`):

```javascript
// detect LOGIN/LOGOUT/LOCK/UNLOCK por transição de estado (usertracer.js:297-344)
currentUsers.forEach(function (u) {
    if (prevUsers.indexOf(u) === -1) {
        var wasLocked = prevLusers.indexOf(u) >= 0;
        obj.storeEvent(nodeid, nodeName, u, wasLocked ? UT_EVENT.UNLOCK : UT_EVENT.LOGIN);
    }
});
```

Detalhes que evitam eventos falsos:
- **Bounce de agente**: primeiro scan pós-reconexão não gera LOGIN se `lastconnect < 2min`
  (v3.5.x #4).
- **Debounce** de 2s nos hooks (`_pendingCheck[nid]`) e stop/start order em
  `server_startup` (v3.5.91: `stopScanner()` setava `_stopped` depois do `startScanner`
  checar → timer nunca criado).
- **Hot-reload safe**: `clearInterval` + `_stopped` + cleanup de debounces
  (`setInterval` sem unref mantém o processo vivo — usar `.unref()`).

### 11.2 Live state: 3 fontes de verdade

`ADR-001-live-state-source.md` (Tracer/analysis) compara: (A) `wsagents` runtime,
(B) round-trip ao agente, (C) cache de `agentInfo.users`, (D) híbrido. Implementado:
A + DB (`doc.pwr`, `doc.conn`) com TTL 5min no cache `devicePower` (#15).

### 11.3 Gantt/WS: as races clássicas

- Response de request antigo sobrescreve view atual → `_reqSeq` (v3.5.54) + `_ganttOwner`
  (v3.5.92) + descarte de `_inflight` morto (v3.5.95).
- Sessões atravessando meia-noite: clamp `start/end` ao range visível (v3.5.82/64).
- Status "Bloqueado" vs "Online": `_activeUsers` + `_activeLusers` no response +
  `liveState()` que re-resolve trailing segments (v3.5.94).

### 11.4 Testes do Tracer (~67, `node --test` nativo)

`tests/_helpers/mock-meshcentral.js` (factory `buildMock()`) + `view-runner.js`
(extrai `<script>` do handlebars e roda em `vm` com DOM fake). Cobertura que pegou
bugs reais: `_getSessionUser` (17), hooks debounce (14), `storeEvent` (18),
`loadTimeline` regressão ReferenceError (12), fluxo scanner (8), startup (8).

---

## 12. Descoberta de impressoras

### 12.1 O que cada protocolo rendeu (bench real: HP M426dw + EPSON L5590)

| Protocolo | HP | Epson | Observações |
|---|---|---|---|
| WSD (UDP 239.255.255.250:3702) | — | — | **zero respostas** mesmo com probe genérico — AP bloqueia multicast |
| mDNS/Bonjour (5353) | — | — | idem |
| SSDP/UPnP (1900) | — | — | idem |
| TCP 9100 (RAW) | ✅ | ✅ | detecção de presença barata |
| **IPP 631 plano** | ✅ 200 + atributos | ❌ 426 Upgrade Required | `printer-make-and-model`, `printer-name`, firmware |
| **IPPS 631 (TLS, cert ignorado)** | — | ✅ 200 + atributos | Epson exige TLS (`SslStream` com callback `{ $true }`) |
| PJL INFO ID (9100) | ✅ `"HP LaserJet MFP M426dw"` | ❌ | nome oficial, 900ms |
| HTTP :80 `<title>` | ✅ (com `&nbsp;` sujo) | ❌ redirect HTTPS | fallback |
| SNMP v2c GET (161) | ❌ | ❌ | desativado em ambas |
| AD LDAP `objectClass=printQueue` | — | — | ~1,5s, achou 0 (sem print server publicado) |

### 12.2 Payload IPP mínimo validado (Get-Printer-Attributes 1.1)

```powershell
# versão(2) op(2=0x000B) reqid(4) op-attr-tag(0x01)
# attributes-charset / natural-language / printer-uri / end(0x03)
1.1 | 0x000B | 0x00000001 | 0x01 | 0x47 'attributes-charset' 'utf-8'
   | 0x48 'attributes-natural-language' 'en' | 0x45 'printer-uri' "ipp://IP:631/ipp/print" | 0x03
```

POST HTTP/1.1 `Content-Type: application/ipp`. Resposta: binário IPP; extração **pela
struct** (não regex!): localizar bytes do nome do atributo → os próximos 2 bytes são o
`value-length` (big-endian) → valor é `GetString(bytes, pos, len)`.

**Armadilha do parse:** depois do nome do atributo NÃO há byte 0x00 extra — o `0x00`
que se vê é o high byte do value-length (valores <256). Pular esse byte desloca tudo
em 1 (sintoma: `"PSON L5590"` / `"P LaserJet"`) e faz o length ler lixo (sintoma:
`"SeriesE\u0000\u0011printer-more-info..."`).

### 12.3 printer-name inútil em firmware simples

Epson ecoa o path da URI: `printer-name = "ipp/print"`. Filtrar
`^(ipp|ipps|print|ipp\/print)$` e cair para `model` → mDNS name → hostname.

### 12.4 Arquitetura do discover (v1.1.9+)

```
mode=wsd (padrão)  → 1 pacote multicast Probe, loop Receive com deadline total
mode=ad            → DirectorySearcher('(objectClass=printQueue)'), PageSize 500
mode=tcp (fallback)→ ConnectAsync 9100 para 1..254 (UM processo PS, zero Start-Job)
                     → Task.WaitAll(timeout, try/catch) → enriquecimento IPP/IPPS/PJL/HTTP
```

---

## 13. Testes

### 13.1 Padrão Tracer: `node --test` nativo, zero dependências

```javascript
// tests/unit/storeEvent.test.js (trecho real do Tracer)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMock } = require('../_helpers/mock-meshcentral.js');
// carrega o plugin com parent mockado e exercita serveraction/hooks
```

- `buildMock()`: webserver com `wssessions2`/`wsagents`/`GetNodeWithRights`, DB fake,
  captura de mensagens enviadas.
- `view-runner.js`: sandbox `node:vm` com DOM shim para testar o `<script>` inline
  dos views (pegou o `loadTimeline is not defined` v3.5.87).
- Rodar: `node --test tests/` (Node ≥18).

### 13.2 Spooler: validação de scripts PS fora do agente

Como o agente exige deploy pesado para testar, o fluxo eficaz (usado nas v1.1.9-1.1.11):

```javascript
// extract-script.js: carrega o módulo do agente com runPS stubado,
// dispara o handler e salva o script PS gerado em disco
const srcPatched = src.replace(/function runPS\(script, callback\) \{[\s\S]*?\n\}/,
  'function runPS(script, callback) { captured.script = script; callback(null, "__SPJSON__[]", null); }');
// depois: o .ps1 gerado roda direto em powershell.exe local com os IPs reais
```

Isso pegou: `$_` vazio no foreach, AggregateException do WaitAll, offset do parse IPP
(duas vezes), lixo de tags no regex — **tudo antes de tocar em qualquer cliente**.

### 13.3 Production behavior pins

Testes com comentários "pinando" comportamento observado em produção (Tracer) evitam
regressões silenciosas quando alguém "simplifica" o código depois.

---

## 14. Depuração em produção

### 14.1 Logs estruturados (mesmo padrão nos 2 plugins)

```javascript
var SP_LOG = {   // idêntico ao UT_LOG do Tracer
    error: function (ctx, err, extra) { /* sempre ativo, stack se debug */ },
    info:  function () { if (!SP_DEBUG) return; /* ... */ },
    debug: function () { if (!SP_DEBUG) return; /* ... */ },
    raw:   function () { if (!SP_DEBUG) return; /* ... */ }
};
```

### 14.2 Debug agent-side em arquivo

```javascript
// ligável remotamente: serveraction 'setDebug' {value:'true'} → grava spooler-plugin.txt
function splog(str) { if (spDebugFlag !== true) return; /* fs.appendStream */ }
function sperr(str) { /* SEMPRE grava: erros + 1 linha de boot */ }
```

A linha de boot (`spooler module loaded (debug=false)`) confirma que o agente pegou o
core novo — indispensável depois de mudar `modules_meshcore/`.

### 14.3 Fluxo de diagnóstico que funcionou (caso v1.1.6)

```
1. Server log: agentResult ok=false error=PS sem resposta → instrumentar agente
2. setDebug on → spooler-plugin.txt: runJson stdout.len=0 stderr=null err=null (~130ms)
3. Reproduzir local (Node real): funciona → o ambiente do agente é diferente
4. Ler código-fonte do MeshAgent (ILibDuktape_ChildProcess.c) → callback 'exit' sem stdout
5. Fix no padrão do core (meshcore.js:1512) → validação local → deploy → green
```

---

## 15. Checklist de revisão de plugin

**Empacotamento**
- [ ] `shortName` = nome da fábrica exportada = nome do `.js` server = pasta
- [ ] `modules_meshcore/<shortName>.js` (SEM prefixo win-/linux-)
- [ ] `module.exports = { consoleaction: consoleaction }` no módulo do agente
- [ ] `downloadUrl` aponta para ZIP limpo (não para o archive do repo)
- [ ] bump de versão em `config.json` **e** entrada no changelog

**Agente**
- [ ] `consoleaction` com guard `args.plugin !== '<sn>'` + loop-guard de agentResult
- [ ] allow-list de pluginactions
- [ ] `runPS` no padrão do core (streams + exit\r\n + timeout manual + ref viva)
- [ ] Scripts PS 100% 5.1 (sem `&&`/`||`/ternário; `$_` só em pipeline)
- [ ] `q()` em todo parâmetro interpolado em comando PS
- [ ] splog/sperr com boot line

**Server**
- [ ] correlação reqid com timeout e limpeza
- [ ] ACL server-side (`GetNodeWithRights`/`getAccessPermissions`) antes de qualquer dado
- [ ] auditoria de operações destrutivas
- [ ] stop/cleanup de timers no reload (`unref()` nos intervals)

**Frontend**
- [ ] 1× `addEventListener('message')`; stubs no-op em `obj.exports` para cada `method`
- [ ] `_reqSeq` em toda requisição com response ordenável
- [ ] `esc()` em toda interpolação HTML; `textContent` sem parênteses
- [ ] navegação de device via `/?viewmode=10&gotonode=`

---

## 16. Bibliografia

### Código-fonte analisado (primário)

| Fonte | Uso neste doc |
|---|---|
| [Ylianst/MeshCentral — pluginHandler.js](https://github.com/Ylianst/MeshCentral/blob/master/pluginHandler.js) | §1-3: carregamento, hooks, RBAC, isValidConfig |
| [Ylianst/MeshCentral — webserver.js](https://github.com/Ylianst/MeshCentral/blob/master/webserver.js) | §1.3: rotas pluginadmin (6895-6920, 7463-7467), troca de views dir |
| [Ylianst/MeshCentral — agents/meshcore.js](https://github.com/Ylianst/MeshCentral/blob/master/agents/meshcore.js) | §5.2: padrão PowerShell (linha ~1512), handleServerCommand |
| [Ylianst/MeshCentral — agents/modules_meshcore/](https://github.com/Ylianst/MeshCentral/tree/master/agents/modules_meshcore) | módulos core embutidos no agente |
| [Ylianst/MeshAgent — microscript/ILibDuktape_ChildProcess.c](https://github.com/Ylianst/MeshAgent/tree/master/microscript) | §5: execFile/callback exit/stdin WritableStream/finalizador GC |
| [Ylianst/MeshAgent — microstack/ILibProcessPipe.c](https://github.com/Ylianst/MeshAgent/tree/master/microstack) | §5: pipes Win32, CREATE_NO_WINDOW, sem quoting |
| [Ylianst/MeshAgent — microscript/ILibDuktape_fs.c](https://github.com/Ylianst/MeshAgent/tree/master/microscript) | §5.3: existsSync via statSync |

### Plugins da comunidade estudados

[ScriptTask](https://github.com/Ylianst/MeshCentral/tree/master/plugins), EventLog, RegEdit,
DevTools, Sample, PluginHookExample/Scheduler, Agentname2Servername,
[PrinterControl](https://github.com/Ylianst/MeshCentral-Plugins) — padrões de DB,
reqid, RBAC, sendToAgent, com module paths em `<datapath>/plugins/`.

### Especificações de protocolo

- [RFC 8011 / IPP 1.1](https://datatracker.ietf.org/doc/html/rfc8011) — Get-Printer-Attributes,
  struct attribute (`value-tag | name-len | name | value-len | value`), operation 0x000B.
- [WS-Discovery (OASIS 2005)](https://docs.oasis-open.org/ws-dd/discovery/1.1/os/discovery-1.1-spec-os.html) — Probe multicast 239.255.255.250:3702; types `prt:PrintDeviceType`
  ([MS-WSDPrint](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-wsdprint/)).
- [RFC 2910/2911 (IPP 1.0/1.1 original)](https://datatracker.ietf.org/doc/html/rfc2910) ·
  [Bonjour printing](https://developer.apple.com/bonjour/printing-specification/bonjourprinting-1.2.1.pdf) — `_ipp._tcp.local`, `_uscan._tcp`.
- PJL (Printer Job Language) — `@PJL INFO ID`, USTATUS; referência HP
  ([HP PJL Technical Reference](https://h10032.www1.hp.com/ctg/Manual/bpl13210.pdf)).

### Docs internos do projeto

- `MESHCENTRAL-PLUGIN-GUIDE.md` (Tracer) — guia de 1650 linhas, base deste doc.
- `Tracer/analysis/` — `ADR-001-live-state-source.md`, `ADR-002-acl-native.md`,
  `FLUXOS-E2E.md` (9 diagramas), `HOOKS-CATALOG.md`, `PERGUNTA-RESPOSTA-NATIVA.md`
  (FAQ de 40+ perguntas), `STUDY-user-online-state.md`.
- `Tracer/meshcentral-core/WEBSERVER_ANALYSIS.md` — análise de 1702 linhas do webserver.js.
- `Spooler/changelog.md` — 11 versões com causa raiz documentada.

### Ferramentas citadas

`node --test` (Node ≥18), Advanced IP Scanner, nmap, MeshCentral v1.x em produção
(Windows Server, 12+ agentes), PowerShell 5.1 (bench local com HP LaserJet MFP M426dw
e EPSON L5590 Series).

---

> **Última atualização:** 2026-10-06, junto com Spooler v1.1.11.
> Manter este documento junto do changelog: cada bug novo = nova linha em §10/§11 + lição.
