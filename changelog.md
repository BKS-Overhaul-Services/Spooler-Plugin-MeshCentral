# Changelog — Spooler Plugin MeshCentral

## 1.1.4 (2026-10-06)
### Fixed
- **Filas nunca carregavam** (`modules_meshcore/spooler.js:getJobs`): referência `$name` (variável PS) no código JS em vez de `name` → `ReferenceError` matava o handler inteiro antes de responder. Fix: usar `name` (JS) na interpolação da string do script.
- **Painel web não renderizava** (`views/device.handlebars:renderWebPanel`): `$('webIp').textContent()` chamado como função — `textContent` é string, não método → `TypeError` após resposta bem-sucedida do agente. Fix: propriedade sem parênteses.
- **Link "Abrir dispositivo" do painel admin era no-op** (`views/admin.handlebars:openDevice`): usava `parent.goDevice`/`postMessage` que não existem no MeshCentral (painel abre standalone via `/pluginadmin.ashx?pin=spooler`). Fix: navegação padrão validada no Tracer (v3.5.4/v3.5.5) — `/?viewmode=10&gotonode=<id>` com strip do prefixo `node//`.

## 1.1.3 (2026-10-06)
### Fixed
- **Plumbing PowerShell→JSON reescrito** (`modules_meshcore/spooler.js`):
  - Protocolo sentinela `__SPJSON__`: resposta isolada de banners/ruído do stdout.
  - UTF-8 (`[Console]::OutputEncoding`) em todos os scripts — acentos corretos.
  - Pipeline vazio → `[]` (`ConvertTo-Json` do PS 5.1 não imprime nada para `@()` vazio — causa do "JSON invalido" no listDrivers).
  - Erros incluem `stderr` real (exit code + 300 chars) em vez de mensagem genérica.
  - Handlers JSON (`runJson`) e textuais (`runText`) unificados; mensagens de erro 100% ASCII (stdin do agente não garante UTF-8).
  - `spoolerStatus`/`webPanel` agora validam objeto vazio e retornam erro explícito.

## 1.1.2 (2026-10-06)
### Fixed
- **Agente achava o módulo mas não a função** (`modules_meshcore/spooler.js`): dispatcher do core chama `require('spooler').consoleaction(...)` — função era declarada solta, sem export → `TypeError: undefined not callable (property 'consoleaction')` a cada comando. Fix: `module.exports = { consoleaction: consoleaction };` (padrão do printercontrol).

## 1.1.1 (2026-10-06)
### Fixed
- **CRÍTICO — agente não recebia comandos** (`modules_meshcore`): módulo nomeado `win-spooler.js`, mas o dispatcher do core do agente procura o módulo pelo `command.plugin` (`spooler`) → `Module: spooler (NOT FOUND)` no `handleServerCommand()` do agente e nenhuma resposta ao servidor. Renomeado para `spooler.js` (sem prefixo — mesmo padrão do plugin comunitário printercontrol; guarda `process.platform === 'win32'` já existente protege Linux). Requer restart do MeshCentral para regenerar cores + reconexão dos agentes.

## 1.1.0 (2026-10-06)
### Added
- **Debug estruturado padrão Tracer**:
  - Server-side (`spooler.js`): `SP_DEBUG` flag + categorias `SP_LOG.error` (sempre ativo, com stack se debug), `.info`, `.debug`, `.raw` (gateados). Logs instrumentados em: startup, serveraction (entrada/from=AGENT|frontend), agentRequest, agentResult, sendToAgent, send, audit, handleAdminReq, timeout de reqid.
  - Agent-side (`win-spooler.js`): `spDebugFlag` (padrão false) gateia `splog()` no arquivo `spooler-plugin.txt`. `sperr()` grava sempre (erros + 1 linha de boot). Debug agent-side ligável via `pluginaction:'setDebug'` com `params.value='true'` (padrão Tracer setDebug).

## 1.0.2 (2026-10-06)
### Fixed
- **Inventário não carregava** (`spooler.js`): frontend envia `pluginaction:'inventory'`, mas o switch do server só aceitava `getPrinters` → "unknown pluginaction=inventory". Adicionado case `inventory`.

## 1.0.1 (2026-10-06)
### Fixed
- **Crash no boot do MeshCentral** (`spooler.js`): `obj.exports` listava `onWebUIStartupEnd` sem implementação → `TypeError: Cannot read properties of undefined (reading 'toString')` no `prepExports` do pluginHandler (pluginHandler.js:78), com crash loop a cada 5s. Removido do exports.

## 1.0.0 (2026-10-06)
- Primeira versão.
- CRUD de impressoras remotamente via agente MeshCentral (Windows):
  - Inventário (`Get-Printer` + porta TCP associada)
  - Adicionar impressora TCP/IP (IP, porta, driver, compartilhamento, padrão)
  - Excluir (com opção de remover porta livre)
  - Renomear, definir padrão, pausar/retomar
  - Configuração avançada (compartilhamento, share name, prioridade, driver, porta, trabalhar offline)
- Descoberta de impressoras de rede via SNMP ping (auto-detecção de sub-rede, instalação em lote).
- Filas de impressão: listar jobs, pausar/retomar/reiniciar/cancelar job, limpar fila.
- Controle do serviço Print Spooler (status/start/stop/restart).
- Página de teste remota.
- Listagem de portas e drivers (com exclusão de porta livre).
- Painel web da impressora (proxy HTTP via agente, scripts sanitizados).
- Auditoria de operações (NeDB) por dispositivo e global.
- Catálogo cacheado no servidor (NeDB) com visão consolidada no painel admin.
- Aba por dispositivo Windows ("Impressoras") + painel admin global.
