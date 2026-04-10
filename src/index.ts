import { loadConfig } from './config.js';
import { startMcpServer } from './mcp-server.js';
import { createCli } from './cli.js';
import { startWatcher } from './watcher.js';

const args = process.argv.slice(2);
const command = args[0];

// Modo MCP: sem output no stdout (apenas stderr para logs)
if (command === 'mcp') {
  const config = loadConfig();
  startMcpServer(config).catch((error) => {
    console.error('Erro ao iniciar MCP server:', error);
    process.exit(1);
  });
} else if (command === 'watch') {
  const config = loadConfig();
  startWatcher(config);
} else {
  // Modo CLI
  const config = loadConfig();
  const cli = createCli(config);
  cli.parseAsync(process.argv).catch((error) => {
    console.error('Erro:', error.message);
    process.exit(1);
  });
}
