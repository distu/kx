# Instalador do kx (Knowledge indeX) para Windows.
#
#   irm https://distu.dev/kx/install.ps1 | iex
#
# O que faz, sem administrador e sem tocar no Node do sistema:
#   1. Baixa um Node.js 22 privado para %USERPROFILE%\.kx\runtime (SHA-256 verificado).
#   2. Baixa o kx para %USERPROFILE%\.kx\app e instala as dependências com esse Node.
#   3. Cria kx.cmd em %USERPROFILE%\.kx\bin e adiciona ao PATH do usuário.
#   4. Roda `kx doctor --warm`, que baixa o modelo e prova a instalação.
#   5. Dentro de um repositório, oferece `kx setup` para configurar o projeto.
#
# Variáveis: KX_HOME, KX_REF, KX_YES=1, KX_NO_SETUP=1, KX_NO_MODIFY_PATH=1,
# KX_SOURCE_DIR (instala de um checkout local), KX_UNINSTALL=1.
# Em Windows ARM64 o Node x64 roda por emulação: o sqlite-vec só publica x64.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Install-Kx {
    try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $repo = if ($env:KX_REPO) { $env:KX_REPO } else { 'distu/kx' }
    $kxHome = if ($env:KX_HOME) { $env:KX_HOME } else { Join-Path $env:USERPROFILE '.kx' }
    $ref = $env:KX_REF
    $nodeMajor = 22
    $esc = [char]27
    $color = -not $env:NO_COLOR -and -not [Console]::IsOutputRedirected

    function Paint([string]$code, [string]$text) { if ($color) { "$esc[$($code)m$text$esc[0m" } else { $text } }
    function Ok([string]$label, [string]$detail = '') { Write-Host ("  {0} {1} {2}" -f (Paint '38;2;214;255;63' '✔'), $label, (Paint '2' $detail)) }
    function Info([string]$text) { Write-Host ("  {0} {1}" -f (Paint '38;2;92;225;255' '›'), $text) }
    function Warn([string]$text) { Write-Host ("  {0} {1}" -f (Paint '38;2;255;246;230' '!'), $text) }
    function Fail([string]$text) {
        Write-Host ''
        Write-Host ("  {0}" -f (Paint '38;2;255;90;54' "✘ $text"))
        if ($script:log -and (Test-Path $script:log)) {
            Write-Host (Paint '2' "  últimas linhas de $($script:log):")
            Get-Content $script:log -Tail 15 | ForEach-Object { Write-Host "    $_" }
        }
        throw "kx: $text"
    }
    function Get-File([string]$url, [string]$out) {
        for ($i = 1; $i -le 3; $i++) {
            try { Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing; return }
            catch { if ($i -eq 3) { Fail "download falhou: $url ($($_.Exception.Message))" } Start-Sleep -Seconds 2 }
        }
    }
    # tar.exe (nativo desde o Windows 10 1803) extrai o zip do Node muito mais rápido.
    function Expand-Zip([string]$zipPath, [string]$dest) {
        $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
        if (Test-Path $tarExe) {
            & $tarExe -xf $zipPath -C $dest
            if ($LASTEXITCODE -eq 0) { return }
        }
        Expand-Archive -Path $zipPath -DestinationPath $dest -Force
    }
    function Invoke-Logged([string]$label, [scriptblock]$block) {
        Info "$label..."
        $watch = [Diagnostics.Stopwatch]::StartNew()
        # Comando nativo escrevendo em stderr não pode virar exceção no PowerShell 5.1.
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        # Out-File em UTF-8: o redirecionamento *>> do PowerShell 5.1 grava em UTF-16.
        try { & $block *>&1 | ForEach-Object { "$_" } | Out-File -FilePath $script:log -Append -Encoding utf8 } finally { $ErrorActionPreference = $previous }
        if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { Fail "falhou: $label" }
        $script:stepSecs = [int]$watch.Elapsed.TotalSeconds
    }

    Write-Host ''
    Write-Host ("  {0}{1}  {2}" -f (Paint '1;38;2;255;246;230' 'k'), (Paint '1;38;2;214;255;63' 'x'), (Paint '1' 'Knowledge indeX'))
    Write-Host ("      {0}" -f (Paint '2' 'busca híbrida local para agentes de IA · instalador'))
    Write-Host ''

    $binDir = Join-Path $kxHome 'bin'

    if ($env:KX_UNINSTALL) {
        foreach ($d in 'app', 'app.new', 'app.old', 'runtime', 'bin', 'models') {
            $p = Join-Path $kxHome $d
            if (Test-Path $p) { Remove-Item $p -Recurse -Force }
        }
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if ($userPath) {
            $clean = ($userPath -split ';' | Where-Object { $_ -and $_ -ne $binDir }) -join ';'
            [Environment]::SetEnvironmentVariable('Path', $clean, 'User')
        }
        Ok 'kx removido' 'app, runtime, modelo, comando e PATH'
        Info "Índices preservados em $(Join-Path $kxHome 'data')."
        Write-Host ''
        return
    }

    # Plataforma: Windows ARM64 usa Node x64 por emulação (sqlite-vec só tem x64).
    $arch = 'x64'
    Ok 'Plataforma' "win-$arch$(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { ' (emulado em ARM64)' })"

    if (Test-Path (Join-Path $kxHome '.git')) { Fail "$kxHome é um checkout de desenvolvimento. Use KX_HOME=<outro diretório>." }
    foreach ($d in 'logs', 'models', 'bin', 'runtime') { New-Item -ItemType Directory -Force -Path (Join-Path $kxHome $d) | Out-Null }
    $script:log = Join-Path $kxHome 'logs\install.log'
    Set-Content -Path $script:log -Value '' -Encoding UTF8

    # ---------- Node privado ----------
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $version = ($index | Where-Object { $_.version -like "v$nodeMajor.*" } | Select-Object -First 1).version
    if (-not $version) { Fail "nenhuma versão do Node $nodeMajor encontrada" }
    $nodeDir = Join-Path $kxHome "runtime\node-$version"
    if (Test-Path (Join-Path $nodeDir 'node.exe')) {
        Ok 'Node.js privado' "$version · já instalado"
    } else {
        $name = "node-$version-win-$arch.zip"
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ("kx-" + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $tmp | Out-Null
        Info "Baixando Node.js $version..."
        Get-File "https://nodejs.org/dist/$version/$name" (Join-Path $tmp $name)
        Get-File "https://nodejs.org/dist/$version/SHASUMS256.txt" (Join-Path $tmp 'SHASUMS256.txt')
        $expected = ((Get-Content (Join-Path $tmp 'SHASUMS256.txt')) | Where-Object { $_ -match " $([regex]::Escape($name))$" }) -split '\s+' | Select-Object -First 1
        $actual = (Get-FileHash (Join-Path $tmp $name) -Algorithm SHA256).Hash.ToLower()
        if (-not $expected -or $expected.ToLower() -ne $actual) { Fail "SHA-256 do Node não confere (esperado $expected, obtido $actual)" }
        Expand-Zip (Join-Path $tmp $name) $tmp
        Move-Item (Join-Path $tmp "node-$version-win-$arch") $nodeDir
        Remove-Item $tmp -Recurse -Force
        Ok 'Node.js privado' "$version · SHA-256 verificado"
    }
    Set-Content -Path (Join-Path $kxHome 'runtime\current.txt') -Value $version
    $node = Join-Path $nodeDir 'node.exe'
    $npm = Join-Path $nodeDir 'npm.cmd'

    # ---------- app ----------
    $stage = Join-Path $kxHome 'app.new'
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    if ($env:KX_SOURCE_DIR) {
        New-Item -ItemType Directory -Path $stage | Out-Null
        Get-ChildItem $env:KX_SOURCE_DIR -Force | Where-Object { $_.Name -notin 'node_modules', '.git' } |
            Copy-Item -Destination $stage -Recurse -Force
        $ref = "local:$($env:KX_SOURCE_DIR)"
    } else {
        if (-not $ref) {
            try { $ref = (Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -UseBasicParsing).tag_name } catch { $ref = $null }
            if (-not $ref) { $ref = 'main' }
        }
        $zip = Join-Path ([IO.Path]::GetTempPath()) ("kx-" + [guid]::NewGuid() + '.zip')
        Info "Baixando kx ($ref)..."
        Get-File "https://codeload.github.com/$repo/zip/$ref" $zip
        $unz = "$zip.d"
        New-Item -ItemType Directory -Path $unz | Out-Null
        Expand-Zip $zip $unz
        Move-Item (Get-ChildItem $unz -Directory | Select-Object -First 1).FullName $stage
        Remove-Item $zip, $unz -Recurse -Force
    }
    if (-not (Test-Path (Join-Path $stage 'bin\kx.js'))) { Fail 'pacote do kx inválido (bin\kx.js ausente)' }

    $env:Path = "$nodeDir;$env:Path"
    Invoke-Logged 'Instalando dependências' { & $npm ci --omit=dev --no-audit --no-fund --prefix $stage }
    Set-Content -Path (Join-Path $stage '.kx-ref') -Value $ref

    $app = Join-Path $kxHome 'app'
    $old = Join-Path $kxHome 'app.old'
    if (Test-Path $old) { Remove-Item $old -Recurse -Force }
    if (Test-Path $app) { Move-Item $app $old }
    Move-Item $stage $app
    if (Test-Path $old) { Remove-Item $old -Recurse -Force }
    $kxVersion = (Get-Content (Join-Path $app 'package.json') -Raw | ConvertFrom-Json).version
    Ok "kx $kxVersion" "$ref · $($script:stepSecs)s"

    # ---------- comando ----------
    $shim = Join-Path $binDir 'kx.cmd'
    $shimText = @(
        '@echo off',
        'rem Gerado pelo instalador do kx. Usa o Node privado para evitar conflito de ABI.',
        "set `"KX_NODE=$node`"",
        "if not defined KX_MODELS_DIR set `"KX_MODELS_DIR=$(Join-Path $kxHome 'models')`"",
        "`"$node`" `"$(Join-Path $app 'bin\kx.js')`" %*"
    ) -join "`r`n"
    [IO.File]::WriteAllText($shim, $shimText + "`r`n", (New-Object Text.UTF8Encoding($false)))
    Ok 'Comando kx' $shim

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ })
    if ($parts -notcontains $binDir) {
        if ($env:KX_NO_MODIFY_PATH) {
            Warn "Adicione $binDir ao PATH para usar o comando kx."
        } else {
            [Environment]::SetEnvironmentVariable('Path', (($parts + $binDir) -join ';'), 'User')
            Ok 'PATH' "$binDir adicionado ao PATH do usuário"
            $pathHint = $true
        }
    }
    $env:Path = "$binDir;$env:Path"

    # ---------- verificação ----------
    Invoke-Logged 'Verificando instalação e baixando o modelo (~23 MB)' { & $shim doctor --warm }
    Ok 'kx doctor' "SQLite, sqlite-vec e embedding testados · $($script:stepSecs)s"

    # ---------- projeto ----------
    $setupHint = $true
    if (-not $env:KX_NO_SETUP) {
        $root = $null
        if (Get-Command git -ErrorAction SilentlyContinue) {
            $previous = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try { $root = (& git rev-parse --show-toplevel 2>$null) } catch { $root = $null } finally { $ErrorActionPreference = $previous }
            if ($LASTEXITCODE -ne 0) { $root = $null }
        }
        if ($root) {
            Write-Host ''
            if ($env:KX_YES) {
                & $shim setup --yes --project-root $root
                $setupHint = $false
            } elseif ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
                $answer = Read-Host "  ? Configurar $root agora (índice + Claude Code/Codex/Cursor)? (S/n)"
                if ($answer -eq '' -or $answer -match '^(s|sim|y|yes)$') {
                    & $shim setup --project-root $root
                    $setupHint = $false
                }
            }
        }
    }

    Write-Host ''
    Write-Host ("  {0} kx instalado em {1}" -f (Paint '1' 'Pronto.'), $kxHome)
    if ($pathHint) { Write-Host (Paint '2' '  Abra um novo terminal para o comando kx entrar no PATH.') }
    if ($setupHint) { Write-Host ("  {0} kx setup" -f (Paint '2' 'Na raiz de um projeto:')) }
    Write-Host ("  {0} kx doctor   {1} `$env:KX_UNINSTALL=1; irm https://distu.dev/kx/install.ps1 | iex" -f (Paint '2' 'Diagnóstico:'), (Paint '2' 'Remover:'))
    Write-Host ''
}

Install-Kx
