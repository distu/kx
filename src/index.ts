export {}; // marca como modulo ESM (habilita top-level await com imports dinamicos)

const args = process.argv.slice(2);
const command = args[0];

// Imports lazy por modo: cada comando carrega apenas o que precisa.
// Em especial, o modo 'daemon' (Cockpit) NAO carrega o stack de SQLite/embeddings.
if (command === 'setup' || command === 'init') {
  // Configurador automático: roda antes de existir qualquer .kx.json.
  const { runSetup } = await import('./setup.js');
  process.exitCode = await runSetup(args.slice(1));
} else if (command === 'doctor') {
  const { runDoctor } = await import('./doctor.js');
  process.exitCode = await runDoctor(args.slice(1));
} else if (command === 'version' || command === '--version' || command === '-v') {
  const { kxVersion } = await import('./doctor.js');
  console.log(`kx ${kxVersion()} · node ${process.version}`);
} else if (command === 'daemon') {
  // Daemon HTTP local do KX Cockpit (kxd). Fase 0: somente leitura.
  const { startDaemon } = await import('./daemon/server.js');
  startDaemon(args.slice(1));
} else if (command === 'mcp') {
  // Modo MCP: sem output no stdout (apenas stderr para logs)
  const { loadConfig } = await import('./config.js');
  const { parseMcpBootOptions } = await import('./mcp-options.js');
  const { startMcpServer } = await import('./mcp-server.js');
  const options = parseMcpBootOptions(args.slice(1));
  const config = loadConfig(options.projectRoot);
  startMcpServer(config).catch((error) => {
    console.error('Erro ao iniciar MCP server:', error);
    process.exit(1);
  });
} else if (command === 'artifact') {
  // Registro de artefatos publicados. CLI propria e sem SQLite no caminho critico: e chamada
  // por hook a cada publicacao, entao precisa subir rapido e nao depender de binario nativo.
  const { loadConfig } = await import('./config.js');
  const { createArtifactCli } = await import('./artifacts-cli.js');
  const config = loadConfig();
  const cli = createArtifactCli(config);
  cli.parseAsync([process.argv[0], process.argv[1], ...args.slice(1)]).catch((error) => {
    console.error('Erro:', error.message);
    process.exit(1);
  });
} else if (command === 'watch') {
  const { loadConfig } = await import('./config.js');
  const { startWatcher } = await import('./watcher.js');
  const config = loadConfig();
  startWatcher(config);
} else {
  // Modo CLI
  const { loadConfig } = await import('./config.js');
  const { createCli } = await import('./cli.js');
  const config = loadConfig();
  const cli = createCli(config);
  cli.parseAsync(process.argv).catch((error) => {
    console.error('Erro:', error.message);
    process.exit(1);
  });
}
