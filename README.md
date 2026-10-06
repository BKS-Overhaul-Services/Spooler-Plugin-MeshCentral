# Spooler — Gerenciador de Impressoras para MeshCentral

Plugin MeshCentral para controle centralizado de impressoras Windows dos clientes via agente MeshCentral.

## Funcionalidades

| Área | Recursos |
|------|----------|
| CRUD | Adicionar, excluir, renomear, pausar/retomar, definir padrão, configurar (compartilhamento, prioridade, driver, porta, trabalhar offline) |
| Descoberta | Varredura SNMP da sub-rede, instalação individual ou em lote das impressoras encontradas |
| Filas | Listar jobs, pausar/retomar/reiniciar/cancelar, limpar fila |
| Spooler | Status/start/stop/restart do serviço Print Spooler |
| Extras | Página de teste, portas e drivers, painel web embutido da impressora, auditoria |

## Instalação

1. Copie a pasta `spooler` para `C:\Program Files\Open Source\MeshCentral\meshcentral-data\plugins\spooler` no bks-server.
2. No `config.json` do MeshCentral:
   ```json
   "settings": { "plugins": { "enabled": true, "list": ["spooler"] } }
   ```
3. Reinicie o serviço do MeshCentral.
4. No painel do MeshCentral: **Meu Servidor → Plugins** deve listar o plugin ativo.

## Como funciona

```
[Browser] --ws--> [spooler.js (server)] --wsagents[nid].send--> [win-spooler.js (agente)]
                         |                                          |
                    NeDB (catálogo +                          PowerShell 64-bit
                    auditoria)                                (Get-Printer/Add-Printer/
                                                              SNMP discover/Get-PrintJob...)
                         ^                                          |
                         +------------ resposta via serveraction ---+
```

- O módulo `modules_meshcore/win-spooler.js` é injetado automaticamente nos cores Windows pelo `pluginHandler.addMeshCoreModules()` — os agentes atualizam sozinhos.
- Toda execução no agente é via PowerShell com parâmetros sanitizados (aspas escapadas, allow-list de ações).
- Respostas correlacionadas por `reqid` com timeout de 2 min.

## Requisitos

- MeshCentral >= 1.0.0 com plugins habilitados
- Agentes Windows (o módulo usa prefixo `win-`; não afeta Linux)
- PowerShell 5.1+ (padrão no Windows 10/11/Server)
- Porta 161/UDP aberta na rede para descoberta SNMP

## Estrutura

```
spooler/
├── config.json                 # metadados do plugin
├── spooler.js                  # server-side (hooks do pluginHandler)
├── db.js                       # NeDB: catálogo de impressoras + auditoria
├── modules_meshcore/
│   └── win-spooler.js          # módulo do agente (injetado nos cores Windows)
├── views/
│   ├── admin.handlebars        # painel global (catálogo consolidado + auditoria)
│   └── device.handlebars       # aba do dispositivo (CRUD completo)
└── changelog.md
```
