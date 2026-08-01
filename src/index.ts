export {}; // marca como modulo ESM (habilita top-level await com imports dinamicos)

const args = process.argv.slice(2);
const command = args[0];

// Imports lazy por modo: cada comando carrega apenas o que precisa.
// Em especial, o modo 'daemon' (Cockpit) NAO carrega o stack de SQLite/embeddings.
if (command === 'daemon') {
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
