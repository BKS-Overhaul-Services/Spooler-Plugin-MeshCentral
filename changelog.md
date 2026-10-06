# Changelog — Spooler Plugin MeshCentral

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
