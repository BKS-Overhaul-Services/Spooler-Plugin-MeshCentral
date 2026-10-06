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

// Executa PowerShell e devolve (err, stdout, stderr)
function runPS(script, callback) {
    try {
        var child = require('child_process');
        var fs = require('fs');
        var sysnative = process.env['windir'] + '\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe';
        var ps = fs.existsSync(sysnative) ? sysnative : (process.env['windir'] + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        var p = child.execFile(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 * 8 }, function (err, stdout, stderr) {
            callback(err, stdout, stderr);
        });
        p.stdin.write(script);
        p.stdin.end();
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
        if (err) {
            var em = 'PowerShell exit ' + (err.code || '?') + (stderr ? (' stderr=' + String(stderr).substring(0, 300)) : (' ' + err.message));
            splog('runJson PS error: ' + em);
            cb({ ok: false, error: em });
            return;
        }
        var s = String(stdout || '');
        var i = s.indexOf(SENTINEL);
        var json = (i >= 0) ? s.substring(i + SENTINEL.length).trim() : s.trim();
        if (!json) {
            // stdout vazio sem sentinela: provável ruído em stderr
            var e2 = stderr ? ('stderr=' + String(stderr).substring(0, 300)) : 'stdout vazio';
            splog('runJson empty: ' + e2);
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
        if (err) {
            cb({ ok: false, error: 'PowerShell exit ' + (err.code || '?') + (stderr ? (' stderr=' + String(stderr).substring(0, 300)) : (' ' + err.message)) });
            return;
        }
        var s = String(stdout || '').trim();
        if (s.indexOf('ERR:') === 0) { cb({ ok: false, error: s.substring(4) }); return; }
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

    // Adicionar impressora
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

    // Descoberta SNMP de impressoras de rede na sub-rede
    discover: function (nodeid, reqid, params, res) {
        var range = q(params.range || '');
        var timeout = parseInt(params.timeout || 1000, 10);
        if (isNaN(timeout) || timeout < 200) timeout = 1000;
        if (timeout > 5000) timeout = 5000;
        var script = PS_HEAD +
            "$out = @(); " +
            "$range = '" + range + "'; " +
            "if (-not $range) { " +
            "  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' } | Select-Object -First 1).IPAddress; " +
            "  if ($ip) { $range = ($ip.Split('.')[0..2] -join '.') } " +
            "}; " +
            "if ($range) { " +
            "  $found = @(); " +
            "  $jobs = @(); " +
            "  1..254 | ForEach-Object { " +
            "    $t = \"$range.$_\"; " +
            "    $jobs += Start-Job -ScriptBlock { " +
            "      param($ip, $to) " +
            "      $udp = New-Object System.Net.Sockets.UdpClient; " +
            "      $udp.Client.ReceiveTimeout = $to; " +
            "      $snmp = [byte[]](0x30,0x26,0x02,0x01,0x00,0x04,0x06,0x70,0x75,0x62,0x6C,0x69,0x63,0xA0,0x19,0x02,0x01,0x01,0x02,0x01,0x00,0x02,0x01,0x00,0x30,0x0F,0x30,0x0D,0x06,0x09,0x2B,0x06,0x01,0x02,0x01,0x01,0x03,0x00,0x05,0x00); " +
            "      try { " +
            "        $udp.Connect($ip, 161); " +
            "        [void]$udp.Send($snmp, $snmp.Length); " +
            "        $ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0); " +
            "        $b = $udp.Receive([ref]$ep); " +
            "        $udp.Close(); " +
            "        if ($b.Length -gt 20) { return $ip } " +
            "      } catch { try { $udp.Close() } catch {} }; " +
            "      return $null " +
            "    } -ArgumentList $t, " + timeout + " " +
            "  }; " +
            "  Wait-Job $jobs -Timeout 8 | Out-Null; " +
            "  $jobs | ForEach-Object { $r = Receive-Job $_ -ErrorAction SilentlyContinue; if ($r) { $found += $r }; Remove-Job $_ -Force -ErrorAction SilentlyContinue }; " +
            "  $found | ForEach-Object { " +
            "    $ip2 = $_; $name2 = $null; " +
            "    try { $name2 = ([System.Net.Dns]::GetHostEntry($ip2)).HostName } catch {} " +
            "    $out += [pscustomobject]@{ ip=$ip2; hostname=$name2 } " +
            "  } " +
            "} " +
            "$__json = '[]'; if ($out) { $__json = @($out) | ConvertTo-Json -Depth 3 -Compress } " +
            "Write-Output ('" + SENTINEL + "' + $__json);";
        runPS(script, function (err, stdout, stderr) {
            if (err) { res({ ok: false, error: 'PowerShell exit ' + (err.code || '?') + (stderr ? (' stderr=' + String(stderr).substring(0, 300)) : (' ' + err.message)) }); return; }
            var s = String(stdout || '');
            var i = s.indexOf(SENTINEL);
            var json = (i >= 0) ? s.substring(i + SENTINEL.length).trim() : s.trim();
            var d = json ? parseJSONSafe(json) : [];
            if (d == null) { res({ ok: false, error: 'JSON invalido do discovery' }); return; }
            if (!Array.isArray(d)) d = [d];
            res({ ok: true, result: d });
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
    }
};

// ------------------------- dispatcher -------------------------

var ALLOWED = ['inventory', 'addPrinter', 'deletePrinter', 'renamePrinter', 'setDefaultPrinter',
    'setPrinterConfig', 'pausePrinter', 'resumePrinter', 'testPage', 'listDrivers', 'listPorts',
    'deletePort', 'discover', 'addFoundPrinter', 'getJobs', 'jobAction', 'clearQueue',
    'spoolerStatus', 'spoolerAction', 'webPanel', 'setDebug'];

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
