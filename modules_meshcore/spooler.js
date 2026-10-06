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

    // Descoberta de impressoras de rede na sub-rede.
    // v1.1.8: SEM Start-Job — a versão anterior criava 254 processos powershell.exe
    // simultâneos (1 por job), o que exauriu kernel pool numa máquina com driver
    // HP/Epson e causou BSOD no cliente. Agora: TCP ConnectAsync porta 9100 (RAW),
    // 254 sockets async num único processo PS, timeout total ~6s, DNS reverso
    // com teto de 1,5s apenas nos hosts encontrados.
    discover: function (nodeid, reqid, params, res) {
        var range = q(params.range || '');
        var timeout = parseInt(params.timeout || 1000, 10);
        if (isNaN(timeout) || timeout < 500) timeout = 1000;
        if (timeout > 2000) timeout = 2000;
        var waitMs = Math.min(Math.max(timeout * 4, 2000), 8000);
        var script = PS_HEAD +
            "$out = @(); " +
            "$range = '" + range + "'; " +
            "if (-not $range) { " +
            "  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' } | Select-Object -First 1).IPAddress; " +
            "  if ($ip) { $range = ($ip.Split('.')[0..2] -join '.') } " +
            "}; " +
            "if ($range) { " +
            "  $conns = @{}; $tasks = @{}; " +
            "  foreach ($i in 1..254) { " +
            "    $t = \"$range.$_\"; " +
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
            "  foreach ($ip2 in $found) { " +
            "    $name2 = $null; " +
            "    $rt = [System.Net.Dns]::BeginGetHostEntry($ip2, $null, $null); " +
            "    if ($rt.AsyncWaitHandle.WaitOne(1500)) { try { $name2 = ([System.Net.Dns]::EndGetHostEntry($rt)).HostName } catch {} } " +
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
