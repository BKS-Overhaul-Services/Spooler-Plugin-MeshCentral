/**
 * Spooler — Agente Windows (injetado no meshcore via addMeshCoreModules,
 * prefixo win- = somente cores Windows).
 *
 * Recebe: { action:'plugin', plugin:'spooler', pluginaction, reqid, params }
 * Responde: mesh.SendCommand({ action:'plugin', plugin:'spooler', pluginaction:'agentResult',
 *                              reqid, op, ok, result|error, target })
 *
 * Toda execução é via PowerShell 64-bit (Sysnative) com comandos montados
 * a partir de parâmetros validados (sem concatenação de input livre).
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

// Executa PowerShell e devolve stdout (JSON esperado)
function runPS(script, callback) {
    try {
        var child = require('child_process');
        var sysnative = process.env['windir'] + '\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe';
        var ps = require('fs').existsSync(sysnative) ? sysnative : (process.env['windir'] + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
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
// Sanitiza para identificador PS (nomes de impressora/porta podem ter espaços)
function ident(s) { return q(s); }

// ------------------------- handlers -------------------------

var handlers = {

    // Inventário de impressoras
    inventory: function (nodeid, reqid, params, res) {
        var script = [
            "$ErrorActionPreference='SilentlyContinue';",
            "$out=@();",
            "$def=(Get-CimInstance -ClassName Win32_Printer | Where-Object {$_.Default} | Select-Object -ExpandProperty Name);",
            "Get-Printer | ForEach-Object {",
            "  $p=$_;",
            "  $pi=$null; try { $pi=Get-PrinterPort -Name $p.PortName -ErrorAction Stop } catch {};",
            "  $out += [pscustomobject]@{",
            "    name=$p.Name; driver=$p.DriverName; port=$p.PortName; shared=[bool]$p.Shared;",
            "    shareName=$p.ShareName; published=[bool]$p.Published; default=($def -contains $p.Name);",
            "    workOffline=[bool]$p.WorkOffline; printerStatus=$p.PrinterStatus;",
            "    type=$p.Type; datatype=$p.DataType; attributes=$p.Attributes; priority=$p.Priority;",
            "    portInfo=$(if($pi){[pscustomobject]@{name=$pi.Name; description=$pi.Description; printerHostAddress=$pi.PrinterHostAddress; portNumber=$pi.PortNumber; protocol=$pi.Protocol; snmp=$pi.SNMPEnabled}}else{$null})",
            "  }",
            "};",
            "$out | ConvertTo-Json -Depth 4 -Compress"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            var d = parseJSONSafe(stdout);
            if (d == null) { res({ ok: false, error: 'JSON inválido do inventário' }); return; }
            if (!Array.isArray(d)) d = [d];
            res({ ok: true, result: d });
        });
    },

    // Adicionar impressora
    addPrinter: function (nodeid, reqid, params, res) {
        var name = ident(params.name);
        var driver = ident(params.driver);
        var ip = ident(params.ip);
        var port = parseInt(params.port || 9100, 10);
        var portName = params.portName ? ident(params.portName) : ('IP_' + ip);
        var shared = params.shared ? '$true' : '$false';
        var shareName = params.shareName ? ident(params.shareName) : null;
        var def = params.setDefault ? '$true' : '$false';
        if (!name || !driver || !ip || isNaN(port)) { res({ ok: false, error: 'Parâmetros inválidos (name, driver, ip, port)' }); return; }
        var script = [
            "$ErrorActionPreference='Stop';",
            "try {",
            "  if (-not (Get-PrinterPort -Name '" + portName + "' -ErrorAction SilentlyContinue)) {",
            "    Add-PrinterPort -Name '" + portName + "' -PrinterHostAddress '" + ip + "' -PortNumber " + port + " -ErrorAction Stop | Out-Null",
            "  }",
            "  if (-not (Get-Printer -Name '" + name + "' -ErrorAction SilentlyContinue)) {",
            "    Add-Printer -Name '" + name + "' -DriverName '" + driver + "' -PortName '" + portName + "' -ErrorAction Stop | Out-Null",
            "  } else {",
            "    Set-Printer -Name '" + name + "' -DriverName '" + driver + "' -PortName '" + portName + "' -ErrorAction Stop",
            "  }",
            "  if (" + shared + ") { Set-Printer -Name '" + name + "' -Shared $true" + (shareName ? (" -ShareName '" + shareName + "'") : '') + " }",
            "  if (" + def + ") { (New-Object -ComObject WScript.Network).SetDefaultPrinter('" + name + "') }",
            "  Write-Output ('OK:' + '" + name + "')",
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            var s = String(stdout || '').trim();
            if (s.indexOf('ERR:') === 0) { res({ ok: false, error: s.substring(4) }); return; }
            res({ ok: true, result: { name: params.name, portName: params.portName || ('IP_' + params.ip) } });
        });
    },

    // Remover impressora
    deletePrinter: function (nodeid, reqid, params, res) {
        var name = ident(params.name);
        var rmPort = params.removePort ? ident(params.portName || '') : null;
        if (!name) { res({ ok: false, error: 'name obrigatório' }); return; }
        var script = [
            "$ErrorActionPreference='Continue';",
            "$p = Get-Printer -Name '" + name + "' -ErrorAction SilentlyContinue;",
            "if (-not $p) { Write-Output 'ERR:Impressora não encontrada'; exit }",
            "$pn = $p.PortName;",
            "Remove-Printer -Name '" + name + "' -ErrorAction Stop;",
            "if ('" + (rmPort ? 'yes' : 'no') + "' -eq 'yes' -and $pn -eq '" + (rmPort || '') + "') {",
            "  $inuse = Get-Printer | Where-Object { $_.PortName -eq $pn };",
            "  if (-not $inuse) { Remove-PrinterPort -Name $pn -ErrorAction SilentlyContinue }",
            "};",
            "Write-Output 'OK'"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            var s = String(stdout || '').trim();
            if (s.indexOf('ERR:') === 0) { res({ ok: false, error: s.substring(4) }); return; }
            res({ ok: true, result: { removed: params.name } });
        });
    },

    // Renomear impressora (remove e recria com novo nome mantendo driver/porta)
    renamePrinter: function (nodeid, reqid, params, res) {
        var oldName = ident(params.oldName);
        var newName = ident(params.newName);
        if (!oldName || !newName) { res({ ok: false, error: 'oldName e newName obrigatórios' }); return; }
        var script = [
            "$ErrorActionPreference='Stop';",
            "try {",
            "  $p = Get-Printer -Name '" + oldName + "' -ErrorAction Stop;",
            "  Rename-Printer -Name '" + oldName + "' -NewName '" + newName + "' -ErrorAction Stop;",
            "  Write-Output 'OK'",
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            var s = String(stdout || '').trim();
            if (s.indexOf('ERR:') === 0) { res({ ok: false, error: s.substring(4) }); return; }
            res({ ok: true, result: { oldName: params.oldName, newName: params.newName } });
        });
    },

    setDefaultPrinter: function (nodeid, reqid, params, res) {
        var name = ident(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatório' }); return; }
        var script = [
            "$ErrorActionPreference='Stop';",
            "try { (New-Object -ComObject WScript.Network).SetDefaultPrinter('" + name + "'); Write-Output 'OK' }",
            "catch { Write-Output ('ERR:' + $_.Exception.Message) }"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            var s = String(stdout || '').trim();
            if (s.indexOf('ERR:') === 0) { res({ ok: false, error: s.substring(4) }); return; }
            res({ ok: true });
        });
    },

    setPrinterConfig: function (nodeid, reqid, params, res) {
        var name = ident(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatório' }); return; }
        var sets = [];
        if (params.shared !== undefined) sets.push('-Shared ' + (params.shared ? '$true' : '$false'));
        if (params.shareName) sets.push("-ShareName '" + ident(params.shareName) + "'");
        if (params.published !== undefined) sets.push('-Published ' + (params.published ? '$true' : '$false'));
        if (params.workOffline !== undefined) sets.push('-WorkOffline ' + (params.workOffline ? '$true' : '$false'));
        if (params.priority !== undefined) { var pr = parseInt(params.priority, 10); if (!isNaN(pr)) sets.push('-Priority ' + pr); }
        if (params.driver) sets.push("-DriverName '" + ident(params.driver) + "'");
        if (params.portName) sets.push("-PortName '" + ident(params.portName) + "'");
        if (!sets.length) { res({ ok: false, error: 'Nenhum campo para alterar' }); return; }
        var script = [
            "$ErrorActionPreference='Stop';",
            "try { Set-Printer -Name '" + name + "' " + sets.join(' ') + " -ErrorAction Stop; Write-Output 'OK' }",
            "catch { Write-Output ('ERR:' + $_.Exception.Message) }"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            var s = String(stdout || '').trim();
            if (s.indexOf('ERR:') === 0) { res({ ok: false, error: s.substring(4) }); return; }
            res({ ok: true });
        });
    },

    pausePrinter: function (nodeid, reqid, params, res) {
        var name = ident(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatório' }); return; }
        var script = [
            "$p = Get-CimInstance Win32_Printer -Filter \"Name='" + name.replace(/'/g, "''") + "'\";",
            "if (-not $p) { Write-Output 'ERR:Impressora não encontrada'; exit }",
            "$p | Invoke-CimMethod -MethodName Pause | Out-Null; Write-Output 'OK'"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            res({ ok: String(stdout || '').trim().indexOf('ERR:') !== 0, error: String(stdout || '').trim().startsWith('ERR:') ? String(stdout).trim().substring(4) : null });
        });
    },

    resumePrinter: function (nodeid, reqid, params, res) {
        var name = ident(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatório' }); return; }
        var script = [
            "$p = Get-CimInstance Win32_Printer -Filter \"Name='" + name.replace(/'/g, "''") + "'\";",
            "if (-not $p) { Write-Output 'ERR:Impressora não encontrada'; exit }",
            "$p | Invoke-CimMethod -MethodName Resume | Out-Null; Write-Output 'OK'"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            res({ ok: String(stdout || '').trim().indexOf('ERR:') !== 0, error: String(stdout || '').trim().startsWith('ERR:') ? String(stdout).trim().substring(4) : null });
        });
    },

    testPage: function (nodeid, reqid, params, res) {
        var name = ident(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatório' }); return; }
        var script = [
            "$ErrorActionPreference='Stop';",
            "try {",
            "  $p = Get-CimInstance Win32_Printer -Filter \"Name='" + name.replace(/'/g, "''") + "'\" -ErrorAction Stop;",
            "  $r = $p | Invoke-CimMethod -MethodName PrintTestPage -ErrorAction Stop;",
            "  Write-Output 'OK'",
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            var s = String(stdout || '').trim();
            if (s.indexOf('ERR:') === 0) { res({ ok: false, error: s.substring(4) }); return; }
            res({ ok: true });
        });
    },

    // Drivers instalados
    listDrivers: function (nodeid, reqid, params, res) {
        var script = [
            "$ErrorActionPreference='SilentlyContinue';",
            "Get-PrinterDriver | Select-Object Name, Manufacturer, DriverVersion, PrinterEnvironment, Architecture |",
            "  ConvertTo-Json -Depth 3 -Compress"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            var d = parseJSONSafe(stdout);
            if (d == null) { res({ ok: false, error: 'JSON inválido' }); return; }
            if (!Array.isArray(d)) d = [d];
            res({ ok: true, result: d });
        });
    },

    // Portas de impressora
    listPorts: function (nodeid, reqid, params, res) {
        var script = [
            "$ErrorActionPreference='SilentlyContinue';",
            "Get-PrinterPort | Select-Object Name, Description, PrinterHostAddress, PortNumber, Protocol, SNMPEnabled |",
            "  ConvertTo-Json -Depth 3 -Compress"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            var d = parseJSONSafe(stdout);
            if (d == null) { res({ ok: false, error: 'JSON inválido' }); return; }
            if (!Array.isArray(d)) d = [d];
            res({ ok: true, result: d });
        });
    },

    deletePort: function (nodeid, reqid, params, res) {
        var name = ident(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatório' }); return; }
        var script = [
            "$ErrorActionPreference='Stop';",
            "try {",
            "  $inuse = Get-Printer | Where-Object { $_.PortName -eq '" + name + "' };",
            "  if ($inuse) { Write-Output 'ERR:Porta em uso por impressora'; exit }",
            "  Remove-PrinterPort -Name '" + name + "' -ErrorAction Stop;",
            "  Write-Output 'OK'",
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            var s = String(stdout || '').trim();
            if (s.indexOf('ERR:') === 0) { res({ ok: false, error: s.substring(4) }); return; }
            res({ ok: true });
        });
    },

    // Descoberta SNMP de impressoras de rede na sub-rede
    discover: function (nodeid, reqid, params, res) {
        var range = ident(params.range || '');
        var timeout = parseInt(params.timeout || 1000, 10);
        if (isNaN(timeout) || timeout < 200) timeout = 1000;
        if (timeout > 5000) timeout = 5000;
        var script = [
            "$ErrorActionPreference='SilentlyContinue';",
            "$range = '" + range + "';",   // ex: 192.168.0 — 3 octetos; vazio = auto-detect do IP local
            "if (-not $range) {",
            "  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' } | Select-Object -First 1).IPAddress;",
            "  if (-not $ip) { Write-Output 'ERR:sem rede'; exit }",
            "  $range = ($ip.Split('.')[0..2] -join '.')",
            "};",
            "$found = @();",
            "$jobs = @();",
            "1..254 | ForEach-Object {",
            "  $t = \"$range.$_\";",
            "  $jobs += Start-Job -ScriptBlock {",
            "    param($ip, $to)",
            "    $udp = New-Object System.Net.Sockets.UdpClient;",
            "    $udp.Client.ReceiveTimeout = $to;",
            "    $snmp = [byte[]](0x30,0x26,0x02,0x01,0x00,0x04,0x06,0x70,0x75,0x62,0x6C,0x69,0x63,0xA0,0x19,0x02,0x01,0x01,0x02,0x01,0x00,0x02,0x01,0x00,0x30,0x0F,0x30,0x0D,0x06,0x09,0x2B,0x06,0x01,0x02,0x01,0x01,0x03,0x00,0x05,0x00);",
            "    try {",
            "      $udp.Connect($ip, 161);",
            "      [void]$udp.Send($snmp, $snmp.Length);",
            "      $ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0);",
            "      $b = $udp.Receive([ref]$ep);",
            "      $udp.Close();",
            "      if ($b.Length -gt 20) { return $ip }",
            "    } catch { try { $udp.Close() } catch {} };",
            "    return $null",
            "  } -ArgumentList $t, " + timeout,
            "};",
            "Wait-Job $jobs -Timeout 8 | Out-Null;",
            "$jobs | ForEach-Object { $r = Receive-Job $_ -ErrorAction SilentlyContinue; if ($r) { $found += $r }; Remove-Job $_ -Force -ErrorAction SilentlyContinue };",
            "$out = @();",
            "$found | ForEach-Object {",
            "  $ip = $_;",
            "  $name = $null;",
            "  try { $name = ([System.Net.Dns]::GetHostEntry($ip)).HostName } catch {}",
            "  $out += [pscustomobject]@{ ip=$ip; hostname=$name }",
            "};",
            "$out | ConvertTo-Json -Depth 3 -Compress"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            var s = String(stdout || '').trim();
            if (s.indexOf('ERR:') === 0) { res({ ok: false, error: s.substring(4) }); return; }
            var d = parseJSONSafe(s);
            if (d == null) d = [];
            if (!Array.isArray(d)) d = [d];
            res({ ok: true, result: d });
        });
    },

    // Instalar impressora encontrada na descoberta (TCP/IP padrão)
    addFoundPrinter: function (nodeid, reqid, params, res) {
        // Reaproveita addPrinter com defaults
        params.port = params.port || 9100;
        params.portName = params.portName || ('IP_' + params.ip);
        params.name = params.name || ('Impressora_' + params.ip);
        handlers.addPrinter(nodeid, reqid, params, res);
    },

    // Filas de impressão
    getJobs: function (nodeid, reqid, params, res) {
        var name = params.name ? ident(params.name) : null;
        var script = [
            "$ErrorActionPreference='SilentlyContinue';",
            "$filter = {};",
            ($name ? "$nameFilter = '" + name + "';" : "$nameFilter = $null;"),
            "Get-PrintJob" + ($name ? " -PrinterName '" + name + "'" : "") + " | Select-Object Id, PrinterName, DocumentName, UserName, JobStatus, SubmittedTime, PagesPrinted, TotalPages, Size |",
            "  ConvertTo-Json -Depth 3 -Compress"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            var d = parseJSONSafe(stdout);
            if (d == null) d = [];
            if (!Array.isArray(d)) d = [d];
            res({ ok: true, result: d });
        });
    },

    jobAction: function (nodeid, reqid, params, res) {
        var jobId = parseInt(params.jobId, 10);
        var act = String(params.action || '');
        var printer = params.printer ? ident(params.printer) : null;
        if (isNaN(jobId) || ['pause', 'resume', 'cancel', 'restart'].indexOf(act) === -1 || !printer) {
            res({ ok: false, error: 'Parâmetros inválidos (jobId, action, printer)' });
            return;
        }
        var method = { pause: 'Pause', resume: 'Resume', cancel: 'Cancel', restart: 'Restart' }[act];
        var script = [
            "$ErrorActionPreference='Stop';",
            "try {",
            "  $j = Get-PrintJob -PrinterName '" + printer + "' -ID " + jobId + " -ErrorAction Stop;",
            "  $j | Invoke-CimMethod -MethodName " + method + " -ErrorAction Stop;",
            "  Write-Output 'OK'",
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            var s = String(stdout || '').trim();
            if (s.indexOf('ERR:') === 0) { res({ ok: false, error: s.substring(4) }); return; }
            res({ ok: true });
        });
    },

    clearQueue: function (nodeid, reqid, params, res) {
        var name = ident(params.name);
        if (!name) { res({ ok: false, error: 'name obrigatório' }); return; }
        var script = [
            "$ErrorActionPreference='Continue';",
            "try { Get-PrintJob -PrinterName '" + name + "' | ForEach-Object { $_ | Invoke-CimMethod -MethodName Cancel -ErrorAction SilentlyContinue } } catch {}",
            "Write-Output 'OK'"
        ].join('\n');
        runPS(script, function (err, stdout) {
            res({ ok: !err, error: err ? err.message : null });
        });
    },

    // Status do serviço Spooler
    spoolerStatus: function (nodeid, reqid, params, res) {
        var script = [
            "$s = Get-Service -Name Spooler -ErrorAction SilentlyContinue;",
            "if ($s) { [pscustomobject]@{ status=$s.Status.ToString(); startType=$s.StartType.ToString(); name=$s.Name } | ConvertTo-Json -Compress }",
            "else { Write-Output 'ERR:Serviço não encontrado' }"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            var s = String(stdout || '').trim();
            if (s.indexOf('ERR:') === 0) { res({ ok: false, error: s.substring(4) }); return; }
            var d = parseJSONSafe(s);
            if (!d) { res({ ok: false, error: 'JSON inválido' }); return; }
            res({ ok: true, result: d });
        });
    },

    spoolerAction: function (nodeid, reqid, params, res) {
        var act = String(params.action || '');
        if (['start', 'stop', 'restart'].indexOf(act) === -1) { res({ ok: false, error: 'action inválida' }); return; }
        var script = [
            "$ErrorActionPreference='Stop';",
            "try {",
            "  if ('" + act + "' -eq 'start') { Start-Service -Name Spooler -ErrorAction Stop }",
            "  elseif ('" + act + "' -eq 'stop') { Stop-Service -Name Spooler -Force -ErrorAction Stop }",
            "  else { Restart-Service -Name Spooler -Force -ErrorAction Stop }",
            "  Start-Sleep -Milliseconds 500;",
            "  $s = (Get-Service -Name Spooler).Status.ToString();",
            "  Write-Output ('OK:' + $s)",
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            var s = String(stdout || '').trim();
            if (s.indexOf('ERR:') === 0) { res({ ok: false, error: s.substring(4) }); return; }
            res({ ok: true, result: { status: s.substring(3) } });
        });
    },

    // Painel web embutido da impressora (proxy HTML básico)
    webPanel: function (nodeid, reqid, params, res) {
        var ip = ident(params.ip || '');
        if (!ip || !/^[\d.]+$/.test(ip)) { res({ ok: false, error: 'IP inválido' }); return; }
        var script = [
            "$ErrorActionPreference='Stop';",
            "try {",
            "  $r = Invoke-WebRequest -Uri ('http://' + '" + ip + "' + '/') -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop;",
            "  $o = [pscustomobject]@{ status=[int]$r.StatusCode; contentType=$r.Headers['Content-Type']; body=$r.Content };",
            "  $o | ConvertTo-Json -Depth 3 -Compress -WarningAction SilentlyContinue | Write-Output",
            "} catch { Write-Output ('ERR:' + $_.Exception.Message) }"
        ].join('\n');
        runPS(script, function (err, stdout) {
            if (err) { res({ ok: false, error: 'PowerShell falhou: ' + err.message }); return; }
            var s = String(stdout || '').trim();
            if (s.indexOf('ERR:') === 0) { res({ ok: false, error: s.substring(4) }); return; }
            var d = parseJSONSafe(s);
            if (!d) { res({ ok: false, error: 'Resposta inválida da impressora' }); return; }
            res({ ok: true, result: d });
        });
    }
};

// ------------------------- dispatcher -------------------------

var ALLOWED = ['inventory', 'addPrinter', 'deletePrinter', 'renamePrinter', 'setDefaultPrinter',
    'setPrinterConfig', 'pausePrinter', 'resumePrinter', 'testPage', 'listDrivers', 'listPorts',
    'deletePort', 'discover', 'addFoundPrinter', 'getJobs', 'jobAction', 'clearQueue',
    'spoolerStatus', 'spoolerAction', 'webPanel'];

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

// Auto-teste ao carregar (log apenas, sempre gravado — 1 linha no boot)
if (typeof require !== 'undefined') {
    try {
        if (process.platform === 'win32') sperr('win-spooler module loaded (debug=' + spDebugFlag + ')');
    } catch (e) {}
}
