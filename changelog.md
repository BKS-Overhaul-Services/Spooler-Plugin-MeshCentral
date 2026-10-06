# Changelog — Spooler Plugin MeshCentral

## 1.1.15 (2026-10-06)
### Added
- **Worker PS persistente no agente** (modules_meshcore/spooler.js): 1 processo PowerShell vivo desde o boot; comandos entram via stdin (1 linha JSON `{id, body}`) e saem com sentinela `__SPW__{id, ok, result, error}`. Elimina o spawn (0,5-2s) de TODA operação. Health check 60s (ping), watchdog 90s por comando (mata worker wedgado; exit handler faz restart com backoff, máx 5), fallback transparente para `runJson` spawn-único se o worker estiver down. Todos os handlers JSON (`inventory`, `listDrivers`, `listPorts`, `discover`, `spoolerStatus`, `webPanel`, `psInfo`) agora passam pelo worker via `workerRun()`. Validado com impressoras reais: 3 comandos (ping/summary/getStatus) num único processo, granular respondeu em ~200ms.
- **Queries granulares**: `getPrinter name=X` (1 impressora, mesma shape do inventory), `getStatus name=X` (default/status/workOffline/jobCount — para polling), `summary` (todas impressoras sem portInfo + status do spooler — ~3x mais leve que inventory).
- **Cache delta server-side** (spooler.js): `obj.cache[nodeid] = { hash, printers, spooler, ts }`; hash djb2 de `JSON(printers)+spooler`. Novo pluginaction `getDelta {hash}`: se hash bate → resposta `unchanged:true` (~200 bytes); senão pede `summary` ao agente via worker, atualiza cache e responde com payload + hash novo. Mutação concluída invalida o cache do node (próximo delta refetcha — usuário vê impressoras adicionadas/removidas por outros).
- **Frontend: polling delta 7s** (views/device.handlebars): `setInterval` 7s só com documento visível (`document.hidden` = skip) e sem fetch em voo; 1ª carga usa `getDelta hash=null` (server devolve summary completo); `applyDelta` atualiza badges de status/jobCount na tabela existente via `data-prn-status` (re-render completo só na 1ª carga ou mudança estrutural).

### Notes
- Custo por poll com cache quente: **~200 bytes de WS** (unchanged). Com mudança: 1 worker query (~200-400ms no cliente, sem spawn). Mutação: 1 WS extra para invalidar.
- `Invoke-Expression` no worker executa apenas bodies gerados pelo próprio agente (params sanitizados por `q()` antes) — superfície de ataque equivalente ao spawn anterior.
- Requer restart do MeshCentral + reconexão dos agentes.

## 1.1.14 (2026-10-06)
### Added
- **Cadeia de ações: fila serial + resposta em 2 fases + verificação pós-operação** (modules_meshcore/spooler.js):
  - **Fila de mutações** (`MUTATION_OPS`/`queueMutation`/`processQueue`): `addPrinter`, `deletePrinter`, `setDefaultPrinter`, `setPrinterConfig`, `pause/resume`, `deletePort`, `jobAction`, `clearQueue`, `spoolerAction` e derivados agora executam **1 por vez** no agente — cliques rápidos não spawnam mais PowerShell simultâneo (o spooler do Windows serializa na driver store; paralelismo só gerava trava + PS acumulado = "spam"). Leituras (inventory/listDrivers/...) continuam paralelas, fora da fila.
  - **Resposta em 2 fases**: o agente responde imediatamente `phase:'started'` (mutação aceita na fila) e depois `phase:'done'` com o resultado. O frontend usa `started` para atualizar o status do dialog ("Na fila do agente — executando...") sem destravar nada. Server mantém o `pending` aberto entre as fases (timeout de mutação estendido para 4min — driver stage + fila).
  - **Verificação pós-ação na cadeia PS** (`addPrinter`): após `Add-Printer`, poll de `Get-Printer` a cada 1,5s por até 30s — só retorna `ok` quando a fila de impressão está **realmente consultável** (o retorno do `Add` não garante o fim do stage do driver).
- Teste da fila (Node, stub de `runPS` + `mesh` fake): 3 mutações simultâneas → 3 `started` imediatos + 3 `done` serializados em ~1,5s (3×500ms). PASS.

### Fixed
- **"Timeout: agente não respondeu" em mutações**: era a corrida entre o `Add-Printer` lento (15-120s) e os timeouts de 120s (runPS do agente e reqid do server). Agora: started chega em <1s (feedback), done tem 4min de janela, e a fila elimina a competição entre mutações que era a principal causa de lentidão.

### Notes
- Requer **restart do MeshCentral + reconexão dos agentes** (mudou `modules_meshcore/`).
- Server-side: `MUTATION_SERVER_OPS` espelha a lista do agente para o timeout diferenciado; `phase:'started'` não consome o pending.

## 1.1.13 (2026-10-06)
### Fixed
- **Spam de requisições idênticas ao agente** (views/device.handlebars): o frontend repetia `inventory`/`spoolerStatus`/`listDrivers`/`listPorts` várias vezes seguidas — cada uma spawnava PowerShell no cliente (~1-2s CPU). Causas: (1) `switchTab` recarregava a aba em **todo clique**; (2) `refreshInventory()` chamado em cadeia por cada mutação (add→refresh, delete→refresh...); (3) sem guard de requisição em voo. Fix: guard `_ops[op]` nos loaders (`skip dup`), auto-load de aba só na 1ª ativação (`_tabLoaded`) e debounce de 300ms no `refreshInventory` (mutações em sequência = 1 fetch).

## 1.1.12 (2026-10-06)
### Fixed
- **Instalação sem feedback** (views/device.handlebars): `Add-Printer` com driver real leva 10-60s (stage do driver pelo spooler — medido 15,5s com EPSON L5590), mas o dialog de instalação não mostrava estado e o `doAddPrinter` fechava antes do resultado. Agora: dialog mostra "Instalando... (pode levar até 60s)" com botão desabilitado; **sucesso** fecha o dialog + toast com o nome da impressora; **erro** destrava o dialog e mostra a mensagem dentro dele (permite tentar de novo sem refazer o discovery).
- **Instalação em lote sem progresso** (`installSelected`): agora mostra "Instalando N/M (ok: X, falha: Y)" no `discInfo` durante o lote e toast final com o resumo. Server ecoa flag `_batch` nas respostas (normal, erro imediato e timeout) para o contador não travar.

### Notes
- Medição local: `Add-PrinterPort` ~2s; `Add-Printer` com driver EPSON L5590 = 15,5s. O timeout do `reqid` (2min) cobre bem, mas o usuário precisava saber que está rodando.

## 1.1.11 (2026-10-06)
### Added
- **Enriquecimento de descoberta via IPP/IPPS** (`modules_meshcore/spooler.js:discover`): para cada host com 9100 aberta, cascade de identidade — (1) IPP `Get-Printer-Attributes` plano na 631 `/ipp/print`; (2) IPPS (TLS com validação de cert desativada) quando o device exige upgrade (ex: Epson IPP-Server responde 426); (3) PJL `INFO ID` na 9100; (4) HTTP `<title>` na 80. Parsing IPP real (struct `tag | nameLen | name | valueLen(2 BE) | value`) extraindo `printer-make-and-model`, `printer-name` e `printer-firmware-string-version` pelo comprimento exato — sem heurística de regex. Validado com 2 impressoras físicas: EPSON L5590 Series (via IPPS) e HP LaserJet MFP M426dw (via IPP, + printerName NPI3E0611A + firmware 20201022). Resultado do discover agora inclui `model`, `printerName`, `firmware`, `modelSource` (ipp|ipp-name|pjl|http).
- **Frontend do discover** (views/device.handlebars): card com **modelo em destaque** + badge da fonte (IPP/PJL/HTTP) + fila + firmware; `bestPrinterName()` com precedência `model > printerName (se não for path de fila: ipp/print etc.) > hostname > IP`; dialog "Instalar" e instalação em lote pré-preenchem o nome com o melhor nome disponível.

### Notes
- `printer-name` IPP de firmwares simples (Epson) ecoa o path da URI (`ipp/print`) — filtrado pelo regex `^(ipp|ipps|print|ipp\/print)$`. O nome real da Epson existe no mDNS (EPSONE78D7B), não no IPP.
- Custo do enriquecimento: ~2-3s por host achado (IPP 2,5s connect + resposta; TLS só quando necessário; PJL espera 900ms). Scan completo em bench: 14,6s para 2 impressoras.
- Descoberta WSD/AD inalterada. TCP continua fallback (mas agora é o único que funciona quando multicast está bloqueado no AP — caso comum).

## 1.1.10 (2026-10-06)
### Fixed
- **CRÍTICO — TCP scan nunca achava nada desde a v1.1.8** (`modules_meshcore/spooler.js:discover`): dentro de `foreach ($i in 1..254)`, o gerador de IP usava `$_` (variável de pipeline, vazia em `foreach`) em vez de `$i` → todos os 254 "IPs" viravam `192.168.0.` (inválido) → 1 task faulted, 0 resultados. Fix: `$_` → `$i`.
- **`Task.WaitAll` abortava quando alguma task faultava**: com 254 sockets, qualquer exceção assíncrona lançava `AggregateException` e o código nunca coletava as portas abertas. Fix: `try/catch` ao redor do `WaitAll` (status `RanToCompletion` é checado task a task depois).
- **Auto-detect de sub-rede pegava interface errada**: `Get-NetIPAddress | First 1` escolhia vEthernet (Hyper-V) em vez da interface real. Fix: usa a interface da **rota default** (`Get-NetRoute 0.0.0.0/0`), filtrando vEthernet/Loopback/APIPA. Validado em máquina multi-interface: escolhe Wi-Fi `192.168.0.78` corretamente.

### Notes
- Validação em rede real com HP LaserJet MFP M426dw (192.168.0.182) + segundo dispositivo (192.168.0.12): **2/2 encontrados em ~10s**.
- Diagnóstico da rede do bench: WSD/SSDP/mDNS não respondem mesmo com probe genérico (multicast bloqueado no AP) — para esses ambientes, TCP corrigido é o caminho. Impressora responde também em IPP 631 (futuro: porta de impressão IPP).

## 1.1.9 (2026-10-06)
### Added
- **Descoberta sem varredura de rede** (`modules_meshcore/spooler.js:discover`): novo parâmetro `mode` com 3 estratégias:
  - **`wsd`** (padrão): WS-Discovery — o mesmo protocolo multicast (UDP 239.255.255.250:3702) que o wizard "Adicionar impressora" do Windows usa. 1 pacote Probe, respostas em ~5-10s, zero flood. Retorna IP + XAddrs de cada PrintDeviceType.
  - **`ad`**: printQueue publicados no Active Directory via LDAP (System.DirectoryServices, sem RSAT). Lista impressoras compartilhadas por print servers do domínio: nome, servidor, local, driver, UNC.
  - **`tcp`**: fallback — varredura TCP 9100 da v1.1.8 (1 processo, sockets async), rebaixada a último recurso.
- **UI do discover reescrita** (views/device.handlebars): seletor de modo com hint contextual por estratégia; render dedicado por formato (tabela AD, cards WSD com XAddrs, cards TCP com botão instalar); mensagens de vazio orientando alternativas.

### Notes
- Motivação: TCP scan não achava impressoras em ambientes com VLANs/firewall e o usuário pediu alternativa nativa. WSD é o mesmo mecanismo do próprio Windows; AD é a fonte oficial em domínio.
- Validado em PS 5.1: WSD ~7,8s (0 impressoras no bench, sem WSD habilitado), AD ~1,5s (0 printQueue no domínio BKSSERVICES — esperado, sem print server publicado).
- Em ambientes sem WSD/AD, o TCP 9100 continua disponível como fallback manual.

## 1.1.8 (2026-10-06)
### Security / Fixed
- **CRÍTICO — descoberta SNMP causava BSOD em produção** (`modules_meshcore/spooler.js:discover`): o desenho anterior usava `Start-Job` dentro de `1..254` — no PS 5.1 cada job é um **processo `powershell.exe` novo** → 254 processos simultâneos (~50-100MB commit cada) + 254 sockets UDP num instante. Em cliente com driver HP/Epson isso exauriu recursos de kernel e dero **tela azul (bugcheck real)**. Reescrito **sem criar nenhum processo extra**: TCP `ConnectAsync` na porta 9100 (RAW printing — presente em praticamente toda impressora de rede) com 254 sockets async **num único processo PS**, `Task.WaitAll` com teto de 8s, DNS reverso com timeout 1,5s só nos hosts achados. Medido em bench: 1 processo PS, ~4s total, carga desprezível. Timeout por conexão agora limitado a 500-2000ms (era 200-5000ms).
- **UI do discover** (views): rótulo atualizado de "SNMP" para "procura por porta RAW 9100" — a descoberta não usa mais SNMP.

## 1.1.7 (2026-10-06)
### Fixed
- **Descoberta SNMP dava timeout (2 min)** (`modules_meshcore/spooler.js:discover`): reverse DNS (`Dns.GetHostEntry`) era síncrono e sem timeout por IP encontrado — em rede AD sem DNS reverso, cada lookup trava 5-10s; com N dispositivos achados, estourava o timeout do `runPS`. Fix: `BeginGetHostEntry` + `WaitOne(1500)` — no máx 1,5s por IP, hostname fica `null` quando não resolve (medido: 2 IPs sem DNS = 4,6s total; antes travava o processo).

## 1.1.6 (2026-10-06)
### Fixed
- **CRÍTICO — `runPS` não capturava stdout no agente** (`modules_meshcore/spooler.js`): o `execFile` do MeshAgent **não é o do Node.js** — é shim em C/Duktape (`ILibDuktape_ChildProcess.c`) onde o callback é o evento `exit` com assinatura `(exitCode, signal)`, **sem** `(error, stdout, stderr)`. Resultado: todo comando PS rodava (~130ms, exit 0) e devolvia stdout vazio/null → "PS sem resposta: sentinela ausente" em TODOS os handlers (inventory, spoolerStatus, psInfo...). Local em Node real funcionava — por isso nunca reproduziu no bench. Fix seguindo o padrão do próprio core do MeshCentral (`agents/meshcore.js:1512`): acumular saída via `p.stdout.on('data')`/`p.stderr.on('data')` + embutir `exit\r\n` no fim do script + timeout manual (o shim ignora `options.timeout`/`maxBuffer`) + manter referência do child até o exit (GC mata processo vivo).

### Notes
- Fonte da análise: código-fonte do MeshAgent (Ylianst/MeshAgent, `microscript/ILibDuktape_ChildProcess.c` + `microstack/ILibProcessPipe.c`) e do MeshCentral (`agents/modules_meshcore/child_process-min.js`, `agents/meshcore.js`).
- Outras limitações do shim documentadas: sem quoting de args (por isso `-Command -` via stdin), `p.stdin.end()` suportado, listeners `data` precisam existir antes dos dados chegarem.
- Requer restart do MeshCentral + reconexão dos agentes (mudou `modules_meshcore/`).

## 1.1.5 (2026-10-06)
### Added
- **Handler `psInfo`** (agente): diagnóstico do ambiente PowerShell no cliente — versão PS, Language Mode (detecta CLM), usuário do processo, 64-bit, PSHOME, status/erro do `Get-Service Spooler`, contagem de `Get-Printer`/`Get-PrinterPort` (cada um com erro capturado). Sintaxe 100% PS 5.1.
- **Botão "Diagnóstico PS"** na aba Serviço Spooler (device tab) + botão liga/desliga **Debug agente** (`setDebug` → grava `spooler-plugin.txt` no cliente, padrão Tracer).

### Fixed
- **`runJson` mascarava falhas como `ok:true, []`**: erro de parse no script PS não mata o processo — PS 5.1 pula pro `Write-Output` final com `$out` vazio e o erro vai só pro stderr. Sintoma: "Servico Spooler nao encontrado" com resultado vazio (BR-25005). Agora: (1) sentinela ausente → erro explícito com stdout/stderr no `spooler-plugin.txt` do cliente + resposta ao server; (2) `[]` com stderr não-vazio → erro com stderr anexado; (3) `[]` limpo → `ok:true` (comportamento legítimo preservado).
- **`runText` aceitava qualquer stdout como sucesso**: resposta sem prefixo OK/OK:/ERR: agora falha com o stdout cru na mensagem.
- **Log raw ampliado**: agente loga stdout.len/stderr de cada execução PS (`runJson`/`runText`); server loga preview do `result` JSON em cada `agentResult`.

### Notes
- Causa raiz provável do "Spooler nao encontrado" na BR-25005: script quebrando no meio com `$ErrorActionPreference='SilentlyContinue'` engolindo a exceção → `$out` vazio → handler validava como erro. Com `psInfo` + novo `runJson`, a próxima ocorrência traz stderr real. **Importante**: mudança em `modules_meshcore/` exige restart do MeshCentral + reconexão dos agentes.

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
