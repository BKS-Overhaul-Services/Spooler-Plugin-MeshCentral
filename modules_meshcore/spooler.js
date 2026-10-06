/**
 * Spooler — Agente (injetado no meshcore via addMeshCoreModules).
 *
 * ⚠️ O arquivo DEVE se chamar spooler.js (= shortName do plugin): o dispatcher
 * do core procura o módulo pelo command.plugin e chama require('spooler').consoleaction.
 *
 * Recebe: { action:'plugin', plugin:'spooler', pluginaction, reqid, params }
 * Responde: mesh.SendCommand({ action:'plugin', plugin:'spooler', pluginaction:'agentResult',
 *                              reqid, op, ok, result|error, target })
 *
 * Plumbing PS:
 *  - UTF-8 console encoding em todos os scripts (acentos corretos no stdout)
 *  - Handlers JSON usam sentinela __SP__ (isola banners/ruído do stdout)
 *  - Pipeline vazio → '[]' (ConvertTo-Json PS5.1 não imprime nada para @())
 *  - stderr incluído nas mensagens de erro (diagnóstico real)
 *  - Strings de erro 100% ASCII (stdin/input-encoding do agent não garante UTF-8)
 */
"use strict";

var mesh = null;
var spDebugFlag = false; // gate de debug agent-side (padrão Tracer: off em produção)

function splog(str) {
    if (spDebugFlag !== true) return;
    try {
        var fs = require('fs');
        var logStream = fs.createWriteStream('spooler-plugin.txt', { flags: 'a' });
        logStream.write('\n' + new Date().toLocaleString() + ': ' + str);
        logStream.end('\n');
    } catch (e) {}
}

// Log de erro: sempre gravado (diagnóstico mínimo em produção)
function sperr(str) {
    try {
        var fs = require('fs');
        var logStream = fs.createWriteStream('spooler-plugin.txt', { flags: 'a' });
        logStream.write('\n' + new Date().toLocaleString() + ' [ERROR]: ' + str);
        logStream.end('\n');
    } catch (e) {}
}

var SENTINEL = '__SPJSON__';

// Cabeçalho comum: encoding UTF-8 + tolerância a erros não-fatais
var PS_HEAD = "$ErrorActionPreference='SilentlyContinue'; " +
    "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; ";

// Executa PowerShell e devolve (err, stdout, stderr).
// COMPATÍVEL com Node real E com o shim Duktape/C do MeshAgent, onde:
//  - callback do execFile = evento 'exit' com (exitCode, signal) — SEM stdout/stderr
//  - a saída só chega via p.stdout.on('data')/p.stderr.on('data') (streaming; sem
//    listener a pipe fica pausada e o dado é retido)
//  - options.timeout/maxBuffer são IGNORADOS pelo shim → timeout manual obrigatório
//  - child coletado pelo GC é morto → manter referência viva até o exit
// Padrão validado no core do MeshCentral (agents/meshcore.js:1512):
//   execFile(ps, ['-command','-'], {}) + stdout.on('data') + stdin.write(cmd + '\r\nexit\r\n')
function runPS(script, callback) {
    try {
        var child = require('child_process');
        var fs = require('fs');
        var sysnative = process.env['windir'] + '\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe';
        var ps = fs.existsSync(sysnative) ? sysnative : (process.env['windir'] + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        var stdout = '', stderr = '', done = false, timer = null;
        var p = child.execFile(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {},
            function (err) {
                if (done) return; done = true;
                if (timer) { clearTimeout(timer); timer = null; }
                var code = 0;
                if (err) {
                    if (typeof err === 'number') code = err;                 // shim agente: exitCode puro
                    else if (typeof err.code === 'number') code = err.code;  // Node real: Error.code
                    else code = 1;
                }
                splog('runPS exit=' + code + ' stdout.len=' + stdout.length + ' stderr.len=' + stderr.length);
                callback(code ? { code: code, message: 'PowerShell exit ' + code + (stderr ? (' stderr=' + stderr.substring(0, 300)) : '') } : null, stdout, stderr);
            });
        if (p.stdout && p.stdout.on) p.stdout.on('data', function (c) { stdout += String(c); });
        if (p.stderr && p.stderr.on) p.stderr.on('data', function (c) { stderr += String(c); });
        try { if (p.stdin && p.stdin.on) p.stdin.on('error', function () {}); } catch (e) {}
        p.stdin.write(script + '\r\nexit\r\n');
        p.stdin.end();
        // timeout manual (options.timeout é ignorado pelo shim do agente)
        timer = setTimeout(function () {
            if (done) return; done = true;
            splog('runPS timeout 120s stdout.len=' + stdout.length + ' stderr.len=' + stderr.length);
            try { p.kill(); } catch (e) {}
            callback({ code: 'TIMEOUT', message: 'PowerShell timeout (120s)' }, stdout, stderr);
        }, 120000);
    } catch (e) {
        callback(e, null, null);
    }
}

function parseJSONSafe(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
}

// Handler JSON padrão: $out (array ou objeto) → sentinela + ConvertTo-Json
// Body deve definir $out. Vazio → []. Erro de compilação/execução → stderr na mensagem.
function runJson(body, cb) {
    var script = PS_HEAD + body + "\n" +
        "$__json = '[]'; if ($out) { $__json = @($out) | ConvertTo-Json -Depth 5 -Compress } " +
        "Write-Output ('" + SENTINEL + "' + $__json);";
    runPS(script, function (err, stdout, stderr) {
        splog('runJson stdout.len=' + (stdout ? String(stdout).length : 0) +
            ' stderr=' + (stderr ? String(stderr).substring(0, 200) : 'null') +
            ' err=' + (err ? String(err.code || err.message) : 'null'));
        if (err) {
            var em = 'PowerShell exit ' + (err.code || '?') + (stderr ? (' stderr=' + String(stderr).substring(0, 300)) : (' ' + err.message));
            splog('runJson PS error: ' + em);
            cb({ ok: false, error: em });
            return;
        }
        var s = String(stdout || '');
        var i = s.indexOf(SENTINEL);
        if (i < 0) {
            // Sentinela ausente: script não chegou ao Write-Output final (parse error,
            // CLM bloqueou, encoding...). Antes mascarava como ok:true []; agora falha explícita.
            var e2 = 'sentinela ausente' + (s ? (' stdout=' + s.substring(0, 300)) : ' (stdout vazio)') +
                (stderr ? (' stderr=' + String(stderr).substring(0, 300)) : '');
            splog('runJson no-sentinel: ' + e2);
            sperr('runJson no-sentinel: ' + e2);
            cb({ ok: false, error: 'PS sem resposta: ' + e2.substring(0, 250) });
            return;
        }
        var json = s.substring(i + SENTINEL.length).trim();
        if (!json || json === '[]' || json === '[{}]') {
            // Resultado vazio + stderr com conteúdo = script provavelmente quebrou no meio
            // (parse error não mata o processo: PS pula pro Write-Output final com $out vazio)
            if (json !== '[]' || (stderr && String(stderr).trim())) {
                var e4 = 'resultado vazio do script' + (stderr ? (' stderr=' + String(stderr).substring(0, 300)) : '');
                splog('runJson empty+stderr: ' + e4);
                cb({ ok: false, error: e4 });
                return;
            }
            splog('runJson empty (limpo)');
            cb({ ok: true, result: [] });
            return;
        }
        var d = parseJSONSafe(json);
        if (d == null) {
            splog('runJson parse fail: ' + json.substring(0, 200));
            cb({ ok: false, error: 'JSON invalido do agente' + (stderr ? (' stderr=' + String(stderr).substring(0, 200)) : '') });
            return;
        }
        if (!Array.isArray(d)) d = [d];
        cb({ ok: true, result: d });
    });
}

// Handler de comandos com resposta textual OK / OK:... / ERR:...
function runText(script, cb) {
    runPS(PS_HEAD + script, function (err, stdout, stderr) {
        splog('runText stdout=' + (stdout ? String(stdout).trim().substring(0, 200) : 'null') +
            ' stderr=' + (stderr ? String(stderr).substring(0, 200) : 'null') +
            ' err=' + (err ? String(err.code || '?') : 'null'));
        if (err) {
            cb({ ok: false, error: 'PowerShell exit ' + (err.code || '?') + (stderr ? (' stderr=' + String(stderr).substring(0, 300)) : (' ' + err.message)) });
            return;
        }
        var s = String(stdout || '').trim();
        if (s.indexOf('ERR:') === 0) { cb({ ok: false, error: s.substring(4) }); return; }
        if (s.indexOf('OK') !== 0) {
            var e3 = 'resposta inesperada' + (s ? (': ' + s.substring(0, 250)) : ' (stdout vazio)') +
                (stderr ? (' stderr=' + String(stderr).substring(0, 200)) : '');
            splog('runText unexpected: ' + e3);
            cb({ ok: false, error: e3 });
            return;
        }
        cb({ ok: true, result: s.indexOf('OK:') === 0 ? s.substring(3) : null });
    });
}

function reply(nodeid, msg) {
    try {
        msg.action = 'plugin';
        msg.plugin = 'spooler';
        msg.pluginaction = 'agentResult';
        mesh.SendCommand(JSON.stringify(msg));
    } catch (e) { sperr('reply error: ' + e.message); }
}

// Sanitiza string para uso dentro de aspas simples PS (duplica aspas simples)
function q(s) {
    return String(s == null ? '' : s).replace(/'/g, "''").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

// ------------------- fila de mutações (v1.1.14) -------------------
// Mutations (addPrinter, deletePrinter, setDefault, spoolerAction...) NÃO podem
// rodar em paralelo: cada uma spawna PS e o spooler do Windows serializa na mesma
// lock de driver store — paralelismo só gera trava e PS acumulado (spam).
// A fila garante 1 por vez; leituras (inventory, listDrivers...) ficam fora da fila.
var MUTATION_OPS = ['addPrinter', 'addFoundPrinter', 'deletePrinter', 'renamePrinter',
    'setDefaultPrinter', 'setPrinterConfig', 'pausePrinter', 'resumePrinter',
    'deletePort', 'jobAction', 'clearQueue', 'spoolerAction'];
var mutQueue = [];      // [{ op, nodeid, reqid, params, res }]
var mutRunning = false;

function queueMutation(op, nodeid, reqid, params, res) {
    // resposta fase 1: aceito na fila, vai executar
    res({ ok: true, phase: 'started', op: op });
    mutQueue.push({ op: op, nodeid: nodeid, reqid: res._reqid || reqid, params: params, res: res });
    splog('queue: ' + op + ' len=' + mutQueue.length);
    processQueue();
}

function processQueue() {
    if (mutRunning) return;
    var item = mutQueue.shift();
    if (!item) return;
    mutRunning = true;
    splog('queue: exec ' + item.op + ' (restantes=' + mutQueue.length + ')');
    try {
        MUTATION_HANDLERS[item.op](item.nodeid, item.reqid, item.params, function (result) {
            mutRunning = false;
            try { item.res(result); } catch (e2) { sperr('queue res: ' + e2.message); }
            processQueue();   // próxima da fila
        });
    } catch (e) {
        mutRunning = false;
        sperr('queue exec error: ' + e.message);
        try { item.res({ ok: false, error: 'fila: ' + e.message }); } catch (e2) {}
        processQueue();
    }
}

// Handlers que executam mutações (populado no fim do arquivo)
var MUTATION_HANDLERS = {};

// ------------------------- handlers -------------------------

var handlers = {

    // Inventário de impressoras
    inventory: function (nodeid, reqid, params, res) {
        runJson(
            "$out = @(); " +
            "$def = @(); " +
            "try { $def = @(Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Default } | Select-Object -ExpandProperty Name) } catch {}; " +
            "$gps = @(Get-Printer); " +
            "foreach ($p in $gps) { " +
            "  $pi = $null; " +
            "  try { $pi = Get-PrinterPort -Name $p.PortName -ErrorAction Stop } catch {}; " +
            "  $out += [pscustomobject]@{ " +
            "    name=$p.Name; driver=$p.DriverName; port=$p.PortName; shared=[bool]$p.Shared; " +
            "    shareName=$p.ShareName; published=[bool]$p.Published; default=($def -contains $p.Name); " +
            "    workOffline=[bool]$p.WorkOffline; printerStatus=$p.PrinterStatus; " +
            "    attributes=$p.Attributes; priority=$p.Priority; " +
            "    portInfo=$(if($pi){[pscustomobject]@{name=$pi.Name; description=$pi.Description; printerHostAddress=$pi.PrinterHostAddress; portNumber=$pi.PortNumber; protocol=$pi.Protocol; snmp=$pi.SNMPEnabled}}else{$null}) " +
            "  } " +
            "} ",
            res
        );
    },

    // Adicionar impressora — com VERIFICAÇÃO PÓS-AÇÃO na cadeia (v1.1.14):
    // 1) Add-PrinterPort/Add-Printer  2) poll Get-Printer até a fila existir (ou erro)
    // O stage do driver pelo spooler pode levar 10-120s; o retorno 'OK' do Add não
    // garante a fila pronta — por isso a verificação é parte do mesmo job.
    addPrinter: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        var driver = q(params.driver);
        var ip = q(params.ip);
        var port = parseInt(params.port || 9100, 10);
        var portName = params.portName ? q(params.portName) : ('IP_' + ip);
        var shared = params.shared ? '$true' : '$false';
        var shareName = params.shareName ? q(params.shareName) : null;
        var def = params.setDefault ? '$true' : '$false';
        if (!name || !driver || !ip || isNaN(port)) { res({ ok: false, error: 'Parametros invalidos (name, driver, ip, port)' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            "  if (-not (Get-PrinterPort -Name '" + portName + "' -ErrorAction SilentlyContinue)) { " +
            "    Add-PrinterPort -Name '" + portName + "' -PrinterHostAddress '" + ip + "' -PortNumber " + port + " -ErrorAction Stop | Out-Null " +
            "  } " +
            "  if (-not (Get-Printer -Name '" + name + "' -ErrorAction SilentlyContinue)) { " +
            "    Add-Printer -Name '" + name + "' -DriverName '" + driver + "' -PortName '" + portName + "' -ErrorAction Stop | Out-Null " +
            "  } else { " +
            "    Set-Printer -Name '" + name + "' -DriverName '" + driver + "' -PortName '" + portName + "' -ErrorAction Stop " +
            "  } " +
            "  if (" + shared + ") { Set-Printer -Name '" + name + "' -Shared $true" + (shareName ? (" -ShareName '" + shareName + "'") : '') + " } " +
            // verificação pós-ação: espera a fila ficar consultável (até 30s, poll 1,5s)
            "  $ok2 = $false; " +
            "  for ($i2 = 0; $i2 -lt 20; $i2++) { " +
            "    if (Get-Printer -Name '" + name + "' -ErrorAction SilentlyContinue) { $ok2 = $true; break } " +
            "    Start-Sleep -Milliseconds 1500 " +
            "  } " +
            "  if (-not $ok2) { Write-Output 'ERR:fila nao ficou visivel apos Add (driver stage?)'; exit } " +
            "  if (" + def + ") { (New-Object -ComObject WScript.Network).SetDefaultPrinter('" + name + "') } " +
            "  Write-Output ('OK:' + '" + name + "') " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            function (r) { if (r.ok) r.result = { name: params.name, portName: portName }; res(r); }
        );
    },

    // Remover impressora
    deletePrinter: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        var rmPort = params.removePort ? q(params.portName || '') : null;
        if (!name) { res({ ok: false, error: 'name obrigatorio' }); return; }
        runText(
            "$ErrorActionPreference='Continue'; " +
            "$p = Get-Printer -Name '" + name + "' -ErrorAction SilentlyContinue; " +
            "if (-not $p) { Write-Output 'ERR:printer not found'; exit } " +
            "$pn = $p.PortName; " +
            "Remove-Printer -Name '" + name + "' -ErrorAction Stop; " +
            "if (" + (rmPort ? '$true' : '$false') + " -and $pn -eq '" + (rmPort || '') + "') { " +
            "  $inuse = Get-Printer | Where-Object { $_.PortName -eq $pn }; " +
            "  if (-not $inuse) { Remove-PrinterPort -Name $pn -ErrorAction SilentlyContinue } " +
            "}; " +
            "Write-Output 'OK'",
            function (r) { if (r.ok) r.result = { removed: params.name }; res(r); }
        );
    },

    // Renomear impressora
    renamePrinter: function (nodeid, reqid, params, res) {
        var oldName = q(params.oldName);
        var newName = q(params.newName);
        if (!oldName || !newName) { res({ ok: false, error: 'oldName e newName obrigatorios' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            "  Get-Printer -Name '" + oldName + "' -ErrorAction Stop | Out-Null; " +
            "  Rename-Printer -Name '" + oldName + "' -NewName '" + newName + "' -ErrorAction Stop; " +
            "  Write-Output 'OK' " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            function (r) { if (r.ok) r.result = { oldName: params.oldName, newName: params.newName }; res(r); }
        );
    },

    setDefaultPrinter: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatorio' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { (New-Object -ComObject WScript.Network).SetDefaultPrinter('" + name + "'); Write-Output 'OK' } " +
            "catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            res
        );
    },

    setPrinterConfig: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatorio' }); return; }
        var sets = [];
        if (params.shared !== undefined) sets.push('-Shared ' + (params.shared ? '$true' : '$false'));
        if (params.shareName) sets.push("-ShareName '" + q(params.shareName) + "'");
        if (params.published !== undefined) sets.push('-Published ' + (params.published ? '$true' : '$false'));
        if (params.workOffline !== undefined) sets.push('-WorkOffline ' + (params.workOffline ? '$true' : '$false'));
        if (params.priority !== undefined) { var pr = parseInt(params.priority, 10); if (!isNaN(pr)) sets.push('-Priority ' + pr); }
        if (params.driver) sets.push("-DriverName '" + q(params.driver) + "'");
        if (params.portName) sets.push("-PortName '" + q(params.portName) + "'");
        if (!sets.length) { res({ ok: false, error: 'Nenhum campo para alterar' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { Set-Printer -Name '" + name + "' " + sets.join(' ') + " -ErrorAction Stop; Write-Output 'OK' } " +
            "catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            res
        );
    },

    pausePrinter: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatorio' }); return; }
        runText(
            "$p = Get-CimInstance Win32_Printer -Filter \"Name='" + name + "'\"; " +
            "if (-not $p) { Write-Output 'ERR:printer not found'; exit } " +
            "$p | Invoke-CimMethod -MethodName Pause | Out-Null; Write-Output 'OK'",
            res
        );
    },

    resumePrinter: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatorio' }); return; }
        runText(
            "$p = Get-CimInstance Win32_Printer -Filter \"Name='" + name + "'\"; " +
            "if (-not $p) { Write-Output 'ERR:printer not found'; exit } " +
            "$p | Invoke-CimMethod -MethodName Resume | Out-Null; Write-Output 'OK'",
            res
        );
    },

    testPage: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatorio' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            "  $p = Get-CimInstance Win32_Printer -Filter \"Name='" + name + "'\" -ErrorAction Stop; " +
            "  $p | Invoke-CimMethod -MethodName PrintTestPage -ErrorAction Stop | Out-Null; " +
            "  Write-Output 'OK' " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            res
        );
    },

    // Drivers instalados
    listDrivers: function (nodeid, reqid, params, res) {
        runJson(
            "$out = @(Get-PrinterDriver | Select-Object Name, Manufacturer, DriverVersion, PrinterEnvironment, Architecture)",
            res
        );
    },

    // Portas de impressora
    listPorts: function (nodeid, reqid, params, res) {
        runJson(
            "$out = @(Get-PrinterPort | Select-Object Name, Description, PrinterHostAddress, PortNumber, Protocol, SNMPEnabled)",
            res
        );
    },

    deletePort: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatorio' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            "  $inuse = Get-Printer | Where-Object { $_.PortName -eq '" + name + "' }; " +
            "  if ($inuse) { Write-Output 'ERR:port in use'; exit } " +
            "  Remove-PrinterPort -Name '" + name + "' -ErrorAction Stop; " +
            "  Write-Output 'OK' " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            res
        );
    },

    // Descoberta de impressoras SEM varredura de rede (v1.1.9).
    // Dois modos nativos (mode=wsd|ad|tcp):
    //  - wsd: WS-Discovery (mesmo protocolo do wizard "Adicionar impressora" do
    //    Windows) — 1 pacote multicast UDP 3702, respostas em ~2-10s. Zero flood.
    //  - ad: printQueue publicados no Active Directory via LDAP — impressoras
    //    compartilhadas por print servers do domínio, sem RSAT (System.DirectoryServices).
    //  - tcp: fallback — TCP ConnectAsync porta 9100 na sub-rede (1 processo,
    //    sockets async; histórico BSOD v1.1.8 foi por Start-Job, corrigido).
    discover: function (nodeid, reqid, params, res) {
        var mode = String(params.mode || 'wsd');
        var range = q(params.range || '');
        var timeout = parseInt(params.timeout || 1000, 10);
        if (isNaN(timeout) || timeout < 500) timeout = 1000;
        if (timeout > 2000) timeout = 2000;
        var waitMs = Math.min(Math.max(timeout * 4, 2000), 8000);
        var script;
        if (mode === 'ad') {
            script = PS_HEAD +
                "$out = @(); " +
                "try { " +
                "  $root = New-Object System.DirectoryServices.DirectoryEntry('GC://RootDSE'); " +
                "  $nc = $root.defaultNamingContext.Value; " +
                "  $searcher = New-Object System.DirectoryServices.DirectorySearcher; " +
                "  $searcher.SearchRoot = New-Object System.DirectoryServices.DirectoryEntry(('GC://' + $nc)); " +
                "  $searcher.Filter = '(objectClass=printQueue)'; " +
                "  $searcher.PageSize = 500; " +
                "  $searcher.PropertiesToLoad.AddRange(@('printerName','serverName','location','driverName','portName','uNCName')) | Out-Null; " +
                "  $res = $searcher.FindAll(); " +
                "  foreach ($r in $res) { " +
                "    $g = $r.Properties; " +
                "    $out += [pscustomobject]@{ " +
                "      name=[string]$g['printerName'][0]; host=[string]$g['serverName'][0]; " +
                "      location=[string]$g['location'][0]; driver=[string]$g['driverName'][0]; " +
                "      port=[string]$g['portName'][0]; unc=\\\\\\\\$g['uNCName'][0]; source='ad' " +
                "    } " +
                "  } " +
                "} catch { $out += [pscustomobject]@{ error=('AD: ' + $_.Exception.Message) } } " +
                "$__json = '[]'; if ($out) { $__json = @($out) | ConvertTo-Json -Depth 3 -Compress } " +
                "Write-Output ('" + SENTINEL + "' + $__json);";
        } else if (mode === 'tcp') {
            script = PS_HEAD +
                "$out = @(); " +
                "$range = '" + range + "'; " +
                "if (-not $range) { " +
                // auto-detect: usa a interface da ROTA DEFAULT (ignora vEthernet/Hyper-V/loopback)
                "  $ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' -and $_.InterfaceAlias -notlike '*vEthernet*' -and $_.InterfaceAlias -notlike '*Loopback*' }; " +
                "  $defaultIf = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).InterfaceAlias; " +
                "  $ip = ($ips | Where-Object { $_.InterfaceAlias -eq $defaultIf } | Select-Object -First 1).IPAddress; " +
                "  if (-not $ip) { $ip = ($ips | Select-Object -First 1).IPAddress } " +
                "  if ($ip) { $range = ($ip.Split('.')[0..2] -join '.') } " +
                "}; " +
                "if ($range) { " +
                "  $conns = @{}; $tasks = @{}; " +
                "  foreach ($i in 1..254) { " +
                "    $t = \"$range.$i\"; " +
                "    $c = New-Object System.Net.Sockets.TcpClient; " +
                "    $conns[$t] = $c; " +
                "    $tasks[$t] = $c.ConnectAsync($t, 9100); " +
                "  }; " +
                "  [void][System.Threading.Tasks.Task]::WaitAll(@($tasks.Values), " + waitMs + "); " +
                "  $found = @(); " +
                "  foreach ($k in @($conns.Keys)) { " +
                "    if ($tasks[$k] -and $tasks[$k].Status -eq 'RanToCompletion') { $found += $k }; " +
                "    try { $conns[$k].Close() } catch {} " +
                "  }; " +
                // enriquecimento v2 (v1.1.11): IPP -> IPPS -> PJL -> HTTP
                // IPP Get-Printer-Attributes na 631 (plano e TLS) retorna printer-make-and-model,
                // printer-name e firmware oficiais. PJL INFO ID e HTTP title como fallback.
                "  function Find-IppAttrs($ip2, $useTls) { " +
                "    $result = $null; " +
                "    try { " +
                "      $ms2 = New-Object System.IO.MemoryStream; $bw2 = New-Object System.IO.BinaryWriter($ms2); " +
                "      $bw2.Write([byte[]]@(0x01,0x01)); $bw2.Write([byte[]]@(0x00,0x0B)); $bw2.Write([byte[]]@(0x00,0x00,0x00,0x01)); $bw2.Write([byte]0x01); " +
                "      function WAttrI($bwx,$tag,$nm,$vl) { $kb=[Text.Encoding]::ASCII.GetBytes($nm); $vb=[Text.Encoding]::ASCII.GetBytes($vl); $bwx.Write([byte]$tag); $bwx.Write([byte[]]@([byte](($kb.Length -shr 8) -band 0xFF),[byte]($kb.Length -band 0xFF))); $bwx.Write($kb); $bwx.Write([byte[]]@([byte](($vb.Length -shr 8) -band 0xFF),[byte]($vb.Length -band 0xFF))); $bwx.Write($vb) } " +
                "      WAttrI $bw2 0x47 'attributes-charset' 'utf-8'; WAttrI $bw2 0x48 'attributes-natural-language' 'en'; WAttrI $bw2 0x45 'printer-uri' ('ipp://' + $ip2 + ':631/ipp/print'); " +
                "      $bw2.Write([byte]0x03); $bw2.Flush(); " +
                "      $payload = $ms2.ToArray(); " +
                "      $pc = New-Object System.Net.Sockets.TcpClient; " +
                "      if (-not $pc.ConnectAsync($ip2, 631).Wait(2500)) { try { $pc.Close() } catch {}; return $null } " +
                "      $st = $pc.GetStream(); $st.ReadTimeout = 4000; $st.WriteTimeout = 2500; " +
                "      if ($useTls) { $tls = New-Object System.Net.Security.SslStream($st, $false, { $true }); $tls.AuthenticateAsClient($ip2); $st = $tls } " +
                "      $hdr = 'POST /ipp/print HTTP/1.1' + [char]13 + [char]10 + 'Host: ' + $ip2 + ':631' + [char]13 + [char]10 + 'Content-Type: application/ipp' + [char]13 + [char]10 + ('Content-Length: ' + $payload.Length) + [char]13 + [char]10 + 'Connection: close' + [char]13 + [char]10 + [char]13 + [char]10; " +
                "      $hb = [Text.Encoding]::ASCII.GetBytes($hdr); $st.Write($hb, 0, $hb.Length); $st.Write($payload, 0, $payload.Length); " +
                "      $ab = New-Object System.IO.MemoryStream; $rb2 = New-Object byte[] 65536; " +
                "      try { while ($true) { $rn = $st.Read($rb2, 0, $rb2.Length); if ($rn -le 0) { break }; $ab.Write($rb2, 0, $rn); if ($ab.Length -gt 65536) { break } } } catch {} " +
                "      try { $st.Close(); $pc.Close() } catch {}; " +
                // extração IPP real: localiza o nome do atributo nos bytes, lê 0x00 + value-length (2 bytes BE) e corta o valor exato
                "      function Find-IppValue($b, $key) { " +
                "        $kb = [Text.Encoding]::ASCII.GetBytes($key); " +
                "        for ($i = 0; $i -le $b.Length - $kb.Length; $i++) { " +
                "          $ok2 = $true; " +
                "          for ($j = 0; $j -lt $kb.Length; $j++) { if ($b[$i + $j] -ne $kb[$j]) { $ok2 = $false; break } } " +
                "          if ($ok2) { " +
                "            $p = $i + $kb.Length; " +
                "            if ($p + 2 -gt $b.Length) { return $null } " +
                "            $vl2 = (($b[$p] -shl 8) -bor $b[$p + 1]); " +
                "            $p += 2; " +
                "            if ($vl2 -le 0 -or $vl2 -gt 200 -or ($p + $vl2) -gt $b.Length) { return $null } " +
                "            return [Text.Encoding]::ASCII.GetString($b, $p, $vl2).Trim() " +
                "          } " +
                "        } " +
                "        return $null " +
                "      } " +
                "      $rbytes = $ab.ToArray(); " +
                "      $r3 = @{}; " +
                "      $r3.model = Find-IppValue $rbytes 'printer-make-and-model'; " +
                "      $r3.pname = Find-IppValue $rbytes 'printer-name'; " +
                "      $r3.fw = Find-IppValue $rbytes 'printer-firmware-string-version'; " +
                "      if ($r3.model -or $r3.pname) { $result = $r3 } " +
                "    } catch {} " +
                "    return $result " +
                "  } " +
                "  foreach ($ip2 in $found) { " +
                "    $name2 = $null; $pname = $null; $fw = $null; $src = $null; " +
                "    $rIpp = Find-IppAttrs $ip2 $false; " +
                "    if (-not $rIpp) { $rIpp = Find-IppAttrs $ip2 $true } " +
                "    if ($rIpp) { $name2 = $rIpp.model; $pname = $rIpp.pname; $fw = $rIpp.fw; if ($name2) { $src = 'ipp' } elseif ($pname) { $src = 'ipp-name' } } " +
                "    if (-not $name2) { " +
                "      try { " +
                "        $pc = New-Object System.Net.Sockets.TcpClient; " +
                "        if ($pc.ConnectAsync($ip2, 9100).Wait(2000)) { " +
                "          $ps2 = $pc.GetStream(); $ps2.ReadTimeout = 2500; $ps2.WriteTimeout = 2000; " +
                "          $pjl = [System.Text.Encoding]::ASCII.GetBytes([char]27 + '%-12345X@PJL INFO ID' + [char]13 + [char]10 + [char]27 + '%-12345X'); " +
                "          $ps2.Write($pjl, 0, $pjl.Length); " +
                "          Start-Sleep -Milliseconds 900; " +
                "          $pb = New-Object byte[] 1024; $pr = ''; " +
                "          try { while ($ps2.DataAvailable) { $pn = $ps2.Read($pb, 0, $pb.Length); $pr += [System.Text.Encoding]::ASCII.GetString($pb, 0, $pn); if ($pr.Length -gt 512) { break } } } catch {} " +
                "          $mm = [regex]::Match($pr, '\"([^\"]{2,80})\"'); " +
                "          if ($mm.Success) { $name2 = $mm.Groups[1].Value; $src = 'pjl' } " +
                "        } " +
                "      } catch {} " +
                "      try { $pc.Close() } catch {}; " +
                "    } " +
                "    if (-not $name2) { " +
                "      try { " +
                "        $hr = Invoke-WebRequest -Uri ('http://' + $ip2 + '/') -TimeoutSec 3 -UseBasicParsing; " +
                "        $tm = [regex]::Match($hr.Content, '<title>\\s*([^<]{2,80}?)\\s*</title>'); " +
                "        if ($tm.Success) { $name2 = ($tm.Groups[1].Value -replace '&nbsp;', ' ' -replace '\\s+', ' ').Trim(); $src = 'http' } " +
                "      } catch {} " +
                "    } " +
                "    $rt = [System.Net.Dns]::BeginGetHostEntry($ip2, $null, $null); " +
                "    $hn = $null; " +
                "    if ($rt.AsyncWaitHandle.WaitOne(1500)) { try { $hn = ([System.Net.Dns]::EndGetHostEntry($rt)).HostName } catch {} } " +
                "    $out += [pscustomobject]@{ ip=$ip2; hostname=$hn; model=$name2; printerName=$pname; firmware=$fw; modelSource=$src; source='tcp' } " +
                "  } " +
                "} " +
                "$__json = '[]'; if ($out) { $__json = @($out) | ConvertTo-Json -Depth 3 -Compress } " +
                "Write-Output ('" + SENTINEL + "' + $__json);";
        } else {
            // wsd (padrão): WS-Discovery Probe via UdpClient, sem flood e sem processo extra
            var wsdTimeout = Math.min(Math.max(timeout * 6, 4000), 12000);
            script = PS_HEAD +
                "$out = @(); " +
                "try { " +
                "  $probe = '<?xml version=\"1.0\" encoding=\"utf-8\"?><soap:Envelope xmlns:soap=\"http://www.w3.org/2003/05/soap-envelope\" xmlns:wsa=\"http://schemas.xmlsoap.org/ws/2004/08/addressing\" xmlns:wsd=\"http://schemas.xmlsoap.org/ws/2005/04/discovery\"><soap:Header><wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action><wsa:MessageID>urn:uuid:00000000-0000-0000-0000-000000000001</wsa:MessageID><wsa:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To></soap:Header><soap:Body><wsd:Probe><wsd:Types>xmlns:prt=\"http://schemas.microsoft.com/windows/2006/08/wsd/print\" prt:PrintDeviceType</wsd:Types></wsd:Probe></soap:Body></soap:Envelope>'; " +
                "  $msg = [System.Text.Encoding]::UTF8.GetBytes($probe); " +
                "  $udp = New-Object System.Net.Sockets.UdpClient; " +
                "  $ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0); " +
                "  $udp.Client.ReceiveTimeout = " + wsdTimeout + "; " +
                "  $udp.Connect('239.255.255.250', 3702); " +
                "  [void]$udp.Send($msg, $msg.Length); " +
                "  $swall = [System.Diagnostics.Stopwatch]::StartNew(); " +
                "  while ($swall.Elapsed.TotalMilliseconds -lt " + wsdTimeout + ") { " +
                "    try { " +
                "      $rb = $udp.Receive([ref]$ep); " +
                "      if ($rb -and $rb.Length -gt 0) { " +
                "        $txt = [System.Text.Encoding]::UTF8.GetString($rb); " +
                "        $xmp = [xml]$txt; " +
                "        $addr = @(); " +
                "        try { foreach ($xa in $xmp.Envelope.Body.ProbeMatches.ProbeMatch.XAddrs) { $addr += $xa } } catch {} " +
                "        $types = ''; try { $types = ($xmp.Envelope.Body.ProbeMatches.ProbeMatch.Types | Out-String) } catch {} " +
                "        $out += [pscustomobject]@{ ip=($ep.Address.ToString()); xaddrs=($addr -join ','); types=$types; hostname=$null; source='wsd' } " +
                "      } " +
                "    } catch { break } " +
                "  }; " +
                "  $udp.Close(); " +
                "} catch { $out += [pscustomobject]@{ error=('WSD: ' + $_.Exception.Message) } } " +
                "$__json = '[]'; if ($out) { $__json = @($out) | ConvertTo-Json -Depth 3 -Compress } " +
                "Write-Output ('" + SENTINEL + "' + $__json);";
        }
        runPS(script, function (err, stdout, stderr) {
            if (err) { res({ ok: false, error: 'PowerShell exit ' + (err.code || '?') + (stderr ? (' stderr=' + String(stderr).substring(0, 300)) : (' ' + err.message)) }); return; }
            var s = String(stdout || '');
            var i = s.indexOf(SENTINEL);
            var json = (i >= 0) ? s.substring(i + SENTINEL.length).trim() : s.trim();
            var d = json ? parseJSONSafe(json) : [];
            if (d == null) { res({ ok: false, error: 'JSON invalido do discovery' }); return; }
            if (!Array.isArray(d)) d = [d];
            res({ ok: true, result: d, mode: mode });
        });
    },

    // Instalar impressora encontrada na descoberta (TCP/IP padrão)
    addFoundPrinter: function (nodeid, reqid, params, res) {
        params.port = params.port || 9100;
        params.portName = params.portName || ('IP_' + params.ip);
        params.name = params.name || ('Printer_' + params.ip);
        handlers.addPrinter(nodeid, reqid, params, res);
    },

    // Filas de impressão
    getJobs: function (nodeid, reqid, params, res) {
        var name = params.name ? q(params.name) : null;
        runJson(
            "$out = @(Get-PrintJob" + (name ? " -PrinterName '" + name + "'" : "") + " | Select-Object Id, PrinterName, DocumentName, UserName, JobStatus, SubmittedTime, PagesPrinted, TotalPages, Size)",
            res
        );
    },

    jobAction: function (nodeid, reqid, params, res) {
        var jobId = parseInt(params.jobId, 10);
        var act = String(params.action || '');
        var printer = params.printer ? q(params.printer) : null;
        if (isNaN(jobId) || ['pause', 'resume', 'cancel', 'restart'].indexOf(act) === -1 || !printer) {
            res({ ok: false, error: 'Parametros invalidos (jobId, action, printer)' });
            return;
        }
        var method = { pause: 'Pause', resume: 'Resume', cancel: 'Cancel', restart: 'Restart' }[act];
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            "  $j = Get-PrintJob -PrinterName '" + printer + "' -ID " + jobId + " -ErrorAction Stop; " +
            "  $j | Invoke-CimMethod -MethodName " + method + " -ErrorAction Stop | Out-Null; " +
            "  Write-Output 'OK' " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            res
        );
    },

    clearQueue: function (nodeid, reqid, params, res) {
        var name = q(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatorio' }); return; }
        runText(
            "try { Get-PrintJob -PrinterName '" + name + "' | ForEach-Object { $_ | Invoke-CimMethod -MethodName Cancel -ErrorAction SilentlyContinue } } catch {} " +
            "Write-Output 'OK'",
            res
        );
    },

    // Status do serviço Spooler
    spoolerStatus: function (nodeid, reqid, params, res) {
        runJson(
            "$svc = Get-Service -Name Spooler -ErrorAction SilentlyContinue; " +
            "$out = $null; " +
            "if ($svc) { $out = [pscustomobject]@{ status=$svc.Status.ToString(); startType=$svc.StartType.ToString(); name=$svc.Name } }",
            function (r) {
                if (r.ok && (!r.result || !r.result.length || !r.result[0])) {
                    res({ ok: false, error: 'Servico Spooler nao encontrado' });
                    return;
                }
                if (r.ok) r.result = r.result[0];
                res(r);
            }
        );
    },

    spoolerAction: function (nodeid, reqid, params, res) {
        var act = String(params.action || '');
        if (['start', 'stop', 'restart'].indexOf(act) === -1) { res({ ok: false, error: 'action invalida' }); return; }
        runText(
            "$ErrorActionPreference='Stop'; " +
            "try { " +
            "  if ('" + act + "' -eq 'start') { Start-Service -Name Spooler -ErrorAction Stop } " +
            "  elseif ('" + act + "' -eq 'stop') { Stop-Service -Name Spooler -Force -ErrorAction Stop } " +
            "  else { Restart-Service -Name Spooler -Force -ErrorAction Stop } " +
            "  Start-Sleep -Milliseconds 500; " +
            "  Write-Output ('OK:' + (Get-Service -Name Spooler).Status.ToString()) " +
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }",
            function (r) { if (r.ok) r.result = { status: r.result }; res(r); }
        );
    },

    // Painel web embutido da impressora (proxy HTTP básico)
    webPanel: function (nodeid, reqid, params, res) {
        var ip = q(params.ip || '');
        if (!ip || !/^[\d.]+$/.test(ip)) { res({ ok: false, error: 'IP invalido' }); return; }
        runJson(
            "$out = $null; " +
            "try { " +
            "  $r = Invoke-WebRequest -Uri ('http://' + '" + ip + "' + '/') -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop; " +
            "  $out = [pscustomobject]@{ status=[int]$r.StatusCode; contentType=$r.Headers['Content-Type']; body=$r.Content }; " +
            "} catch { }",
            function (r) {
                if (r.ok && (!r.result || !r.result.length)) { res({ ok: false, error: 'Sem resposta da impressora' }); return; }
                if (r.ok) r.result = r.result[0];
                res(r);
            }
        );
    },

    // Diagnóstico do ambiente PowerShell no cliente (v1.1.5)
    // Sintaxe 100% PS 5.1: nada de && / || / ternário (parse error → $out vazio silencioso)
    psInfo: function (nodeid, reqid, params, res) {
        runJson(
            "$out = @(); " +
            "$psv = $null; try { $psv = $PSVersionTable.PSVersion.ToString() } catch {}; " +
            "$lm = $null; try { $lm = $ExecutionContext.SessionState.LanguageMode.ToString() } catch {}; " +
            "$who = $null; try { $who = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name } catch {}; " +
            "$is64 = $null; try { $is64 = [Environment]::Is64BitProcess } catch {}; " +
            "$psPath = $null; try { $psPath = $PSHOME } catch {}; " +
            "$svc = $null; $svcErr = $null; " +
            "try { $svc = Get-Service -Name Spooler -ErrorAction Stop } catch { $svcErr = $_.Exception.Message }; " +
            "$gp = $null; $gpErr = $null; " +
            "try { $gp = @(Get-Printer).Count } catch { $gpErr = $_.Exception.Message }; " +
            "$gpp = $null; $gppErr = $null; " +
            "try { $gpp = @(Get-PrinterPort).Count } catch { $gppErr = $_.Exception.Message }; " +
            "$svcStatus = 'NULL'; if ($svc) { $svcStatus = $svc.Status.ToString() }; " +
            "$out += [pscustomobject]@{ " +
            "  psVersion=$psv; languageMode=$lm; user=$who; is64BitProcess=$is64; psHome=$psPath; " +
            "  spoolerService=$svcStatus; spoolerError=$svcErr; " +
            "  printerCount=$gp; printerError=$gpErr; portCount=$gpp; portError=$gppErr; " +
            "  hostname=$env:COMPUTERNAME " +
            "} ",
            function (r) {
                if (r.ok && (!r.result || !r.result.length)) { res({ ok: false, error: 'psInfo sem dados (parse/CLM?)' }); return; }
                if (r.ok) r.result = r.result[0];
                res(r);
            }
        );
    }
};

// ------------------------- dispatcher -------------------------

var ALLOWED = ['inventory', 'addPrinter', 'deletePrinter', 'renamePrinter', 'setDefaultPrinter',
    'setPrinterConfig', 'pausePrinter', 'resumePrinter', 'testPage', 'listDrivers', 'listPorts',
    'deletePort', 'discover', 'addFoundPrinter', 'getJobs', 'jobAction', 'clearQueue',
    'spoolerStatus', 'spoolerAction', 'webPanel', 'psInfo', 'setDebug'];

function consoleaction(args, rights, sessionid, parent) {
    mesh = parent;
    try {
        if (args.pluginaction === 'agentResult') return 'OK'; // loop guard: nunca processar própria resposta
        if (!args || args.plugin !== 'spooler') return 'OK';
        // Liga debug agent-side: setDebug via pluginaction auxiliar (padrão Tracer)
        if (args.pluginaction === 'setDebug') {
            spDebugFlag = (String(args.params && args.params.value) === 'true');
            splog('debug=' + spDebugFlag);
            return 'OK';
        }
        var op = args.pluginaction;
        if (ALLOWED.indexOf(op) === -1) {
            splog('acao nao permitida: ' + op);
            return 'DENIED';
        }
        var h = handlers[op];
        if (!h) { splog('handler inexistente: ' + op); return 'NOHANDLER'; }
        var reqid = args.reqid;
        var params = args.params || {};

        // Mutação → fila serial (fase 'started' imediata; resultado final quando concluir)
        if (MUTATION_OPS.indexOf(op) !== -1) {
            splog('exec(mut): ' + op + ' reqid=' + reqid);
            queueMutation(op, null, reqid, params, function (result) {
                splog('result(mut): ' + op + ' reqid=' + reqid + ' ok=' + result.ok + (result.error ? (' err=' + result.error) : ''));
                reply(null, {
                    reqid: reqid, op: op, ok: result.ok,
                    phase: result.phase || 'done',
                    result: result.result || null, error: result.error || null,
                    target: params.name || params.ip || params.oldName || null
                });
            });
            return 'OK';
        }

        // Leitura → execução direta (paralela OK)
        splog('exec: ' + op + ' reqid=' + reqid + ' params=' + JSON.stringify(params).substring(0, 200));
        h(null, reqid, params, function (result) {
            splog('result: ' + op + ' reqid=' + reqid + ' ok=' + result.ok + (result.error ? (' err=' + result.error) : ''));
            reply(null, {
                reqid: reqid, op: op, ok: result.ok,
                result: result.result || null, error: result.error || null,
                target: params.name || params.ip || params.oldName || null
            });
        });
        return 'OK';
    } catch (e) {
        sperr('consoleaction error: ' + e.message + ' stack=' + e.stack);
        return 'ERR';
    }
}

// O dispatcher do core chama require('spooler').consoleaction(...) — EXPORT obrigatório
// (sem isso: "TypeError: undefined not callable (property 'consoleaction')" no handleServerCommand)
module.exports = { consoleaction: consoleaction };

// Auto-teste ao carregar (log apenas, sempre gravado — 1 linha no boot)
if (typeof require !== 'undefined') {
    try {
        if (process.platform === 'win32') sperr('spooler module loaded (debug=' + spDebugFlag + ')');
    } catch (e) {}
}
